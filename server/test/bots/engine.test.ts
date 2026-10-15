import { describe, expect, it } from 'vitest';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { makeTestCtx } from '../helpers.js';

describe('bot runtime', () => {
  it('runs callbacks for the same chat one at a time, other chats in parallel, and survives a failure', async () => {
    const rt = createBotRuntime();
    const order: string[] = [];
    let release!: () => void;
    const first = rt.withChatLock('c1', async () => {
      order.push('a:start');
      await new Promise<void>((r) => { release = r; });
      order.push('a:end');
    });
    const failing = rt.withChatLock('c1', async () => { order.push('b'); throw new Error('x'); }).catch((e: Error) => e.message);
    const third = rt.withChatLock('c1', async () => { order.push('c'); return 3; });
    await rt.withChatLock('c2', async () => { order.push('other'); });
    expect(order).toEqual(['a:start', 'other']);
    release();
    await first;
    expect(await failing).toBe('x');
    expect(await third).toBe(3);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b', 'c']);
  });

  it('starts the fake clock on Wednesday 09:00 in Cuiabá and moves it only when told', () => {
    const clock = createFakeClock();
    expect(clock.now().toISOString()).toBe('2026-10-14T13:00:00.000Z');
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-14T13:01:00.000Z');
    clock.set(new Date('2026-10-15T00:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-15T00:00:00.000Z');
  });

  it('merges an injected registry over the default one, and makeTestCtx wires the fake clock', async () => {
    const note = { type: 'note' as const, run: async () => ({ next: 'next' }) };
    expect(createBotRuntime({ registry: { note } }).registry.note).toBe(note);
    const ctx = await makeTestCtx();
    ctx.clock.advance(5_000);
    expect(ctx.botRuntime.now()).toEqual(ctx.clock.now());
  });
});
