import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCK_CATALOG,
  outputsOf,
  type BlockConfigMap,
  type BlockType,
  type BotGraph,
  type BotNode,
  type BotRunState,
  type BotRunVars,
  type ChatAgentConfig,
  type HoursConfig,
  type MultiConditionCase,
  type Rule,
  type RuleOperator,
  type TagsConfig,
  type TimeUnit,
  type WaitIntervalConfig,
  type Weekday,
} from '@talk/shared';
import { compareValues, conditionBlocks, evalRule, operandValue } from '../../src/bots/blocks/conditions.js';
import { resumeOnReply, resumeOnTimer, startRun } from '../../src/bots/engine.js';
import { defaultRegistry, type BlockResult, type BotCtx, type ResumeEvent } from '../../src/bots/registry.js';
import { createBot, latestVersion, type BotRunRow } from '../../src/bots/repo.js';
import { createBotRuntime } from '../../src/bots/runtime.js';
import { loadBotTextVars, renderBotText } from '../../src/bots/variables.js';
import { botRuns, bots, channels, chats, contactFieldValues, contactTags, contacts, customFields, messages, tags } from '../../src/db/schema.js';
import { seedChat, seedMessage, type SeedChatOpts } from '../chats/seed.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';

type TestCtx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: TestCtx;
let s: Seeded;
let otherChannel: string;
let cpfFieldId: string;
let tagIds: string[];

beforeAll(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  const [ch] = await ctx.db
    .insert(channels)
    .values({ name: 'Outro canal', evolutionInstance: 'talk-other', status: 'connected' })
    .returning({ id: channels.id });
  otherChannel = ch.id;
  const [cpf] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'cpf' }).returning({ id: customFields.id });
  cpfFieldId = cpf.id;
  const rows = await ctx.db
    .insert(tags)
    .values([
      { name: 'Cliente', color: 'blue' },
      { name: 'VIP', color: 'green' },
      { name: 'Inadimplente', color: 'red' },
    ])
    .returning({ id: tags.id });
  tagIds = rows.map((r) => r.id);
});

// ---------- helpers ----------

const at = (iso: string) => new Date(iso);
const v = (value: string) => ({ kind: 'var' as const, value });
const lit = (value: string) => ({ kind: 'literal' as const, value });
const fld = (value: string) => ({ kind: 'field' as const, value });

function node<T extends BlockType>(type: T, config: BlockConfigMap[T], name: string = type): BotNode {
  return { id: name, type, name, position: { x: 0, y: 0 }, config: config as unknown as Record<string, unknown> };
}

interface RunOpts { vars?: BotRunVars; state?: BotRunState; parentRunId?: string | null; depth?: number }

/** A run of a fresh bot (each bot is unique, so the one-active-run-per-(chat, bot) index never collides). */
async function seedRun(chatId: string, o: RunOpts = {}): Promise<BotRunRow> {
  const bot = await createBot(ctx.db, {
    name: `Bot ${randomUUID()}`, graph: { nodes: [], edges: [] }, valid: false, publish: false, createdBy: null,
  });
  const version = await latestVersion(ctx.db, bot.id);
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  const [run] = await ctx.db
    .insert(botRuns)
    .values({
      botId: bot.id, versionId: version.id, chatId, contactId: chat.contactId, currentNodeId: 'n',
      state: o.state ?? 'running', vars: o.vars ?? {}, parentRunId: o.parentRunId ?? null, depth: o.depth ?? 0,
    })
    .returning();
  return run;
}

async function contactWith(values: Partial<typeof contacts.$inferInsert> = {}): Promise<string> {
  const [c] = await ctx.db.insert(contacts).values({ name: 'Maria Silva', ...values }).returning({ id: contacts.id });
  return c.id;
}

interface SceneOpts { chat?: Partial<SeedChatOpts>; contact?: Partial<typeof contacts.$inferInsert>; run?: RunOpts }

/** New contact (unless chat.contactId is given) + open chat on the test channel + a running run on it. */
async function scene(o: SceneOpts = {}) {
  const contactId = o.chat?.contactId ?? (await contactWith(o.contact));
  const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, ...o.chat, contactId });
  const run = await seedRun(chatId, o.run);
  return { contactId, chatId, run };
}

interface CtxOpts { now?: Date; random?: () => number }

