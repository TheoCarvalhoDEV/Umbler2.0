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
describe('send_message', () => {
  it('renders variables, tags the message with the run and follows next', async () => {
    const run = await runFlow([node('ola', 'send_message', { text: 'Olá {{contato.primeiro_nome}}!', attachment: null, signature: false })]);

    expect(run.state).toBe('finished');
    expect(outcome(run, 'ola')).toBe('next');
    expect(texts()).toEqual(['Olá Maria!']);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg).toMatchObject({ direction: 'out', authorId: null, botRunId: run.id, body: 'Olá Maria!', status: 'sent' });
  });

  it('sends a file from the bot library with the rendered caption', async () => {
    await mkdir(join(ctx.config.mediaDir, 'bots'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'bots', 'foto.png'), Buffer.from('png'));

    const run = await runFlow([
      node('foto', 'send_message', {
        text: 'Para {{contato.nome}}',
        attachment: { path: 'bots/foto.png', name: 'foto.png', mime: 'image/png', size: 3 },
        signature: false,
      }),
    ]);

    expect(run.state).toBe('finished');
    expect(ctx.wa.sent).toHaveLength(1);
    expect(ctx.wa.sent[0]).toMatchObject({ method: 'sendMedia', payload: { media: { kind: 'image', caption: 'Para Maria Silva', fileName: 'foto.png' } } });
  });

  it('refuses an attachment outside the bot library without sending', async () => {
    const run = await runFlow([
      node('arquivo', 'send_message', {
        text: '',
        attachment: { path: 'bots/../../segredo.txt', name: 'segredo.txt', mime: 'text/plain', size: 1 },
        signature: false,
      }),
    ]);

    expect(run).toMatchObject({ state: 'failed', error: 'Arquivo do chatbot inválido' });
    expect(ctx.wa.sent).toHaveLength(0);
  });

  it('follows error when WhatsApp refuses the message', async () => {
    ctx.wa.failNext();

    const run = await runFlow(
      [node('ola', 'send_message', { text: 'Oi', attachment: null, signature: false }), node('falhou', 'note', { text: 'Envio falhou' })],
      [edge('ola', 'error', 'falhou')],
    );

    expect(outcome(run, 'ola')).toBe('error');
    expect(run.state).toBe('finished');
    expect((await eventsOf(ctx, chatId)).filter((e) => e.kind === 'bot_note')).toHaveLength(1);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg!.status).toBe('failed');
  });

  it('fails the run when the send fails and error is not connected', async () => {
    ctx.wa.failNext();

    const run = await runFlow([node('ola', 'send_message', { text: 'Oi', attachment: null, signature: false })]);

    expect(run).toMatchObject({ state: 'failed', error: 'Não foi possível enviar a mensagem' });
  });
});

describe('note', () => {
  it('writes a bot_note event with the rendered text and sends nothing', async () => {
    const run = await runFlow([node('nota', 'note', { text: 'Cliente {{contato.nome}} entrou pelo bot' })]);

    expect(run.state).toBe('finished');
    expect(outcome(run, 'nota')).toBe('next');
    expect(ctx.wa.sent).toHaveLength(0);
    const ev = (await eventsOf(ctx, chatId)).find((e) => e.kind === 'bot_note');
    expect(ev).toMatchObject({
      authorId: null,
      data: { botId: run.botId, botName: expect.stringMatching(/^Teste /), runId: run.id, text: 'Cliente Maria Silva entrou pelo bot' },
    });
  });
});

describe('set_contact_field', () => {
  it('renders the value into a custom field and into the contact name', async () => {
    const [field] = await ctx.db.insert(customFields).values({ name: 'Origem', kind: 'text' }).returning();

    const run = await runFlow(
      [
        node('origem', 'set_contact_field', { fieldId: field!.id, value: 'Bot {{contato.primeiro_nome}}' }),
        node('nome', 'set_contact_field', { fieldId: 'native:name', value: 'Maria Souza' }),
      ],
      [edge('origem', 'next', 'nome')],
    );

    expect(run.state).toBe('finished');
    const [saved] = await ctx.db
      .select()
      .from(contactFieldValues)
      .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, field!.id)));
    expect(saved?.value).toBe('Bot Maria');
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.name).toBe('Maria Souza');
  });

  it('fails with "Campo inexistente" for a missing field, and follows error when connected', async () => {
    const failed = await runFlow([node('campo', 'set_contact_field', { fieldId: randomUUID(), value: 'x' })]);
    expect(failed).toMatchObject({ state: 'failed', error: 'Campo inexistente' });

    const handled = await runFlow(
      [node('campo', 'set_contact_field', { fieldId: 'nao-e-uuid', value: 'x' }), node('erro', 'note', { text: 'sem campo' })],
      [edge('campo', 'error', 'erro')],
    );
    expect(outcome(handled, 'campo')).toBe('error');
    expect(handled.state).toBe('finished');
  });
});

