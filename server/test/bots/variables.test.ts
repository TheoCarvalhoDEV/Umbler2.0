import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contextoVars, loadBotTextVars, renderBotText } from '../../src/bots/variables.js';
import { chats, contactFieldValues, contacts, customFields, users } from '../../src/db/schema.js';
import { buildChatVars } from '../../src/messages/quick-answers.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

async function setup(opts: { contactName?: string } = {}) {
  const ctx = await makeTestCtx();
  const seed = await seedBasics(ctx);
  const contactId = await newContact(ctx, { name: opts.contactName ?? 'Maria Souza', phone: '5565999991111' });
  await ctx.db.update(contacts).set({ email: 'maria@exemplo.com.br' }).where(eq(contacts.id, contactId));
  const fieldId = randomUUID();
  await ctx.db.insert(customFields).values({ id: fieldId, name: 'Número do processo', kind: 'text', position: 0 });
  await ctx.db.insert(contactFieldValues).values({ contactId, fieldId, value: '0001234-56.2026.8.11.0041' });
  return { ctx, seed, contactId };
}

async function chatRow(ctx: Awaited<ReturnType<typeof makeTestCtx>>, id: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, id));
  return row;
}

describe('buildChatVars', () => {
  it('fills contato and campo from the chat contact and atendente from the given user', async () => {
    const { ctx, contactId } = await setup();
    const vars = await buildChatVars(ctx.db, { contactId }, { name: '  Ana Paula Lima ', email: 'ana@jvo.adv.br' });
    expect(vars).toEqual({
      atendente: { nome: '  Ana Paula Lima ', primeiro_nome: 'Ana', email: 'ana@jvo.adv.br' },
      contato: { nome: 'Maria Souza', primeiro_nome: 'Maria', telefone: '5565999991111', email: 'maria@exemplo.com.br' },
      campo: { 'Número do processo': '0001234-56.2026.8.11.0041' },
    });
  });

  it('leaves atendente empty when there is none, and only reads the chat contact', async () => {
    const { ctx, seed, contactId } = await setup();
    const other = await newContact(ctx, { name: 'Outro Cliente' });
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId });
    const vars = await buildChatVars(ctx.db, await chatRow(ctx, chatId), null);
    expect(vars.atendente).toEqual({ nome: '', primeiro_nome: '', email: '' });
    expect(vars.contato.nome).toBe('Maria Souza');
    expect((await buildChatVars(ctx.db, { contactId: other }, null)).campo).toEqual({});
  });
});

describe('contextoVars', () => {
  it('maps each run var to its value, :raw and :label keys', () => {
    expect(
      contextoVars({
        cpf: { raw: '123.456.789-00 ', value: '123.456.789-00' },
        menu: { raw: 'financeiro', value: '2', label: 'Financeiro' },
      }),
    ).toEqual({
      cpf: '123.456.789-00',
      'cpf:raw': '123.456.789-00 ',
      'cpf:label': '',
      menu: '2',
      'menu:raw': 'financeiro',
      'menu:label': 'Financeiro',
    });
  });

  it('lets a node really named cpf_raw win over the :raw key of node cpf', () => {
    const vars = {
      atendente: { nome: '', primeiro_nome: '', email: '' },
      contato: { nome: '', primeiro_nome: '', telefone: '', email: '' },
      campo: {},
      contexto: contextoVars({ cpf: { raw: 'digitado', value: 'formatado' }, cpf_raw: { raw: 'x', value: 'outro bloco' } }),
    };
    expect(renderBotText('{{contexto.cpf}} | {{contexto.cpf_raw}}', vars)).toBe('formatado | outro bloco');
  });
});

describe('loadBotTextVars + renderBotText', () => {
  const text =
    'Olá {{contato.primeiro_nome}}, sou {{atendente.primeiro_nome}}. CPF {{contexto.cpf}} (digitado: {{contexto.cpf:raw}}). ' +
    'Opção {{contexto.menu}} · {{contexto.menu:label}}. Processo {{campo.numero_do_processo}}. {{empresa}} [{{contexto.nada}}]';
  const runVars = {
    cpf: { raw: '12345678900', value: '123.456.789-00' },
    menu: { raw: '2', value: '2', label: 'Financeiro' },
  };

  it('uses the chat owner as atendente and the run vars as contexto', async () => {
    const { ctx, seed, contactId } = await setup();
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId, ownerId: seed.agentA.id });
    const vars = await loadBotTextVars(ctx.db, await chatRow(ctx, chatId), runVars);
    expect(vars.atendente).toEqual({ nome: 'Ana Financeiro', primeiro_nome: 'Ana', email: 'ana@teste.local' });
    expect(renderBotText(text, vars)).toBe(
      'Olá Maria, sou Ana. CPF 123.456.789-00 (digitado: 12345678900). Opção 2 · Financeiro. ' +
        'Processo 0001234-56.2026.8.11.0041. {{empresa}} []',
    );
  });

  it('leaves atendente empty when the chat has no owner or the owner is inactive', async () => {
    const { ctx, seed, contactId } = await setup();
    const noOwner = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId });
    const empty = { nome: '', primeiro_nome: '', email: '' };
    expect((await loadBotTextVars(ctx.db, await chatRow(ctx, noOwner), {})).atendente).toEqual(empty);

    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, noOwner));
    const owned = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, contactId, ownerId: seed.agentA.id });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, seed.agentA.id));
    const vars = await loadBotTextVars(ctx.db, await chatRow(ctx, owned), runVars);
    expect(vars.atendente).toEqual(empty);
    expect(renderBotText('[{{atendente.nome}}] {{contexto.cpf}}', vars)).toBe('[] 123.456.789-00');
  });
});