/** The BotCtx the engine hands a block, built from the DB the same way (fresh chat, renderBotText, newest inbound). */
async function botCtx(run: BotRunRow, o: CtxOpts = {}): Promise<BotCtx> {
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, run.chatId));
  const app = o.random ? { ...ctx, botRuntime: createBotRuntime({ random: o.random }) } : ctx;
  return {
    app,
    now: o.now ?? ctx.clock.now(),
    chat,
    bot: { id: run.botId, name: 'Bot de teste' },
    actor: { botId: run.botId, botName: 'Bot de teste', runId: run.id },
    render: async (text) => renderBotText(text, await loadBotTextVars(ctx.db, chat, run.vars)),
    lastInbound: async () => {
      const [m] = await ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.chatId, run.chatId), eq(messages.direction, 'in')))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      return m
        ? { messageId: m.id, kind: m.kind, body: m.body, mediaMime: m.mediaMime, mediaName: m.mediaName, createdAt: m.createdAt }
        : null;
    },
    startChild: async () => {
      throw new Error('startChild não é usado por blocos de condição');
    },
    stopOtherRuns: async () => {
      throw new Error('stopOtherRuns não é usado por blocos de condição');
    },
  };
}

function definition(type: BlockType) {
  const def = conditionBlocks[type];
  if (!def) throw new Error(`bloco ${type} não registrado em conditionBlocks`);
  return def;
}

/** Runs the block and checks that any handle it returns is one the editor draws (outputsOf). */
async function runBlock(run: BotRunRow, n: BotNode, o: CtxOpts = {}): Promise<BlockResult> {
  const result = await definition(n.type).run(await botCtx(run, o), run, n);
  if ('next' in result) expect(outputsOf(n.type, n.config).map((x) => x.id)).toContain(result.next);
  return result;
}

async function nextOf(run: BotRunRow, n: BotNode, o: CtxOpts = {}): Promise<string> {
  const result = await runBlock(run, n, o);
  if (!('next' in result)) throw new Error(`esperava { next }, veio ${JSON.stringify(result)}`);
  return result.next;
}

const menuIs = (value: string): Rule => ({ left: v('menu'), operator: 'eq', right: lit(value) });

// ---------- cycle 1: rules ----------

describe('compareValues', () => {
  it.each<[string, RuleOperator, string, boolean]>([
    ['10', 'gt', '9', true], // numeric (as text "10" < "9")
    ['9', 'lt', '10', true],
    ['1,5', 'eq', '1.5', true], // decimal comma
    [' 7 ', 'eq', '7', true],
    ['5', 'lte', '5', true],
    ['4', 'lt', '5', true],
    ['5', 'gte', '6', false],
    ['', 'eq', '0', false], // empty is not the number 0
    ['b', 'gt', 'a', true],
    ['abc', 'gt', 'abd', false],
    ['Ação', 'eq', 'acao', true],
    ['a', 'neq', 'A', false],
    ['São Paulo', 'contains', 'PAULO', true],
    ['São Paulo', 'not_contains', 'rio', true],
    ['Boleto atrasado', 'starts', 'boleto', true],
    ['10', 'contains', '1', true], // contains is always text
    ['   ', 'empty', '', true],
    ['x', 'empty', '', false],
    ['x', 'not_empty', '', true],
  ])('%j %s %j is %s', (left, op, right, expected) => {
    expect(compareValues(left, op, right)).toBe(expected);
  });
});

describe('operandValue and evalRule', () => {
  it('reads vars, raw vars, contact fields and rendered literals', async () => {
    const { contactId, run } = await scene({
      contact: { name: 'Maria Silva', email: 'maria@exemplo.com', landline: '6533221100', address: { city: 'Cuiabá', state: 'MT' } },
      run: { vars: { menu: { raw: 'Quero o 1', value: '1', label: 'Atendimento' } } },
    });
    await ctx.db.insert(contactFieldValues).values({ contactId, fieldId: cpfFieldId, value: '529.982.247-25' });
    const b = await botCtx(run);
    expect(await operandValue(b, run, v('menu'))).toBe('1');
    expect(await operandValue(b, run, v('menu:raw'))).toBe('Quero o 1');
    expect(await operandValue(b, run, v('inexistente'))).toBe('');
    expect(await operandValue(b, run, fld(cpfFieldId))).toBe('529.982.247-25');
    expect(await operandValue(b, run, fld(randomUUID()))).toBe('');
    expect(await operandValue(b, run, fld('native:name'))).toBe('Maria Silva');
    expect(await operandValue(b, run, fld('native:email'))).toBe('maria@exemplo.com');
    expect(await operandValue(b, run, fld('native:landline'))).toBe('6533221100');
    expect(await operandValue(b, run, fld('native:city'))).toBe('Cuiabá');
    expect(await operandValue(b, run, fld('native:state'))).toBe('MT');
    expect(await operandValue(b, run, lit('Olá {{contato.primeiro_nome}}, opção {{contexto.menu}}'))).toBe('Olá Maria, opção 1');
  });

  it('gives empty text for native fields the contact does not have', async () => {
    const { run } = await scene({ contact: { name: null } });
    const b = await botCtx(run);
    expect(await operandValue(b, run, fld('native:name'))).toBe('');
    expect(await operandValue(b, run, fld('native:email'))).toBe('');
    expect(await operandValue(b, run, fld('native:city'))).toBe('');
  });

  it('ignores the right side for empty and not_empty', async () => {
    const { run } = await scene({ run: { vars: { nome: { raw: '  ', value: '  ' } } } });
    const b = await botCtx(run);
    expect(await evalRule(b, run, { left: v('nome'), operator: 'empty' })).toBe(true);
    expect(await evalRule(b, run, { left: v('nome'), operator: 'not_empty', right: lit('ignorado') })).toBe(false);
  });
});

