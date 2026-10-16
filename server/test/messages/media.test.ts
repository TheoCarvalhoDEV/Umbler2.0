import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaResponseHeaders, saveMedia } from '../../src/messages/media.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

describe('saveMedia', () => {
  it('stores the bytes under YYYY/MM/<uuid>.<ext> using the mime type', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('abc'), 'audio/ogg; codecs=opus', 'voz.opus');
    expect(r.size).toBe(3);
    expect(r.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.ogg$`));
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('abc');
  });

  it('falls back to the original extension, then to .bin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const docx = await saveMedia(dir, Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Contrato.DOCX');
    expect(docx.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.docx$`));
    const weird = await saveMedia(dir, Buffer.from('x'), 'application/x-unknown', 'arquivo.<script>');
    expect(weird.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.bin$`));
    const none = await saveMedia(dir, Buffer.from('x'), 'application/x-unknown');
    expect(none.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.bin$`));
  });

  it('never lets the original name pick the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('<h1>x</h1>'), 'text/html', '../../evil.html');
    expect(r.path).toMatch(new RegExp(`^\\d{4}/\\d{2}/${UUID}\\.html$`));
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('<h1>x</h1>');
  });
});

describe('saveMedia subdir', () => {
  it('stores under the given subdir instead of YYYY/MM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const r = await saveMedia(dir, Buffer.from('%PDF'), 'application/pdf', 'Contrato.pdf', 'bots');
    expect(r.path).toMatch(new RegExp(`^bots/${UUID}\\.pdf$`));
    expect(r.size).toBe(4);
    expect(await readFile(join(dir, r.path), 'utf8')).toBe('%PDF');
  });
});

describe('mediaResponseHeaders', () => {
  const inlineCases: Array<[string, string]> = [
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/webp', 'image/webp'],
    ['image/gif', 'image/gif'],
    ['IMAGE/PNG', 'image/png'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/mpeg', 'audio/mpeg'],
    ['video/mp4', 'video/mp4'],
  ];

  it.each(inlineCases)('%s → inline as %s, nosniff, CSP sandbox', (mime, type) => {
    const h = mediaResponseHeaders(mime, 'arquivo');
    expect(h['Content-Type']).toBe(type);
    expect(h['Content-Disposition']).toMatch(/^inline;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe('sandbox');
  });

  it('application/pdf → inline, nosniff, and NO CSP sandbox (browser viewer needs scripts)', () => {
    const h = mediaResponseHeaders('application/pdf', 'contrato.pdf');
    expect(h['Content-Type']).toBe('application/pdf');
    expect(h['Content-Disposition']).toMatch(/^inline;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBeUndefined();
  });

  // Review Focus 5: malicious media must never render inline.
  const attachmentCases = ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/javascript', 'video/quicktime', 'application/octet-stream', ''];

  it.each(attachmentCases)('%s → attachment as application/octet-stream with CSP sandbox', (mime) => {
    const h = mediaResponseHeaders(mime, 'x.html');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toMatch(/^attachment;/);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toBe('sandbox');
  });

  it('encodes the filename per RFC 5987 with a safe ASCII fallback', () => {
    const h = mediaResponseHeaders('application/pdf', 'Petição "final".pdf');
    expect(h['Content-Disposition']).toBe(
      `inline; filename="Peti__o _final_.pdf"; filename*=UTF-8''Peti%C3%A7%C3%A3o%20%22final%22.pdf`,
    );
  });

  it('never lets CR/LF from a filename reach the header', () => {
    const h = mediaResponseHeaders('text/plain', 'a\r\nSet-Cookie: x=1.txt');
    expect(h['Content-Disposition']).not.toMatch(/[\r\n]/);
  });
});

describe('saveMedia: outgoing files (Task 10)', () => {
  it('saves under the current UTC YYYY/MM with the mapped extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    const data = Buffer.from('jpeg-bytes');
    const saved = await saveMedia(dir, data, 'image/jpeg', 'foto.JPG');
    const now = new Date();
    const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/`;
    expect(saved.path.startsWith(prefix)).toBe(true);
    expect(saved.path).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(saved.size).toBe(data.length);
    expect(await readFile(join(dir, saved.path))).toEqual(data);
  });

  it.each([
    ['video/quicktime', 'mov'],
    ['video/3gpp', '3gp'],
    ['audio/aac', 'aac'],
    ['audio/amr', 'amr'],
    ['application/msword', 'doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['text/plain', 'txt'],
    ['application/zip', 'zip'],
  ])('maps %s to .%s without needing an original name', async (mime, ext) => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    expect((await saveMedia(dir, Buffer.from('a'), mime)).path).toMatch(new RegExp(`\\.${ext}$`));
  });

  it('unknown mime with an unsafe original extension falls back to .bin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-media-'));
    expect((await saveMedia(dir, Buffer.from('a'), 'application/x-foo', 'x.tar.g$z')).path).toMatch(/\.bin$/);
  });
});
