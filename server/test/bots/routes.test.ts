import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BotDto, BotGraph } from '@talk/shared';
import { latestVersion } from '../../src/bots/repo.js';
import { botRuns, chats } from '../../src/db/schema.js';
import { insertChat } from '../inbox/fixtures.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agentA: Record<string, string>;
let agentB: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agentA = (await loginAs(app, seed.agentA.email)).headers;
  agentB = (await loginAs(app, seed.agentB.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

/** start_manual → ask_choice: a run started from it stops at waiting_reply. */
const manualGraph = (): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_manual', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'n2', type: 'ask_choice', name: 'menu', position: { x: 300, y: 0 },
      config: { text: 'Escolha uma opção', options: [{ key: '1', label: 'Atendimento' }], invalidRetries: 1, timeoutHours: null },
    },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' }],
});

const callerGraph = (botId: string): BotGraph => ({
  nodes: [
    { id: 'n1', type: 'start_manual', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    { id: 'n2', type: 'call_flow', name: 'fluxo', position: { x: 300, y: 0 }, config: { botId, continueAfter: false } },
  ],
  edges: [{ id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' }],
});

const noStartGraph = (): BotGraph => ({
  nodes: [{ id: 'n1', type: 'note', name: 'nota', position: { x: 0, y: 0 }, config: { text: 'x' } }],
  edges: [],
});

async function newBot(name: string): Promise<BotDto> {
  const res = await call('POST', '/api/bots', admin, { name });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function saveVersion(botId: string, graph: BotGraph, publish: boolean) {
  return call('POST', `/api/bots/${botId}/versions`, admin, { graph, publish });
}

/** Active, published, manual-start bot built from manualGraph(). */
async function publishManual(name: string): Promise<BotDto> {
  const bot = await newBot(name);
  expect((await saveVersion(bot.id, manualGraph(), true)).statusCode).toBe(200);
  expect((await call('PATCH', `/api/bots/${bot.id}`, admin, { manualStart: true })).statusCode).toBe(200);
  const res = await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' });
  expect(res.statusCode).toBe(200);
  return res.json();
}

function pngUpload(): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----talkbotmediaboundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('admin bot routes', () => {
  it('lets only admins manage bots', async () => {
    expect((await call('GET', '/api/bots', agentA)).statusCode).toBe(403);
    expect((await call('POST', '/api/bots', agentA, { name: 'X' })).statusCode).toBe(403);
    const bot = await newBot('X');
    expect((await call('GET', `/api/bots/${bot.id}`, agentA)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/bots/${bot.id}`, agentA, { name: 'Y' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/bots/${bot.id}`, agentA)).statusCode).toBe(403);
    expect((await call('GET', `/api/bots/${bot.id}/versions`, agentA)).statusCode).toBe(403);
    expect((await call('POST', `/api/bots/${bot.id}/versions`, agentA, { graph: manualGraph(), publish: false })).statusCode).toBe(403);
    expect((await call('GET', `/api/bots/${bot.id}/export`, agentA)).statusCode).toBe(403);
  });

  it('creates a paused bot whose version 1 is the starter graph', async () => {
    const res = await call('POST', '/api/bots', admin, { name: 'Boas-vindas', description: 'Primeiro' });
    expect(res.statusCode).toBe(200);
    const bot: BotDto = res.json();
    expect(bot).toMatchObject({
      name: 'Boas-vindas', description: 'Primeiro', status: 'paused', publishedVersionId: null,
      publishedVersionNumber: null, latestVersionNumber: 1, runCount: 0, activeRunCount: 0,
    });

    const dup = await call('POST', '/api/bots', admin, { name: 'Boas-vindas' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('Já existe um chatbot com esse nome');
    expect((await call('POST', '/api/bots', admin, { name: '   ' })).statusCode).toBe(400);

    await newBot('Abertura');
    expect((await call('GET', '/api/bots', admin)).json().map((b: BotDto) => b.name)).toEqual(['Abertura', 'Boas-vindas']);

    const v1 = (await call('GET', `/api/bots/${bot.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ botId: bot.id, number: 1, published: false, createdByName: 'Admin Teste' });
    expect(v1.graph.nodes.map((n: { type: string }) => n.type)).toEqual(['start_channel', 'send_message']);

    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json().id).toBe(bot.id);
    expect((await call('GET', `/api/bots/${randomUUID()}`, admin)).statusCode).toBe(404);
  });

  it('saves an invalid draft but refuses to publish it, then publishes a valid version', async () => {
    const bot = await newBot('Fluxo');

    const refused = await saveVersion(bot.id, noStartGraph(), true);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('O fluxo tem problemas');
    expect(refused.json().problems).toContainEqual({ nodeId: null, message: 'O fluxo precisa de um bloco de início' });

    const list = (await call('GET', `/api/bots/${bot.id}/versions`, admin)).json();
    expect(list.map((v: { number: number }) => v.number)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ number: 2, valid: false, published: false });
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json()).toMatchObject({ publishedVersionId: null, latestVersionNumber: 2 });

    const ok = await call('POST', `/api/bots/${bot.id}/versions`, admin, { graph: manualGraph(), label: 'Primeira', publish: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ number: 3, valid: true, published: true, label: 'Primeira', problems: [], createdByName: 'Admin Teste' });
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json().publishedVersionNumber).toBe(3);

    const draft = await saveVersion(bot.id, noStartGraph(), false);
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ number: 4, valid: false, published: false });
    expect(draft.json().problems.length).toBeGreaterThan(0);
    expect((await call('GET', `/api/bots/${bot.id}`, admin)).json()).toMatchObject({ publishedVersionNumber: 3, latestVersionNumber: 4 });

    const v3 = (await call('GET', `/api/bots/${bot.id}/versions/3`, admin)).json();
    expect(v3.graph).toEqual(manualGraph());
    expect(v3).toMatchObject({ published: true, problems: [] });
    expect((await call('GET', `/api/bots/${bot.id}/versions/99`, admin)).statusCode).toBe(404);

    const malformed = { nodes: [{ id: 'n1', type: 'nao_existe', position: { x: 0, y: 0 }, config: {} }], edges: [] };
    expect((await call('POST', `/api/bots/${bot.id}/versions`, admin, { graph: malformed, publish: false })).statusCode).toBe(400);
  });

  it('activates only a bot with a published version', async () => {
    const bot = await newBot('Ativação');
    const early = await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' });
    expect(early.statusCode).toBe(400);
    expect(early.json().error).toBe('Publique uma versão antes de ativar');

    await saveVersion(bot.id, manualGraph(), true);
    expect((await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'active' })).json().status).toBe('active');
    expect((await call('POST', `/api/bots/${bot.id}/status`, admin, { status: 'paused' })).json().status).toBe('paused');
  });

  it('patches fields, rejecting duplicate names and unknown channels', async () => {
    const a = await newBot('A');
    await newBot('B');

    const dup = await call('PATCH', `/api/bots/${a.id}`, admin, { name: 'B' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('Já existe um chatbot com esse nome');

    const badChannel = await call('PATCH', `/api/bots/${a.id}`, admin, { startChannelIds: [randomUUID()] });
    expect(badChannel.statusCode).toBe(400);
    expect(badChannel.json().error).toBe('Canal inexistente');

    const res = await call('PATCH', `/api/bots/${a.id}`, admin, {
      description: 'Menu do escritório', startChannelIds: [seed.channelId, seed.channelId],
      manualStart: true, manualTitle: 'Iniciar A', manualUnlisted: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'A', description: 'Menu do escritório', startChannelIds: [seed.channelId],
      manualStart: true, manualTitle: 'Iniciar A', manualUnlisted: true,
    });
    expect((await call('PATCH', `/api/bots/${a.id}`, admin, {})).json().name).toBe('A');
    expect((await call('PATCH', `/api/bots/${a.id}`, admin, { name: 'A2' })).json().name).toBe('A2');
  });

  it('refuses to delete a bot with live runs or callers, then deletes it', async () => {
    const target = await publishManual('Alvo');
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });
    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    const [run] = await ctx.db
      .insert(botRuns)
      .values({
        botId: target.id, versionId: (await latestVersion(ctx.db, target.id)).id, chatId,
        contactId: chat.contactId, state: 'waiting_reply', currentNodeId: 'n2',
      })
      .returning();

    const live = await call('DELETE', `/api/bots/${target.id}`, admin);
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toBe('Este chatbot tem execuções em andamento');
    await ctx.db.update(botRuns).set({ state: 'finished' }).where(eq(botRuns.id, run.id));

    const caller = await newBot('Chamador');
    const expectUsedBy = async () => {
      const res = await call('DELETE', `/api/bots/${target.id}`, admin);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Este chatbot é acionado por outros fluxos', usedBy: [{ id: caller.id, name: 'Chamador' }] });
    };

    // Only the latest (draft) version calls the target.
    expect((await saveVersion(caller.id, callerGraph(target.id), false)).statusCode).toBe(200);
    await expectUsedBy();
    // Only the published version calls it: a newer draft dropped the call.
    expect((await saveVersion(caller.id, callerGraph(target.id), true)).statusCode).toBe(200);
    expect((await saveVersion(caller.id, manualGraph(), false)).statusCode).toBe(200);
    await expectUsedBy();
    // Neither calls it any more.
    expect((await saveVersion(caller.id, manualGraph(), true)).statusCode).toBe(200);

    expect((await call('DELETE', `/api/bots/${target.id}`, admin)).statusCode).toBe(204);
    expect((await call('GET', `/api/bots/${target.id}`, admin)).statusCode).toBe(404);
    expect(await ctx.db.select().from(botRuns)).toHaveLength(0);
    expect((await call('DELETE', `/api/bots/${target.id}`, admin)).statusCode).toBe(404);
  });

  it('duplicates the latest graph as a paused, unpublished copy with the same start settings', async () => {
    const src = await publishManual('Origem');
    await call('PATCH', `/api/bots/${src.id}`, admin, { startChannelIds: [seed.channelId], manualTitle: 'Menu', manualUnlisted: true });
    await saveVersion(src.id, noStartGraph(), false);

    const res = await call('POST', `/api/bots/${src.id}/duplicate`, admin);
    expect(res.statusCode).toBe(200);
    const copy: BotDto = res.json();
    expect(copy).toMatchObject({
      name: 'Origem (cópia)', status: 'paused', publishedVersionId: null, latestVersionNumber: 1,
      startChannelIds: [seed.channelId], manualStart: true, manualTitle: 'Menu', manualUnlisted: true,
    });
    const v1 = (await call('GET', `/api/bots/${copy.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ valid: false, published: false });
    expect(v1.graph).toEqual(noStartGraph());

    expect((await call('POST', `/api/bots/${src.id}/duplicate`, admin)).json().name).toBe('Origem (cópia) (2)');
  });

  it('exports the latest version as a file and imports it under a unique name', async () => {
    const bot = await newBot('Atendimento Inicial');
    await saveVersion(bot.id, manualGraph(), false);

    const exp = await call('GET', `/api/bots/${bot.id}/export`, admin);
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toBe('attachment; filename="atendimento-inicial.json"');
    const file = exp.json();
    expect(file).toEqual({ name: 'Atendimento Inicial', graph: manualGraph() });

    const imp = await call('POST', '/api/bots/import', admin, file);
    expect(imp.statusCode).toBe(200);
    const imported: BotDto = imp.json();
    expect(imported).toMatchObject({ name: 'Atendimento Inicial (2)', status: 'paused', publishedVersionId: null, latestVersionNumber: 1 });
    const v1 = (await call('GET', `/api/bots/${imported.id}/versions/1`, admin)).json();
    expect(v1).toMatchObject({ valid: true });
    expect(v1.graph).toEqual(manualGraph());

    expect((await call('POST', '/api/bots/import', admin, { name: 'Quebrado', graph: { nodes: 'x' } })).statusCode).toBe(400);
    expect((await call('POST', '/api/bots/import', agentA, file)).statusCode).toBe(403);
  });

  it('uploads bot media under bots/ in the media dir', async () => {
    const up = pngUpload();
    const res = await app.inject({ method: 'POST', url: '/api/bots/media', headers: { ...admin, ...up.headers }, payload: up.payload });
    expect(res.statusCode).toBe(200);
    const media = res.json();
    expect(media).toMatchObject({ name: 'logo.png', mime: 'image/png', size: 4 });
    expect(media.path).toMatch(new RegExp(`^bots/${UUID}\\.png$`));
    expect(existsSync(join(ctx.config.mediaDir, media.path))).toBe(true);

    const agent = await app.inject({ method: 'POST', url: '/api/bots/media', headers: { ...agentA, ...up.headers }, payload: up.payload });
    expect(agent.statusCode).toBe(403);
    expect((await call('POST', '/api/bots/media', admin, {})).statusCode).toBe(400);
  });
});
describe('manual bots and runs', () => {
  it('lists active, published, listed manual bots for any user, by title', async () => {
    const b = await publishManual('Menu B');
    await call('PATCH', `/api/bots/${b.id}`, admin, { manualTitle: 'Abertura' });
    const a = await publishManual('Menu A');
    const hidden = await publishManual('Oculto');
    await call('PATCH', `/api/bots/${hidden.id}`, admin, { manualUnlisted: true });
    const paused = await publishManual('Pausado');
    await call('POST', `/api/bots/${paused.id}/status`, admin, { status: 'paused' });
    await newBot('Sem início manual');

    const res = await call('GET', '/api/bots/manual', agentA);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: b.id, title: 'Abertura' }, { id: a.id, title: 'Menu A' }]);
  });

  it('starts a manual bot in a visible chat, lists it, refuses a duplicate and stops it', async () => {
    const bot = await publishManual('Menu manual');
    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });

    const started = await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: bot.id });
    expect(started.statusCode).toBe(200);
    const run = started.json();
    expect(run).toMatchObject({
      botId: bot.id, botName: 'Menu manual', chatId, state: 'waiting_reply', currentNodeId: 'n2',
      depth: 0, startedByName: 'Ana Financeiro', finishedAt: null,
    });

    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: bot.id })).statusCode).toBe(409);
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentA)).json().map((r: { id: string }) => r.id)).toEqual([run.id]);

    // Bruno (sector B) cannot see the chat: everything is 404.
    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentB, { botId: bot.id })).statusCode).toBe(404);
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentB)).statusCode).toBe(404);
    expect((await call('POST', `/api/bot-runs/${run.id}/stop`, agentB)).statusCode).toBe(404);

    const stopped = await call('POST', `/api/bot-runs/${run.id}/stop`, agentA);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({ id: run.id, state: 'stopped' });
    const again = await call('POST', `/api/bot-runs/${run.id}/stop`, agentA);
    expect(again.statusCode).toBe(200);
    expect(again.json().state).toBe('stopped');
    expect((await call('GET', `/api/chats/${chatId}/bot-runs`, agentA)).json()).toEqual([]);
  });

  it('refuses closed chats, bots that cannot start manually and unknown runs', async () => {
    const manual = await publishManual('Manual');
    const closedChat = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA, state: 'closed' });
    const closed = await call('POST', `/api/chats/${closedChat}/bot-runs`, agentA, { botId: manual.id });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('Conversa finalizada');

    const chatId = await insertChat(ctx, { channelId: seed.channelId, sectorId: seed.sectorA });
    const NOT_MANUAL = 'Este chatbot não pode ser iniciado manualmente';
    const draft = await newBot('Rascunho');
    const noManual = await publishManual('Sem manual');
    await call('PATCH', `/api/bots/${noManual.id}`, admin, { manualStart: false });
    for (const botId of [draft.id, noManual.id, randomUUID()]) {
      const res = await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(NOT_MANUAL);
    }
    expect((await call('POST', `/api/chats/${chatId}/bot-runs`, agentA, { botId: 'x' })).statusCode).toBe(400);
    expect((await call('POST', `/api/bot-runs/${randomUUID()}/stop`, agentA)).statusCode).toBe(404);
  });
});
