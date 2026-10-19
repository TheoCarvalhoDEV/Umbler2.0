import { and, eq, sql } from 'drizzle-orm';
import type { HistoryPeriod } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, historyImports } from '../db/schema.js';
import { copyRange } from './copy.js';
import type { HistoryImportRow } from './imports.js';

const MIN = 60_000;
/** §5.1: the phone may take ~45 min to send its history, so an automatic import repeats the copy. */
const AUTO_REPEAT_MS = 2 * MIN;
const AUTO_QUIET_MS = 10 * MIN;
const AUTO_MAX_MS = 60 * MIN;
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
 * One pass of a running import (§5.1–5.6): copies [periodStart, now], adds the counts after each page and publishes
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
    await copyRange(ctx, channel, periodStart(imp.period, now), now, async (r) => {
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
