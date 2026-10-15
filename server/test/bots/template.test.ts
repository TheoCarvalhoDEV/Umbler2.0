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
