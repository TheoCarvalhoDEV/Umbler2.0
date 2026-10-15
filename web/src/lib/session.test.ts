import { expect, it } from 'vitest';
import { sessionChanged } from './auth';

const ev = (newValue: string | null, key = 'talk:session') => ({ key, newValue });

it('reloads only when the session key points to another user', () => {
  expect(sessionChanged(ev('u2:123'), 'u1')).toBe(true);
  expect(sessionChanged(ev('none:123'), 'u1')).toBe(true);
  expect(sessionChanged(ev('u1:123'), 'u2')).toBe(true);
  expect(sessionChanged(ev('u1:123'), 'u1')).toBe(false);
  expect(sessionChanged(ev('none:123'), null)).toBe(false);
  expect(sessionChanged(ev('u1:1'), null)).toBe(true);
  expect(sessionChanged(ev('u2:1', 'other'), 'u1')).toBe(false);
  expect(sessionChanged(ev(null), 'u1')).toBe(false);
});
