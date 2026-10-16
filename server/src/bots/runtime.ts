import { defaultRegistry, type BlockRegistry } from './registry.js';

export interface BotRuntime {
  now(): Date;
  random(): number; // [0,1); distribute
  withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T>; // in-process FIFO mutex per chat; NOT re-entrant
  registry: BlockRegistry;
}

export function createBotRuntime(opts: { now?: () => Date; random?: () => number; registry?: BlockRegistry } = {}): BotRuntime {
  // ponytail: in-process lock — single server process; use pg_advisory_xact_lock if the app ever runs >1 instance.
  const tails = new Map<string, Promise<unknown>>();
  return {
    now: opts.now ?? (() => new Date()),
    random: opts.random ?? Math.random,
    registry: { ...defaultRegistry, ...opts.registry },
    async withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
      const result = (tails.get(chatId) ?? Promise.resolve()).then(fn);
      const tail = result.catch(() => undefined); // a failed holder must not block the queue
      tails.set(chatId, tail);
      try {
        return await result;
      } finally {
        if (tails.get(chatId) === tail) tails.delete(chatId);
      }
    },
  };
}

export interface FakeClock { now(): Date; set(d: Date): void; advance(ms: number): void }

/** Default 2026-10-14T13:00:00Z = Wednesday 09:00 America/Cuiaba. Closures, not `this`: `clock.now` is passed unbound. */
export function createFakeClock(start: Date = new Date('2026-10-14T13:00:00Z')): FakeClock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => { t = d.getTime(); },
    advance: (ms) => { t += ms; },
  };
}
