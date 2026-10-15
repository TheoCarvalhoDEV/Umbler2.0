import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import { contacts } from '../db/schema.js';
import { baseMime } from '../messages/media.js';
import { waAddress } from '../messages/send.js';

// Raster types only: the spec says image/*, but image/svg+xml served from our origin could carry script.
export const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MAX_BYTES = 2 * 1024 * 1024;
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
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const ext = AVATAR_TYPES[baseMime(res.headers.get('content-type') ?? '')];
  if (!res.ok || !ext || Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    throw new AvatarRejected();
  }
  // ponytail: reads the whole body before the size check; the URL comes from WhatsApp's CDN via Evolution.
  // Stream with a byte cap if that source ever becomes untrusted.
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new AvatarRejected();
  return { data, ext };
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
    await mkdir(join(ctx.config.mediaDir, 'avatars'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, path), data);
  }
  await ctx.db.update(contacts).set({ avatarPath: path, avatarCheckedAt: sql`now()` }).where(eq(contacts.id, contactId));
  if (c.avatarPath && c.avatarPath !== path) await rm(join(ctx.config.mediaDir, c.avatarPath), { force: true });
  return c.avatarPath !== null || path !== null;
}
