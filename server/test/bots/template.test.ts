import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotDto, BotVersionDto, OfficeTemplateInput } from '@talk/shared';
import { validateGraph, type GraphCatalog } from '../../src/bots/graph.js';
import { createScheduler } from '../../src/bots/scheduler.js';
import { buildOfficeGraph } from '../../src/bots/templates.js';
import { botRuns, bots, chats, contactFieldValues, customFields, messages } from '../../src/db/schema.js';
import { avatarRefreshesIdle, handleInbound } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';

// Spec §8 texts, copied verbatim on purpose: the test pins the spec, not the implementation's constants.
const OUT_OF_HOURS = 'Estamos fora do horário de atendimento. Deixe sua mensagem que retornaremos assim que possível.';
const WELCOME = 'Olá Maria! 👋 Sou o assistente virtual da Silva Advogados. Como posso te ajudar hoje?';
const MENU_TEXT = 'Escolha uma das opções abaixo digitando o número correspondente:';
const MENU = `${MENU_TEXT}\n\n1: Atendimento\n2: Financeiro\n3: Processos`;
const NOTICE =
  '⚠️ COMUNICADO — Informamos que nosso WhatsApp está com uma demanda muito alta no momento. Por isso, pedimos um prazo de até 2 dias úteis para retorno. Enquanto isso, deixe aqui sua dúvida ou necessidade. Agradecemos a compreensão! 🤝';
const CPF_ASK = 'Para agilizar, digite seu CPF:';
const CPF_INVALID = 'CPF inválido, confira e digite de novo.';
const WORKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

describe('buildOfficeGraph', () => {
  const ids = {
    channel: randomUUID(),
    atendimento: randomUUID(),
    financeiro: randomUUID(),
    processos: randomUUID(),
    ana: randomUUID(),
    cpf: randomUUID(),
  };
  const input: OfficeTemplateInput = {
    companyName: 'Silva Advogados',
    channelId: ids.channel,
    destinations: {
      atendimento: { sectorId: ids.atendimento },
      financeiro: { sectorId: ids.financeiro, userId: ids.ana },
      processos: { sectorId: ids.processos, userId: null },
    },
  };
  const catalog: GraphCatalog = {
    selfBotId: null,
    sectorIds: new Set([ids.atendimento, ids.financeiro, ids.processos]),
    activeUserIds: new Set([ids.ana]),
    tagIds: new Set(),
    customFieldIds: new Set([ids.cpf]),
    channelIds: new Set([ids.channel]),
    botIds: new Set(),
    startChannelIds: [ids.channel],
  };
  const g = buildOfficeGraph(input, ids.cpf);
  const node = (name: string) => g.nodes.find((n) => n.name === name);
  const target = (source: string, handle: string) =>
    g.edges.find((e) => e.source === source && e.sourceHandle === handle)?.target ?? null;

  it('is a valid graph with the contract node names', () => {
    expect(validateGraph(g, catalog)).toEqual([]);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(
      [
        'inicio', 'horario', 'fora_do_horario', 'boas_vindas', 'menu', 'comunicado', 'cpf', 'destino',
        'setor_atendimento', 'setor_financeiro', 'agente_financeiro', 'aviso_financeiro', 'setor_processos',
      ].sort(),
    );
    for (const n of g.nodes) expect(n.id).toBe(n.name);
  });

  it('checks the office hours in Cuiabá and sends the notice when closed', () => {
    expect(node('inicio')?.type).toBe('start_channel');
    expect(target('inicio', 'next')).toBe('horario');
    expect(node('horario')).toMatchObject({
      type: 'hours',
      config: {
        timezone: 'America/Cuiaba',
        intervals: [
          { from: '08:00', to: '12:00', days: WORKDAYS },
          { from: '14:00', to: '18:00', days: WORKDAYS },
        ],
      },
    });
    expect(target('horario', 'in')).toBe('boas_vindas');
    expect(target('horario', 'out')).toBe('fora_do_horario');
    expect(node('fora_do_horario')).toMatchObject({ type: 'send_message', config: { text: OUT_OF_HOURS, signature: false } });
    expect(target('fora_do_horario', 'next')).toBeNull(); // run ends; the chat is not closed
  });

  it('fills the company name into the welcome text and nothing else', () => {
    expect(node('boas_vindas')?.config.text).toBe(
      'Olá {{contato.primeiro_nome}}! 👋 Sou o assistente virtual da Silva Advogados. Como posso te ajudar hoje?',
    );
    // `$&` must stay literal (String.replace patterns)
    const odd = buildOfficeGraph({ ...input, companyName: 'Souza $& Cia' }, ids.cpf);
    expect(odd.nodes.find((n) => n.name === 'boas_vindas')?.config.text).toContain('da Souza $& Cia. Como');
    expect(target('boas_vindas', 'next')).toBe('menu');
  });

  it('asks the menu with one retry and a 24 h timeout, every option going to the notice', () => {
    expect(node('menu')).toMatchObject({
      type: 'ask_choice',
      config: {
        text: MENU_TEXT,
        options: [
          { key: '1', label: 'Atendimento' },
          { key: '2', label: 'Financeiro' },
          { key: '3', label: 'Processos' },
        ],
        invalidRetries: 1,
        timeoutHours: 24,
      },
    });
    for (const k of ['1', '2', '3']) expect(target('menu', `opt:${k}`)).toBe('comunicado');
    expect(target('menu', 'invalid')).toBeNull();
    expect(target('menu', 'timeout')).toBeNull();
    expect(node('comunicado')).toMatchObject({ type: 'send_message', config: { text: NOTICE } });
    expect(target('comunicado', 'next')).toBe('cpf');
  });

  it('asks the CPF with two retries, saves it to the field and goes on even when invalid', () => {
    expect(node('cpf')).toMatchObject({
      type: 'ask_input',
      config: {
        text: CPF_ASK,
        validator: 'cpf',
        useLastMessage: false,
        invalidText: CPF_INVALID,
        invalidRetries: 2,
        saveToField: ids.cpf,
      },
    });
    expect(target('cpf', 'next')).toBe('destino');
    expect(target('cpf', 'invalid')).toBe('destino');
  });

  it('routes by the menu answer; only a mapped agent gets the transfer and the notification', () => {
    const cases = node('destino')?.config.cases as Array<{ rules: unknown[] }>;
    expect(cases.map((c) => c.rules)).toEqual(
      ['1', '2', '3'].map((v) => [{ left: { kind: 'var', value: 'menu' }, operator: 'eq', right: { kind: 'literal', value: v } }]),
    );
    expect(target('destino', 'case:0')).toBe('setor_atendimento');
    expect(target('destino', 'case:1')).toBe('setor_financeiro');
    expect(target('destino', 'case:2')).toBe('setor_processos');
    expect(target('destino', 'else')).toBeNull();

    expect(node('setor_atendimento')?.config).toEqual({ sectorId: ids.atendimento, onlyIfAgentAllowed: false });
    expect(node('setor_processos')?.config).toEqual({ sectorId: ids.processos, onlyIfAgentAllowed: false });
    expect(target('setor_atendimento', 'next')).toBeNull();
    expect(target('setor_processos', 'next')).toBeNull();

    expect(target('setor_financeiro', 'next')).toBe('agente_financeiro');
    expect(node('agente_financeiro')?.config).toEqual({ rule: 'specific', userIds: [ids.ana], sectorIds: [] });
    expect(target('agente_financeiro', 'next')).toBe('aviso_financeiro');
    expect(node('aviso_financeiro')?.config).toEqual({
      title: 'Nova conversa',
      text: 'Nova conversa de {{contato.nome}} — CPF {{contexto.cpf}}',
      target: 'owner',
      userIds: [],
    });
  });
});
type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
let ctx: Ctx;
let seed: Seeded;
let app: FastifyInstance;
let admin: Record<string, string>;

