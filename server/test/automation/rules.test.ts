import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTO_RULES, type AutoRulesDto } from '@talk/shared';
import { runAutoRules } from '../../src/automation/rules.js';
import { createAutomationWorker } from '../../src/automation/worker.js';
import { chats, messages, scheduledMessages, settings } from '../../src/db/schema.js';
import { assumeChat, closeChatForInactivity } from '../../src/inbox/chats.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { seedChat, type SeedChatOpts } from '../chats/seed.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { insertScheduled, runningBot } from './seed.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const hooks: IngestHooks = { startTriage: async () => {}, handleTriageReply: async () => false };

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ctx.clock.set(new Date()); // events carry the DB's clock_timestamp(): keep the fake clock on real time
});
afterEach(() => vi.restoreAllMocks());

const ago = (ms: number) => new Date(ctx.clock.now().getTime() - ms);
const run = () => runAutoRules(ctx, ctx.clock.now());
const chatRow = async (id: string) => (await ctx.db.select().from(chats).where(eq(chats.id, id)))[0]!;
const texts = () => ctx.wa.sent.filter((x) => x.method === 'sendText');
let phoneSeq = 0;
const chat = (o: Partial<SeedChatOpts> = {}) =>
  seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: `55659900000${String(++phoneSeq).padStart(2, '0')}`, ...o,
  });

async function setRules(r: { returnToQueue?: Partial<AutoRulesDto['returnToQueue']>; closeInactive?: Partial<AutoRulesDto['closeInactive']> }) {
  const value: AutoRulesDto = {
    returnToQueue: { ...DEFAULT_AUTO_RULES.returnToQueue, ...r.returnToQueue },
    closeInactive: { ...DEFAULT_AUTO_RULES.closeInactive, ...r.closeInactive },
  };
  await ctx.db.insert(settings).values({ key: 'auto_rules', value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

function inbound(phone: string): Extract<InboundEvent, { type: 'message' }> {
  const externalId = `IN-${randomUUID()}`;
  return {
    type: 'message', instance: s.instance, externalId, direction: 'in', phone, lid: null, pushName: 'Maria Cliente', kind: 'text',
    body: 'Ainda preciso de ajuda', hasMedia: false, mediaMime: null, mediaName: null, replyToExternalId: null, sentAt: new Date(),
    raw: { key: { id: externalId } },
  };
}

describe('"Devolver à fila conversas paradas" (spec 2026-10-20 agendamentos §4.1)', () => {
  const waitingFor = (ms: number): Partial<SeedChatOpts> => ({ waiting: true, waitingSince: ago(ms), at: ago(ms) });

  it('is off by default', async () => {
    await chat(waitingFor(2 * HOUR));
    expect(await run()).toEqual({ returned: 0, closed: 0 });
  });

  it('takes the owner away from a chat whose contact waits past N minutes, once, and says why', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat(waitingFor(31 * MIN));
    const fresh = await chat(waitingFor(29 * MIN));

    expect(await run()).toEqual({ returned: 1, closed: 0 });
    expect(await chatRow(chatId)).toMatchObject({ ownerId: null, sectorId: s.sectorA, state: 'open', waiting: true });
    expect((await chatRow(fresh.chatId)).ownerId).toBe(s.agentA.id);
    expect(await eventsOf(ctx, chatId)).toMatchObject([
      { kind: 'returned_to_queue', data: { minutes: 30, previousOwnerId: s.agentA.id }, authorId: null },
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    expect(await run()).toEqual({ returned: 0, closed: 0 }); // once per wait: it has no owner now
  });

  it('a wait from before waiting_since existed counts from the last message', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat({ waiting: true, waitingSince: null, at: ago(31 * MIN) });
    expect((await run()).returned).toBe(1);
    expect((await chatRow(chatId)).ownerId).toBeNull();
  });

  it('the count starts again when someone takes the chat (Review Focus 3)', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const { chatId } = await chat({ ...waitingFor(2 * HOUR), ownerId: null });
    await assumeChat(ctx, s.agentA, chatId);
    expect((await run()).returned).toBe(0);
    ctx.clock.advance(31 * MIN);
    expect((await run()).returned).toBe(1);
    expect((await chatRow(chatId)).ownerId).toBeNull();
  });

  it('leaves private, unowned, answered, triage, history and chatbot chats alone', async () => {
    await setRules({ returnToQueue: { enabled: true, minutes: 30 } });
    const priv = await chat({ ...waitingFor(2 * HOUR), private: true });
    await chat({ ...waitingFor(2 * HOUR), ownerId: null });
    const answered = await chat({ at: ago(2 * HOUR) });
    const triage = await chat(waitingFor(2 * HOUR));
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, triage.chatId));
    const history = await chat(waitingFor(2 * HOUR));
    await ctx.db.update(chats).set({ history: true }).where(eq(chats.id, history.chatId));
    const bot = await chat(waitingFor(2 * HOUR));
    await runningBot(ctx, bot.chatId, bot.contactId);

    expect((await run()).returned).toBe(0);
    for (const c of [priv, answered, triage, history, bot]) expect((await chatRow(c.chatId)).ownerId).toBe(s.agentA.id);
  });
});