describe('edit_tags', () => {
  async function newTag(name: string): Promise<string> {
    const [t] = await ctx.db.insert(tags).values({ name, color: 'blue' }).returning();
    return t!.id;
  }

  it('adds and removes contact tags and keeps the others', async () => {
    const vip = await newTag('VIP');
    const novo = await newTag('Novo');
    const antigo = await newTag('Antigo');
    await ctx.db.insert(contactTags).values([{ contactId, tagId: vip }, { contactId, tagId: antigo }]);

    const run = await runFlow([node('etiquetas', 'edit_tags', { add: [novo, vip], remove: [antigo] })]);

    expect(run.state).toBe('finished');
    const rows = await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, contactId));
    expect(rows.map((r) => r.tagId).sort()).toEqual([vip, novo].sort());
  });

  it('fails with "Etiqueta inexistente" and leaves the tags alone', async () => {
    const vip = await newTag('VIP');
    await ctx.db.insert(contactTags).values({ contactId, tagId: vip });

    const run = await runFlow([node('etiquetas', 'edit_tags', { add: [randomUUID()], remove: [vip] })]);

    expect(run).toMatchObject({ state: 'failed', error: 'Etiqueta inexistente' });
    const rows = await ctx.db.select().from(contactTags).where(eq(contactTags.contactId, contactId));
    expect(rows.map((r) => r.tagId)).toEqual([vip]);
  });
});

const MENU = {
  text: 'Escolha uma opção:',
  options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }, { key: '3', label: 'Jurídico' }],
  invalidRetries: 1,
  timeoutHours: 24,
};
const MENU_TEXT = 'Escolha uma opção:\n\n1: Atendimento\n2: Financeiro\n3: Jurídico';

const askInput = (over: Record<string, unknown>) => ({
  text: 'Informe:', validator: 'any', useLastMessage: false, invalidRetries: 1, timeoutHours: null, saveToField: null, ...over,
});

