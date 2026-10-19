import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { chatEvents, chats, contacts, messages, settings } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import {
  getTriageMenu,
  handleTriageReply,
  matchTriageOption,
  startTriage,
  type TriageMenu,
} from '../../src/triage/triage.js';

const sectorNames = new Map<string, string>([
  ['s-fin', 'Financeiro'],
  ['s-jur', 'Jurídico'],
]);

const menu: TriageMenu = {
  enabled: true,
  welcomeText: 'Olá! Escolha uma opção:',
  invalidText: 'Opção inválida.',
  options: [
    { key: '1', label: 'Financeiro e boletos', sectorId: 's-fin' },
    { key: '2', label: 'Processos', sectorId: 's-jur' },
    { key: '3', label: 'Setor apagado', sectorId: 's-gone' },
  ],
};

describe('matchTriageOption', () => {
  it.each([
    ['1', '1'],
    [' 2 ', '2'],
    ['1.', '1'],
    ['(2)', '2'],
    ['2)', '2'],
    ['financeiro', '1'],
    ['FINANCEIRO!', '1'],
    ['Financeiro e boletos', '1'],
    ['financeiro   e  boletos', '1'],
    ['Jurídico', '2'],
    ['juridico', '2'],
    ['JURIDICO.', '2'],
    ['processos', '2'],
    ['"Processos"', '2'],
    ['1\nquero saber do meu boleto', '1'], // the whole text matches nothing, its first line does
    ['Bom dia!\nJurídico', '2'],
  ])('%j matches option %s', (text, key) => {
    expect(matchTriageOption(text, menu, sectorNames)?.key).toBe(key);
  });

  it.each([
    ['3'], // option whose sector no longer exists
    ['setor apagado'],
    ['12'],
    [''],
    ['   '],
    ['...'],
    ['oi, quero falar com o financeiro'],
    ['oi\nquero falar com alguém'],
    ['\n \n'],
  ])('%j matches nothing', (text) => {
    expect(matchTriageOption(text, menu, sectorNames)).toBeNull();
  });
});

describe('getTriageMenu', () => {
  it('returns a disabled empty menu when the setting is missing', async () => {
    const ctx = await makeTestCtx();
    await ctx.db.delete(settings).where(eq(settings.key, 'triage_menu'));
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('returns a disabled empty menu when the stored value is malformed', async () => {
    const ctx = await makeTestCtx();
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value: { enabled: 'sim' } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { enabled: 'sim' } } });
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('maps the snake_case jsonb to TriageMenu', async () => {
    const ctx = await makeTestCtx();
    const value = {
      enabled: true,
      welcome_text: 'Olá!',
      invalid_text: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sector_id: 's-fin' }],
    };
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    expect(await getTriageMenu(ctx.db)).toEqual({
      enabled: true,
      welcomeText: 'Olá!',
      invalidText: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sectorId: 's-fin' }],
    });
  });
});

const PHONE = '5565999990000';
const WELCOME = 'Olá! Escolha uma opção:';
const INVALID = 'Não entendi. Um atendente vai te responder.';

async function setup(enabled = true) {
  const ctx = await makeTestCtx();
  const seed = await seedBasics(ctx);
  const value = {
    enabled,
    welcome_text: WELCOME,
    invalid_text: INVALID,
    options: [
      { key: '1', label: 'Boletos', sector_id: seed.sectorA },
      { key: '2', label: 'Processos', sector_id: seed.sectorB },
      { key: '3', label: 'Setor apagado', sector_id: crypto.randomUUID() },
    ],
  };
  await ctx.db
    .insert(settings)
    .values({ key: 'triage_menu', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
  const contactId = crypto.randomUUID();
  const now = new Date();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria', phone: PHONE, createdAt: now, updatedAt: now });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: seed.defaultSector, ownerId: null, waiting: true, triagePending: false, createdBy: null },
  });
  return { ctx, seed, chat };
}

async function reload(ctx: Awaited<ReturnType<typeof makeTestCtx>>, chatId: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row;
}

