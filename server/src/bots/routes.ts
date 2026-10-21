import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BLOCK_TYPES, NON_TERMINAL_RUN_STATES,
  type BotExport, type BotGraph, type BotMediaDto, type BotVersionDto, type GraphProblem, type ManualBotDto,
} from '@talk/shared';
import { requireAdmin } from '../auth/plugin.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { botRuns, bots, channels } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/http-error.js';
import { baseMime, saveMedia } from '../messages/media.js';
import { runningRunsForChat, startRun, stopRun } from './engine.js';
import { loadGraphCatalog, validateGraph } from './graph.js';
import {
  STARTER_GRAPH, callersOf, createBot, getBot, getVersionByNumber, insertBotVersion, latestVersion,
  toBotDto, toBotDtos, toBotRunDto, toBotVersionSummaries, uniqueBotName, type BotRow, type BotVersionRow,
} from './repo.js';
import { createOfficeTemplate } from './templates.js';

const IdParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), n: z.coerce.number().int().positive() });
const NodeSchema = z.object({
  id: z.string().min(1).max(64), type: z.enum(BLOCK_TYPES),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
  config: z.record(z.string(), z.unknown()), name: z.string().max(40).optional(),
});
const EdgeSchema = z.object({
  id: z.string().min(1).max(64), source: z.string().min(1).max(64),
  sourceHandle: z.string().min(1).max(64), target: z.string().min(1).max(64),
});
export const GraphSchema = z.object({ nodes: z.array(NodeSchema).max(500), edges: z.array(EdgeSchema).max(2000) });
export const Name = z.string().trim().min(1).max(80);
const TemplateDest = z.object({ sectorId: z.uuid(), userId: z.uuid().nullable().optional() });
const TemplateBody = z.object({ template: z.enum(['office', 'triagem']).optional(), name: Name.optional(),
  companyName: z.string().trim().min(1).max(80), channelId: z.uuid(),
  destinations: z.object({ atendimento: TemplateDest, financeiro: TemplateDest, processos: TemplateDest }) });
const CreateBody = z.object({ name: Name, description: z.string().trim().max(500).optional() });
const PatchBody = z
  .object({
    name: Name, description: z.string().trim().max(500), startChannelIds: z.array(z.uuid()).max(50),
    manualStart: z.boolean(), manualTitle: z.string().trim().max(80), manualUnlisted: z.boolean(),
  })
  .partial();
const SaveVersionBody = z.object({ graph: GraphSchema, label: z.string().trim().max(80).optional(), publish: z.boolean() });
const StatusBody = z.object({ status: z.enum(['active', 'paused']) });
const ImportBody = z.object({ name: Name, graph: GraphSchema });
const StartRunBody = z.object({ botId: z.uuid() });

const admin = { preHandler: requireAdmin };
const NAME_TAKEN = 'Já existe um chatbot com esse nome';
const BAD_MEDIA = 'Envie um único arquivo de até 64 MB no campo "file"';

async function problemsFor(
  db: Db, selfBotId: string | null, startChannelIds: string[], graph: BotGraph,
): Promise<GraphProblem[]> {
  return validateGraph(graph, await loadGraphCatalog(db, selfBotId, startChannelIds));
}

// ponytail: builds every summary to pick one (one query per call); fine for tens of versions.
async function toVersionDto(db: Db, bot: BotRow, row: BotVersionRow): Promise<BotVersionDto> {
  const summary = (await toBotVersionSummaries(db, bot)).find((s) => s.id === row.id);
  if (!summary) throw notFound('Versão não encontrada');
  return { ...summary, graph: row.graph, problems: await problemsFor(db, bot.id, bot.startChannelIds, row.graph) };
}

// ponytail: check-then-insert; two admins racing on one name get a 500 from the unique index, retrying shows the 409.
async function assertNameFree(db: Db, name: string, exceptId?: string): Promise<void> {
  const where = exceptId ? and(eq(bots.name, name), ne(bots.id, exceptId)) : eq(bots.name, name);
  if (await db.$count(bots, where)) throw conflict(NAME_TAKEN);
}

async function assertChannelsExist(db: Db, ids: string[]): Promise<void> {
  if (ids.length > 0 && (await db.$count(channels, inArray(channels.id, ids))) !== ids.length) {
    throw badRequest('Canal inexistente');
  }
}

const fileSlug = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'chatbot';

