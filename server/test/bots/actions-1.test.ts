import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BlockType, BotEdge, BotGraph, BotNode, InputValidator } from '@talk/shared';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf, insertChat, newContact } from '../inbox/fixtures.js';
import { botRuns, bots, chats, contactFieldValues, contactTags, contacts, customFields, messages, tags } from '../../src/db/schema.js';
import { createBot, type BotRunRow } from '../../src/bots/repo.js';
import { resumeOnReply, resumeOnTimer, startRun } from '../../src/bots/engine.js';
import { createBotRuntime } from '../../src/bots/runtime.js';
import type { InboundReply } from '../../src/bots/registry.js';
import { sendSystemMessage } from '../../src/messages/send.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
type Media = { kind?: InboundReply['kind']; mediaMime?: string; mediaName?: string };

const HOUR = 3_600_000;

let ctx: Ctx;
let seed: Seeded;
let contactId: string;
let chatId: string;
let botSeq = 0;

beforeEach(async () => {
  ctx = await makeTestCtx();
  // start_manual is registered by Task 8; this stand-in keeps the file independent of it (same behavior).
  ctx.botRuntime = createBotRuntime({
    now: () => ctx.clock.now(),
    registry: { start_manual: { type: 'start_manual', run: async () => ({ next: 'next' }) } },
  });
  seed = await seedBasics(ctx);
  contactId = await newContact(ctx, { name: 'Maria Silva' });
  chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector, contactId });
});

const node = (id: string, type: BlockType, config: Record<string, unknown> = {}): BotNode => ({
  id, type, name: id, position: { x: 0, y: 0 }, config,
});
const edge = (source: string, sourceHandle: string, target: string): BotEdge => ({
  id: `${source}.${sourceHandle}`, source, sourceHandle, target,
});

async function reloadRun(id: string): Promise<BotRunRow> {
  const [row] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
  return row!;
}

/** start_manual 'inicio' → nodes[0]; publishes and activates a fresh bot, starts it on `chat`, returns the stored run. */
async function runFlow(nodes: BotNode[], edges: BotEdge[] = [], chat = chatId): Promise<BotRunRow> {
  const graph: BotGraph = {
    nodes: [node('inicio', 'start_manual'), ...nodes],
    edges: [edge('inicio', 'next', nodes[0]!.id), ...edges],
  };
  botSeq += 1;
  const bot = await createBot(ctx.db, { name: `Teste ${botSeq}`, graph, valid: true, publish: true, createdBy: null, manualStart: true });
  await ctx.db.update(bots).set({ status: 'active' }).where(eq(bots.id, bot.id));
  const run = await startRun(ctx, { botId: bot.id, chatId: chat, entry: 'manual', startedBy: null });
  return reloadRun(run.id);
}

/** Stores an inbound message the way ingest does and returns it as an InboundReply. */
async function storeInbound(body: string | null, media: Media = {}, chat = chatId): Promise<InboundReply> {
  const id = randomUUID();
  // Comfortably after waiting_since (DB clock_timestamp(), microseconds), even when the test runs within one millisecond.
  const createdAt = new Date(Date.now() + 1000);
  const kind = media.kind ?? 'text';
  const mediaMime = media.mediaMime ?? null;
  const mediaName = media.mediaName ?? null;
  await ctx.db.insert(messages).values({
    id, chatId: chat, channelId: seed.channelId, direction: 'in', kind, body, mediaMime, mediaName,
    authorId: null, externalId: `in-${id}`, status: 'sent', sentAt: createdAt, createdAt,
  });
  return { messageId: id, kind, body, mediaMime, mediaName, createdAt };
}

async function reply(body: string | null, media: Media = {}, chat = chatId): Promise<void> {
  await resumeOnReply(ctx, chat, await storeInbound(body, media, chat));
}

/** Outcome of the last step logged for a node (handle id, 'wait:reply', 'error'…). */
const outcome = (run: BotRunRow, nodeId: string) => run.steps.filter((s) => s.node === nodeId).at(-1)?.outcome;
const texts = () => ctx.wa.sent.filter((s) => s.method === 'sendText').map((s) => (s.payload as { text: string }).text);

async function chatRow() {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row!;
}

describe('sendSystemMessage', () => {
  it('stores an author-less out message, sends it as text and leaves waiting alone', async () => {
    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Olá do sistema' });

    expect(res).toEqual({ ok: true, messageId: expect.any(String), echoDropped: false });
    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendText', instance: seed.instance, payload: { text: 'Olá do sistema' } });
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ direction: 'out', kind: 'text', body: 'Olá do sistema', authorId: null, botRunId: null, status: 'sent' });
    expect(msg!.externalId).toMatch(/^fake-/);
    expect((await chatRow()).lastMessagePreview).toBe('Olá do sistema');
    expect(ctx.hub.events.filter((e) => e.messageId === msg!.id).map((e) => e.type)).toEqual(['message.created', 'message.updated']);
  });

  it('sends a bot media file with the text as caption', async () => {
    const pdf = Buffer.from('%PDF-1.4 teste');
    await mkdir(join(ctx.config.mediaDir, 'bots'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'bots', 'tabela.pdf'), pdf);

    const res = await sendSystemMessage(ctx, await chatRow(), {
      text: 'Segue a tabela',
      attachment: { path: 'bots/tabela.pdf', name: 'Tabela.pdf', mime: 'application/pdf', size: pdf.length },
    });

    expect(res.ok).toBe(true);
    expect(ctx.wa.sent[0]).toMatchObject({
      method: 'sendMedia',
      payload: { media: { kind: 'document', mime: 'application/pdf', fileName: 'Tabela.pdf', caption: 'Segue a tabela', base64: pdf.toString('base64') } },
    });
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ kind: 'document', body: 'Segue a tabela', mediaPath: 'bots/tabela.pdf', mediaName: 'Tabela.pdf', mediaMime: 'application/pdf', mediaSize: pdf.length });
  });

  it('stores nothing when the contact has no WhatsApp address', async () => {
    await ctx.db.update(contacts).set({ phone: null, lid: null }).where(eq(contacts.id, contactId));

    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Oi' });

    expect(res).toEqual({ ok: false, messageId: null, echoDropped: false });
    expect(ctx.wa.sent).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(0);
  });

  it('marks the message failed when the gateway throws', async () => {
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    const res = await sendSystemMessage(ctx, await chatRow(), { text: 'Oi' });

    expect(res.ok).toBe(false);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, res.messageId!));
    expect(msg).toMatchObject({ status: 'failed', error: 'Evolution fora do ar' });
  });
});
