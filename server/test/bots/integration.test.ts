import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import type { InboundReply } from '../../src/bots/registry.js';
import { createBot } from '../../src/bots/repo.js';
import { botRuns, bots, chats, contacts, messages } from '../../src/db/schema.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

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
