import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import type { FastifyReply } from 'fastify';
import { notFound } from '../lib/http-error.js';

/** Profile pictures (contacts and users) live under `<mediaDir>/avatars`; paths in the DB are relative to mediaDir. */

// Decision: only jpeg/png/webp/gif are ever stored or served. SVG is excluded on purpose (security):
// image/svg+xml served from our origin could carry script. Users may upload only jpeg/png/webp (auth/routes.ts).
export const AVATAR_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** Absolute path of `relPath` when it stays inside mediaDir, else null. */
function insideMediaDir(mediaDir: string, relPath: string): string | null {
  const root = resolve(mediaDir);
  const file = resolve(root, relPath);
  return file.startsWith(root + sep) ? file : null;
}

function fileOrThrow(mediaDir: string, relPath: string): string {
  const file = insideMediaDir(mediaDir, relPath);
  if (!file) throw new Error('avatar path outside mediaDir');
  return file;
}

/** Writes `<path>.tmp` and renames it over `path`, so a reader never sees a half-written picture. */
export async function writeAvatarFile(mediaDir: string, relPath: string, data: Buffer): Promise<void> {
  const file = fileOrThrow(mediaDir, relPath);
  const tmp = `${file}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export async function removeAvatarFile(mediaDir: string, relPath: string): Promise<void> {
  await rm(fileOrThrow(mediaDir, relPath), { force: true });
}

/**
 * Streams a stored picture: 404 unless it is a file inside mediaDir with a known raster extension.
 * The Content-Type comes from that whitelist, never from the bytes; nosniff + CSP sandbox on top.
 */
export async function sendAvatarFile(reply: FastifyReply, mediaDir: string, relPath: string | null | undefined) {
  const file = relPath ? insideMediaDir(mediaDir, relPath) : null;
  if (!file) throw notFound();
  const type = Object.keys(AVATAR_TYPES).find((t) => AVATAR_TYPES[t] === extname(file));
  const info = await stat(file).catch(() => null);
  if (!type || !info?.isFile()) throw notFound();
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