async function boot() {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
}

const templateBody = (over: Record<string, unknown> = {}) => ({
  companyName: 'Silva Advogados',
  channelId: seed.channelId,
  destinations: {
    atendimento: { sectorId: seed.defaultSector },
    financeiro: { sectorId: seed.sectorA, userId: seed.agentA.id },
    processos: { sectorId: seed.sectorB, userId: null },
  },
  ...over,
});
const fromTemplate = (payload: object, headers = admin) =>
  app.inject({ method: 'POST', url: '/api/bots/from-template', headers, payload });
const cpfFields = () => ctx.db.select().from(customFields).where(eq(customFields.name, 'CPF'));

describe('POST /api/bots/from-template', () => {
  beforeEach(boot);
  afterEach(async () => {
    await app.close();
  });

  it('creates a published, paused bot on the channel and the CPF field only once', async () => {
    const res = await fromTemplate(templateBody());
    expect(res.statusCode).toBe(200);
    const bot = res.json() as BotDto;
    expect(bot).toMatchObject({
      name: 'Fluxo do escritório',
      status: 'paused',
      startChannelIds: [seed.channelId],
      manualStart: false,
      publishedVersionNumber: 1,
      latestVersionNumber: 1,
    });

    const [field] = await cpfFields();
    expect(field).toMatchObject({ kind: 'cpf' });
    const v = await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/versions/1`, headers: admin });
    const version = v.json() as BotVersionDto;
    expect(version).toMatchObject({ valid: true, published: true, problems: [] });
    expect(version.graph.nodes.find((n) => n.name === 'cpf')?.config.saveToField).toBe(field.id);
    expect(version.graph.nodes.find((n) => n.name === 'boas_vindas')?.config.text).toContain('da Silva Advogados.');

    const again = await fromTemplate(templateBody());
    expect(again.statusCode).toBe(200);
    expect((again.json() as BotDto).name).toBe('Fluxo do escritório (2)');
    expect(await cpfFields()).toHaveLength(1);
  });

  it('uses the given name and reuses an existing CPF field', async () => {
    const [existing] = await ctx.db.insert(customFields).values({ name: 'CPF', kind: 'text' }).returning();
    const res = await fromTemplate(templateBody({ name: 'Atendimento inicial' }));
    expect(res.statusCode).toBe(200);
    const bot = res.json() as BotDto;
    expect(bot.name).toBe('Atendimento inicial');
    const v = (await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/versions/1`, headers: admin })).json() as BotVersionDto;
    expect(v.graph.nodes.find((n) => n.name === 'cpf')?.config.saveToField).toBe(existing.id);
    expect(await cpfFields()).toHaveLength(1);
  });

  it('rejects agents with 403', async () => {
    const agent = (await loginAs(app, seed.agentA.email)).headers;
    expect((await fromTemplate(templateBody(), agent)).statusCode).toBe(403);
  });

  it('rejects an unknown channel, sector or agent with 400 and creates nothing', async () => {
    const missing = randomUUID();
    const cases: Array<[object, string]> = [
      [templateBody({ channelId: missing }), 'Canal inexistente'],
      [
        templateBody({
          destinations: {
            atendimento: { sectorId: missing },
            financeiro: { sectorId: seed.sectorA },
            processos: { sectorId: seed.sectorB },
          },
        }),
        'Setor inexistente',
      ],
      [
        templateBody({
          destinations: {
            atendimento: { sectorId: seed.defaultSector },
            financeiro: { sectorId: seed.sectorA, userId: missing },
            processos: { sectorId: seed.sectorB },
          },
        }),
        'Atendente inexistente',
      ],
    ];
    for (const [payload, error] of cases) {
      const res = await fromTemplate(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error });
    }
    expect((await fromTemplate(templateBody({ companyName: '  ' }))).statusCode).toBe(400); // zod
    expect(await ctx.db.$count(bots)).toBe(0);
    expect(await cpfFields()).toHaveLength(0);
  });
});