/** The `file` part of a multipart body; 400 for a missing file, a non-multipart body or one past the 64 MB limit. */
async function readBotMedia(req: FastifyRequest): Promise<{ buffer: Buffer; mime: string; name: string }> {
  try {
    const part = await req.file();
    if (!part) throw badRequest(BAD_MEDIA);
    const buffer = await part.toBuffer(); // throws (413) past the limit set in buildApp
    return {
      buffer,
      mime: baseMime(part.mimetype) || 'application/octet-stream',
      name: (part.filename || 'arquivo').slice(0, 200),
    };
  } catch (err) {
    // @fastify/multipart: 406 not multipart, 413 file too large, ...
    if (err instanceof HttpError) throw err;
    if (typeof (err as { statusCode?: unknown }).statusCode === 'number') throw badRequest(BAD_MEDIA);
    throw err;
  }
}

export function registerBotRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/bots', admin, async () =>
    toBotDtos(ctx.db, await ctx.db.select().from(bots).orderBy(asc(bots.name))),
  );

  app.post('/api/bots', admin, async (req) => {
    const b = CreateBody.parse(req.body);
    await assertNameFree(ctx.db, b.name);
    const graph = STARTER_GRAPH();
    const row = await createBot(ctx.db, {
      name: b.name, description: b.description, graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, [], graph)).length === 0, // no channel yet: v1 has that problem
    });
    return toBotDto(ctx.db, row);
  });

  app.get('/api/bots/:id', admin, async (req) => toBotDto(ctx.db, await getBot(ctx.db, IdParams.parse(req.params).id)));

  app.patch('/api/bots/:id', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = PatchBody.parse(req.body);
    const bot = await getBot(ctx.db, id);
    if (b.name !== undefined) await assertNameFree(ctx.db, b.name, id);
    const startChannelIds = b.startChannelIds && [...new Set(b.startChannelIds)];
    if (startChannelIds) await assertChannelsExist(ctx.db, startChannelIds);
    const set = { ...b, startChannelIds };
    if (Object.values(set).every((v) => v === undefined)) return toBotDto(ctx.db, bot);
    const [row] = await ctx.db.update(bots).set(set).where(eq(bots.id, id)).returning();
    return toBotDto(ctx.db, row);
  });

  app.delete('/api/bots/:id', admin, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await getBot(ctx.db, id);
    const live = await ctx.db.$count(
      botRuns,
      and(eq(botRuns.botId, id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])),
    );
    if (live) throw conflict('Este chatbot tem execuções em andamento');
    const usedBy = await callersOf(ctx.db, id);
    if (usedBy.length) throw new HttpError(409, 'Este chatbot é acionado por outros fluxos', { usedBy });
    // Cascades to bot_versions and bot_runs; messages.bot_run_id becomes null.
    await ctx.db.delete(bots).where(eq(bots.id, id));
    return reply.code(204).send();
  });

  app.post('/api/bots/:id/duplicate', admin, async (req) => {
    const bot = await getBot(ctx.db, IdParams.parse(req.params).id);
    const { graph } = await latestVersion(ctx.db, bot.id);
    const row = await createBot(ctx.db, {
      name: await uniqueBotName(ctx.db, `${bot.name} (cópia)`),
      description: bot.description, graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, bot.startChannelIds, graph)).length === 0,
      startChannelIds: bot.startChannelIds, manualStart: bot.manualStart, manualTitle: bot.manualTitle,
    });
    if (!bot.manualUnlisted) return toBotDto(ctx.db, row);
    // createBot has no manualUnlisted input.
    const [copy] = await ctx.db.update(bots).set({ manualUnlisted: true }).where(eq(bots.id, row.id)).returning();
    return toBotDto(ctx.db, copy);
  });

  app.get('/api/bots/:id/versions', admin, async (req) =>
    toBotVersionSummaries(ctx.db, await getBot(ctx.db, IdParams.parse(req.params).id)),
  );

  app.get('/api/bots/:id/versions/:n', admin, async (req) => {
    const { id, n } = VersionParams.parse(req.params);
    const bot = await getBot(ctx.db, id);
    return toVersionDto(ctx.db, bot, await getVersionByNumber(ctx.db, id, n));
  });

  // Spec §9: an invalid graph is still saved as a draft (valid=false); only publishing it is refused.
  app.post('/api/bots/:id/versions', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const b = SaveVersionBody.parse(req.body);
    // The editor PATCHes the bot's channels before saving, so this reads the channels being saved with.
    const bot = await getBot(ctx.db, id);
    const problems = await problemsFor(ctx.db, id, bot.startChannelIds, b.graph);
    const valid = problems.length === 0;
    const version = await insertBotVersion(ctx.db, {
      botId: id, graph: b.graph, valid, createdBy: req.user.id, label: b.label || null,
    });
    await ctx.db
      .update(bots)
      .set(b.publish && valid ? { publishedVersionId: version.id } : { updatedAt: new Date() })
      .where(eq(bots.id, id));
    if (b.publish && !valid) throw new HttpError(400, 'O fluxo tem problemas', { problems });
    return toVersionDto(ctx.db, await getBot(ctx.db, id), version);
  });

  app.post('/api/bots/:id/status', admin, async (req) => {
    const { id } = IdParams.parse(req.params);
    const { status } = StatusBody.parse(req.body);
    const bot = await getBot(ctx.db, id);
    if (status === 'active' && !bot.publishedVersionId) throw badRequest('Publique uma versão antes de ativar');
    const [row] = await ctx.db.update(bots).set({ status }).where(eq(bots.id, id)).returning();
    return toBotDto(ctx.db, row);
  });

  app.post('/api/bots/import', admin, async (req) => {
    const b = ImportBody.parse(req.body);
    const row = await createBot(ctx.db, {
      name: await uniqueBotName(ctx.db, b.name), graph: b.graph, publish: false, createdBy: req.user.id,
      valid: (await problemsFor(ctx.db, null, [], b.graph)).length === 0, // imported bots start with no channel
    });
    return toBotDto(ctx.db, row);
  });

  app.get('/api/bots/:id/export', admin, async (req, reply) => {
    const bot = await getBot(ctx.db, IdParams.parse(req.params).id);
    const body: BotExport = { name: bot.name, graph: (await latestVersion(ctx.db, bot.id)).graph };
    return reply.header('content-disposition', `attachment; filename="${fileSlug(bot.name)}.json"`).send(body);
  });

  app.post('/api/bots/media', admin, async (req): Promise<BotMediaDto> => {
    const { buffer, mime, name } = await readBotMedia(req);
    const saved = await saveMedia(ctx.config.mediaDir, buffer, mime, name, 'bots');
    return { path: saved.path, name, mime, size: saved.size };
  });

  registerRunRoutes(app, ctx);
}