describe('ask_choice', () => {
  it('sends the numbered menu and waits with a timeout', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);

    expect(texts()).toEqual([MENU_TEXT]);
    expect(run).toMatchObject({ state: 'waiting_reply', waitNodeId: 'menu' });
    expect(run.timeoutAt?.getTime()).toBe(ctx.clock.now().getTime() + 24 * HOUR);
    const [msg] = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(msg!.botRunId).toBe(run.id);
  });

  it('waits forever when timeoutHours is null', async () => {
    const run = await runFlow([node('menu', 'ask_choice', { ...MENU, timeoutHours: null })]);

    expect(run.state).toBe('waiting_reply');
    expect(run.timeoutAt).toBeNull();
  });

  it.each([
    ['2', '2', 'Financeiro'],
    [' juridico. ', '3', 'Jurídico'],
    ['ATENDIMENTO', '1', 'Atendimento'],
    ['1\nquero saber do meu processo', '1', 'Atendimento'], // a line of the reply
    ['3: Jurídico', '3', 'Jurídico'], // the menu line itself
  ])('matches the reply %j to option %s by key or label, ignoring case and accents', async (body, key, label) => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);

    await reply(body);

    const after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe(`opt:${key}`);
    expect(after.state).toBe('finished');
    expect(after.vars.menu).toEqual({ raw: body, value: key, label });
  });

  it('follows the edge of the chosen option', async () => {
    const run = await runFlow(
      [node('menu', 'ask_choice', MENU), node('financeiro', 'note', { text: 'Foi para o financeiro' })],
      [edge('menu', 'opt:2', 'financeiro')],
    );

    await reply('2');

    expect(outcome(await reloadRun(run.id), 'financeiro')).toBe('next');
    expect((await eventsOf(ctx, chatId)).some((e) => e.kind === 'bot_note' && e.data.text === 'Foi para o financeiro')).toBe(true);
  });

  it('an invalid edge back into the menu sends the menu again with fresh retries', async () => {
    const run = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidRetries: 0 })], [edge('menu', 'invalid', 'menu')]);

    await reply('x');

    const after = await reloadRun(run.id);
    expect(after).toMatchObject({ state: 'waiting_reply', waitNodeId: 'menu', retries: 0 });
    expect(after.steps.map((s) => s.outcome)).toEqual(['next', 'wait:reply', 'invalid', 'wait:reply']);
    expect(texts()).toEqual([MENU_TEXT, MENU_TEXT]);

    await reply('2');
    expect(outcome(await reloadRun(run.id), 'menu')).toBe('opt:2');
  });

  it('sends the invalid text and the menu again, then takes invalid when retries run out', async () => {
    const run = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidText: 'Não entendi, {{contato.primeiro_nome}}.' })]);

    await reply('quero falar com alguém');
    let after = await reloadRun(run.id);
    expect(after).toMatchObject({ state: 'waiting_reply', retries: 1 });
    expect(after.timeoutAt?.getTime()).toBe(run.timeoutAt?.getTime());
    expect(texts()).toEqual([MENU_TEXT, 'Não entendi, Maria.', MENU_TEXT]);

    await reply('9');
    after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe('invalid');
    expect(after.state).toBe('finished');
    expect(texts()).toHaveLength(3);
    expect(after.vars.menu).toBeUndefined();
  });

  it('uses "Opção inválida." when no invalid text is set, and goes straight to invalid with 0 retries', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);
    await reply('x');
    expect(texts()).toEqual([MENU_TEXT, 'Opção inválida.', MENU_TEXT]);

    const otherChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector });
    const strict = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidRetries: 0 })], [], otherChat);
    await reply('x', {}, otherChat);
    expect(outcome(await reloadRun(strict.id), 'menu')).toBe('invalid');
    expect(texts()).toHaveLength(4); // only the second chat's menu was added
    expect((await reloadRun(run.id)).state).toBe('waiting_reply');
  });

  it('takes timeout once the deadline passes', async () => {
    const run = await runFlow([node('menu', 'ask_choice', MENU)]);
    const start = ctx.clock.now().getTime();

    expect(await resumeOnTimer(ctx, run.id, new Date(start + 23 * HOUR))).toBeNull();
    await resumeOnTimer(ctx, run.id, new Date(start + 25 * HOUR));

    const after = await reloadRun(run.id);
    expect(outcome(after, 'menu')).toBe('timeout');
    expect(after.state).toBe('finished');
  });

  it('follows error when the menu cannot be sent', async () => {
    ctx.wa.failNext();

    const run = await runFlow(
      [node('menu', 'ask_choice', MENU), node('falhou', 'note', { text: 'menu falhou' })],
      [edge('menu', 'error', 'falhou')],
    );

    expect(outcome(run, 'menu')).toBe('error');
    expect(run.state).toBe('finished');
  });
});

