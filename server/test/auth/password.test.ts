import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('password', () => {
  it('hashes with argon2id and verifies the right password only', async () => {
    const hash = await hashPassword('segredo-forte-1');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('segredo-forte-1');
    expect(await verifyPassword(hash, 'segredo-forte-1')).toBe(true);
    expect(await verifyPassword(hash, 'segredo-forte-2')).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    expect(await hashPassword('igual')).not.toBe(await hashPassword('igual'));
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'qualquer')).toBe(false);
  });
});