async function chatMessages(ctx: Awaited<ReturnType<typeof makeTestCtx>>, chatId: string) {
  return ctx.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(messages.createdAt);
}

describe('startTriage', () => {
  it('sends the welcome text with numbered options and sets triage_pending', async () => {
    const { ctx, seed, chat } = await setup();

    await startTriage(ctx, chat);

    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendText', instance: seed.instance, phone: PHONE });
    const expectedText = `${WELCOME}\n\n1 - Boletos\n2 - Processos`; // option 3 points to a deleted sector
    expect(JSON.stringify(ctx.wa.sent[0].payload)).toContain(JSON.stringify(expectedText).slice(1, -1));

    const [msg] = await chatMessages(ctx, chat.id);
    expect(msg).toMatchObject({
      direction: 'out',
      kind: 'text',
      body: expectedText,
      authorId: null,
      status: 'sent',
      error: null,
    });
    expect(msg.externalId).toMatch(/^fake-/);

    const after = await reload(ctx, chat.id);
    expect(after.triagePending).toBe(true);
    expect(after.waiting).toBe(true); // system message does not clear "Esperando"
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(after.ownerId).toBeNull();
    expect(after.lastMessagePreview).toBe(expectedText.slice(0, 100));

    const msgEvents = ctx.hub.events.filter((e) => e.messageId === msg.id).map((e) => e.type);
    expect(msgEvents).toEqual(['message.created', 'message.updated']);
    expect(ctx.hub.events.some((e) => e.chatId === chat.id && e.messageId === undefined)).toBe(true);
  });

  it('does nothing when the menu is disabled', async () => {
    const { ctx, chat } = await setup(false);

    await startTriage(ctx, chat);

    expect(ctx.wa.sent).toHaveLength(0);
    expect(await chatMessages(ctx, chat.id)).toHaveLength(0);
    expect((await reload(ctx, chat.id)).triagePending).toBe(false);
  });

  it('marks the menu message failed and leaves triage off when sending fails', async () => {
    const { ctx, chat } = await setup();
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    await startTriage(ctx, chat);

    const [msg] = await chatMessages(ctx, chat.id);
    expect(msg.status).toBe('failed');
    expect(msg.error).toBe('Evolution fora do ar');
    expect((await reload(ctx, chat.id)).triagePending).toBe(false);
  });

  it('keeps one menu row and stays armed when the webhook echo beats the gateway response', async () => {
    const { ctx, chat } = await setup();
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // What Task 9's ingest does with Evolution's fromMe echo while our call is still pending:
      // an author-less 'out' copy with our external_id, and waiting/triage_pending cleared.
      await ctx.db.insert(messages).values({
        id: crypto.randomUUID(), chatId: chat.id, channelId: chat.channelId, direction: 'out', kind: 'text',
        body: text, authorId: null, externalId: res.externalId, status: 'sent', sentAt: new Date(),
      });
      await ctx.db.update(chats).set({ waiting: false, triagePending: false }).where(eq(chats.id, chat.id));
      return res;
    });

    await startTriage(ctx, chat);

    const msgs = await chatMessages(ctx, chat.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: 'sent', error: null, authorId: null });
    expect(msgs[0].externalId).toMatch(/^fake-/);
    const after = await reload(ctx, chat.id);
    expect(after.triagePending).toBe(true);
    expect(after.waiting).toBe(true); // the echo's ingest cleared it; system messages must not
  });
});

