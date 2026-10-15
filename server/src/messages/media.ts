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
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'application/zip': '.zip',
};

// Spec §4: only these (plus audio/*) may render inline in the browser.
const INLINE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf']);

export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function extensionFor(mime: string, originalName?: string | null): string {
  const byMime = EXT_BY_MIME[baseMime(mime)];
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

export function mediaResponseHeaders(mime: string, fileName: string): Record<string, string> {
  const type = baseMime(mime);
  const inline = INLINE.has(type) || type.startsWith('audio/');
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
  if (type !== 'application/pdf') headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
