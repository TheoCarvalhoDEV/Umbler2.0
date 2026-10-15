import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BotGraph } from '@talk/shared';
import {
  STARTER_GRAPH,
  createBot,
  findChannelBot,
  getBot,
  getPublishedVersion,
  getRun,
  getVersionByNumber,
  getVersionRow,
  insertBotVersion,
  insertRun,
  latestVersion,
  lockRun,
  toBotDto,
  toBotDtos,
  toBotRunDto,
  toBotVersionSummaries,
  uniqueBotName,
  type BotRow,
  type NewBotRun,
} from '../../src/bots/repo.js';
import type { AppCtx } from '../../src/ctx.js';
import { botRuns, botVersions, bots, messages } from '../../src/db/schema.js';
import { toMessageDto } from '../../src/messages/dto.js';
import { makeTestCtx, seedBasics, type Seeded } from '../helpers.js';
import { insertChat, newContact, statusOf } from '../inbox/fixtures.js';

let ctx: AppCtx;
let s: Seeded;
let chatId: string;
let contactId: string;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  contactId = await newContact(ctx);
  chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
});

const manualGraph = (): BotGraph => ({
  nodes: [{ id: 'm', type: 'start_manual', name: 'manual', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
});

/** Published, valid, paused bot with the starter graph unless overridden. */
function newBot(name: string, over: Partial<Parameters<typeof createBot>[1]> = {}): Promise<BotRow> {
  return createBot(ctx.db, { name, graph: STARTER_GRAPH(), valid: true, publish: true, createdBy: s.admin.id, ...over });
}

function newRun(bot: BotRow, over: Partial<NewBotRun> = {}) {
  return insertRun(ctx.db, { botId: bot.id, versionId: bot.publishedVersionId!, chatId, contactId, currentNodeId: 'inicio', ...over });
}

describe('STARTER_GRAPH', () => {
  it('is a fresh start_channel → send_message "Olá!" graph on every call', () => {
    const g = STARTER_GRAPH();
    expect(g.nodes.map((n) => [n.id, n.type, n.name])).toEqual([
      ['inicio', 'start_channel', 'inicio'],
      ['mensagem', 'send_message', 'mensagem'],
    ]);
    expect(g.nodes[1].config).toEqual({ text: 'Olá!', attachment: null, signature: false });
    expect(g.edges).toEqual([{ id: 'e-inicio-next', source: 'inicio', sourceHandle: 'next', target: 'mensagem' }]);
    expect(STARTER_GRAPH()).not.toBe(g);
  });
});

describe('createBot', () => {
  it('inserts version 1 and publishes it only when asked', async () => {
    const draft = await newBot('Rascunho', { publish: false, valid: false });
    expect(draft).toMatchObject({ name: 'Rascunho', status: 'paused', publishedVersionId: null, startChannelIds: [], manualStart: false, runCount: 0 });
    expect(await latestVersion(ctx.db, draft.id)).toMatchObject({ number: 1, valid: false, createdBy: s.admin.id, label: null });
    expect(await getPublishedVersion(ctx.db, draft)).toBeNull();

    const pub = await newBot('Publicado', { description: 'Menu', startChannelIds: [s.channelId], manualStart: true, manualTitle: 'Atendimento' });
    expect(pub).toMatchObject({ description: 'Menu', startChannelIds: [s.channelId], manualStart: true, manualTitle: 'Atendimento' });
    const published = await getPublishedVersion(ctx.db, pub);
    expect(published).toMatchObject({ id: pub.publishedVersionId, botId: pub.id, number: 1, valid: true });
    expect(published!.graph).toEqual(STARTER_GRAPH());
    expect(await getBot(ctx.db, pub.id)).toEqual(pub);
  });

  it('refuses to publish an invalid graph and rejects a duplicate name, inserting nothing', async () => {
    expect(await statusOf(newBot('Ruim', { valid: false }))).toBe(400);
    expect(await ctx.db.select().from(bots)).toEqual([]);

    await newBot('Fluxo');
    expect(await statusOf(newBot('Fluxo'))).toBe(409);
    expect(await ctx.db.select().from(bots)).toHaveLength(1);
    expect(await ctx.db.select().from(botVersions)).toHaveLength(1);
  });
});

describe('versions', () => {
  it('numbers versions per bot, also inside a transaction', async () => {
    const a = await newBot('A');
    const b = await newBot('B');

    const v2 = await insertBotVersion(ctx.db, { botId: a.id, graph: manualGraph(), valid: true, createdBy: null, label: 'Ajuste' });
    expect(v2).toMatchObject({ botId: a.id, number: 2, label: 'Ajuste', createdBy: null, valid: true });
    expect(v2.graph).toEqual(manualGraph());

    const v3 = await ctx.db.transaction((tx) =>
      insertBotVersion(tx, { botId: a.id, graph: manualGraph(), valid: false, createdBy: s.admin.id }),
    );
    expect(v3.number).toBe(3);
    expect((await insertBotVersion(ctx.db, { botId: b.id, graph: manualGraph(), valid: true, createdBy: null })).number).toBe(2);

    expect((await latestVersion(ctx.db, a.id)).id).toBe(v3.id);
    expect((await getVersionByNumber(ctx.db, a.id, 2)).id).toBe(v2.id);
    expect(await getVersionRow(ctx.db, v2.id)).toEqual(v2);
    expect(await getVersionRow(ctx.db, randomUUID())).toBeNull();
    expect(await statusOf(getVersionByNumber(ctx.db, a.id, 9))).toBe(404);
    expect(await statusOf(latestVersion(ctx.db, randomUUID()))).toBe(404);
    expect(await statusOf(getBot(ctx.db, randomUUID()))).toBe(404);
  });

  it('never updates a bot_versions row anywhere in server/src (versions are immutable)', async () => {
    const srcDir = fileURLToPath(new URL('../../src', import.meta.url));
    const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(join(srcDir, f), 'utf8');
      if (/\.update\(\s*botVersions\b/.test(text) || /update\s+"?bot_versions\b/i.test(text)) offenders.push(f);
    }
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('uniqueBotName', () => {
  it('returns the base when free, else the first free " (n)" suffix', async () => {
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo');
    await newBot('Fluxo');
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo (2)');
    await newBot('Fluxo (2)');
    expect(await uniqueBotName(ctx.db, 'Fluxo')).toBe('Fluxo (3)');
  });
});

describe('findChannelBot', () => {
  it('picks the oldest active bot whose published graph starts on that channel', async () => {
    expect(await findChannelBot(ctx.db, s.channelId)).toBeNull();

    await newBot('Pausado', { startChannelIds: [s.channelId] }); // stays paused
    const draft = await newBot('Rascunho', { startChannelIds: [s.channelId], publish: false });
    const manualOnly = await newBot('Manual', { startChannelIds: [s.channelId], graph: manualGraph() });
    const noChannel = await newBot('Sem canal');
    const newer = await newBot('Novo', { startChannelIds: [s.channelId] });
    const older = await newBot('Antigo', { startChannelIds: [randomUUID(), s.channelId] });
    await ctx.db
      .update(bots)
      .set({ status: 'active' })
      .where(inArray(bots.id, [draft.id, manualOnly.id, noChannel.id, newer.id, older.id]));
    await ctx.db.update(bots).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(bots.id, older.id));

    expect((await findChannelBot(ctx.db, s.channelId))?.id).toBe(older.id);

    await ctx.db.update(bots).set({ status: 'paused' }).where(eq(bots.id, older.id));
    expect((await findChannelBot(ctx.db, s.channelId))?.id).toBe(newer.id);
    expect(await findChannelBot(ctx.db, randomUUID())).toBeNull();
  });
});

describe('runs', () => {
  it('insertRun stores defaults and turns a second active root run of the same bot on the chat into 409', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    expect(run).toMatchObject({
      botId: bot.id, versionId: bot.publishedVersionId, chatId, contactId, state: 'running', currentNodeId: 'inicio',
      depth: 0, retries: 0, vars: {}, steps: [], parentRunId: null, waitingSince: null, wakeAt: null, timeoutAt: null, finishedAt: null,
    });

    expect(await statusOf(newRun(bot, { state: 'waiting_reply' }))).toBe(409);
    const child = await newRun(bot, { depth: 1, parentRunId: run.id });
    expect(child.parentRunId).toBe(run.id);
  });

  it('getRun reads a run and lockRun returns it under FOR UPDATE inside a transaction', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    expect(await getRun(ctx.db, run.id)).toEqual(run);
    expect(await getRun(ctx.db, randomUUID())).toBeNull();

    const locked = await ctx.db.transaction(async (tx) => {
      const row = await lockRun(tx, run.id);
      await tx.update(botRuns).set({ state: 'waiting_reply' }).where(eq(botRuns.id, run.id));
      return row;
    });
    expect(locked?.state).toBe('running');
    expect((await getRun(ctx.db, run.id))?.state).toBe('waiting_reply');
    expect(await ctx.db.transaction((tx) => lockRun(tx, randomUUID()))).toBeNull();
  });
});

describe('DTOs', () => {
  it('toBotDtos aggregates published and latest version numbers and active runs', async () => {
    const a = await newBot('A', { startChannelIds: [s.channelId] });
    await insertBotVersion(ctx.db, { botId: a.id, graph: STARTER_GRAPH(), valid: false, createdBy: null });
    await ctx.db.update(bots).set({ runCount: 3 }).where(eq(bots.id, a.id));
    await newRun(a, { state: 'waiting_reply' });
    await newRun(a, { state: 'finished', finishedAt: new Date() });
    const b = await newBot('B', { publish: false });
    const aRow = await getBot(ctx.db, a.id);

    const [dtoA, dtoB] = await toBotDtos(ctx.db, [aRow, b]);

    expect(dtoA).toEqual({
      id: a.id, name: 'A', description: '', status: 'paused', startChannelIds: [s.channelId],
      manualStart: false, manualTitle: '', manualUnlisted: false,
      publishedVersionId: a.publishedVersionId, publishedVersionNumber: 1, latestVersionNumber: 2,
      runCount: 3, activeRunCount: 1,
      createdAt: aRow.createdAt.toISOString(), updatedAt: aRow.updatedAt.toISOString(),
    });
    expect(dtoB).toMatchObject({ id: b.id, publishedVersionId: null, publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0 });
    expect(await toBotDto(ctx.db, b)).toEqual(dtoB);
    expect(await toBotDtos(ctx.db, [])).toEqual([]);
  });

  it('toBotVersionSummaries lists newest first with author name and published flag', async () => {
    const bot = await newBot('Fluxo');
    const v2 = await insertBotVersion(ctx.db, { botId: bot.id, graph: STARTER_GRAPH(), valid: false, createdBy: null, label: 'Teste' });

    const list = await toBotVersionSummaries(ctx.db, bot);

    expect(list).toEqual([
      { id: v2.id, botId: bot.id, number: 2, valid: false, label: 'Teste', createdByName: null, createdAt: v2.createdAt.toISOString(), published: false },
      expect.objectContaining({ id: bot.publishedVersionId, number: 1, valid: true, label: null, createdByName: 'Admin Teste', published: true }),
    ]);
  });

  it('toBotRunDto names the bot and the user who started it', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot, { startedBy: s.agentA.id });

    expect(await toBotRunDto(ctx.db, run)).toEqual({
      id: run.id, botId: bot.id, botName: 'Fluxo', chatId, state: 'running', currentNodeId: 'inicio', depth: 0,
      startedByName: 'Ana Financeiro', error: null,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: null,
    });
    const byChannel = await newRun(bot, { depth: 1 });
    expect((await toBotRunDto(ctx.db, byChannel)).startedByName).toBeNull();
  });

  it('toMessageDto carries the bot run and the bot name', async () => {
    const bot = await newBot('Fluxo');
    const run = await newRun(bot);
    const base = { chatId, channelId: s.channelId, direction: 'out' as const, kind: 'text' as const, status: 'sent' as const, sentAt: new Date() };
    const [byBot] = await ctx.db.insert(messages).values({ ...base, body: 'Olá!', botRunId: run.id }).returning();
    const [byPhone] = await ctx.db.insert(messages).values({ ...base, body: 'Oi' }).returning();

    expect(await toMessageDto(ctx.db, byBot)).toMatchObject({ botRunId: run.id, botName: 'Fluxo', authorId: null, authorName: null });
    expect(await toMessageDto(ctx.db, byPhone)).toMatchObject({ botRunId: null, botName: null });
  });
});
