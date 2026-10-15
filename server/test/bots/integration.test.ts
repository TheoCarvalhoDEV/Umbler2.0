import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBot } from '../../src/bots/repo.js';
import { botRuns, bots, chats, contacts, messages, settings } from '../../src/db/schema.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999990001';
const OTHER_PHONE = '5565999990002';
const MENU_TEXT = 'Escolha uma opção:\n\n1: Financeiro';
let seq = 0;

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: 'message',
    instance: 'talk-test',
    externalId: `BOT-EXT${seq}`,
    direction: 'in',
    phone: PHONE,
    lid: null,
    pushName: 'Maria Cliente',
    kind: 'text',
    body: `mensagem ${seq}`,
    hasMedia: false,
    mediaMime: null,
    mediaName: null,
    replyToExternalId: null,
    sentAt: new Date(Date.UTC(2026, 9, 14, 13, 0, seq % 60)),
    raw: { key: { id: `BOT-EXT${seq}` } },
    ...over,
  };
}

/** start_channel → ask_choice "menu" (1: Financeiro, no retries, no timeout) → send_message "Certo!". */
const menuGraph = (): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_channel', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'n2', type: 'ask_choice', name: 'menu', position: { x: 300, y: 0 },
      config: { text: 'Escolha uma opção:', options: [{ key: '1', label: 'Financeiro' }], invalidRetries: 0, timeoutHours: null },
    },
    { id: 'n3', type: 'send_message', name: 'ok', position: { x: 600, y: 0 }, config: { text: 'Certo!', attachment: null, signature: false } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' },
    { id: 'e2', source: 'n2', sourceHandle: 'opt:1', target: 'n3' },
  ],
});

/** Triage stubs only: the bot hooks stay the real ones (handleInbound merges the defaults). */
function triageStub() {
  const calls: string[] = [];
  const hooks: IngestHooks = {
    startTriage: async (_c, chat) => {
      calls.push(`triage:start:${chat.id}`);
    },
    handleTriageReply: async (_c, chat, text) => {
      calls.push(`triage:reply:${chat.id}:${text}`);
      return false;
    },
  };
  return { calls, hooks };
}

let ctx: Ctx;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let triage: ReturnType<typeof triageStub>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  triage = triageStub();
});

const ingest = (...events: InboundEvent[]) => handleInbound(ctx, events, triage.hooks);
const allRuns = () => ctx.db.select().from(botRuns);
const sentTexts = () => ctx.wa.sent.filter((s) => s.method === 'sendText').map((s) => (s.payload as { text: string }).text);

async function activeChannelBot(name = 'Recepção') {
  const bot = await createBot(ctx.db, {
    name, graph: menuGraph(), valid: true, publish: true, createdBy: null, startChannelIds: [seed.channelId],
  });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  return bot;
}

async function chatOf(phone: string) {
  const [row] = await ctx.db
    .select({ chat: chats })
    .from(chats)
    .innerJoin(contacts, eq(contacts.id, chats.contactId))
    .where(eq(contacts.phone, phone));
  return row!.chat;
}

