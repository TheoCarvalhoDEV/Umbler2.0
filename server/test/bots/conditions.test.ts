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
