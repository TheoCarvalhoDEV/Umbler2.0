import { mkdtemp, readFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeAvatarFile } from '../../src/media/avatar-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, writeFile: vi.fn(orig.writeFile), rename: vi.fn(orig.rename) };
});

describe('writeAvatarFile', () => {
  it('writes <path>.tmp and renames it over the final file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'talk-avatar-'));
    await writeAvatarFile(dir, 'avatars/users/u1.png', Buffer.from('img'));

    const final = join(dir, 'avatars/users/u1.png');
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(`${final}.tmp`, Buffer.from('img'));
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(`${final}.tmp`, final);
    expect(await readFile(final, 'utf8')).toBe('img');
  });
});