describe('ingest and bots', () => {
  it('starts the channel bot instead of the triage when a contact opens a chat', async () => {
    const bot = await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));

    const chat = await chatOf(PHONE);
    const runs = await allRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ botId: bot.id, chatId: chat.id, state: 'waiting_reply', startedBy: null, depth: 0 });
    expect(triage.calls).toEqual([]);
    expect(sentTexts()).toEqual([MENU_TEXT]);
    const [botMsg] = await ctx.db.select().from(messages).where(eq(messages.botRunId, runs[0]!.id));
    expect(botMsg).toMatchObject({ direction: 'out', authorId: null, body: MENU_TEXT });
  });

  it('runs the triage as before when no active bot starts on the channel', async () => {
    const paused = await createBot(ctx.db, {
      name: 'Pausado', graph: menuGraph(), valid: true, publish: true, createdBy: null, startChannelIds: [seed.channelId],
    });
    expect(paused.status).toBe('paused');

    await ingest(msg({ body: 'Bom dia' }));

    const chat = await chatOf(PHONE);
    expect(triage.calls).toEqual([`triage:start:${chat.id}`]);
    expect(await allRuns()).toEqual([]);
    expect(ctx.wa.sent).toEqual([]);
  });

  it('resumes the waiting run with the contact reply', async () => {
    await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));
    await ingest(msg({ body: '1' }));

    const [run] = await allRuns();
    expect(run!.state).toBe('finished');
    expect(run!.vars.menu).toMatchObject({ raw: '1', value: '1', label: 'Financeiro' });
    expect(sentTexts()).toEqual([MENU_TEXT, 'Certo!']);
    expect(triage.calls).toEqual([]);
  });

  it('hands a reply to the triage first and then to the bots, as the stored message', async () => {
    const calls: string[] = [];
    const replies: InboundReply[] = [];
    const hooks: IngestHooks = {
      startTriage: async (_c, chat) => {
        calls.push(`triage:start:${chat.id}`);
      },
      handleTriageReply: async (_c, chat, text) => {
        calls.push(`triage:reply:${chat.id}:${text}`);
        return true;
      },
      startChannelBot: async (_c, chat) => {
        calls.push(`bot:start:${chat.id}`);
        return false; // no bot → the triage must start
      },
      resumeBotsOnReply: async (_c, chatId, reply) => {
        calls.push(`bot:resume:${chatId}`);
        replies.push(reply);
        return 0;
      },
    };

    await handleInbound(ctx, [msg({ body: 'Bom dia' })], hooks);
    const chat = await chatOf(PHONE);
    expect(calls).toEqual([`bot:start:${chat.id}`, `triage:start:${chat.id}`]);

    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, chat.id));
    await handleInbound(ctx, [msg({ body: '2' })], hooks);
    expect(calls.slice(2)).toEqual([`triage:reply:${chat.id}:2`, `bot:resume:${chat.id}`]);

    const [stored] = await ctx.db.select().from(messages).where(and(eq(messages.chatId, chat.id), eq(messages.body, '2')));
    expect(replies).toEqual([
      { messageId: stored!.id, kind: 'text', body: '2', mediaMime: null, mediaName: null, createdAt: stored!.createdAt },
    ]);
  });

  it('outbound and echo messages neither start nor resume bots', async () => {
    await activeChannelBot();

    // The office phone writes first to a new contact: the chat opens, but no bot starts on an outbound message.
    await ingest(msg({ direction: 'out', phone: OTHER_PHONE, body: 'Olá, aqui é o escritório' }));
    expect(await allRuns()).toEqual([]);

    await ingest(msg({ body: 'Bom dia' }));
    const [run] = await allRuns();
    expect(run!.state).toBe('waiting_reply');
    const [menu] = await ctx.db.select().from(messages).where(eq(messages.botRunId, run!.id));
    const sentBefore = ctx.wa.sent.length;

    await ingest(
      msg({ direction: 'out', body: '1' }), // an agent types "1" on the office phone
      msg({ direction: 'out', externalId: menu!.externalId!, body: MENU_TEXT }), // the webhook echo of the bot's own menu
    );

    const after = await allRuns();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: run!.id, state: 'waiting_reply', currentNodeId: run!.currentNodeId });
    expect(after[0]!.steps).toEqual(run!.steps);
    expect(ctx.wa.sent.length).toBe(sentBefore);
    expect(triage.calls).toEqual([]);
  });
});