describe('condition', () => {
  it('follows yes when every rule holds (and) or any rule holds (or)', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [menuIs('2')] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [menuIs('2'), menuIs('3')] }))).toBe('no');
    expect(await nextOf(run, node('condition', { logic: 'or', rules: [menuIs('3'), menuIs('2')] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'or', rules: [menuIs('3'), menuIs('4')] }))).toBe('no');
  });

  it('compares the raw answer with a literal that has variables', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: 'Aqui é a MARIA', value: '9' } } } });
    const rule: Rule = { left: v('menu:raw'), operator: 'contains', right: lit('{{contato.primeiro_nome}}') };
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [rule] }))).toBe('yes');
    expect(await nextOf(run, node('condition', { logic: 'and', rules: [{ ...rule, left: v('menu') }] }))).toBe('no');
  });
});

describe('multi_condition', () => {
  const cases: MultiConditionCase[] = [
    { label: 'Atendimento', logic: 'and', rules: [menuIs('1')] },
    { label: 'Financeiro', logic: 'and', rules: [menuIs('2')] },
    { label: 'Processos', logic: 'and', rules: [menuIs('3')] },
  ];

  it('follows the matching case', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    expect(await nextOf(run, node('multi_condition', { cases }))).toBe('case:1');
  });

  it('follows else when no case matches', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '9', value: '9' } } } });
    expect(await nextOf(run, node('multi_condition', { cases }))).toBe('else');
  });

  it('takes the first true case when several match', async () => {
    const { run } = await scene({ run: { vars: { menu: { raw: '2', value: '2' } } } });
    const overlapping: MultiConditionCase[] = [
      { label: 'Qualquer', logic: 'and', rules: [{ left: v('menu'), operator: 'not_empty' }] },
      { label: 'Dois', logic: 'and', rules: [menuIs('2')] },
    ];
    expect(await nextOf(run, node('multi_condition', { cases: overlapping }))).toBe('case:0');
  });
});

describe('value', () => {
  it('compares a native field with a literal ignoring case and accents', async () => {
    const { run } = await scene({ contact: { address: { city: 'Cuiabá', state: 'MT' } } });
    expect(await nextOf(run, node('value', { left: fld('native:city'), operator: 'eq', right: lit('CUIABA') }))).toBe('yes');
    expect(await nextOf(run, node('value', { left: fld('native:city'), operator: 'neq', right: lit('CUIABA') }))).toBe('no');
  });

  it('compares a var numerically', async () => {
    const { run } = await scene({ run: { vars: { idade: { raw: '42 anos', value: '42' } } } });
    expect(await nextOf(run, node('value', { left: v('idade'), operator: 'gte', right: lit('18') }))).toBe('yes');
    expect(await nextOf(run, node('value', { left: v('idade'), operator: 'lt', right: lit('18') }))).toBe('no');
  });
});

describe('contact_field', () => {
  it('checks a custom field value', async () => {
    const { contactId, run } = await scene();
    await ctx.db.insert(contactFieldValues).values({ contactId, fieldId: cpfFieldId, value: '529.982.247-25' });
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'eq', value: '529.982.247-25' }))).toBe('yes');
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'empty', value: '' }))).toBe('no');
  });

  it('treats a custom field without a value as empty', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('contact_field', { fieldId: cpfFieldId, operator: 'empty', value: '' }))).toBe('yes');
  });

  it('checks a native field against a value with variables', async () => {
    const { run } = await scene({ contact: { address: { city: 'Cuiabá', state: 'MT' } }, run: { vars: { uf: { raw: 'mt', value: 'mt' } } } });
    expect(await nextOf(run, node('contact_field', { fieldId: 'native:state', operator: 'eq', value: '{{contexto.uf}}' }))).toBe('yes');
  });
});

