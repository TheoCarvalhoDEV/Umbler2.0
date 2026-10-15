import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { BotEdge, BotGraph, BotNode } from '@talk/shared';
import { botRuns, bots, messages } from '../../src/db/schema.js';
import { createBot } from '../../src/bots/repo.js';
import { resumeOnReply, startRun } from '../../src/bots/engine.js';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { createScheduler } from '../../src/bots/scheduler.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;
const HOUR = 60 * MIN;

let ctx: Ctx;
let s: Seeded;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const node = (id: string, type: BotNode['type'], config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}-${sourceHandle}`, source, sourceHandle, target,
});
const say = (text: string) => ({ text, attachment: null, signature: false });

/** inicio → espera (10 min) → depois; with resumeOnReply also espera.replied → respondeu. */
function timerGraph(resumeOnReply: boolean): BotGraph {
  return {
    nodes: [
      node('inicio', 'start_manual'),
      node('espera', 'wait_interval', { mode: 'fixed', amount: 10, unit: 'minutes', resumeOnReply }),
      node('depois', 'send_message', say('Passou o tempo')),
      ...(resumeOnReply ? [node('respondeu', 'send_message', say('Respondeu antes'))] : []),
    ],
    edges: [
      edge('inicio', 'next', 'espera'),
      edge('espera', 'next', 'depois'),
      ...(resumeOnReply ? [edge('espera', 'replied', 'respondeu')] : []),
    ],
  };
}

/** inicio → menu (ask_choice "1: Sim"); opt:1 → escolheu; timeout → sem_resposta when timeoutHours is set. */
function menuGraph(timeoutHours: number | null): BotGraph {
  return {
    nodes: [
      node('inicio', 'start_manual'),
      node('menu', 'ask_choice', { text: 'Escolha uma opção', options: [{ key: '1', label: 'Sim' }], invalidRetries: 1, timeoutHours }),
      node('escolheu', 'send_message', say('Escolheu sim')),
      ...(timeoutHours ? [node('sem_resposta', 'send_message', say('Sem resposta, encerrando'))] : []),
    ],
    edges: [
      edge('inicio', 'next', 'menu'),
      edge('menu', 'opt:1', 'escolheu'),
      ...(timeoutHours ? [edge('menu', 'timeout', 'sem_resposta')] : []),
    ],
  };
}

async function activeBot(graph: BotGraph, name = 'Bot teste') {
  const created = await createBot(ctx.db, { name, graph, valid: true, publish: true, createdBy: null });
  const [row] = await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, created.id)).returning();
  return { botId: row.id, versionId: row.publishedVersionId! };
}

async function openChat() {
  const contactId = await newContact(ctx);
  const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
  return { chatId, contactId };
}

async function startManual(graph: BotGraph) {
  const { botId, versionId } = await activeBot(graph);
  const { chatId, contactId } = await openChat();
  const run = await startRun(ctx, { botId, chatId, entry: 'manual', startedBy: s.admin.id });
  return { botId, versionId, chatId, contactId, runId: run.id };
}

async function runOf(id: string) {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row;
}

function texts(): string[] {
  return ctx.wa.sent.filter((m) => m.method === 'sendText').map((m) => (m.payload as { text: string }).text);
}

/** Stores an inbound text 1 ms after the run started waiting, so it counts as the answer (Review Focus 1). */
async function replyAfterWait(runId: string, chatId: string, body: string): Promise<InboundReply> {
  const { waitingSince } = await runOf(runId);
  const createdAt = new Date(waitingSince!.getTime() + 1);
  const [m] = await ctx.db
    .insert(messages)
    .values({ chatId, channelId: s.channelId, direction: 'in', kind: 'text', body, status: 'sent', sentAt: createdAt, createdAt })
    .returning({ id: messages.id });
  return { messageId: m.id, kind: 'text', body, mediaMime: null, mediaName: null, createdAt };
}

describe('scheduler tick', () => {
  it('resumes a wait_interval timer only once it is due, using the runtime clock by default', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));
    expect((await runOf(runId)).state).toBe('waiting_timer');

    const sched = createScheduler(ctx);
    expect(await sched.tick(new Date(t0.getTime() + 5 * MIN))).toBe(0);
    expect(texts()).toEqual([]);

    ctx.clock.set(new Date(t0.getTime() + 10 * MIN));
    expect(await sched.tick()).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.wakeAt).toBeNull();

    expect(await sched.tick()).toBe(0);
    expect(texts()).toEqual(['Passou o tempo']);
  });

  it('sends a waiting ask_choice down its timeout output when timeout_at passes', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(menuGraph(1));
    const waiting = await runOf(runId);
    expect(waiting.state).toBe('waiting_reply');
    expect(waiting.timeoutAt?.getTime()).toBe(t0.getTime() + HOUR);

    const sched = createScheduler(ctx);
    expect(await sched.tick(new Date(t0.getTime() + HOUR - 1000))).toBe(0);
    expect(await sched.tick(new Date(t0.getTime() + HOUR))).toBe(1);

    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome)).toContain('timeout');
    expect(texts()).toHaveLength(2); // the menu, then the timeout branch
    expect(texts()[1]).toBe('Sem resposta, encerrando');
  });

  it('continues a wait_interval with resumeOnReply through "next" when nobody replies', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(true));
    const waiting = await runOf(runId);
    expect(waiting.state).toBe('waiting_reply');
    expect(waiting.timeoutAt?.getTime()).toBe(t0.getTime() + 10 * MIN);

    expect(await createScheduler(ctx).tick(new Date(t0.getTime() + 10 * MIN))).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });

  it('never wakes a reply wait that has no timeout', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(menuGraph(null));
    expect(await createScheduler(ctx).tick(new Date(t0.getTime() + 365 * 24 * HOUR))).toBe(0);
    expect((await runOf(runId)).state).toBe('waiting_reply');
  });

  it('takes at most 50 due runs per tick, earliest due first', async () => {
    const t0 = ctx.clock.now();
    const { botId, versionId } = await activeBot(timerGraph(false));
    const { chatId, contactId } = await openChat();
    // depth 1: the one-active-run-per-(chat, bot) index covers root runs only, so 51 waits can share one chat
    const rows = await ctx.db
      .insert(botRuns)
      .values(
        Array.from({ length: 51 }, (_, i) => ({
          botId, versionId, chatId, contactId, state: 'waiting_timer' as const,
          currentNodeId: 'espera', waitNodeId: 'espera', depth: 1, wakeAt: new Date(t0.getTime() - i * MIN),
        })),
      )
      .returning({ id: botRuns.id });

    const sched = createScheduler(ctx);
    expect(await sched.tick(t0)).toBe(50);
    expect(texts()).toHaveLength(50);
    const left = await ctx.db.select({ id: botRuns.id }).from(botRuns).where(eq(botRuns.state, 'waiting_timer'));
    expect(left.map((r) => r.id)).toEqual([rows[0].id]); // the latest-due one waits for the next tick

    expect(await sched.tick(t0)).toBe(1);
    expect(await sched.tick(t0)).toBe(0);
    expect(texts()).toHaveLength(51);
  });

  it('never processes a run twice when two ticks overlap', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));
    const due = new Date(t0.getTime() + 10 * MIN);

    const [a, b] = await Promise.all([createScheduler(ctx).tick(due), createScheduler(ctx).tick(due)]);
    expect(a + b).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });

  it('lets a reply and a due timeout race without resuming the run twice', async () => {
    const t0 = ctx.clock.now();
    const { runId, chatId } = await startManual(menuGraph(1));
    const reply = await replyAfterWait(runId, chatId, '1');
    ctx.clock.set(new Date(t0.getTime() + HOUR));

    const [byTick, byReply] = await Promise.all([createScheduler(ctx).tick(), resumeOnReply(ctx, chatId, reply)]);
    expect(byTick + byReply).toBe(1);
    const run = await runOf(runId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome).filter((o) => o === 'opt:1' || o === 'timeout')).toHaveLength(1);
    expect(texts()).toHaveLength(2); // the menu, then exactly one of "Escolheu sim" / "Sem resposta, encerrando"
  });

  it('picks up a due timer after a restart (new ctx and runtime over the same database)', async () => {
    const t0 = ctx.clock.now();
    const { runId } = await startManual(timerGraph(false));

    const clock = createFakeClock(new Date(t0.getTime() + 10 * MIN));
    const restarted = { ...ctx, botRuntime: createBotRuntime({ now: clock.now }) };
    expect(await createScheduler(restarted).tick()).toBe(1);
    expect(texts()).toEqual(['Passou o tempo']);
    expect((await runOf(runId)).state).toBe('finished');
  });
});

describe('scheduler start/stop', () => {
  const flush = () => new Promise<void>((r) => setImmediate(r)); // setImmediate is not faked below

  it('ticks every interval, skips a beat while a tick is running, survives a failed tick and stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sched = createScheduler(ctx, { intervalMs: 1000 });
    let release!: () => void;
    const tick = vi
      .spyOn(sched, 'tick')
      .mockImplementationOnce(() => new Promise<number>((r) => { release = () => r(0); }))
      .mockRejectedValueOnce(Object.assign(new Error('segredo do contato'), { code: '57P01' }))
      .mockResolvedValue(0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    sched.start();
    sched.start();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(1); // the first tick is still running

    release();
    await flush();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2); // this one rejects
    await flush();
    expect(log).toHaveBeenCalledWith('chatbot: falha no relógio', 'Error 57P01');
    expect(JSON.stringify(log.mock.calls)).not.toContain('segredo');

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    await flush();

    sched.stop();
    sched.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('defaults to a 5 s interval', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sched = createScheduler(ctx);
    const tick = vi.spyOn(sched, 'tick').mockResolvedValue(0);
    sched.start();
    vi.advanceTimersByTime(4999);
    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    sched.stop();
  });
});