function multipart(fields: Record<string, string>, file: { name: string; mime: string; data: Buffer }) {
  const boundary = '----talkbotboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('agents and running bots (bot_running_behavior)', () => {
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let chatId: string;
  let runId: string;

  beforeEach(async () => {
    await enableSeeAll(ctx, seed.admin); // the chat sits in the default sector, which no seeded agent belongs to
    await activeChannelBot();
    await ingest(msg({ body: 'Bom dia' }));
    chatId = (await chatOf(PHONE)).id;
    runId = (await allRuns())[0]!.id;
    ({ app } = await makeTestApp(ctx));
    admin = (await loginAs(app, seed.admin.email)).headers;
  });

  afterEach(async () => {
    await app.close();
  });

  const post = (path: string, payload: object, headers = admin) =>
    app.inject({ method: 'POST', url: `/api/chats/${chatId}/${path}`, headers, payload });
  const runState = async () =>
    (await ctx.db.select({ state: botRuns.state }).from(botRuns).where(eq(botRuns.id, runId)))[0]!.state;
  const stops = async () => (await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_stopped');
  const agentMessages = () =>
    ctx.db.select().from(messages).where(and(eq(messages.chatId, chatId), eq(messages.authorId, seed.admin.id)));
  const botRunning = () => ({
    error: 'O chatbot está em execução nesta conversa',
    code: 'BOT_RUNNING',
    runs: [{ id: runId, botName: 'Recepção' }],
  });
  async function setBehavior(value: 'ask' | 'stop' | 'keep') {
    await ctx.db
      .insert(settings)
      .values({ key: 'bot_running_behavior', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  it('asks with 409 BOT_RUNNING by default and sends nothing until botAction comes', async () => {
    const asked = await post('messages', { text: 'Olá, sou a atendente' });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual(botRunning());
    expect(await agentMessages()).toHaveLength(0);
    expect(sentTexts()).toEqual([MENU_TEXT]);
    expect(await runState()).toBe('waiting_reply');

    const kept = await post('messages', { text: 'Olá, sou a atendente', botAction: 'keep' });
    expect(kept.statusCode).toBe(200);
    expect(await agentMessages()).toHaveLength(1);
    expect(await runState()).toBe('waiting_reply');
    expect(await stops()).toEqual([]);
  });

  it('botAction stop stops the run as the agent, then sends', async () => {
    const res = await post('messages', { text: 'Assumo daqui', botAction: 'stop' });
    expect(res.statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([
      { authorId: seed.admin.id, data: { reason: 'agent_message', runId, botName: 'Recepção' } },
    ]);
    expect(sentTexts().at(-1)).toContain('Assumo daqui');

    // No run left: the next send goes straight through, even under 'ask'.
    expect((await post('messages', { text: 'Mais uma' })).statusCode).toBe(200);
  });

  it('the keep and stop settings decide without asking', async () => {
    await setBehavior('keep');
    expect((await post('messages', { text: 'Primeira' })).statusCode).toBe(200);
    expect(await runState()).toBe('waiting_reply');

    await setBehavior('stop');
    expect((await post('messages', { text: 'Segunda' })).statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'agent_message' } }]);
  });

  it('a multipart send carries botAction', async () => {
    const file = { name: 'doc.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 teste') };
    const upload = (fields: Record<string, string>) => {
      const { payload, contentType } = multipart(fields, file);
      return app.inject({
        method: 'POST', url: `/api/chats/${chatId}/messages`, headers: { ...admin, 'content-type': contentType }, payload,
      });
    };

    const asked = await upload({ signature: 'false' });
    expect(asked.statusCode).toBe(409);
    expect(asked.json().code).toBe('BOT_RUNNING');

    const stopped = await upload({ signature: 'false', botAction: 'stop' });
    expect(stopped.statusCode).toBe(200);
    expect(await runState()).toBe('stopped');
    expect(ctx.wa.sent.filter((s) => s.method === 'sendMedia')).toHaveLength(1);
  });

  it('internal notes never touch the bot', async () => {
    const res = await post('notes', { text: 'Cliente ligou antes' });
    expect(res.statusCode).toBe(200);
    expect(await runState()).toBe('waiting_reply');
  });

  it('a user who cannot see the chat gets 404, never the bot names', async () => {
    const ana = (await loginAs(app, seed.agentA.email)).headers; // sector Financeiro; the chat is in Atendimento
    expect((await post('messages', { text: 'Oi' }, ana)).statusCode).toBe(404);
    expect((await post('transfer', { sectorId: seed.sectorA }, ana)).statusCode).toBe(404);
    expect(await runState()).toBe('waiting_reply');
  });

  it('a manual transfer follows the setting: ask answers 409, then keep or stop', async () => {
    const asked = await post('transfer', { sectorId: seed.sectorA });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toEqual(botRunning());
    const [still] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    expect(still!.sectorId).toBe(seed.defaultSector);

    const kept = await post('transfer', { sectorId: seed.sectorA, botAction: 'keep' });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().sectorId).toBe(seed.sectorA);
    expect(await runState()).toBe('waiting_reply');

    const stopped = await post('transfer', { sectorId: seed.sectorB, botAction: 'stop' });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().sectorId).toBe(seed.sectorB);
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'transfer', runId } }]);
  });

  it('closing the chat stops its bots without asking, also when the closing message is sent', async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Atendimento finalizado.' });

    const res = await post('close', { sendClosingMessage: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('closed');
    expect(sentTexts().at(-1)).toBe('Atendimento finalizado.');
    expect(await runState()).toBe('stopped');
    expect(await stops()).toMatchObject([{ authorId: seed.admin.id, data: { reason: 'chat_closed', runId } }]);
  });
});
