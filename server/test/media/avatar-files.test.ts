import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { removeAvatarFile, writeAvatarFile } from '../../src/media/avatar-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, writeFile: vi.fn(orig.writeFile), rename: vi.fn(orig.rename), rm: vi.fn(orig.rm) };
});

const tempDir = () => mkdtemp(join(tmpdir(), 'talk-avatar-'));

describe('writeAvatarFile', () => {
  it('writes <path>.tmp and renames it over the final file', async () => {
    const dir = await tempDir();
    await writeAvatarFile(dir, 'avatars/users/u1.png', Buffer.from('img'));

    const final = join(dir, 'avatars/users/u1.png');
    expect(vi.mocked(fsp.writeFile)).toHaveBeenCalledWith(`${final}.tmp`, Buffer.from('img'));
    expect(vi.mocked(fsp.rename)).toHaveBeenCalledWith(`${final}.tmp`, final);
    expect(await readFile(final, 'utf8')).toBe('img');
  });

  it('removes the .tmp when writing it fails halfway', async () => {
    const dir = await tempDir();
    vi.mocked(fsp.writeFile).mockImplementationOnce(async (path) => {
      writeFileSync(path as string, 'half');
      throw new Error('ENOSPC');
    });
    await expect(writeAvatarFile(dir, 'avatars/u2.png', Buffer.from('img'))).rejects.toThrow('ENOSPC');
    expect(existsSync(join(dir, 'avatars/u2.png.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'avatars/u2.png'))).toBe(false);
  });

  it('removes the .tmp when the rename fails', async () => {
    const dir = await tempDir();
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('EPERM'));
    await expect(writeAvatarFile(dir, 'avatars/u3.png', Buffer.from('img'))).rejects.toThrow('EPERM');
    expect(existsSync(join(dir, 'avatars/u3.png.tmp'))).toBe(false);
  });

  it('refuses a path outside mediaDir', async () => {
    const dir = await tempDir();
    vi.mocked(fsp.writeFile).mockClear();
    await expect(writeAvatarFile(join(dir, 'media'), '../fora.png', Buffer.from('img'))).rejects.toThrow();
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'fora.png'))).toBe(false);
  });
});

describe('removeAvatarFile', () => {
  it('refuses a path outside mediaDir', async () => {
    const dir = await tempDir();
    writeFileSync(join(dir, 'fora.png'), 'x');
    await expect(removeAvatarFile(join(dir, 'media'), '../fora.png')).rejects.toThrow();
    expect(existsSync(join(dir, 'fora.png'))).toBe(true);
  });
});
