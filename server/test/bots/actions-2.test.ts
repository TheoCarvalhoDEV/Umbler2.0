import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLOCK_TYPES, type BlockType, type BotEdge, type BotNode } from '@talk/shared';
import { botRuns, bots, channels, chats, contacts, messages, settings, users } from '../../src/db/schema.js';
import { createBot, type BotRunRow } from '../../src/bots/repo.js';
import { resumeOnReply, startRun } from '../../src/bots/engine.js';
import { defaultRegistry, type BotCtx, type InboundReply } from '../../src/bots/registry.js';
import { startBlocks } from '../../src/bots/blocks/start.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let botSeq = 0;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
});

// Node id === node name, so step assertions work whichever one the engine logs.
const node = (id: string, type: BlockType, config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}:${sourceHandle}`, source, sourceHandle, target,
});
const ASK = { text: 'Confirma?', options: [{ key: '1', label: 'Sim' }], invalidRetries: 0, timeoutHours: null };

/** start_manual 'inicio' → nodes[0]; published and active. Returns the bot id. */
async function makeBot(nodes: BotNode[], edges: BotEdge[] = []): Promise<string> {
  const graph = {
    nodes: [node('inicio', 'start_manual'), ...nodes],
    edges: [...(nodes[0] ? [edge('inicio', 'next', nodes[0].id)] : []), ...edges],
  };
  const bot = await createBot(ctx.db, { name: `Bot ${++botSeq}`, graph, valid: true, publish: true, createdBy: null, manualStart: true });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  return bot.id;
}

async function openChat(f: { ownerId?: string | null; sectorId?: string; contactId?: string; channelId?: string; private?: boolean } = {}) {
  const contactId = f.contactId ?? (await newContact(ctx, { name: 'Maria Souza' }));
  const chatId = await insertChat(ctx, {
    channelId: f.channelId ?? s.channelId, sectorId: f.sectorId ?? s.sectorA, contactId,
    ownerId: f.ownerId ?? null, private: f.private ?? false,
  });
  return { chatId, contactId };
}

async function runRow(id: string): Promise<BotRunRow> {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row;
}

async function runBot(botId: string, chatId: string): Promise<BotRunRow> {
  const started = await startRun(ctx, { botId, chatId, entry: 'manual', startedBy: null });
  return runRow(started.id);
}

async function chatRow(id: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
  return row;
}

const notes = async (chatId: string) =>
  (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_note').map((e) => e.data.text);

const sentTexts = () =>
  ctx.wa.sent.filter((m) => m.method === 'sendText').map((m) => (m.payload as { text: string }).text);

/** Stores an inbound text and returns it as the engine's InboundReply. */
async function reply(chatId: string, body: string): Promise<InboundReply> {
  const [m] = await ctx.db.insert(messages).values({
    chatId, channelId: s.channelId, direction: 'in', kind: 'text', body, status: 'sent', sentAt: new Date(),
    // A reply counts only at/after bot_runs.waiting_since (DB clock_timestamp, microseconds); +1 s keeps a
    // same-millisecond JS Date from landing just before it.
    createdAt: new Date(Date.now() + 1000),
  }).returning();
  return { messageId: m.id, kind: 'text', body, mediaMime: null, mediaName: null, createdAt: m.createdAt };
}

describe('start and utility blocks', () => {
  it('start_channel and start_manual continue on next; sticky_note never runs', async () => {
    const fake = {} as BotCtx;
    const run = {} as BotRunRow;
    expect(await startBlocks.start_channel!.run(fake, run, node('a', 'start_channel'))).toEqual({ next: 'next' });
    expect(await startBlocks.start_manual!.run(fake, run, node('b', 'start_manual'))).toEqual({ next: 'next' });
    expect(await startBlocks.sticky_note!.run(fake, run, node('c', 'sticky_note', { text: 'lembrete', color: 'yellow' })))
      .toEqual({ end: 'failed', error: 'Anotação não executa' });
  });

  it('a manual start runs through start_manual into the next block', async () => {
    const { chatId } = await openChat();
    const botId = await makeBot([node('ola', 'note', { text: 'começou' })]);
    const run = await runBot(botId, chatId);
    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['começou']);
  });
});

describe('close_chat', () => {
  it('sends the settings closing message as the bot, closes the chat and stops the other bots', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Obrigado pelo contato!' });
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const waiting = await runBot(await makeBot([node('pergunta', 'ask_choice', ASK)]), chatId);
    expect(waiting.state).toBe('waiting_reply');
    const closer = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true })]);
    ctx.hub.events.length = 0;

    const run = await runBot(closer, chatId);

    expect(run.state).toBe('finished');
    expect(await chatRow(chatId)).toMatchObject({ state: 'closed', waiting: false, triagePending: false });
    expect(sentTexts().at(-1)).toBe('Obrigado pelo contato!');
    const [msg] = await ctx.db.select().from(messages).where(and(eq(messages.chatId, chatId), eq(messages.botRunId, run.id)));
    expect(msg).toMatchObject({ body: 'Obrigado pelo contato!', authorId: null, direction: 'out' });
    const closed = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'closed');
    expect(closed).toMatchObject({ authorId: null, data: { closingMessageSent: true, botId: closer, runId: run.id } });
    expect(closed?.data.botName).toMatch(/^Bot /);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect((await runRow(waiting.id)).state).toBe('stopped');
    const stopped = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data.reason).toBe('chat_closed');
  });

  it('renders its own closing text, and sends nothing when sendClosingMessage is off', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Texto das configurações' });
    const own = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true, closingText: 'Até logo, {{contato.primeiro_nome}}!' })]);
    const silent = await makeBot([node('fim', 'close_chat', { sendClosingMessage: false })]);
    const a = await openChat();
    const b = await openChat();

    await runBot(own, a.chatId);
    await runBot(silent, b.chatId);

    expect(sentTexts()).toEqual(['Até logo, Maria!']);
    expect((await chatRow(b.chatId)).state).toBe('closed');
    const closedB = (await eventsOf(ctx, b.chatId)).find((e) => e.kind === 'closed');
    expect(closedB?.data.closingMessageSent).toBe(false);
  });

  it('keeps the chat open and fails the run when the closing message cannot be sent', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Obrigado!' });
    const { chatId } = await openChat();
    const botId = await makeBot([node('fim', 'close_chat', { sendClosingMessage: true })]);
    ctx.wa.failNext();

    const run = await runBot(botId, chatId);

    expect(run).toMatchObject({ state: 'failed', error: 'Mensagem de encerramento não enviada' });
    expect((await chatRow(chatId)).state).toBe('open');
  });
});
describe('registry', () => {
  it('has a definition for every block type', () => {
    expect(BLOCK_TYPES.filter((t) => !defaultRegistry[t])).toEqual([]);
  });
});

describe('transfer_sector', () => {
  it('moves the chat as the bot, keeps the owner, records bot_transferred and publishes', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const botId = await makeBot([node('mover', 'transfer_sector', { sectorId: s.sectorB, onlyIfAgentAllowed: false })]);
    ctx.hub.events.length = 0;

    const run = await runBot(botId, chatId);

    expect(run.state).toBe('finished');
    expect(await chatRow(chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: s.agentA.id, triagePending: false });
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_transferred');
    expect(ev).toMatchObject({
      authorId: null,
      data: { botId, runId: run.id, fromSectorId: s.sectorA, toSectorId: s.sectorB, fromOwnerId: s.agentA.id, toOwnerId: s.agentA.id },
    });
    expect(ev?.data.botName).toMatch(/^Bot /);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('onlyIfAgentAllowed clears an owner outside the destination and keeps one inside it', async () => {
    const botId = await makeBot([node('mover', 'transfer_sector', { sectorId: s.sectorB, onlyIfAgentAllowed: true })]);
    const outside = await openChat({ ownerId: s.agentA.id, private: true }); // Ana is only in sector A
    const inside = await openChat({ ownerId: s.agentB.id });                  // Bruno is in sector B

    await runBot(botId, outside.chatId);
    await runBot(botId, inside.chatId);

    expect(await chatRow(outside.chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: null, private: false });
    expect(await chatRow(inside.chatId)).toMatchObject({ sectorId: s.sectorB, ownerId: s.agentB.id });
  });

  it('a missing sector takes the error edge, or fails the run without one', async () => {
    const missing = crypto.randomUUID();
    const withEdge = await makeBot(
      [node('mover', 'transfer_sector', { sectorId: missing, onlyIfAgentAllowed: false }), node('falha', 'note', { text: 'sem setor' })],
      [edge('mover', 'error', 'falha')],
    );
    const withoutEdge = await makeBot([node('mover', 'transfer_sector', { sectorId: missing, onlyIfAgentAllowed: false })]);
    const a = await openChat();
    const b = await openChat();

    const handled = await runBot(withEdge, a.chatId);
    const failed = await runBot(withoutEdge, b.chatId);

    expect(handled.state).toBe('finished');
    expect(handled.steps).toContainEqual(expect.objectContaining({ node: 'mover', outcome: 'error' }));
    expect(await notes(a.chatId)).toEqual(['sem setor']);
    expect(failed).toMatchObject({ state: 'failed', error: 'Setor não encontrado' });
    expect((await chatRow(b.chatId)).sectorId).toBe(s.sectorA);
  });
});

describe('transfer_agent', () => {
  it('specific takes the first active user in list order', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentA.id));
    const { chatId } = await openChat();
    const botId = await makeBot([node('agente', 'transfer_agent', { rule: 'specific', userIds: [s.agentA.id, s.agentB.id], sectorIds: [] })]);

    await runBot(botId, chatId);

    expect(await chatRow(chatId)).toMatchObject({ ownerId: s.agentB.id, sectorId: s.sectorA });
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_transferred');
    expect(ev?.data).toMatchObject({ fromOwnerId: null, toOwnerId: s.agentB.id, toSectorId: s.sectorA });
  });

  it('least_busy picks the fewest open chats in the sectors, ties by name, and fails with no candidate', async () => {
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id });
    await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id });
    for (let i = 0; i < 3; i++) {
      await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, state: 'closed' }); // closed: not counted
    }
    const botId = await makeBot([node('agente', 'transfer_agent', { rule: 'least_busy', userIds: [], sectorIds: [s.sectorA, s.sectorB] })]);
    const first = await openChat({ sectorId: s.defaultSector });
    const second = await openChat({ sectorId: s.defaultSector });

    await runBot(botId, first.chatId);  // Ana 2 open, Bruno 1 → Bruno (now 2)
    await runBot(botId, second.chatId); // 2 × 2 → "Ana Financeiro" before "Bruno Jurídico"

    expect((await chatRow(first.chatId)).ownerId).toBe(s.agentB.id);
    expect((await chatRow(second.chatId)).ownerId).toBe(s.agentA.id);

    const nobody = await makeBot([node('agente', 'transfer_agent', { rule: 'least_busy', userIds: [], sectorIds: [s.defaultSector] })]);
    const third = await openChat();
    expect(await runBot(nobody, third.chatId)).toMatchObject({ state: 'failed', error: 'Nenhum atendente disponível' });
  });
});

describe('privacy', () => {
  it('makes an owned chat private and public again, as the bot', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const lock = await makeBot([node('privar', 'privacy', { mode: 'private' })]);
    const unlock = await makeBot([node('abrir', 'privacy', { mode: 'public' })]);

    await runBot(lock, chatId);
    expect((await chatRow(chatId)).private).toBe(true);
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'privacy_changed');
    expect(ev).toMatchObject({ authorId: null, data: { private: true, botId: lock } });

    await runBot(unlock, chatId);
    expect((await chatRow(chatId)).private).toBe(false);
  });

  it('fails when making a chat without owner private', async () => {
    const { chatId } = await openChat();
    const botId = await makeBot([node('privar', 'privacy', { mode: 'private' })]);
    expect(await runBot(botId, chatId)).toMatchObject({ state: 'failed', error: 'A conversa não tem atendente' });
    expect((await chatRow(chatId)).private).toBe(false);
  });
});

describe('notify_agent', () => {
  it('notifies the owner with rendered title and text', async () => {
    const { chatId } = await openChat({ ownerId: s.agentA.id });
    const botId = await makeBot([node('aviso', 'notify_agent', {
      title: 'Nova conversa', text: 'Nova conversa de {{contato.nome}}', target: 'owner', userIds: [],
    })]);
    const spy = vi.spyOn(ctx.hub, 'publishNotification');

    const run = await runBot(botId, chatId);

    expect(run.state).toBe('finished');
    expect(ctx.hub.events.filter((e) => e.type === 'notification')).toEqual([{ type: 'notification', chatId, userId: s.agentA.id }]);
    expect(spy).toHaveBeenCalledWith(chatId, [s.agentA.id], {
      id: expect.any(String), chatId, title: 'Nova conversa', text: 'Nova conversa de Maria Souza',
      botName: expect.stringMatching(/^Bot /), createdAt: ctx.clock.now().toISOString(),
    });
  });

  it('notifies the listed users, and fails for target owner on a chat without owner', async () => {
    const { chatId } = await openChat();
    const users2 = await makeBot([node('aviso', 'notify_agent', { title: 'Oi', text: 'x', target: 'users', userIds: [s.agentA.id, s.agentB.id] })]);
    const owner = await makeBot([node('aviso', 'notify_agent', { title: 'Oi', text: 'x', target: 'owner', userIds: [] })]);

    await runBot(users2, chatId);
    const failed = await runBot(owner, chatId);

    expect(ctx.hub.events.filter((e) => e.type === 'notification').map((e) => e.userId)).toEqual([s.agentA.id, s.agentB.id]);
    expect(failed).toMatchObject({ state: 'failed', error: 'A conversa não tem atendente para notificar' });
  });
});

describe('call_flow', () => {
  async function parentOf(childId: string, continueAfter: boolean) {
    return makeBot(
      [node('chamar', 'call_flow', { botId: childId, continueAfter }), node('depois', 'note', { text: 'no pai' })],
      [edge('chamar', 'next', 'depois')],
    );
  }
  const childRuns = (parentRunId: string) => ctx.db.select().from(botRuns).where(eq(botRuns.parentRunId, parentRunId));

  it('continueAfter=false starts the child and ends the caller', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    const { chatId } = await openChat();

    const run = await runBot(await parentOf(child, false), chatId);

    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no filho']);
    expect(await childRuns(run.id)).toEqual([expect.objectContaining({ botId: child, depth: 1, state: 'finished' })]);
  });

  it('continueAfter=true follows next right away when the child finishes at once', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    const { chatId } = await openChat();

    const run = await runBot(await parentOf(child, true), chatId);

    expect(run.state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no filho', 'no pai']);
  });

  it('continueAfter=true waits for a waiting child and resumes when it finishes', async () => {
    const child = await makeBot([node('pergunta', 'ask_choice', ASK)]);
    const { chatId } = await openChat();

    const parent = await runBot(await parentOf(child, true), chatId);
    expect(parent.state).toBe('waiting_flow');
    const [kid] = await childRuns(parent.id);
    expect(kid).toMatchObject({ state: 'waiting_reply', depth: 1 });

    expect(await resumeOnReply(ctx, chatId, await reply(chatId, '1'))).toBe(1); // the parent in waiting_flow is skipped

    expect((await runRow(kid.id)).state).toBe('finished');
    expect((await runRow(parent.id)).state).toBe('finished');
    expect(await notes(chatId)).toEqual(['no pai']);
  });

  it.each([
    ['close_chat', { sendClosingMessage: false }, 'chat_closed'],
    ['block_contact', {}, 'chat_closed'], // block_contact also closes the chat; the step precheck looks at the chat first
  ] as const)('continueAfter=true stops the caller instead of sending when the child ran %s', async (type, config, reason) => {
    const child = await makeBot([node('fim', type, config)]);
    const parent = await makeBot(
      [node('chamar', 'call_flow', { botId: child, continueAfter: true }), node('depois', 'send_message', { text: 'no pai', attachment: null, signature: false })],
      [edge('chamar', 'next', 'depois')],
    );
    const { chatId } = await openChat();

    const run = await runBot(parent, chatId);

    expect(run.state).toBe('stopped');
    expect(sentTexts()).toEqual([]);
    const stopped = (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped');
    expect(stopped).toEqual([expect.objectContaining({ data: expect.objectContaining({ runId: run.id, reason }) })]);
  });

  it('fails with the start error when the called bot is paused', async () => {
    const child = await makeBot([node('filho', 'note', { text: 'no filho' })]);
    await ctx.db.update(bots).set({ status: 'paused' }).where(eq(bots.id, child));
    const { chatId } = await openChat();

    expect(await runBot(await parentOf(child, true), chatId)).toMatchObject({ state: 'failed', error: 'Este chatbot não está ativo' });
  });

  it('stops at 5 chained levels', async () => {
    let target = await makeBot([node('folha', 'note', { text: 'nunca' })]);
    for (let i = 0; i < 5; i++) target = await makeBot([node('chamar', 'call_flow', { botId: target, continueAfter: true })]);
    const { chatId } = await openChat();

    const root = await runBot(target, chatId);

    const runs = await ctx.db.select().from(botRuns).where(eq(botRuns.chatId, chatId)).orderBy(botRuns.depth);
    expect(runs.map((r) => [r.depth, r.state])).toEqual([[0, 'failed'], [1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
    expect(runs[4].error).toBe('Limite de 5 fluxos encadeados');
    expect(root.error).toBe('O fluxo acionado não terminou');
    expect(await notes(chatId)).toEqual([]);
  });
});

describe('block_contact', () => {
  it('blocks the contact, closes all of their open chats without a message and stops their other bots', async () => {
    const [second] = await ctx.db.insert(channels).values({ name: 'Segundo número', evolutionInstance: 'talk-test-2', status: 'connected' }).returning();
    const { chatId, contactId } = await openChat();
    const other = await openChat({ contactId, channelId: second.id });
    const waiting = await runBot(await makeBot([node('pergunta', 'ask_choice', ASK)]), other.chatId);
    expect(waiting.state).toBe('waiting_reply');
    const blocker = await makeBot([node('bloquear', 'block_contact')]);

    const run = await runBot(blocker, chatId);

    expect(run.state).toBe('finished');
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact.blocked).toBe(true);
    for (const id of [chatId, other.chatId]) {
      expect((await chatRow(id)).state).toBe('closed');
      const closed = (await eventsOf(ctx, id)).find((e) => e.kind === 'closed');
      expect(closed).toMatchObject({ authorId: null, data: { closingMessageSent: false, botId: blocker, runId: run.id } });
    }
    expect((await runRow(waiting.id)).state).toBe('stopped');
    const stopped = (await eventsOf(ctx, other.chatId)).find((e) => e.kind === 'bot_stopped');
    expect(stopped?.data.reason).toBe('contact_blocked');
    expect(sentTexts()).toHaveLength(1); // only the question of the waiting bot
  });
});
