import { setTimeout as sleep } from 'node:timers/promises';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import { channels, chats, contacts } from '../db/schema.js';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatarFile, writeAvatarFile } from '../media/avatar-files.js';
import { baseMime } from '../messages/media.js';
import { waAddress } from '../messages/send.js';
import { publishOpenChats } from './service.js';

const RECHECK_AFTER = sql`now() - interval '7 days'`;
// ponytail: no extra column; a failed check is backdated so the 7-day rule lets it run again in about an hour.
const RETRY_AFTER_FAILURE = sql`now() - interval '7 days' + interval '1 hour'`;

type AvatarFields = { id: string; avatarPath: string | null; avatarCheckedAt: Date | null };

/** URL of the contact's picture; `v` busts the browser cache whenever it is re-checked. */
export function avatarUrl(c: AvatarFields): string | null {
  return c.avatarPath && c.avatarCheckedAt ? `/api/contacts/${c.id}/avatar?v=${c.avatarCheckedAt.getTime()}` : null;
}

/** A download we refuse to keep (named so the log says why without any data). */
class AvatarRejected extends Error {
  override name = 'AvatarRejected';
}

async function download(url: string): Promise<{ data: Buffer; ext: string }> {
  if (new URL(url).protocol !== 'https:') throw new AvatarRejected();
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  // jpeg/png/webp/gif only; SVG is refused on purpose (see AVATAR_TYPES in media/avatar-files.ts).
  const ext = AVATAR_TYPES[baseMime(res.headers.get('content-type') ?? '')];
  if (!res.ok || !ext || !res.body || Number(res.headers.get('content-length') ?? 0) > AVATAR_MAX_BYTES) {
    await res.body?.cancel();
    throw new AvatarRejected();
  }
  // Counts while streaming: a body without (or lying about) content-length is cut at the cap.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > AVATAR_MAX_BYTES) throw new AvatarRejected(); // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  return { data: Buffer.concat(chunks), ext };
}

/**
 * Re-fetches the contact's WhatsApp picture when it was never checked or was checked over 7 days ago.
 * The check is claimed first (avatar_checked_at = now()), so a burst of messages looks it up once and a
 * failure is not retried on every message. Returns whether the contact's avatarUrl may have changed.
 * Throws on gateway/download/disk failures; the old picture is kept and the check is due again in ~1 h.
 */
export async function refreshContactAvatar(ctx: AppCtx, instance: string, contactId: string): Promise<boolean> {
  const [c] = await ctx.db
    .update(contacts)
    .set({ avatarCheckedAt: sql`now()` })
    .where(and(eq(contacts.id, contactId), or(isNull(contacts.avatarCheckedAt), lt(contacts.avatarCheckedAt, RECHECK_AFTER))))
    .returning({ phone: contacts.phone, lid: contacts.lid, avatarPath: contacts.avatarPath });
  const address = waAddress(c);
  if (!c || !address) return false;

  let path: string | null = null;
  try {
    const url = await ctx.wa.fetchProfilePicture(instance, address);
    if (url) {
      const { data, ext } = await download(url);
      path = `avatars/${contactId}${ext}`;
      await writeAvatarFile(ctx.config.mediaDir, path, data);
    }
  } catch (err) {
    await ctx.db.update(contacts).set({ avatarCheckedAt: RETRY_AFTER_FAILURE }).where(eq(contacts.id, contactId));
    throw err;
  }
  await ctx.db.update(contacts).set({ avatarPath: path, avatarCheckedAt: sql`now()` }).where(eq(contacts.id, contactId));
  if (c.avatarPath && c.avatarPath !== path) await removeAvatarFile(ctx.config.mediaDir, c.avatarPath);
  return c.avatarPath !== null || path !== null;
}

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/** Never throws; logs only the error name. Re-sends the contact's open chats when its avatarUrl may have changed. */
async function refreshAndPublish(ctx: AppCtx, instance: string, contactId: string): Promise<void> {
  try {
    if (await refreshContactAvatar(ctx, instance, contactId)) await publishOpenChats(ctx, contactId);
  } catch (err) {
    console.error('avatar refresh failed', { contactId, err: errName(err) });
  }
}

// ponytail: in-process set of running refreshes, awaited by tests (and nothing else); fine for one app process.
const avatarRefreshes = new Set<Promise<void>>();

/** Resolves once every background avatar refresh started so far has finished. */
export async function avatarRefreshesIdle(): Promise<void> {
  while (avatarRefreshes.size) await Promise.all(avatarRefreshes);
}

/**
 * Spec Part 3, also on sends and when a conversation is opened: not awaited, never throws; call it outside any
 * transaction. Asks through `channelId` only while it is connected; the stale rule lives in refreshContactAvatar.
 */
export function refreshAvatarInBackground(ctx: AppCtx, channelId: string, contactId: string): void {
  const run: Promise<void> = (async () => {
    const [ch] = await ctx.db
      .select({ instance: channels.evolutionInstance })
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.status, 'connected')));
    if (ch) await refreshAndPublish(ctx, ch.instance, contactId);
  })()
    .catch((err: unknown) => console.error('avatar refresh failed', { contactId, err: errName(err) }))
    .finally(() => avatarRefreshes.delete(run));
  avatarRefreshes.add(run);
}

/**
 * Hourly sweep (and once at boot) of contacts never checked, e.g. ones that only got messages before this existed.
 * One lookup every `gapMs`, at most `limit` per sweep, through the channel of the contact's latest chat when connected.
 */
export function createAvatarSweep(ctx: AppCtx, opts: { intervalMs?: number; gapMs?: number; limit?: number } = {}) {
  const { intervalMs = 60 * 60_000, gapMs = 3000, limit = 200 } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let abort = new AbortController();
  let running: Promise<void> | null = null;

  async function sweep(): Promise<number> {
    const { signal } = abort;
    const latest = ctx.db
      .selectDistinctOn([chats.contactId], { contactId: chats.contactId, channelId: chats.channelId })
      .from(chats)
      .orderBy(chats.contactId, desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`))
      .as('latest');
    const due = await ctx.db
      .select({ id: contacts.id, instance: channels.evolutionInstance })
      .from(contacts)
      .innerJoin(latest, eq(latest.contactId, contacts.id))
      .innerJoin(channels, eq(channels.id, latest.channelId))
      .where(and(isNull(contacts.avatarCheckedAt), eq(channels.status, 'connected')))
      .limit(limit);
    let done = 0;
    for (const c of due) {
      if (done > 0) {
        try {
          await sleep(gapMs, undefined, { signal, ref: false });
        } catch {
          break; // stopped during the wait
        }
      }
      if (signal.aborted) break;
      await refreshAndPublish(ctx, c.instance, c.id);
      done += 1;
    }
    return done;
  }

  function run(): void {
    if (running) return; // the previous sweep is still going
    running = sweep()
      .then(
        () => undefined,
        (err: unknown) => console.error('avatar sweep failed', { err: errName(err) }),
      )
      .finally(() => {
        running = null;
      });
  }

  return {
    sweep,
    start(): void {
      if (timer) return;
      abort = new AbortController();
      run();
      timer = setInterval(run, intervalMs);
      timer.unref();
    },
    /** Ends the wait at once; resolves when the lookup in flight (if any) has finished. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort();
      await running;
    },
  };
}
