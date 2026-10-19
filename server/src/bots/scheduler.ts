import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import { botRuns } from '../db/schema.js';
import { resumeOnTimer } from './engine.js';

export interface Scheduler {
  tick(now?: Date): Promise<number>;
  start(): void;
  stop(): void;
}

const TICK_LIMIT = 50;

/** Error name and pg code (or HTTP status of a GatewayError) only: never the message, which may quote contact data. */
export function errorTag(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; status?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  if (typeof e?.code === 'string') return `${name} ${e.code}`;
  return typeof e?.status === 'number' ? `${name} ${e.status}` : name;
}

export function createScheduler(ctx: AppCtx, opts: { intervalMs?: number } = {}): Scheduler {
  const intervalMs = opts.intervalMs ?? 5000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let busy = false;

  const scheduler: Scheduler = {
    async tick(now: Date = ctx.botRuntime.now()): Promise<number> {
      // Claim the due ids in a short tx; SKIP LOCKED passes over runs a reply/timer is resuming right now.
      // The locks end at commit, so resumeOnTimer's own locked re-check is what stops a run resuming twice.
      const ids = await ctx.db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: botRuns.id })
          .from(botRuns)
          .where(
            or(
              and(eq(botRuns.state, 'waiting_timer'), lte(botRuns.wakeAt, now)),
              and(eq(botRuns.state, 'waiting_reply'), lte(botRuns.timeoutAt, now)),
            ),
          )
          .orderBy(sql`case when ${botRuns.state} = 'waiting_timer' then ${botRuns.wakeAt} else ${botRuns.timeoutAt} end`, botRuns.id)
          .limit(TICK_LIMIT)
          .for('update', { skipLocked: true });
        return rows.map((r) => r.id);
      });

      let resumed = 0;
      for (const id of ids) {
        try {
          if (await resumeOnTimer(ctx, id, now)) resumed += 1;
        } catch (err) {
          // one broken run must not hold back the rest of the batch
          console.error('chatbot: falha ao retomar execução', id, errorTag(err));
        }
      }
      return resumed;
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (busy) return; // a slow tick is still draining; the next beat picks up whatever is left
        busy = true;
        scheduler
          .tick()
          .catch((err: unknown) => console.error('chatbot: falha no relógio', errorTag(err)))
          .finally(() => {
            busy = false;
          });
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return scheduler;
}
