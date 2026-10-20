import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats } from '../../src/db/schema.js';
import { closeChat } from '../../src/inbox/chats.js';
import { handleInbound, type IngestHooks } from '../../src/messages/ingest.js';
import { sendAgentMessage, sendSystemMessage } from '../../src/messages/send.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { enableSeeAll, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat } from './seed.js';

type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999999999';
const hooks: IngestHooks = { startTriage: async () => {}, handleTriageReply: async () => false };
const t = (min: number) => new Date(Date.UTC(2026, 9, 20, 12, min));

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  await enableSeeAll(ctx, s.admin); // inbound chats open in the default sector, which no agent belongs to
});

let seq = 0;
function msg(min: number, direction: 'in' | 'out' = 'in'): MessageEvent {
  seq += 1;
  return {
    type: 'message', instance: s.instance, externalId: `WAIT${seq}`, direction, phone: PHONE, lid: null,
    pushName: 'Maria Cliente', kind: 'text', body: `mensagem ${seq}`, hasMedia: false, mediaMime: null, mediaName: null,
    replyToExternalId: null, sentAt: t(min), raw: { key: { id: `WAIT${seq}` } },
  };
}

async function onlyChat() {
  const rows = await ctx.db.select().from(chats);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('chats.waiting_since (spec 2026-10-20 §3)', () => {
  it('the first unanswered contact message sets it, later ones keep it, the agent reply clears it', async () => {
    await handleInbound(ctx, [msg(1)], hooks);
    expect(await onlyChat()).toMatchObject({ waiting: true, waitingSince: t(1) });
    await handleInbound(ctx, [msg(5)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(1));

    await sendAgentMessage(ctx, s.admin, (await onlyChat()).id, { text: 'Bom dia', signature: false });
    expect(await onlyChat()).toMatchObject({ waiting: false, waitingSince: null });

    await handleInbound(ctx, [msg(9)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(9));
  });

  it('a message from the office phone and closing the chat clear it', async () => {
    await handleInbound(ctx, [msg(1)], hooks);
    await handleInbound(ctx, [msg(2, 'out')], hooks);
    expect(await onlyChat()).toMatchObject({ waiting: false, waitingSince: null });

    await handleInbound(ctx, [msg(3)], hooks);
    expect((await onlyChat()).waitingSince).toEqual(t(3));
    await closeChat(ctx, s.admin, (await onlyChat()).id, { sendClosingMessage: false });
    expect(await onlyChat()).toMatchObject({ state: 'closed', waiting: false, waitingSince: null });
  });

  it('a chatbot or triage message leaves it alone, even when its echo beats the gateway (Review Focus 3)', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, phone: PHONE, waiting: true, waitingSince: t(1),
    });
    const row = async () => (await ctx.db.select().from(chats).where(eq(chats.id, chatId)))[0]!;
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // Evolution's fromMe echo is ingested while our call is still pending: it clears waiting and waiting_since
      await handleInbound(ctx, [{ ...msg(2, 'out'), externalId: res.externalId, phone, body: text }], hooks);
      return res;
    });

    const sent = await sendSystemMessage(ctx, await row(), { text: 'Escolha uma opção' });

    expect(sent).toMatchObject({ ok: true, echoDropped: true });
    expect(await row()).toMatchObject({ waiting: true, waitingSince: t(1) });
  });
});