describe('ask_input', () => {
  it('useLastMessage reads the stored message without the agent signature in front of it', async () => {
    await storeInbound('*Atendimento - Ana:*\nMaria Silva');

    const run = await runFlow([node('nome', 'ask_input', askInput({ useLastMessage: true }))]);

    expect(run.state).toBe('finished');
    expect(run.vars.nome).toEqual({ raw: 'Maria Silva', value: 'Maria Silva' });
    expect(texts()).toEqual([]); // nothing was asked
  });

  it('treats a sticker reply to ask_choice as invalid and an audio reply to ask_input(any) as valid', async () => {
    const choice = await runFlow([node('menu', 'ask_choice', { ...MENU, invalidRetries: 0 })]);
    await reply(null, { kind: 'sticker', mediaMime: 'image/webp' });
    expect(outcome(await reloadRun(choice.id), 'menu')).toBe('invalid');

    const otherChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.defaultSector });
    const input = await runFlow([node('pergunta', 'ask_input', askInput({ text: 'Mande sua dúvida' }))], [], otherChat);
    await reply(null, { kind: 'audio', mediaMime: 'audio/ogg' }, otherChat);
    const after = await reloadRun(input.id);
    expect(outcome(after, 'pergunta')).toBe('next');
    expect(after.vars.pergunta).toEqual({ raw: '', value: 'audio' });
  });

  it('validates a CPF, retries without repeating the question, saves the formatted value and keeps the raw text', async () => {
    const [field] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'cpf' }).returning();
    const run = await runFlow([
      node('cpf', 'ask_input', askInput({
        text: 'Digite seu CPF:', validator: 'cpf', invalidText: 'CPF inválido, confira e digite de novo.',
        invalidRetries: 2, timeoutHours: 24, saveToField: field!.id,
      })),
    ]);
    expect(texts()).toEqual(['Digite seu CPF:']);

    await reply('123.456.789-00');
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });
    expect(texts()).toEqual(['Digite seu CPF:', 'CPF inválido, confira e digite de novo.']);

    await reply('52998224725');
    const after = await reloadRun(run.id);
    expect(outcome(after, 'cpf')).toBe('next');
    expect(after.vars.cpf).toEqual({ raw: '52998224725', value: '529.982.247-25' });
    const [saved] = await ctx.db
      .select()
      .from(contactFieldValues)
      .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, field!.id)));
    expect(saved?.value).toBe('529.982.247-25');
  });

  it('takes invalid after the retries run out, sending the default invalid text once', async () => {
    const run = await runFlow([node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email' }))]);

    await reply('não tenho');
    await reply('nenhum');

    const after = await reloadRun(run.id);
    expect(outcome(after, 'email')).toBe('invalid');
    expect(texts()).toEqual(['Qual seu e-mail?', 'Resposta inválida. Tente de novo.']);
    expect(after.vars.email).toBeUndefined();
  });

  const cases: Array<[InputValidator, Record<string, unknown>, string, string, string]> = [
    ['email', {}, 'maria@', ' Maria@Exemplo.COM ', 'maria@exemplo.com'],
    ['phone', {}, '123', '(65) 99999-0001', '5565999990001'],
    ['cnpj', {}, '11.222.333/0001-00', '11222333000181', '11.222.333/0001-81'],
    ['regex', { regex: '^\\d{5}$' }, 'abcde', '78000', '78000'],
  ];
  it.each(cases)('validator %s rejects the bad answer and normalizes the good one', async (validator, extra, bad, good, value) => {
    const run = await runFlow([node('dado', 'ask_input', askInput({ validator, ...extra }))]);

    await reply(bad);
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });

    await reply(good);
    const after = await reloadRun(run.id);
    expect(outcome(after, 'dado')).toBe('next');
    expect(after.vars.dado?.value).toBe(value);
  });

  it('validator media accepts only the listed types', async () => {
    const run = await runFlow([node('doc', 'ask_input', askInput({ text: 'Envie o contrato em PDF', validator: 'media', mediaTypes: ['pdf'] }))]);

    await reply(null, { kind: 'image', mediaMime: 'image/jpeg' });
    expect(await reloadRun(run.id)).toMatchObject({ state: 'waiting_reply', retries: 1 });

    await reply(null, { kind: 'document', mediaMime: 'application/pdf', mediaName: 'contrato.pdf' });
    expect(outcome(await reloadRun(run.id), 'doc')).toBe('next');
  });

  it('useLastMessage takes a valid last inbound message without asking and saves to a native field', async () => {
    await storeInbound('maria@exemplo.com');

    const run = await runFlow([
      node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email', useLastMessage: true, saveToField: 'native:email' })),
    ]);

    expect(ctx.wa.sent).toHaveLength(0);
    expect(run.state).toBe('finished');
    expect(outcome(run, 'email')).toBe('next');
    expect(run.vars.email).toEqual({ raw: 'maria@exemplo.com', value: 'maria@exemplo.com' });
    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.email).toBe('maria@exemplo.com');
  });

  it('useLastMessage asks when the last inbound message does not validate', async () => {
    await storeInbound('Bom dia');

    const run = await runFlow([node('email', 'ask_input', askInput({ text: 'Qual seu e-mail?', validator: 'email', useLastMessage: true }))]);

    expect(texts()).toEqual(['Qual seu e-mail?']);
    expect(run.state).toBe('waiting_reply');
  });

  it('saves native:city inside the address and keeps the other keys', async () => {
    await ctx.db.update(contacts).set({ address: { state: 'MT', zipCode: '78000-000' } }).where(eq(contacts.id, contactId));
    await runFlow([node('cidade', 'ask_input', askInput({ text: 'Sua cidade?', saveToField: 'native:city' }))]);

    await reply('Cuiabá');

    const [contact] = await ctx.db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.address).toEqual({ state: 'MT', zipCode: '78000-000', city: 'Cuiabá' });
  });

  it('takes timeout when the contact does not answer in time', async () => {
    const run = await runFlow([node('dado', 'ask_input', askInput({ timeoutHours: 2 }))]);
    expect(run.timeoutAt?.getTime()).toBe(ctx.clock.now().getTime() + 2 * HOUR);

    await resumeOnTimer(ctx, run.id, new Date(ctx.clock.now().getTime() + 3 * HOUR));

    const after = await reloadRun(run.id);
    expect(outcome(after, 'dado')).toBe('timeout');
    expect(after.state).toBe('finished');
  });
});