describe('handleTriageReply', () => {
  it('routes to the chosen sector on a valid reply', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    const pending = await reload(ctx, chat.id);
    ctx.hub.events.length = 0;

    expect(await handleTriageReply(ctx, pending, ' Jurídico! ')).toBe(true);

    const after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.sectorB);
    expect(after.triagePending).toBe(false);
    expect(after.ownerId).toBeNull();
    expect(ctx.wa.sent).toHaveLength(1); // only the menu, no extra message

    const routed = await ctx.db
      .select()
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chat.id), eq(chatEvents.kind, 'triage_routed')));
    expect(routed).toHaveLength(1);
    expect(routed[0].data).toEqual({ sectorId: seed.sectorB, option: '2' });
    expect(routed[0].authorId).toBeNull();
    expect(ctx.hub.events.some((e) => e.chatId === chat.id && e.messageId === undefined)).toBe(true);
  });

  it('routes by option number', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), '1')).toBe(true);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.sectorA);
  });

  it('sends the invalid text once and keeps the default sector', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), 'quero falar com alguém')).toBe(true);

    let after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(after.triagePending).toBe(false);
    expect(ctx.wa.sent).toHaveLength(2);
    const msgs = await chatMessages(ctx, chat.id);
    expect(msgs[1]).toMatchObject({ direction: 'out', authorId: null, body: INVALID, status: 'sent' });

    // A second unmatched message is no longer a triage answer: no second invalid text.
    expect(await handleTriageReply(ctx, after, 'alô?')).toBe(false);
    after = await reload(ctx, chat.id);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(2);
  });

  it('keeps "Esperando" when the echo of the invalid text beats the gateway response', async () => {
    const { ctx, chat } = await setup();
    await startTriage(ctx, chat);
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // The fromMe echo's ingest while our call is pending: author-less copy, waiting/triage_pending cleared.
      await ctx.db.insert(messages).values({
        id: crypto.randomUUID(), chatId: chat.id, channelId: chat.channelId, direction: 'out', kind: 'text',
        body: text, authorId: null, externalId: res.externalId, status: 'sent', sentAt: new Date(),
      });
      await ctx.db.update(chats).set({ waiting: false, triagePending: false }).where(eq(chats.id, chat.id));
      return res;
    });

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), 'quero falar com alguém')).toBe(true);

    const after = await reload(ctx, chat.id);
    expect(after.waiting).toBe(true); // nobody answered the contact yet
    expect(after.triagePending).toBe(false);
    expect((await chatMessages(ctx, chat.id)).filter((m) => m.body === INVALID)).toHaveLength(1);
  });

  it('sends the menu to a contact known only by LID', async () => {
    const { ctx, chat } = await setup();
    await ctx.db.update(contacts).set({ phone: null, lid: '987654321' }).where(eq(contacts.id, chat.contactId));
    await startTriage(ctx, chat);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendText', phone: '987654321@lid' });
    expect((await reload(ctx, chat.id)).triagePending).toBe(true);
  });

  it('treats a media message (null text) as an invalid reply', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), null)).toBe(true);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(2);
  });

  it('answers only once when the same pending chat row is handled twice', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    const pending = await reload(ctx, chat.id);

    // PGlite serializes transactions, so this runs the two replies one after the other; it checks the
    // `WHERE triage_pending = true` guard, not real lock behaviour (that relies on the conditional UPDATE).
    const results = await Promise.all([
      handleTriageReply(ctx, pending, '2'),
      handleTriageReply(ctx, pending, '1'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const routed = await ctx.db
      .select()
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chat.id), eq(chatEvents.kind, 'triage_routed')));
    expect(routed).toHaveLength(1);
    expect([seed.sectorA, seed.sectorB]).toContain((await reload(ctx, chat.id)).sectorId);
  });

  it('returns false and does nothing when no triage is pending', async () => {
    const { ctx, seed, chat } = await setup();

    expect(await handleTriageReply(ctx, chat, '1')).toBe(false);
    expect((await reload(ctx, chat.id)).sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(0);
  });

  it('clears the flag without sending anything when the menu was disabled meanwhile', async () => {
    const { ctx, seed, chat } = await setup();
    await startTriage(ctx, chat);
    await ctx.db
      .update(settings)
      .set({ value: { enabled: false, welcome_text: '', invalid_text: INVALID, options: [] } })
      .where(eq(settings.key, 'triage_menu'));

    expect(await handleTriageReply(ctx, await reload(ctx, chat.id), 'qualquer coisa')).toBe(true);
    const after = await reload(ctx, chat.id);
    expect(after.triagePending).toBe(false);
    expect(after.sectorId).toBe(seed.defaultSector);
    expect(ctx.wa.sent).toHaveLength(1);
  });
});
