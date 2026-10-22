import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledMessageDto } from '@talk/shared';
import { NOT_PENDING, REMINDER_LOCKED } from '../../src/automation/scheduled.js';
import { scheduledMessages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { multipart } from '../messages/actions-seed.js';
import { insertAppointment, insertScheduled } from './seed.js';

const MIN = 60_000;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let chatId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ana = (await loginAs(app, s.agentA.email)).headers;
  ({ chatId } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, name: 'Maria Cliente', phone: '5565999999999',
  }));
});
afterEach(async () => {
  await app.close();
});

/** `n` minutes after the fake clock (the server checks the limits against ctx.botRuntime.now()). */
const inMin = (n: number) => new Date(ctx.clock.now().getTime() + n * MIN).toISOString();
const schedule = (payload: object, headers = ana, id = chatId) =>
  app.inject({ method: 'POST', url: `/api/chats/${id}/scheduled-messages`, headers, payload });

describe('POST /api/chats/:id/scheduled-messages (spec 2026-10-20 agendamentos §3.1)', () => {
  it('schedules a text in an open chat, records the event and lists it in the chat', async () => {
    const res = await schedule({ text: '  Lembrete da audiência  ', sendAt: inMin(10), signature: true });
    expect(res.statusCode).toBe(200);
    const dto = res.json() as ScheduledMessageDto;
    expect(dto).toMatchObject({
      chatId, body: 'Lembrete da audiência', signature: true, attachment: null, sendAt: inMin(10), status: 'pending',
      authorId: s.agentA.id, authorName: 'Ana Financeiro', contact: { name: 'Maria Cliente', phone: '5565999999999' },
      messageId: null, sentChatId: null, canEdit: true,
    });
    expect(await eventsOf(ctx, chatId)).toMatchObject([
      { kind: 'message_scheduled', data: { scheduledId: dto.id, sendAt: inMin(10) }, authorId: s.agentA.id },
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
    const list = await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: ana });
    expect((list.json() as ScheduledMessageDto[]).map((r) => r.id)).toEqual([dto.id]);
  });

  it('stores the attachment when it is scheduled (multipart, fields before the file)', async () => {
    const pdf = Buffer.from('%PDF-1.4 petição');
    const mp = multipart({ text: 'Segue a petição', sendAt: inMin(10), signature: 'false' }, { name: 'peticao.pdf', mime: 'application/pdf', data: pdf });
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/scheduled-messages`, headers: { ...ana, 'content-type': mp.contentType }, payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'Segue a petição', signature: false, attachment: { name: 'peticao.pdf', mime: 'application/pdf', size: pdf.length } });
    const [row] = await ctx.db.select().from(scheduledMessages);
    expect(await readFile(join(ctx.config.mediaDir, row!.mediaPath!))).toEqual(pdf);
  });

  it('refuses a closed chat (409), a time out of bounds or no text (400), a hidden chat (404) and no Origin (403)', async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, state: 'closed' });
    const r409 = await schedule({ text: 'Oi', sendAt: inMin(10) }, ana, closed.chatId);
    expect([r409.statusCode, r409.json().error]).toEqual([409, 'Conversa finalizada']);

    const soon = await schedule({ text: 'Oi', sendAt: inMin(1) });
    expect([soon.statusCode, soon.json().error]).toEqual([400, 'Escolha um horário pelo menos 2 minutos à frente']);
    const far = await schedule({ text: 'Oi', sendAt: inMin(366 * 24 * 60) });
    expect([far.statusCode, far.json().error]).toEqual([400, 'Escolha um horário em até 1 ano']);
    expect((await schedule({ text: '   ', sendAt: inMin(10) })).statusCode).toBe(400);
    expect((await schedule({ text: 'x'.repeat(4097), sendAt: inMin(10) })).statusCode).toBe(400);
    expect((await schedule({ text: 'Oi', sendAt: '2026-10-14 13:10' })).statusCode).toBe(400);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await schedule({ text: 'Oi', sendAt: inMin(10) }, bruno)).statusCode).toBe(404);
    expect((await schedule({ text: 'Oi', sendAt: inMin(10) }, { cookie: ana.cookie! })).statusCode).toBe(403);

    expect(await ctx.db.select().from(scheduledMessages)).toEqual([]);
  });
});

describe('listing, editing and cancelling (spec §3.2)', () => {
  it("the page lists an agent's own rows and everyone's for an admin, by tab; the chat lists its pending ones", async () => {
    const mine = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(10)) });
    const brunos = await insertScheduled(ctx, { chatId, authorId: s.agentB.id, sendAt: new Date(inMin(5)) });
    const canceled = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(20)), status: 'canceled' });
    const admin = (await loginAs(app, s.admin.email)).headers;
    const ids = async (headers: Record<string, string>, status: string) =>
      ((await app.inject({ method: 'GET', url: `/api/scheduled-messages?status=${status}`, headers })).json() as ScheduledMessageDto[]).map((r) => r.id);

    expect(await ids(ana, 'pending')).toEqual([mine.id]);
    expect(await ids(admin, 'pending')).toEqual([brunos.id, mine.id]); // next first
    expect(await ids(ana, 'canceled')).toEqual([canceled.id]);
    expect(await ids(ana, 'sent')).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/scheduled-messages?status=nope', headers: ana })).statusCode).toBe(400);

    // the chat's own list: anyone who sees the chat, pending only, Editar only for the author (or an admin)
    const forChat = (await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: ana })).json() as ScheduledMessageDto[];
    expect(forChat.map((r) => [r.id, r.canEdit])).toEqual([[brunos.id, false], [mine.id, true]]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}/scheduled-messages`, headers: bruno })).statusCode).toBe(404);
  });

  it('the author or an admin edits and cancels; anyone else gets 404; a row no longer pending is 409', async () => {
    const created = (await schedule({ text: 'Lembrete', sendAt: inMin(10), signature: false })).json() as ScheduledMessageDto;
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    const admin = (await loginAs(app, s.admin.email)).headers;
    const patch = (headers: Record<string, string>, payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/scheduled-messages/${created.id}`, headers, payload });
    const cancel = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/api/scheduled-messages/${created.id}/cancel`, headers });

    expect((await patch(bruno, { text: 'x' })).statusCode).toBe(404);
    expect((await cancel(bruno)).statusCode).toBe(404);
    expect((await patch(ana, {})).statusCode).toBe(400);
    expect((await patch({ cookie: ana.cookie! }, { text: 'x' })).statusCode).toBe(403);

    const moved = await patch(admin, { sendAt: inMin(60) });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ sendAt: inMin(60), canEdit: true });
    expect((await patch(ana, { text: 'Lembrete: audiência às 9h' })).json()).toMatchObject({ body: 'Lembrete: audiência às 9h', sendAt: inMin(60) });
    expect((await patch(ana, { sendAt: inMin(1) })).statusCode).toBe(400);
    // a time change is an event; a text change is not
    expect((await eventsOf(ctx, chatId)).map((e) => [e.kind, e.data, e.authorId])).toEqual([
      ['message_scheduled', { scheduledId: created.id, sendAt: inMin(10) }, s.agentA.id],
      ['message_scheduled', { scheduledId: created.id, sendAt: inMin(60), edited: true }, s.admin.id],
    ]);

    expect((await cancel(ana)).json()).toMatchObject({ status: 'canceled', canEdit: false });
    expect((await eventsOf(ctx, chatId)).at(-1)).toMatchObject({ kind: 'scheduled_canceled', data: { scheduledId: created.id }, authorId: s.agentA.id });
    const again = await cancel(ana);
    expect([again.statusCode, again.json().error]).toEqual([409, NOT_PENDING]);
    expect((await patch(ana, { text: 'y' })).statusCode).toBe(409);
  });
});

