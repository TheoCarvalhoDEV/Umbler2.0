// Reminder days are office-zone days: must not depend on the host zone. Set before anything reads the zone.
process.env.TZ = 'Asia/Tokyo';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APPOINTMENT_REMINDERS, type AppointmentDto } from '@talk/shared';
import { NO_CHAT_WITH_CONTACT } from '../../src/automation/appointments.js';
import { appointmentReminders, appointments, contacts, scheduledMessages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { eventsOf, insertChat } from '../inbox/fixtures.js';
import { insertAppointment } from './seed.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const [TWO_DAYS, ONE_HOUR] = DEFAULT_APPOINTMENT_REMINDERS.reminders;

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let ana: Record<string, string>;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z (09:00 in Cuiabá)
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ana = (await loginAs(app, s.agentA.email)).headers;
  ({ chatId, contactId } = await seedChat(ctx, {
    channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, name: 'Maria Cliente', phone: '5565999999999',
  }));
});
afterEach(async () => {
  await app.close();
});

/** `ms` after the fake clock (the server checks the limits against ctx.botRuntime.now()). */
const after = (ms: number) => new Date(ctx.clock.now().getTime() + ms).toISOString();
const dateIn = (ms: number) => new Date(ctx.clock.now().getTime() + ms);
const create = (payload: object, headers = ana) => app.inject({ method: 'POST', url: '/api/appointments', headers, payload });
/** In Ana's chat, 17/10/2026 14:00 in Cuiabá, with the two default reminders. */
const base = (over: object = {}) => ({ chatId, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', reminders: [TWO_DAYS, ONE_HOUR], ...over });
const rows = () => ctx.db.select().from(scheduledMessages).orderBy(scheduledMessages.sendAt);

describe('POST /api/appointments (spec 2026-10-21 compromissos §3.1–3.2)', () => {
  it('from the chat: saves it, turns each reminder into a scheduled message as the author, records the event and publishes', async () => {
    const res = await create(base({ note: '  Levar RG  ', signature: false }));
    expect(res.statusCode).toBe(200);
    const dto = res.json() as AppointmentDto;
    expect(dto).toMatchObject({
      chatId, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', note: 'Levar RG', canceledAt: null, canceledByName: null,
      canEdit: true, authorId: s.agentA.id, authorName: 'Ana Financeiro',
      contact: { id: contactId, name: 'Maria Cliente', phone: '5565999999999' },
    });
    const [first, second] = await rows();
    expect(first).toMatchObject({
      chatId, authorId: s.agentA.id, signature: false, status: 'pending', sendAt: new Date('2026-10-15T18:00:00.000Z'),
      body: 'Olá, Maria Cliente! Lembramos do seu compromisso (Audiência) no dia 17/10/2026, às 14:00 (horário de Cuiabá). Qualquer dúvida, é só responder esta mensagem.',
    });
    expect(second).toMatchObject({
      signature: false, sendAt: new Date('2026-10-17T17:00:00.000Z'),
      body: 'Olá, Maria Cliente! Seu compromisso (Audiência) é às 14:00 de 17/10/2026 (horário de Cuiabá).',
    });
    expect(dto.reminders.map((r) => [r.amount, r.unit, r.status, r.sendAt, r.scheduledId])).toEqual([
      [2, 'days', 'pending', '2026-10-15T18:00:00.000Z', first!.id],
      [1, 'hours', 'pending', '2026-10-17T17:00:00.000Z', second!.id],
    ]);
    // the reminder keeps the placeholders, to fill them again on a reschedule
    expect((await ctx.db.select().from(appointmentReminders)).map((r) => r.text).sort()).toEqual([TWO_DAYS!.text, ONE_HOUR!.text].sort());
    expect([first!.reminderId, second!.reminderId].sort()).toEqual(dto.reminders.map((r) => r.id).sort());
    const events = await eventsOf(ctx, chatId);
    expect(events.map((e) => [e.kind, e.data, e.authorId])).toEqual([
      ['appointment_scheduled', { appointmentId: dto.id, title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z' }, s.agentA.id],
    ]);
    expect(ctx.hub.events).toContainEqual({ type: 'chat', chatId });
  });

  it('a reminder whose send time is under 2 minutes away is saved "Não criado"; with all of them so, the appointment saves anyway', async () => {
    // in 1 h 05 min: "2 dias antes" already passed, "1 hora antes" goes in 5 minutes
    const soon = (await create(base({ startsAt: after(65 * MIN) }))).json() as AppointmentDto;
    expect(soon.reminders.map((r) => [r.unit, r.status, r.scheduledId === null])).toEqual([
      ['days', 'skipped', true],
      ['hours', 'pending', false],
    ]);
    expect((await rows()).map((r) => [r.sendAt.toISOString(), r.signature])).toEqual([[after(5 * MIN), true]]); // signature on by default
    // in 61 min: "1 hora antes" would be 1 minute from now
    const tooSoon = await create(base({ startsAt: after(61 * MIN), reminders: [ONE_HOUR] }));
    expect(tooSoon.statusCode).toBe(200);
    expect((tooSoon.json() as AppointmentDto).reminders).toMatchObject([{ status: 'skipped', scheduledId: null, sendAt: after(MIN), error: null }]);
    expect(await rows()).toHaveLength(1);
  });

  it('refuses a time out of bounds and bad reminders (400), a hidden or private chat (404), and no Origin (403)', async () => {
    const err = async (payload: object) => {
      const r = await create(payload);
      return [r.statusCode, r.json().error];
    };
    expect(await err(base({ startsAt: after(-MIN) }))).toEqual([400, 'Este horário já passou; escolha uma data e hora futuras']);
    expect(await err(base({ startsAt: after(366 * DAY) }))).toEqual([400, 'Escolha um horário em até 1 ano']);
    expect(await err(base({ reminders: [{ ...ONE_HOUR, text: 'Olá, {Nome}!' }] }))).toEqual([
      400, 'Marcador desconhecido: {Nome}. Use {nome}, {titulo}, {data} ou {hora}',
    ]);
    expect(await err(base({ reminders: [{ amount: 2, unit: 'days', text: 'Oi' }, { amount: 48, unit: 'hours', text: 'Oi' }] }))).toEqual([
      400, 'Dois lembretes cairiam no mesmo horário',
    ]);
    for (const payload of [
      base({ reminders: [] }),
      base({ reminders: Array.from({ length: 6 }, (_, i) => ({ amount: i + 1, unit: 'hours', text: 'Oi' })) }),
      base({ reminders: [{ amount: 31, unit: 'days', text: 'Oi' }] }),
      base({ reminders: [{ amount: 49, unit: 'hours', text: 'Oi' }] }),
      base({ reminders: [{ amount: 0, unit: 'hours', text: 'Oi' }] }),
      base({ reminders: [{ amount: 1, unit: 'weeks', text: 'Oi' }] }),
      base({ reminders: [{ ...ONE_HOUR, text: '   ' }] }),
      base({ title: '  ' }),
      base({ title: 'x'.repeat(121) }),
      base({ note: 'x'.repeat(2001) }),
      base({ startsAt: '2026-10-17 14:00' }),
      base({ contactId }), // both chatId and contactId
      { title: 'Audiência', startsAt: '2026-10-17T18:00:00.000Z', reminders: [ONE_HOUR] }, // neither
    ]) {
      expect((await create(payload)).statusCode).toBe(400);
    }

    // {nome} for a contact without a name (decision 6)
    const nameless = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565988887777' });
    await ctx.db.update(contacts).set({ name: null }).where(eq(contacts.id, nameless.contactId));
    expect(await err(base({ chatId: nameless.chatId }))).toEqual([400, 'O contato não tem nome cadastrado; tire {nome} do lembrete']);
    expect((await create(base({ chatId: nameless.chatId, reminders: [{ ...ONE_HOUR, text: 'Seu compromisso é às {hora}.' }] }))).statusCode).toBe(200);

    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await create(base(), bruno)).statusCode).toBe(404);
    const brunosPrivate = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentB.id, private: true, phone: '5565977776666',
    });
    expect((await create(base({ chatId: brunosPrivate.chatId }))).statusCode).toBe(404);
    expect((await create(base(), { cookie: ana.cookie! })).statusCode).toBe(403);
    expect(await ctx.db.select().from(appointments)).toHaveLength(1); // only the nameless one without {nome}
  });

  it('a closed chat and a WhatsApp history chat are accepted (decision 8)', async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, state: 'closed', phone: '5565966665555' });
    expect((await create(base({ chatId: closed.chatId }))).statusCode).toBe(200);
    const history = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, state: 'closed', history: true });
    expect((await create(base({ chatId: history }))).statusCode).toBe(200);
  });

  it('by contactId: the open chat the user sees, else the newest one they see; none → 400; no such contact → 404 (Review Focus 3)', async () => {
    const byContact = (id: string) => create({ ...base(), chatId: undefined, contactId: id });
    // Maria: her open chat wins over an older closed one
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    expect((await byContact(contactId)).json()).toMatchObject({ chatId });

    // João: his open chat is in Bruno's sector, so Ana gets the newest of the two closed ones she sees
    const joao = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, ownerId: s.agentB.id, phone: '5565955554444', name: 'João' });
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId: joao.contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    const newest = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, contactId: joao.contactId, state: 'closed', at: new Date('2026-10-10T12:00:00Z'),
    });
    expect((await byContact(joao.contactId)).json()).toMatchObject({ chatId: newest.chatId });

    // a contact Ana has no chat with
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, phone: '5565944443333' });
    const none = await byContact(other.contactId);
    expect([none.statusCode, none.json().error]).toEqual([400, NO_CHAT_WITH_CONTACT]);
    expect((await byContact('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('listing (spec §3.4–3.5)', () => {
  it("the chat lists the contact's upcoming appointments in every chat the user sees, next first (Review Focus 3)", async () => {
    const closed = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId, state: 'closed', at: new Date('2026-10-01T12:00:00Z') });
    const hidden = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, contactId, state: 'closed', at: new Date('2026-10-02T12:00:00Z') });
    const later = await insertAppointment(ctx, { chatId, authorId: s.agentB.id, startsAt: dateIn(3 * DAY) });
    const sooner = await insertAppointment(ctx, { chatId: closed.chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    await insertAppointment(ctx, { chatId: hidden.chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY) }); // a chat Ana cannot see
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY), canceledAt: dateIn(0) });
    await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR) }); // already passed
    const list = (headers = ana, id = chatId) => app.inject({ method: 'GET', url: `/api/chats/${id}/appointments`, headers });

    const dtos = (await list()).json() as AppointmentDto[];
    expect(dtos.map((d) => [d.id, d.canEdit])).toEqual([[sooner.id, true], [later.id, false]]); // Bruno's: no Editar for Ana
    expect(dtos[0]!.reminders).toMatchObject([{ amount: 1, unit: 'hours', status: 'skipped', scheduledId: null, sendAt: dateIn(DAY - HOUR).toISOString() }]);
    // the same list from the contact's other chat
    expect(((await list(ana, closed.chatId)).json() as AppointmentDto[]).map((d) => d.id)).toEqual([sooner.id, later.id]);
    const bruno = (await loginAs(app, s.agentB.email)).headers;
    expect((await list(bruno)).statusCode).toBe(404);
  });

  it("the Agenda tab lists an agent's own appointments and everyone's for an admin, by tab, in order, up to 100", async () => {
    const mineSoon = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(DAY) });
    const mineLater = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(2 * DAY) });
    const brunos = await insertAppointment(ctx, { chatId, authorId: s.agentB.id, startsAt: dateIn(HOUR) });
    const pastOld = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-2 * DAY) });
    const pastNew = await insertAppointment(ctx, { chatId, authorId: s.agentA.id, startsAt: dateIn(-HOUR) });
    const canceled = await insertAppointment(ctx, {
      chatId, authorId: s.agentA.id, startsAt: dateIn(DAY), canceledAt: dateIn(0), canceledBy: s.agentA.id,
    });
    const admin = (await loginAs(app, s.admin.email)).headers;
    const get = (headers: Record<string, string>, tab: string) => app.inject({ method: 'GET', url: `/api/appointments?tab=${tab}`, headers });
    const ids = async (headers: Record<string, string>, tab: string) => ((await get(headers, tab)).json() as AppointmentDto[]).map((d) => d.id);

    expect(await ids(ana, 'upcoming')).toEqual([mineSoon.id, mineLater.id]);
    expect(await ids(admin, 'upcoming')).toEqual([brunos.id, mineSoon.id, mineLater.id]); // next first
    expect(await ids(ana, 'past')).toEqual([pastNew.id, pastOld.id]); // newest first
    expect(await ids(ana, 'canceled')).toEqual([canceled.id]);
    expect(((await get(ana, 'canceled')).json() as AppointmentDto[])[0]).toMatchObject({ canceledByName: 'Ana Financeiro', canEdit: false });
    expect((await get(ana, 'nope')).statusCode).toBe(400);

    await ctx.db.insert(appointments).values(
      Array.from({ length: 100 }, (_, i) => ({ chatId, authorId: s.agentA.id, title: `C${i}`, startsAt: dateIn(3 * DAY + i * MIN) })),
    );
    expect(await ids(ana, 'upcoming')).toHaveLength(100);
  });
});