const PHONE = '5565999999999';
let seq = 0;

function inbound(body: string): Extract<InboundEvent, { type: 'message' }> {
  seq += 1;
  return {
    type: 'message',
    instance: seed.instance,
    externalId: `TPL${seq}`,
    direction: 'in',
    phone: PHONE,
    lid: null,
    pushName: 'Maria Cliente',
    kind: 'text',
    body,
    hasMedia: false,
    mediaMime: null,
    mediaName: null,
    replyToExternalId: null,
    sentAt: ctx.clock.now(),
    raw: {},
  };
}

async function say(body: string): Promise<string[]> {
  const before = ctx.wa.sent.length;
  await handleInbound(ctx, [inbound(body)]);
  await avatarRefreshesIdle();
  return ctx.wa.sent.slice(before).map((s) => (s.payload as { text: string }).text);
}

const theChat = async () => (await ctx.db.select().from(chats))[0]!;
const theRun = async () => (await ctx.db.select().from(botRuns))[0]!;
async function cpfValue(): Promise<string | undefined> {
  const [field] = await cpfFields();
  const [row] = await ctx.db.select().from(contactFieldValues).where(eq(contactFieldValues.fieldId, field!.id));
  return row?.value;
}

describe('Fluxo do escritório end to end', () => {
  let botId: string;

  beforeEach(async () => {
    await boot();
    ctx.clock.set(new Date('2026-10-14T13:00:00Z')); // Wednesday 09:00 in Cuiabá (UTC-4)
    const created = await fromTemplate(templateBody());
    botId = (created.json() as BotDto).id;
    const activated = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/status`,
      headers: admin,
      payload: { status: 'active' },
    });
    expect(activated.statusCode).toBe(200);
  });
  afterEach(async () => {
    await app.close();
  });

  it('in hours: welcome, menu, invalid option, CPF invalid then valid, transfer and notification', async () => {
    const notify = vi.spyOn(ctx.hub, 'publishNotification');

    expect(await say('Bom dia')).toEqual([WELCOME, MENU]);
    expect(await theRun()).toMatchObject({ botId, state: 'waiting_reply', waitNodeId: 'menu' });
    expect((await theChat()).triagePending).toBe(false); // the bot took priority over triage

    const invalid = (await say('7')).join('\n');
    expect(invalid).toContain('Opção inválida.');
    expect(invalid).toContain('3: Processos'); // menu repeated once
    expect(await theRun()).toMatchObject({ state: 'waiting_reply', waitNodeId: 'menu', retries: 1 });

    expect(await say('2')).toEqual([NOTICE, CPF_ASK]);
    expect(await theRun()).toMatchObject({ state: 'waiting_reply', waitNodeId: 'cpf', retries: 0 });

    expect(await say('123.456.789-00')).toEqual([CPF_INVALID]); // wrong check digits
    expect(await cpfValue()).toBeUndefined();

    expect(await say('52998224725')).toEqual([]); // valid; transfer and notification send nothing on WhatsApp
    expect(await cpfValue()).toBe('529.982.247-25');

    const chat = await theChat();
    expect(chat).toMatchObject({ state: 'open', sectorId: seed.sectorA, ownerId: seed.agentA.id });
    const run = await theRun();
    expect(run.state).toBe('finished');
    expect(run.vars.menu).toMatchObject({ value: '2', label: 'Financeiro' });
    expect(run.vars.cpf).toMatchObject({ value: '529.982.247-25' });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      chat.id,
      [seed.agentA.id],
      expect.objectContaining({
        chatId: chat.id,
        title: 'Nova conversa',
        text: 'Nova conversa de Maria Cliente — CPF 529.982.247-25',
        botName: 'Fluxo do escritório',
      }),
    );
    expect(ctx.hub.events).toContainEqual({ type: 'notification', chatId: chat.id, userId: seed.agentA.id });

    const out = await ctx.db.select().from(messages).where(eq(messages.direction, 'out'));
    expect(out).toHaveLength(ctx.wa.sent.length);
    for (const m of out) expect(m).toMatchObject({ botRunId: run.id, authorId: null, status: 'sent' });

    const kinds = (await eventsOf(ctx, chat.id)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'bot_started')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'bot_transferred')).toHaveLength(2); // sector, then agent
    expect(kinds.at(-1)).toBe('bot_finished');
  });

  it.each([
    ['at opening time', '2026-10-14T12:00:00Z'], // 08:00
    ['right after lunch', '2026-10-14T18:00:00Z'], // 14:00
  ])('in hours %s: greets with the menu', async (_label, at) => {
    ctx.clock.set(new Date(at));
    expect(await say('Olá')).toEqual([WELCOME, MENU]);
  });

  it.each([
    ['at lunch on a weekday', '2026-10-14T16:30:00Z'], // Wednesday 12:30
    ['at closing time', '2026-10-14T22:00:00Z'], // Wednesday 18:00 (`to` is exclusive)
    ['on a Saturday morning', '2026-10-17T14:00:00Z'], // Saturday 10:00
  ])('out of hours %s: sends the notice and leaves the chat open in the queue', async (_label, at) => {
    ctx.clock.set(new Date(at));
    expect(await say('Olá')).toEqual([OUT_OF_HOURS]);
    expect(await theRun()).toMatchObject({ state: 'finished' });
    expect(await theChat()).toMatchObject({ state: 'open', sectorId: seed.defaultSector, ownerId: null, triagePending: false });
    expect(await say('Alguém aí?')).toEqual([]); // same open chat: the bot does not start again
    expect(await ctx.db.$count(botRuns)).toBe(1);
  });

  it('a label answer and three invalid CPFs still route to Processos, with no agent and no notification', async () => {
    const notify = vi.spyOn(ctx.hub, 'publishNotification');
    await say('Oi');
    expect(await say('PROCESSOS')).toEqual([NOTICE, CPF_ASK]);
    expect(await say('123')).toEqual([CPF_INVALID]);
    expect(await say('não sei')).toEqual([CPF_INVALID]);
    expect(await say('123.456.789-00')).toEqual([]); // retries used up → invalid → destino

    expect(await theChat()).toMatchObject({ state: 'open', sectorId: seed.sectorB, ownerId: null });
    const run = await theRun();
    expect(run.state).toBe('finished');
    expect(run.vars.cpf).toBeUndefined();
    expect(await cpfValue()).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('no answer to the menu for 24 h ends the bot and keeps the chat open', async () => {
    await say('Oi');
    expect((await theRun()).timeoutAt?.toISOString()).toBe('2026-10-15T13:00:00.000Z');
    const sends = ctx.wa.sent.length;
    const scheduler = createScheduler(ctx);

    ctx.clock.advance(24 * 60 * 60 * 1000 - 1000);
    expect(await scheduler.tick(ctx.clock.now())).toBe(0);
    ctx.clock.advance(2000);
    expect(await scheduler.tick(ctx.clock.now())).toBe(1);

    expect(await theRun()).toMatchObject({ state: 'finished', timeoutAt: null });
    expect(ctx.wa.sent).toHaveLength(sends);
    expect((await theChat()).state).toBe('open');
  });
});
