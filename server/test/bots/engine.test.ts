import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_LOG_LIMIT, type BlockType, type BotGraph } from '@talk/shared';
import {
  failInterruptedRuns,
  resumeOnReply,
  resumeOnTimer,
  runningRunsForChat,
  startRun,
  stopRun,
  stopRunsForChat,
} from '../../src/bots/engine.js';
import { BlockError, type BlockRegistry, type InboundReply } from '../../src/bots/registry.js';
import { createBot, insertBotVersion, type BotRunRow } from '../../src/bots/repo.js';
import { createBotRuntime, createFakeClock } from '../../src/bots/runtime.js';
import { botRuns, bots, chats, contacts } from '../../src/db/schema.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf, insertChat, statusOf } from '../inbox/fixtures.js';

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

// ---------- stub blocks: real type names, fake behavior ----------
const HOUR = 3_600_000;
const calls: string[] = [];
const stubs: BlockRegistry = {
  start_channel: { type: 'start_channel', run: async () => ({ next: 'next' }) },
  start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) },
  note: { type: 'note', run: async (_c, _r, n) => { calls.push(n.id); return { next: 'next' }; } },
  condition: { type: 'condition', run: async () => ({ next: 'yes' }) },
  ask_input: {
    type: 'ask_input',
    run: async (c, _r, n) => {
      calls.push(`ask:${n.id}`);
      const h = Number(n.config.timeoutHours ?? 0);
      return { wait: 'reply', timeoutAt: h > 0 ? new Date(c.now.getTime() + h * HOUR) : null };
    },
    resume: async (_c, run, n, ev) => {
      if (ev.kind === 'timeout') return { next: 'timeout' };
      if (ev.kind !== 'reply') throw new BlockError('Evento inesperado');
      run.vars[n.name ?? n.id] = { raw: ev.reply.body ?? '', value: ev.reply.body ?? '' };
      return { next: 'next' };
    },
  },
  wait_interval: {
    type: 'wait_interval',
    run: async (c) => ({ wait: 'timer', wakeAt: new Date(c.now.getTime() + 60_000) }),
    resume: async () => ({ next: 'next' }),
  },
  transfer_sector: { type: 'transfer_sector', run: async () => { throw new BlockError('Setor inexistente'); } },
  privacy: { type: 'privacy', run: async () => { throw new Error('detalhe interno 123.456.789-00'); } },
  call_flow: {
    type: 'call_flow',
    run: async (c, _r, n) => {
      const child = await c.startChild(String(n.config.botId));
      if (!n.config.continueAfter) return { end: 'finished' };
      if (child.state === 'finished') return { next: 'next' };
      if (child.state === 'failed' || child.state === 'stopped') throw new BlockError('O fluxo acionado não terminou');
      return { wait: 'flow' };
    },
    resume: async (_c, _r, _n, ev) => {
      if (ev.kind === 'flow' && ev.outcome === 'finished') return { next: 'next' };
      throw new BlockError('O fluxo acionado não terminou');
    },
  },
};

type N = [id: string, type: BlockType, config?: Record<string, unknown>];
function graph(nodes: N[], edges: Array<[source: string, handle: string, target: string]>): BotGraph {
  return {
    nodes: nodes.map(([id, type, config = {}]) => ({ id, type, name: id, position: { x: 0, y: 0 }, config })),
    edges: edges.map(([source, sourceHandle, target], i) => ({ id: `e${i}`, source, sourceHandle, target })),
  };
}
const askGraph = () =>
  graph([['inicio', 'start_channel'], ['cpf', 'ask_input'], ['fim', 'note']], [['inicio', 'next', 'cpf'], ['cpf', 'next', 'fim']]);
const timerGraph = () =>
  graph([['inicio', 'start_channel'], ['espera', 'wait_interval'], ['depois', 'note']], [['inicio', 'next', 'espera'], ['espera', 'next', 'depois']]);