/** Routes for every user. The chat-scoped ones go through getChatForUser, so a chat the user cannot see is 404. */
function registerRunRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/bots/manual', async (): Promise<ManualBotDto[]> => {
    const rows = await ctx.db
      .select({ id: bots.id, name: bots.name, manualTitle: bots.manualTitle })
      .from(bots)
      .where(
        and(
          eq(bots.status, 'active'), isNotNull(bots.publishedVersionId),
          eq(bots.manualStart, true), eq(bots.manualUnlisted, false),
        ),
      );
    return rows
      .map((r) => ({ id: r.id, title: r.manualTitle || r.name }))
      .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
  });

  app.post('/api/chats/:id/bot-runs', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { botId } = StartRunBody.parse(req.body);
    const chat = await getChatForUser(ctx, req.user, id);
    if (chat.state !== 'open') throw conflict('Conversa finalizada');
    const [bot] = await ctx.db.select().from(bots).where(eq(bots.id, botId));
    // A missing bot gets the same answer, so the route does not reveal which bot ids exist.
    if (!bot || bot.status !== 'active' || !bot.publishedVersionId || !bot.manualStart) {
      throw badRequest('Este chatbot não pode ser iniciado manualmente');
    }
    const started = await startRun(ctx, { botId, chatId: chat.id, entry: 'manual', startedBy: req.user.id }); // 409 on a duplicate
    // Re-read: the DTO shows the state after the first step (waiting_reply, finished…).
    const [run] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, started.id));
    return toBotRunDto(ctx.db, run ?? started);
  });

  app.get('/api/chats/:id/bot-runs', async (req) => {
    const chat = await getChatForUser(ctx, req.user, IdParams.parse(req.params).id);
    const runs = await runningRunsForChat(ctx.db, chat.id);
    return Promise.all(runs.map((r) => toBotRunDto(ctx.db, r)));
  });

  // Idempotent: an already terminal run comes back as it is.
  app.post('/api/bot-runs/:id/stop', async (req) => {
    const { id } = IdParams.parse(req.params);
    const [run] = await ctx.db.select().from(botRuns).where(eq(botRuns.id, id));
    if (!run) throw notFound();
    await getChatForUser(ctx, req.user, run.chatId); // 404 unless canSee
    const row = NON_TERMINAL_RUN_STATES.includes(run.state)
      ? await stopRun(ctx, id, { userId: req.user.id, reason: 'manual' })
      : run;
    return toBotRunDto(ctx.db, row);
  });

  app.post('/api/bots/from-template', admin, async (req) => {
    const body = TemplateBody.parse(req.body);
    return createOfficeTemplate(ctx, body, req.user.id);
  });
}
