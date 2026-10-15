import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';
import { notFound } from '../lib/http-error.js';

/** Profile pictures (contacts and users) live under `<mediaDir>/avatars`; paths in the DB are relative to mediaDir. */

// Raster types only: image/svg+xml served from our origin could carry script.
export const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Writes `<path>.tmp` and renames it over `path`, so a reader never sees a half-written picture. */
export async function writeAvatarFile(mediaDir: string, relPath: string, data: Buffer): Promise<void> {
  const file = resolve(mediaDir, relPath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, data);
  await rename(`${file}.tmp`, file);
}

export async function removeAvatarFile(mediaDir: string, relPath: string): Promise<void> {
  await rm(resolve(mediaDir, relPath), { force: true });
}

/**
 * Streams a stored picture: 404 unless it is a file inside mediaDir with a known raster extension.
 * The Content-Type comes from that whitelist, never from the bytes; nosniff + CSP sandbox on top.
 */
export async function sendAvatarFile(reply: FastifyReply, mediaDir: string, relPath: string | null | undefined) {
  if (!relPath) throw notFound();
  const root = resolve(mediaDir);
  const file = resolve(root, relPath);
  const type = Object.keys(AVATAR_TYPES).find((t) => AVATAR_TYPES[t] === extname(file));
  const info = await stat(file).catch(() => null);
  if (!file.startsWith(root + sep) || !type || !info?.isFile()) throw notFound();
  return reply
    .headers({
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    })
    .send(createReadStream(file));
}

/** `v` is a short hash of the path; every upload gets a new file name, so the URL changes with the picture. */
export function userAvatarUrl(u: { id: string; avatarPath: string | null }): string | null {
  if (!u.avatarPath) return null;
  return `/api/users/${u.id}/avatar?v=${createHash('sha256').update(u.avatarPath).digest('hex').slice(0, 8)}`;
}