describe('bot engine', () => {
  let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
  let s: Seeded;
  let chatId: string;

  beforeEach(async () => {
    calls.length = 0;
    ctx = await makeTestCtx();
    ctx.botRuntime = createBotRuntime({ now: ctx.clock.now, registry: stubs });
    s = await seedBasics(ctx);
    chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector });
  });

  async function activeBot(name: string, g: BotGraph): Promise<string> {
    const bot = await createBot(ctx.db, { name, graph: g, valid: true, publish: true, createdBy: null });
    await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
    return bot.id;
  }
  async function runRow(id: string): Promise<BotRunRow> {
    const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
    return row;
  }
  const reply = (body: string | null, createdAt: Date): InboundReply => ({
    messageId: randomUUID(), kind: body === null ? 'sticker' : 'text', body, mediaMime: null, mediaName: null, createdAt,
  });
  /** A reply stored right after the run started waiting. */
  const after = (r: BotRunRow) => new Date(r.waitingSince!.getTime() + 1);
  const start = (botId: string) => startRun(ctx, { botId, chatId, entry: 'channel', startedBy: null });

  async function startParentAndChild(): Promise<{ parent: BotRunRow; child: BotRunRow; parentId: string; childId: string }> {
    const childId = await activeBot('Filho', graph(
      [['inicio', 'start_manual'], ['pergunta', 'ask_input'], ['filho_fim', 'note']],
      [['inicio', 'next', 'pergunta'], ['pergunta', 'next', 'filho_fim']],
    ));
    const parentId = await activeBot('Pai', graph(
      [['inicio', 'start_channel'], ['sub', 'call_flow', { botId: childId, continueAfter: true }], ['volta', 'note']],
      [['inicio', 'next', 'sub'], ['sub', 'next', 'volta']],
    ));
    const parent = await start(parentId);
    const child = (await runningRunsForChat(ctx.db, chatId)).find((r) => r.botId === childId)!;
    return { parent, child, parentId, childId };
  }

  it('runs blocks in order, saves each step and finishes on an unconnected output', async () => {
    const botId = await activeBot('Simples', graph(
      [['inicio', 'start_channel'], ['a', 'note'], ['b', 'note']],
      [['inicio', 'next', 'a'], ['a', 'next', 'b']],
    ));
    const [before] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    const run = await start(botId);
    expect(run.state).toBe('finished');
    expect(run.finishedAt).toEqual(ctx.clock.now());
    expect(run.steps.map((st) => [st.node, st.outcome])).toEqual([['inicio', 'next'], ['a', 'next'], ['b', 'next']]);
    expect(run.steps[0].at).toBe(ctx.clock.now().toISOString());
    expect(calls).toEqual(['a', 'b']);
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    expect(bot.runCount).toBe(1);
    expect(bot.updatedAt).toEqual(before.updatedAt); // a run is not an edit of the bot
    const events = await eventsOf(ctx, chatId);
    expect(events.map((e) => e.kind)).toEqual(['bot_started', 'bot_finished']);
    expect(events[1]).toMatchObject({ authorId: null, data: { botId, botName: 'Simples', runId: run.id } });
    expect(ctx.hub.events.filter((e) => e.type === 'chat' && e.chatId === chatId)).toHaveLength(2);
  });

  it('waits for a reply, keeps the answer in vars and resumes with it', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    expect(waiting).toMatchObject({ state: 'waiting_reply', waitNodeId: 'cpf', currentNodeId: 'cpf', timeoutAt: null, wakeAt: null });
    expect(waiting.waitingSince).toBeInstanceOf(Date);
    expect(await resumeOnReply(ctx, chatId, reply('123', after(waiting)))).toBe(1);
    const done = await runRow(waiting.id);
    expect(done.state).toBe('finished');
    expect(done.vars).toEqual({ cpf: { raw: '123', value: '123' } });
    expect(calls).toEqual(['ask:cpf', 'fim']);
  });

  it('ignores a reply that was stored before the wait began', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    const early = new Date(waiting.waitingSince!.getTime() - 1); // "preciso de ajuda" arrived while the menu was being sent
    expect(await resumeOnReply(ctx, chatId, reply('preciso de ajuda', early))).toBe(0);
    expect((await runRow(waiting.id)).state).toBe('waiting_reply');
    expect(calls).toEqual(['ask:cpf']);
  });

  it('serializes two simultaneous replies: the second predates the next question and is ignored', async () => {
    const botId = await activeBot('Duas', graph(
      [['inicio', 'start_channel'], ['a', 'ask_input'], ['b', 'ask_input']],
      [['inicio', 'next', 'a'], ['a', 'next', 'b']],
    ));
    const waiting = await start(botId);
    const at = waiting.waitingSince!;
    const [n1, n2] = await Promise.all([
      resumeOnReply(ctx, chatId, reply('primeira', at)),
      resumeOnReply(ctx, chatId, reply('segunda', at)),
    ]);
    expect(n1 + n2).toBe(1);
    const run = await runRow(waiting.id);
    expect(run).toMatchObject({ state: 'waiting_reply', waitNodeId: 'b' });
    expect(run.vars).toEqual({ a: { raw: 'primeira', value: 'primeira' } });
  });

  it('times out a reply wait from the clock and follows the timeout output', async () => {
    const botId = await activeBot('Prazo', graph(
      [['inicio', 'start_channel'], ['q', 'ask_input', { timeoutHours: 1 }], ['sem_resposta', 'note']],
      [['inicio', 'next', 'q'], ['q', 'timeout', 'sem_resposta']],
    ));
    const waiting = await start(botId);
    expect(waiting.timeoutAt).toEqual(new Date(ctx.clock.now().getTime() + HOUR));
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull(); // not due yet
    ctx.clock.advance(HOUR);
    const done = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(done?.state).toBe('finished');
    expect(calls).toEqual(['ask:q', 'sem_resposta']);
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull(); // already finished
  });

  it('sleeps on a timer and continues when it is due', async () => {
    const waiting = await start(await activeBot('Espera', timerGraph()));
    expect(waiting).toMatchObject({ state: 'waiting_timer', waitNodeId: 'espera', wakeAt: new Date(ctx.clock.now().getTime() + 60_000) });
    expect(await resumeOnTimer(ctx, waiting.id, ctx.clock.now())).toBeNull();
    ctx.clock.advance(60_000);
    const done = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(done).toMatchObject({ state: 'finished', wakeAt: null });
    expect(calls).toEqual(['depois']);
  });

  it('stops instead of sending when the chat was closed while waiting', async () => {
    const waiting = await start(await activeBot('Espera', timerGraph()));
    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));
    ctx.clock.advance(60_000);
    const run = await resumeOnTimer(ctx, waiting.id, ctx.clock.now());
    expect(run).toMatchObject({ state: 'stopped', error: null, wakeAt: null });
    expect(calls).toEqual([]);
    expect(ctx.wa.sent).toEqual([]);
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped).toMatchObject({ authorId: null, data: { reason: 'chat_closed', by: null } });
  });

  it('stops with contact_blocked when the contact was blocked while waiting', async () => {
    const waiting = await start(await activeBot('Pergunta', askGraph()));
    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    await ctx.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, chat.contactId));
    expect(await resumeOnReply(ctx, chatId, reply('123', after(waiting)))).toBe(1);
    expect((await runRow(waiting.id)).state).toBe('stopped');
    expect(calls).toEqual(['ask:cpf']);
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data).toMatchObject({ reason: 'contact_blocked' });
  });

  it('follows the error output when a block throws and the output is connected', async () => {
    const botId = await activeBot('Plano B', graph(
      [['inicio', 'start_channel'], ['setor', 'transfer_sector'], ['plano_b', 'note']],
      [['inicio', 'next', 'setor'], ['setor', 'error', 'plano_b']],
    ));
    const run = await start(botId);
    expect(run.state).toBe('finished');
    expect(run.steps.map((st) => st.outcome)).toEqual(['next', 'error', 'next']);
    expect(calls).toEqual(['plano_b']);
    expect((await eventsOf(ctx, chatId)).map((e) => e.kind)).toEqual(['bot_started', 'bot_finished']);
  });

  it('fails with the BlockError message when the error output is not connected', async () => {
    const botId = await activeBot('Sem plano', graph(
      [['inicio', 'start_channel'], ['setor', 'transfer_sector']],
      [['inicio', 'next', 'setor']],
    ));
    const run = await start(botId);
    expect(run).toMatchObject({ state: 'failed', error: 'Setor inexistente' });
    expect(run.steps.map((st) => [st.node, st.outcome])).toEqual([['inicio', 'next'], ['setor', 'failed']]);
    const failed = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_failed');
    expect(failed?.data).toMatchObject({ botName: 'Sem plano', reason: 'Setor inexistente' });
  });

  it('hides an unexpected error behind the block label and never logs its message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const botId = await activeBot('Quebra', graph(
        [['inicio', 'start_channel'], ['priv', 'privacy']],
        [['inicio', 'next', 'priv']],
      ));
      const run = await start(botId);
      expect(run).toMatchObject({ state: 'failed', error: 'Erro inesperado no bloco "Privacidade"' });
      expect(spy).toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain('123.456.789-00');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails a run that takes 50 steps without waiting', async () => {
    const botId = await activeBot('Laço', graph(
      [['inicio', 'start_channel'], ['x', 'condition'], ['y', 'condition']],
      [['inicio', 'next', 'x'], ['x', 'yes', 'y'], ['y', 'yes', 'x']],
    ));
    const run = await start(botId);
    expect(run).toMatchObject({ state: 'failed', error: 'Limite de 50 passos sem espera (possível laço)' });
    expect(run.steps).toHaveLength(STEP_LOG_LIMIT);
  });

  it('fails on a block type without a definition', async () => {
    ctx.botRuntime = createBotRuntime({ now: ctx.clock.now, registry: { ...stubs, tags: undefined } });
    const botId = await activeBot('Sem bloco', graph([['inicio', 'start_channel'], ['et', 'tags']], [['inicio', 'next', 'et']]));
    expect(await start(botId)).toMatchObject({ state: 'failed', error: 'Bloco não suportado' });
  });

  it('refuses a duplicate start, a paused bot and a missing start type', async () => {
    const botId = await activeBot('Pergunta', askGraph());
    await start(botId);
    expect(await statusOf(start(botId))).toBe(409);
    expect(await statusOf(startRun(ctx, { botId, chatId, entry: 'manual', startedBy: s.admin.id }))).toBe(400);
    const paused = await createBot(ctx.db, { name: 'Pausado', graph: askGraph(), valid: true, publish: true, createdBy: null });
    expect(await statusOf(start(paused.id))).toBe(400);
    expect(await runningRunsForChat(ctx.db, chatId)).toHaveLength(1);
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    expect(bot.runCount).toBe(1);
  });

  it('keeps a run on the version it started with, even after the bot is paused', async () => {
    const botId = await activeBot('Versão', askGraph());
    const waiting = await start(botId);
    const v2 = await insertBotVersion(ctx.db, {
      botId,
      graph: graph([['inicio', 'start_channel'], ['cpf', 'ask_input'], ['outro', 'note']], [['inicio', 'next', 'cpf'], ['cpf', 'next', 'outro']]),
      valid: true,
      createdBy: null,
    });
    await ctx.db.update(bots).set({ publishedVersionId: v2.id, status: 'paused' }).where(eq(bots.id, botId));
    await resumeOnReply(ctx, chatId, reply('x', after(waiting)));
    expect(calls).toEqual(['ask:cpf', 'fim']);
    const otherChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector });
    expect(await statusOf(startRun(ctx, { botId, chatId: otherChat, entry: 'channel', startedBy: null }))).toBe(400);
  });

  it('runs a called flow and resumes the caller when the child finishes', async () => {
    const { parent, child, parentId, childId } = await startParentAndChild();
    expect(parent.state).toBe('waiting_flow');
    expect(child).toMatchObject({ parentRunId: parent.id, depth: 1, state: 'waiting_reply' });
    expect(await resumeOnReply(ctx, chatId, reply('oi', after(child)))).toBe(1); // the waiting_flow parent is skipped
    expect((await runRow(child.id)).state).toBe('finished');
    expect((await runRow(parent.id)).state).toBe('finished');
    expect(calls).toEqual(['ask:pergunta', 'filho_fim', 'volta']);
    const counts = await ctx.db.select({ id: bots.id, runCount: bots.runCount }).from(bots);
    expect(Object.fromEntries(counts.map((b) => [b.id, b.runCount]))).toEqual({ [parentId]: 1, [childId]: 1 });
  });

  it('fails call_flow past 5 chained levels', async () => {
    const botId = await activeBot('Recursivo', graph([['inicio', 'start_channel']], []));
    const v = await insertBotVersion(ctx.db, {
      botId,
      graph: graph([['inicio', 'start_channel'], ['de_novo', 'call_flow', { botId, continueAfter: true }]], [['inicio', 'next', 'de_novo']]),
      valid: true,
      createdBy: null,
    });
    await ctx.db.update(bots).set({ publishedVersionId: v.id }).where(eq(bots.id, botId));
    const root = await start(botId);
    const all = await ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId)).orderBy(asc(botRuns.depth));
    expect(all.map((r) => [r.depth, r.state])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
    expect(all[4].error).toBe('Limite de 5 fluxos encadeados');
    expect(root).toMatchObject({ state: 'failed', error: 'O fluxo acionado não terminou' });
  });

  it('stopRun stops the whole chain, is idempotent, and a stopped run ignores later replies', async () => {
    const { parent, child } = await startParentAndChild();
    const stopped = await stopRun(ctx, child.id, { userId: s.admin.id, reason: 'manual' });
    expect(stopped).toMatchObject({ state: 'stopped', waitingSince: null });
    expect((await runRow(parent.id)).state).toBe('stopped');
    const evs = (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped');
    expect(evs).toHaveLength(2);
    for (const e of evs) expect(e).toMatchObject({ authorId: s.admin.id, data: { reason: 'manual', by: s.admin.id } });
    expect(await resumeOnReply(ctx, chatId, reply('oi', after(child)))).toBe(0);
    expect(await runningRunsForChat(ctx.db, chatId)).toEqual([]);
    expect((await stopRun(ctx, child.id, { userId: s.admin.id, reason: 'manual' })).state).toBe('stopped');
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped')).toHaveLength(2);
    expect(await statusOf(stopRun(ctx, randomUUID(), { userId: null, reason: 'manual' }))).toBe(404);
  });

  it('stopRunsForChat stops every running bot of the chat except the excepted runs', async () => {
    const a = await start(await activeBot('A', askGraph()));
    const b = await start(await activeBot('B', askGraph()));
    const stopped = await stopRunsForChat(ctx, chatId, { userId: null, reason: 'chat_closed' }, { exceptRunIds: [b.id] });
    expect(stopped.map((r) => r.id)).toEqual([a.id]);
    expect((await runningRunsForChat(ctx.db, chatId)).map((r) => r.id)).toEqual([b.id]);
  });

  it('failInterruptedRuns also fails a caller left waiting for an interrupted child', async () => {
    const { parent, child } = await startParentAndChild();
    await ctx.db.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, child.id)); // the server died mid-step of the child
    expect(await failInterruptedRuns(ctx.db)).toBe(2);
    expect(await runRow(child.id)).toMatchObject({ state: 'failed', error: 'Interrompido por reinício do servidor' });
    expect(await runRow(parent.id)).toMatchObject({ state: 'failed', error: 'Interrompido por reinício do servidor' });
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_failed')).toHaveLength(2);
    expect(await runningRunsForChat(ctx.db, chatId)).toEqual([]);
  });
});