describe('appointment reminders in the Agenda (spec 2026-10-21 compromissos §3.7, decision 4)', () => {
  it('a reminder carries its appointment, cannot be edited or cancelled there (409), and anyone else still gets 404 (Review Focus 4)', async () => {
    const { id: appointmentId, reminderId } = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: new Date(inMin(120)) });
    const reminder = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(60)), reminderId });
    const plain = await insertScheduled(ctx, { chatId, authorId: s.agentA.id, sendAt: new Date(inMin(30)) });
    const list = (await app.inject({ method: 'GET', url: '/api/scheduled-messages?status=pending', headers: ana })).json() as ScheduledMessageDto[];
    expect(list.map((r) => [r.id, r.canEdit, r.appointment])).toEqual([
      [plain.id, true, null],
      [reminder.id, false, { id: appointmentId, title: 'Audiência' }],
    ]);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    const patchIt = (headers: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/scheduled-messages/${reminder.id}`, headers, payload: { text: 'x' } });
    const cancelIt = () => app.inject({ method: 'POST', url: `/api/scheduled-messages/${reminder.id}/cancel`, headers: ana });
    expect((await patchIt(bruno)).statusCode).toBe(404);
    for (const res of [await patchIt(ana), await cancelIt()]) expect([res.statusCode, res.json().error]).toEqual([409, REMINDER_LOCKED]);
    // once it went out, the answer is still "change it through the appointment"
    await ctx.db.update(scheduledMessages).set({ status: 'sent' }).where(eq(scheduledMessages.id, reminder.id));
    expect((await cancelIt()).json().error).toBe(REMINDER_LOCKED);
    expect((await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, reminder.id)))[0]!.body).not.toBe('x');
  });
});
