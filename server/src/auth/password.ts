import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 defaults to Argon2id (the test asserts the `$argon2id$` prefix).
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(passwordHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(passwordHash, plain);
  } catch {
    return false;
  }
}
