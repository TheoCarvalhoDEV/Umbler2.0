import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveMedia } from '../../src/messages/media.js';

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