// ---------- cycle 2: contact, chat and message data; distribute ----------

/** Deterministic [0,1) generator (mulberry32) for the distribution test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('distribute', () => {
  const oneToThree = node('distribute', { branches: [{ label: 'A', weight: 1 }, { label: 'B', weight: 3 }] });

  it.each<[number, string]>([
    [0, 'branch:0'],
    [0.2499, 'branch:0'],
    [0.25, 'branch:1'],
    [0.9999, 'branch:1'],
  ])('random() = %d picks %s with weights 1:3', async (r, expected) => {
    const { run } = await scene();
    expect(await nextOf(run, oneToThree, { random: () => r })).toBe(expected);
  });

  it.each<[number, string]>([
    [0.49, 'branch:0'],
    [0.5, 'branch:1'],
    [0.74, 'branch:1'],
    [0.75, 'branch:2'],
  ])('random() = %d picks %s with weights 2:1:1', async (r, expected) => {
    const { run } = await scene();
    const threeWay = node('distribute', { branches: [{ label: 'A', weight: 2 }, { label: 'B', weight: 1 }, { label: 'C', weight: 1 }] });
    expect(await nextOf(run, threeWay, { random: () => r })).toBe(expected);
  });

  it('splits about 25/75 with a seeded generator', async () => {
    const { run } = await scene();
    const b = await botCtx(run, { random: mulberry32(42) });
    const counts = [0, 0];
    for (let i = 0; i < 4000; i++) {
      const r = await definition('distribute').run(b, run, oneToThree);
      if ('next' in r) counts[Number(r.next.split(':')[1])] += 1;
    }
    expect(counts[0] + counts[1]).toBe(4000);
    expect(counts[0]).toBeGreaterThan(900);
    expect(counts[0]).toBeLessThan(1100);
  });

  it('fails the run instead of guessing when no branch has weight', async () => {
    const { run } = await scene();
    expect(await runBlock(run, node('distribute', { branches: [] }), { random: () => 0.5 })).toEqual({
      end: 'failed',
      error: 'O bloco "Distribuir" não tem caminhos com peso',
    });
  });
});

describe('contact_active', () => {
  const now = at('2026-10-14T13:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('is yes for an inbound message in the last 24 h on this channel', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(23));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('yes');
  });

  it('is no for an inbound message older than 24 h or a message we sent', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(25));
    await seedMessage(ctx, chatId, s.channelId, hoursAgo(1), { direction: 'out' });
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('no');
  });

  it('counts earlier chats of the contact on this channel but not other channels', async () => {
    const { contactId, run } = await scene();
    const old = await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed' });
    const other = await seedChat(ctx, { channelId: otherChannel, sectorId: s.defaultSector, contactId });
    await seedMessage(ctx, other.chatId, otherChannel, hoursAgo(1));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('no');
    await seedMessage(ctx, old.chatId, s.channelId, hoursAgo(2));
    expect(await nextOf(run, node('contact_active', {}), { now })).toBe('yes');
  });
});

describe('first_chat', () => {
  it('is yes for the only chat of the contact on this channel', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('first_chat', {}))).toBe('yes');
  });

  it('is no when the contact had an earlier chat on this channel', async () => {
    const { contactId, run } = await scene();
    await seedChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed' });
    expect(await nextOf(run, node('first_chat', {}))).toBe('no');
  });

  it('ignores chats on other channels', async () => {
    const { contactId, run } = await scene();
    await seedChat(ctx, { channelId: otherChannel, sectorId: s.defaultSector, contactId });
    expect(await nextOf(run, node('first_chat', {}))).toBe('yes');
  });
});

describe('tags', () => {
  // The contact has tags 0 and 1 (Cliente, VIP), never 2 (Inadimplente).
  it.each<[TagsConfig['mode'], number[], 'yes' | 'no']>([
    ['any', [0, 2], 'yes'],
    ['any', [2], 'no'],
    ['all', [0, 1], 'yes'],
    ['all', [0, 2], 'no'],
    ['none', [2], 'yes'],
    ['none', [1], 'no'],
  ])('mode %s with tags %j → %s', async (mode, idx, expected) => {
    const { contactId, run } = await scene();
    await ctx.db.insert(contactTags).values([{ contactId, tagId: tagIds[0] }, { contactId, tagId: tagIds[1] }]);
    expect(await nextOf(run, node('tags', { mode, tagIds: idx.map((i) => tagIds[i]) }))).toBe(expected);
  });
});

describe('chat_sector and chat_channel', () => {
  it('chat_sector is yes only when the chat sector is listed', async () => {
    const { run } = await scene({ chat: { sectorId: s.sectorA } });
    expect(await nextOf(run, node('chat_sector', { sectorIds: [s.sectorB, s.sectorA] }))).toBe('yes');
    expect(await nextOf(run, node('chat_sector', { sectorIds: [s.defaultSector] }))).toBe('no');
  });

  it('chat_channel is yes only when the chat channel is listed', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('chat_channel', { channelIds: [s.channelId] }))).toBe('yes');
    expect(await nextOf(run, node('chat_channel', { channelIds: [otherChannel] }))).toBe('no');
  });
});

describe('chat_agent', () => {
  const agent = (mode: ChatAgentConfig['mode'], userIds: string[] = []) => node('chat_agent', { mode, userIds });

  it('with an owner: any and the owner listed are yes, none and others are no', async () => {
    const { run } = await scene({ chat: { ownerId: s.agentA.id } });
    expect(await nextOf(run, agent('any'))).toBe('yes');
    expect(await nextOf(run, agent('none'))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentB.id]))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentB.id, s.agentA.id]))).toBe('yes');
  });

  it('without an owner: none is yes, any and specific are no', async () => {
    const { run } = await scene();
    expect(await nextOf(run, agent('none'))).toBe('yes');
    expect(await nextOf(run, agent('any'))).toBe('no');
    expect(await nextOf(run, agent('specific', [s.agentA.id]))).toBe('no');
  });
});

describe('chat_status', () => {
  it('is yes when the chat is waiting', async () => {
    const { run } = await scene({ chat: { waiting: true } });
    expect(await nextOf(run, node('chat_status', {}))).toBe('yes');
  });

  it('is no when the chat is not waiting', async () => {
    const { run } = await scene({ chat: { waiting: false } });
    expect(await nextOf(run, node('chat_status', {}))).toBe('no');
  });
});

describe('message_contains', () => {
  const contains = (keywords: string[], match: 'any' | 'all') => node('message_contains', { keywords, match });

  it('looks only at the newest inbound message, ignoring case and accents', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'Preciso da segunda via do BOLETO, por favor' });
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:30:00Z'), { body: 'Segue o pix', direction: 'out' });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['Pix', 'boleto'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['pix', 'boleto'], 'all'))).toBe('no');
    expect(await nextOf(run, contains(['Segunda Via', 'boleto'], 'all'))).toBe('yes');

    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:45:00Z'), { body: 'Quero falar sobre a ação' });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
    expect(await nextOf(run, contains(['AÇÃO'], 'any'))).toBe('yes');
    expect(await nextOf(run, contains(['acao'], 'any'))).toBe('yes');
  });

  it('is no when the newest inbound message has no text', async () => {
    const { chatId, run } = await scene();
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'boleto' });
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:10:00Z'), { kind: 'sticker', body: null });
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
  });

  it('is no when the contact never wrote or no keyword has text', async () => {
    const { chatId, run } = await scene();
    expect(await nextOf(run, contains(['boleto'], 'any'))).toBe('no');
    await seedMessage(ctx, chatId, s.channelId, at('2026-10-14T12:00:00Z'), { body: 'boleto' });
    expect(await nextOf(run, contains(['  ', '!'], 'any'))).toBe('no');
  });
});

describe('parallel_bot', () => {
  it('is no when this run is alone on the chat', async () => {
    const { run } = await scene();
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('no');
  });

  it('is yes when another bot is still running, ignoring finished runs', async () => {
    const { chatId, run } = await scene();
    await seedRun(chatId, { state: 'finished' });
    await seedRun(chatId, { state: 'stopped' });
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('no');
    await seedRun(chatId, { state: 'waiting_reply' });
    expect(await nextOf(run, node('parallel_bot', {}))).toBe('yes');
  });

  it('does not count its own call_flow ancestors waiting for it', async () => {
    const { chatId, run: parent } = await scene({ run: { state: 'waiting_flow' } });
    const child = await seedRun(chatId, { state: 'waiting_flow', parentRunId: parent.id, depth: 1 });
    const grandchild = await seedRun(chatId, { parentRunId: child.id, depth: 2 });
    expect(await nextOf(grandchild, node('parallel_bot', {}))).toBe('no');
    await seedRun(chatId, { state: 'waiting_timer' });
    expect(await nextOf(grandchild, node('parallel_bot', {}))).toBe('yes');
  });
});
