import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAIL, deliverDueScheduled } from '../../src/automation/delivery.js';
import { botRuns, chats, messages, scheduledMessages, users } from '../../src/db/schema.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { saveMedia } from '../../src/messages/media.js';
import { formatSignature, signatureLabel } from '../../src/messages/signature.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { insertScheduled, runningBot } from './seed.js';

const MIN = 60_000;
const PHONE = '5565999999999';
const TEXT = 'Lembrete: audiência amanhã às 9h';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: PHONE }));
});
afterEach(() => vi.restoreAllMocks());

const inMin = (n: number) => new Date(ctx.clock.now().getTime() + n * MIN);
const beat = () => deliverDueScheduled(ctx, ctx.clock.now());
const rowOf = async (id: string) => (await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)))[0]!;
const messageOf = async (id: string | null) => (await ctx.db.select().from(messages).where(eq(messages.id, id!)))[0]!;
const texts = () => ctx.wa.sent.filter((x) => x.method === 'sendText');
const due = (extra: Partial<typeof scheduledMessages.$inferInsert> = {}) =>
  insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: inMin(-1), body: TEXT, ...extra });
const closeOriginal = () => ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));

describe('deliverDueScheduled (spec 2026-10-20 agendamentos §3.3)', () => {
  it('sends at its time and not before, as the author, exactly once', async () => {
    const row = await due({ sendAt: inMin(10) });
    expect(await beat()).toBe(0);
    ctx.clock.advance(10 * MIN);
    expect(await beat()).toBe(1);
    expect(await beat()).toBe(0);

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatchObject({ phone: PHONE, payload: { text: TEXT } });
    const done = await rowOf(row.id);
    expect(done).toMatchObject({ status: 'sent', error: null, finishedAt: ctx.clock.now() });
    const sent = await messageOf(done.messageId);
    expect(sent).toMatchObject({ chatId, authorId: s.agentA.id, body: TEXT, scheduled: true, status: 'sent' });
    expect((await toMessageDto(ctx.db, sent)).scheduled).toBe(true); // the bubble's "agendada" mark
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('two beats at the same time still send it once (Review Focus 1)', async () => {
    await due();
    const [a, b] = await Promise.all([beat(), beat()]);
    expect(a + b).toBe(1);
    expect(texts()).toHaveLength(1);
  });

  it('a row stuck in sending for more than 10 minutes fails and is never sent again (Review Focus 1)', async () => {
    const stuck = await due({ sendAt: inMin(-20), status: 'sending', claimedAt: inMin(-11) });
    const busy = await due({ sendAt: inMin(-5), status: 'sending', claimedAt: inMin(-5) });
    expect(await beat()).toBe(0);
    expect(await rowOf(stuck.id)).toMatchObject({ status: 'failed', error: FAIL.stuck, messageId: null });
    expect((await rowOf(busy.id)).status).toBe('sending');
    expect(texts()).toEqual([]);
    expect(ctx.hub.events).toContainEqual({ type: 'notification', chatId, userId: s.agentA.id });
  });

  it("signs like a normal send, with the author's signature at send time", async () => {
    await due({ signature: true });
    await beat();
    expect(texts()[0]!.payload).toMatchObject({ text: formatSignature(TEXT, signatureLabel(s.agentA, 'Financeiro')) });
  });

  it('sends the file stored at schedule time, with the text as its caption', async () => {
    const pdf = Buffer.from('%PDF-1.4 petição');
    const saved = await saveMedia(ctx.config.mediaDir, pdf, 'application/pdf', 'peticao.pdf');
    const row = await due({
      body: 'Segue a petição', mediaPath: saved.path, mediaMime: 'application/pdf', mediaName: 'peticao.pdf', mediaSize: saved.size,
      mediaSha256: saved.sha256,
    });
    expect(await beat()).toBe(1);
    expect(ctx.wa.sent.find((x) => x.method === 'sendMedia')?.payload).toMatchObject({
      media: { kind: 'document', base64: pdf.toString('base64'), mime: 'application/pdf', fileName: 'peticao.pdf', caption: 'Segue a petição' },
    });
    expect(await messageOf((await rowOf(row.id)).messageId)).toMatchObject({ kind: 'document', mediaPath: saved.path, body: 'Segue a petição' });
  });

  it('a closed chat: opens a new chat in the original sector with the author as owner, like "Nova conversa" (Review Focus 2)', async () => {
    await closeOriginal();
    const row = await due();
    expect(await beat()).toBe(1);
    const [open] = await ctx.db.select().from(chats).where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
    expect(open).toMatchObject({ sectorId: s.sectorA, ownerId: s.agentA.id });
    expect((await messageOf((await rowOf(row.id)).messageId)).chatId).toBe(open!.id);
    expect((await eventsOf(ctx, open!.id))[0]).toMatchObject({ kind: 'created', authorId: s.agentA.id });
  });

  it('an open chat the author cannot see: fails with the reason, sends nothing and tells only the author (Review Focus 2)', async () => {
    await closeOriginal();
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, contactId });
    const row = await due();
    expect(await beat()).toBe(0);
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: 'Este contato já está em atendimento em outro setor', messageId: null });
    expect(texts()).toEqual([]);
    expect(ctx.hub.events.filter((e) => e.type === 'notification')).toEqual([{ type: 'notification', chatId, userId: s.agentA.id }]);
  });

  it('a deactivated author fails without sending', async () => {
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, s.agentA.id));
    const row = await due();
    await beat();
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: FAIL.authorInactive });
    expect(texts()).toEqual([]);
  });

  it('WhatsApp refusing it fails with the message id, so the bubble can be resent', async () => {
    ctx.wa.failNext();
    const row = await due();
    expect(await beat()).toBe(0);
    const failed = await rowOf(row.id);
    expect(failed).toMatchObject({ status: 'failed', error: FAIL.refused });
    expect(await messageOf(failed.messageId)).toMatchObject({ status: 'failed', scheduled: true });
  });

  it('a running chatbot keeps running', async () => {
    const runId = await runningBot(ctx, chatId, contactId);
    await due();
    expect(await beat()).toBe(1);
    expect((await ctx.db.select().from(botRuns).where(eq(botRuns.id, runId)))[0]!.state).toBe('waiting_reply');
  });

  it('more than an hour late (the server was down): fails without sending', async () => {
    const row = await due({ sendAt: inMin(-61) });
    await beat();
    expect(await rowOf(row.id)).toMatchObject({ status: 'failed', error: FAIL.late });
    expect(texts()).toEqual([]);
  });

  it('a cancelled row is never sent', async () => {
    await due({ status: 'canceled' });
    expect(await beat()).toBe(0);
    expect(texts()).toEqual([]);
  });
});

describe('the send route (Review Focus 6)', () => {
  it('never takes storedFile or scheduled from the body', async () => {
    const { app } = await makeTestApp(ctx);
    const { headers } = await loginAs(app, s.agentA.email);
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers,
      payload: {
        text: 'Oi', signature: false, scheduled: true,
        storedFile: { path: '../../segredo.txt', mime: 'text/plain', name: 'segredo.txt', size: 1, sha256: null },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'text', media: null, scheduled: false });
    await app.close();
  });
});