describe('"Finalizar por inatividade" (spec 2026-10-20 agendamentos §4.2)', () => {
  beforeEach(async () => {
    await ctx.db.insert(settings).values({ key: 'closing_message', value: 'Atendimento encerrado. Obrigado!' });
  });

  it('closes a chat where the office spoke last over N hours ago, sending the closing message as the system', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    const recent = await chat({ at: ago(23 * HOUR) });

    expect(await run()).toEqual({ returned: 0, closed: 1 });
    expect(await chatRow(chatId)).toMatchObject({ state: 'closed', waiting: false });
    expect((await chatRow(recent.chatId)).state).toBe('open');
    expect(texts().map((x) => (x.payload as { text: string }).text)).toEqual(['Atendimento encerrado. Obrigado!']);
    expect((await ctx.db.select().from(messages).where(eq(messages.chatId, chatId)))[0]).toMatchObject({ direction: 'out', authorId: null, status: 'sent' });
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({
      kind: 'closed', authorId: null, data: { closingMessageSent: true, reason: 'inactivity', hours: 24 },
    });
  });

  it('closes without a message when the box is off', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    expect((await run()).closed).toBe(1);
    expect(texts()).toEqual([]);
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({ kind: 'closed', data: { closingMessageSent: false, reason: 'inactivity' } });
  });

  it('closes without sending when the contact has no phone, or the closing message is empty', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const noPhone = await chat({ at: ago(25 * HOUR), phone: null });
    expect(await run()).toEqual({ returned: 0, closed: 1 });
    expect((await chatRow(noPhone.chatId)).state).toBe('closed');
    expect((await eventsOf(ctx, noPhone.chatId)).at(-1)).toMatchObject({ kind: 'closed', data: { closingMessageSent: false, reason: 'inactivity' } });

    await ctx.db.update(settings).set({ value: '' }).where(eq(settings.key, 'closing_message'));
    const emptyText = await chat({ at: ago(25 * HOUR) });
    expect(await run()).toEqual({ returned: 0, closed: 1 });
    expect((await chatRow(emptyText.chatId)).state).toBe('closed');
    expect((await eventsOf(ctx, emptyText.chatId)).at(-1)).toMatchObject({ kind: 'closed', data: { closingMessageSent: false } });
    expect(texts()).toEqual([]);
  });

  it('leaves history and triage-pending chats alone', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const history = await chat({ at: ago(25 * HOUR) });
    await ctx.db.update(chats).set({ history: true }).where(eq(chats.id, history.chatId));
    const triage = await chat({ at: ago(25 * HOUR) });
    await ctx.db.update(chats).set({ triagePending: true }).where(eq(chats.id, triage.chatId));

    expect((await run()).closed).toBe(0);
    for (const c of [history, triage]) expect((await chatRow(c.chatId)).state).toBe('open');
  });

  it('leaves waiting, chatbot and scheduled chats alone, and closes private ones (Review Focus 7)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const waiting = await chat({ at: ago(25 * HOUR), waiting: true, waitingSince: ago(25 * HOUR) });
    const bot = await chat({ at: ago(25 * HOUR) });
    await runningBot(ctx, bot.chatId, bot.contactId);
    const scheduled = await chat({ at: ago(25 * HOUR) });
    await insertScheduled(ctx, { chatId: scheduled.chatId, authorId: s.agentA.id, sendAt: ago(-HOUR) });
    const priv = await chat({ at: ago(25 * HOUR), private: true });

    expect((await run()).closed).toBe(1);
    expect((await chatRow(priv.chatId)).state).toBe('closed');
    for (const c of [waiting, bot, scheduled]) expect((await chatRow(c.chatId)).state).toBe('open');
  });

  it('an agent writing after the selection wins: no close, no closing message (ruling)', async () => {
    const { chatId } = await chat({ at: ago(23 * HOUR) }); // was 25 h when the batch selected it, an agent wrote since
    expect(await closeChatForInactivity(ctx, chatId, { closingText: 'Atendimento encerrado. Obrigado!', hours: 24, now: ctx.clock.now() })).toBe(false);
    expect((await chatRow(chatId)).state).toBe('open');
    expect(texts()).toEqual([]);
  });

  it('a failed closing message keeps the chat open and the next beat leaves it alone (Review Focus 4)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR) });
    ctx.wa.failNext();
    expect((await run()).closed).toBe(0);
    expect((await chatRow(chatId)).state).toBe('open');
    expect((await ctx.db.select().from(messages).where(eq(messages.chatId, chatId)))[0]).toMatchObject({ status: 'failed' });
    expect((await run()).closed).toBe(0); // the failed message is the chat's last message now
    expect(texts()).toEqual([]);
  });

  it('a contact writing while the closing message goes out keeps the chat open (Review Focus 4)', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: true } });
    const { chatId } = await chat({ at: ago(25 * HOUR), phone: '5565988887777' });
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      await handleInbound(ctx, [inbound('5565988887777')], hooks);
      return res;
    });
    expect((await run()).closed).toBe(0);
    expect(await chatRow(chatId)).toMatchObject({ state: 'open', waiting: true });
  });
});

describe('createAutomationWorker', () => {
  it('runs the scheduled-message beat and the rules beat until stopped', async () => {
    await setRules({ closeInactive: { enabled: true, hours: 24, sendClosingMessage: false } });
    const idle = await chat({ at: ago(25 * HOUR) });
    const target = await chat();
    const row = await insertScheduled(ctx, { chatId: target.chatId, authorId: s.agentA.id, sendAt: ago(MIN) });
    const worker = createAutomationWorker(ctx, { scheduledMs: 10, rulesMs: 10 });
    worker.start();
    try {
      await vi.waitFor(async () => {
        expect((await chatRow(idle.chatId)).state).toBe('closed');
        expect((await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, row.id)))[0]!.status).toBe('sent');
      }, { timeout: 5000 });
    } finally {
      worker.stop();
    }
  });
});
