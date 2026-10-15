import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import { contacts } from '../db/schema.js';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatarFile, writeAvatarFile } from '../media/avatar-files.js';
import { baseMime } from '../messages/media.js';
import { waAddress } from '../messages/send.js';

const RECHECK_AFTER = sql`now() - interval '7 days'`;

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
 * Throws on gateway/download/disk failures; the claim stays, the old picture is kept.
 */
export async function refreshContactAvatar(ctx: AppCtx, instance: string, contactId: string): Promise<boolean> {
  const [c] = await ctx.db
    .update(contacts)
    .set({ avatarCheckedAt: sql`now()` })
    .where(and(eq(contacts.id, contactId), or(isNull(contacts.avatarCheckedAt), lt(contacts.avatarCheckedAt, RECHECK_AFTER))))
    .returning({ phone: contacts.phone, lid: contacts.lid, avatarPath: contacts.avatarPath });
  const address = waAddress(c);
  if (!c || !address) return false;

  const url = await ctx.wa.fetchProfilePicture(instance, address);
  let path: string | null = null;
  if (url) {
    const { data, ext } = await download(url);
    path = `avatars/${contactId}${ext}`;
    await writeAvatarFile(ctx.config.mediaDir, path, data);
  }
  await ctx.db.update(contacts).set({ avatarPath: path, avatarCheckedAt: sql`now()` }).where(eq(contacts.id, contactId));
  if (c.avatarPath && c.avatarPath !== path) await removeAvatarFile(ctx.config.mediaDir, c.avatarPath);
  return c.avatarPath !== null || path !== null;
}
