// Spec 2026-10-20 agendamentos: one module, two beats. Scheduled messages every 15 s (a minute-precise time goes out within
// seconds), the automatic rules every minute. A beat that is still draining makes the next one skip.
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { deliverDueScheduled } from './delivery.js';
import { runAutoRules } from './rules.js';

export function createAutomationWorker(ctx: AppCtx, opts: { scheduledMs?: number; rulesMs?: number } = {}) {
  const timers: Array<ReturnType<typeof setInterval>> = [];

  function every(ms: number, label: string, beat: () => Promise<unknown>): void {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      beat()
        .catch((err: unknown) => console.error(label, errorTag(err)))
        .finally(() => {
          busy = false;
        });
    }, ms);
    timer.unref();
    timers.push(timer);
  }

  return {
    start(): void {
      if (timers.length) return;
      every(opts.scheduledMs ?? 15_000, 'scheduled messages beat failed', () => deliverDueScheduled(ctx));
      every(opts.rulesMs ?? 60_000, 'auto rules beat failed', () => runAutoRules(ctx));
    },
    stop(): void {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}
