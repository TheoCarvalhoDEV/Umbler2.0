import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'application/pdf': '.pdf',
};

function extensionFor(mime: string, originalName?: string | null): string {
  const byMime = EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()];
  if (byMime) return byMime;
  const ext = extname(originalName ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
}

/** Writes media to `<mediaDir>/YYYY/MM/<uuid>.<ext>`; the original name never becomes part of the path. */
export async function saveMedia(
  mediaDir: string,
  data: Buffer,
  mime: string,
  originalName?: string | null,
): Promise<{ path: string; size: number }> {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const path = `${folder}/${randomUUID()}${extensionFor(mime, originalName)}`;
  await mkdir(join(mediaDir, folder), { recursive: true });
  await writeFile(join(mediaDir, path), data);
  return { path, size: data.length };
}
