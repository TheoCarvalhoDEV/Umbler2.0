import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { HistoryPeriod } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, historyImports } from '../db/schema.js';
import { copyRange } from './copy.js';
import { drainMediaQueue } from './media.js';
import type { HistoryImportRow } from './imports.js';

const MIN = 60_000;
/** §5.1: the phone may take ~45 min to send its history, so an automatic import repeats the copy. */
const AUTO_REPEAT_MS = 2 * MIN;
const AUTO_QUIET_MS = 10 * MIN;
const AUTO_MAX_MS = 60 * MIN;
/** The last 30 min still belong to the webhook (Evolution retries ~20 min): there a message keeps its queue and bots. */
const BACKFILL_LAG_MS = 30 * MIN;
/** "Tudo" starts the year WhatsApp launched: monthly windows from there are ~210 cheap requests. */
const ALL_START = new Date('2009-01-01T00:00:00Z');

/** Start of the period an import copies (UTC calendar months back from `now`). */
export function periodStart(period: HistoryPeriod, now: Date): Date {
  if (period === 'all') return ALL_START;
  const months = period === '3m' ? 3 : 12;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()),
  );
}

/**
 * One pass of a running import (§5.1–5.6): copies [periodStart, now - 30 min] (the rest is the webhook's; the back-fill picks it up later), adds the counts after each page and publishes
 * channel.status, then decides done / next pass in 2 min / failed. Returns the updated row, or null when the import
 * is no longer running.
 */
export async function runImportPass(ctx: AppCtx, importId: string): Promise<HistoryImportRow | null> {
  const [imp] = await ctx.db
    .select()
    .from(historyImports)
    .where(and(eq(historyImports.id, importId), eq(historyImports.state, 'running')));
  if (!imp) return null;
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, imp.channelId));
  if (!channel) return null;
  const now = ctx.botRuntime.now();

  let inserted = 0;
  let patch: Partial<typeof historyImports.$inferInsert>;
  try {
    await copyRange(ctx, channel, periodStart(imp.period, now), new Date(now.getTime() - BACKFILL_LAG_MS), async (r) => {
      if (r.inserted === 0 && r.contactsCreated === 0) return;
      inserted += r.inserted;
      await ctx.db
        .update(historyImports)
        .set({
          messagesImported: sql`${historyImports.messagesImported} + ${r.inserted}`,
          contactsCreated: sql`${historyImports.contactsCreated} + ${r.contactsCreated}`,
          oldestMessageAt: r.oldest ? sql`least(${historyImports.oldestMessageAt}, ${r.oldest.toISOString()}::timestamptz)` : undefined,
        })
        .where(eq(historyImports.id, imp.id));
      await ctx.hub.publishChannel(channel.id); // "Importando histórico… N mensagens" (§5.6)
    });
    const lastNewAt = inserted > 0 ? now : (imp.lastNewAt ?? imp.startedAt);
    const finished =
      !imp.auto || now.getTime() - lastNewAt.getTime() >= AUTO_QUIET_MS || now.getTime() - imp.startedAt.getTime() >= AUTO_MAX_MS;
    patch = finished
      ? { state: 'done', finishedAt: now, lastNewAt, nextRunAt: null }
      : { lastNewAt, nextRunAt: new Date(now.getTime() + AUTO_REPEAT_MS) };
  } catch (err) {
    // §9: stop, keep what came in; only the error name/code is kept and logged
    console.error('history: import failed', imp.id, errorTag(err));
    patch = { state: 'failed', finishedAt: now, error: errorTag(err), nextRunAt: null };
  }
  const [row] = await ctx.db.update(historyImports).set(patch).where(eq(historyImports.id, imp.id)).returning();
  await ctx.hub.publishChannel(channel.id);
  return row ?? null;
}

/** §6: back-fill cadence (also once at boot). */
export const BACKFILL_EVERY_MS = 5 * MIN;
const BACKFILL_OVERLAP_MS = 10 * MIN;

/**
 * §6: copies, as history, Evolution's messages in [backfill_until - 10 min, now - 30 min] the app does not have, and
 * advances backfill_until. The first run of a channel only sets the watermark. Throws on an Evolution failure
 * (backfill_until stays). Returns how many messages it copied.
 */
export async function runBackfill(ctx: AppCtx, channelId: string): Promise<number> {
  const [channel] = await ctx.db.select().from(channels).where(eq(channels.id, channelId));
  if (!channel) return 0;
  const lteAt = new Date(ctx.botRuntime.now().getTime() - BACKFILL_LAG_MS);
  if (!channel.backfillUntil) {
    await ctx.db.update(channels).set({ backfillUntil: lteAt }).where(eq(channels.id, channelId));
    return 0;
  }
  const totals = await copyRange(ctx, channel, new Date(channel.backfillUntil.getTime() - BACKFILL_OVERLAP_MS), lteAt);
  await ctx.db.update(channels).set({ backfillUntil: lteAt }).where(eq(channels.id, channelId));
  return totals.inserted;
}

/**
 * The history worker (§5-6), one per app process: import passes that are due and, every 5 min, the back-fill of every
 * channel; plus the media queue in its own loop, so a long download run never delays an import pass. All state lives
 * in the DB, so a restart resumes where the previous process stopped.
 * ponytail: one process only; claim rows with FOR UPDATE SKIP LOCKED if the app ever runs more than one.
 */
export function createHistoryWorker(ctx: AppCtx, opts: { intervalMs?: number; mediaIntervalMs?: number } = {}) {
  const { intervalMs = 15_000, mediaIntervalMs = 10_000 } = opts;
  let lastBackfill = Number.NEGATIVE_INFINITY;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let abort = new AbortController();
  let jobs: Promise<unknown> | null = null;
  let media: Promise<unknown> | null = null;

  async function tick(): Promise<void> {
    const now = ctx.botRuntime.now();
    const due = await ctx.db
      .select({ id: historyImports.id })
      .from(historyImports)
      .where(and(eq(historyImports.state, 'running'), lte(historyImports.nextRunAt, now)))
      .orderBy(asc(historyImports.nextRunAt));
    for (const { id } of due) {
      try {
        await runImportPass(ctx, id);
      } catch (err) {
        console.error('history: import pass failed', id, errorTag(err)); // a DB error; the next beat retries
      }
    }
    if (now.getTime() - lastBackfill < BACKFILL_EVERY_MS) return;
    lastBackfill = now.getTime();
    for (const { id } of await ctx.db.select({ id: channels.id }).from(channels)) {
      try {
        await runBackfill(ctx, id);
      } catch (err) {
        console.error('history: backfill failed', id, errorTag(err));
      }
    }
  }

  function runJobs(): void {
    if (jobs) return; // the previous beat is still running
    jobs = tick()
      .catch((err: unknown) => console.error('history: tick failed', errorTag(err)))
      .finally(() => {
        jobs = null;
      });
  }

  function runMedia(): void {
    if (media) return;
    media = drainMediaQueue(ctx, abort.signal)
      .catch((err: unknown) => console.error('history: media queue failed', errorTag(err)))
      .finally(() => {
        media = null;
      });
  }

  return {
    tick,
    start(): void {
      if (timers.length) return;
      abort = new AbortController();
      runJobs();
      runMedia();
      timers.push(setInterval(runJobs, intervalMs), setInterval(runMedia, mediaIntervalMs));
      for (const t of timers) t.unref();
    },
    /** Clears the timers, ends the media loop after its current download, and waits for both. */
    async stop(): Promise<void> {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      abort.abort();
      await Promise.all([jobs, media]);
    },
  };
}
