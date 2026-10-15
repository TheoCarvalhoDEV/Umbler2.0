import { and, asc, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { NON_TERMINAL_RUN_STATES } from '@talk/shared';
import type { BotDto, BotGraph, BotRunDto, BotVersionSummaryDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { botRuns, botVersions, bots, users } from '../db/schema.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';

export type BotRow = typeof bots.$inferSelect;
export type BotVersionRow = typeof botVersions.$inferSelect;
export type BotRunRow = typeof botRuns.$inferSelect;
export type NewBotRun = typeof botRuns.$inferInsert;

// drizzle wraps the driver error, so the SQLSTATE may sit on `cause` (same check as markSent in messages/send.ts).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === '23505';
}

/** Version 1 of a bot created from the list page: start by channel → "Olá!". */
export const STARTER_GRAPH = (): BotGraph => ({
  nodes: [
    { id: 'inicio', type: 'start_channel', name: 'inicio', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'mensagem',
      type: 'send_message',
      name: 'mensagem',
      position: { x: 360, y: 0 },
      config: { text: 'Olá!', attachment: null, signature: false },
    },
  ],
  edges: [{ id: 'e-inicio-next', source: 'inicio', sourceHandle: 'next', target: 'mensagem' }],
});

// ---------- bots ----------

export async function getBot(db: Db | Tx, id: string): Promise<BotRow> {
  const [row] = await db.select().from(bots).where(eq(bots.id, id));
  if (!row) throw notFound('Chatbot não encontrado');
  return row;
}

/** base if free, else `${base} (2)`, `${base} (3)`… */
export async function uniqueBotName(db: Db | Tx, base: string): Promise<string> {
  // ponytail: reads every bot name; an office has dozens of bots, not thousands.
  const taken = new Set((await db.select({ name: bots.name }).from(bots)).map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`;
    if (!taken.has(name)) return name;
  }
}

/** One tx: insert bot (name must already be unique) + version 1; publish=true also sets publishedVersionId (requires valid). */
export async function createBot(
  db: Db,
  input: {
    name: string;
    description?: string;
    graph: BotGraph;
    valid: boolean;
    publish: boolean;
    createdBy: string | null;
    startChannelIds?: string[];
    manualStart?: boolean;
    manualTitle?: string;
  },
): Promise<BotRow> {
  if (input.publish && !input.valid) throw badRequest('O fluxo tem problemas');
  try {
    return await db.transaction(async (tx) => {
      const [bot] = await tx
        .insert(bots)
        .values({
          name: input.name,
          description: input.description ?? '',
          startChannelIds: input.startChannelIds ?? [],
          manualStart: input.manualStart ?? false,
          manualTitle: input.manualTitle ?? '',
        })
        .returning();
      const version = await insertBotVersion(tx, { botId: bot.id, graph: input.graph, valid: input.valid, createdBy: input.createdBy });
      if (!input.publish) return bot;
      const [published] = await tx.update(bots).set({ publishedVersionId: version.id }).where(eq(bots.id, bot.id)).returning();
      return published;
    });
  } catch (err) {
    // the only unique constraint a brand-new bot can hit is bots.name
    if (isUniqueViolation(err)) throw conflict('Já existe um chatbot com esse nome');
    throw err;
  }
}

/** Oldest (created_at) active bot with a published version whose start_channel_ids contains channelId and whose published graph has a start_channel node. */
export async function findChannelBot(db: Db | Tx, channelId: string): Promise<BotRow | null> {
  const rows = await db
    .select({ bot: bots, graph: botVersions.graph })
    .from(bots)
    .innerJoin(botVersions, eq(botVersions.id, bots.publishedVersionId))
    .where(and(eq(bots.status, 'active'), sql`${channelId}::uuid = any(${bots.startChannelIds})`))
    .orderBy(asc(bots.createdAt), asc(bots.id));
  return rows.find((r) => r.graph.nodes.some((n) => n.type === 'start_channel'))?.bot ?? null;
}

// ---------- versions (immutable: insert and select only) ----------

export async function getVersionRow(db: Db | Tx, versionId: string): Promise<BotVersionRow | null> {
  const [row] = await db.select().from(botVersions).where(eq(botVersions.id, versionId));
  return row ?? null;
}

export async function getPublishedVersion(db: Db | Tx, bot: Pick<BotRow, 'publishedVersionId'>): Promise<BotVersionRow | null> {
  return bot.publishedVersionId ? getVersionRow(db, bot.publishedVersionId) : null;
}

export async function getVersionByNumber(db: Db | Tx, botId: string, n: number): Promise<BotVersionRow> {
  const [row] = await db
    .select()
    .from(botVersions)
    .where(and(eq(botVersions.botId, botId), eq(botVersions.number, n)));
  if (!row) throw notFound('Versão não encontrada');
  return row;
}

export async function latestVersion(db: Db | Tx, botId: string): Promise<BotVersionRow> {
  const [row] = await db.select().from(botVersions).where(eq(botVersions.botId, botId)).orderBy(desc(botVersions.number)).limit(1);
  if (!row) throw notFound('Versão não encontrada');
  return row;
}

/** number = coalesce(max(number),0)+1 for the bot; one retry on unique violation 23505. */
export async function insertBotVersion(
  db: Db | Tx,
  input: { botId: string; graph: BotGraph; valid: boolean; createdBy: string | null; label?: string | null },
): Promise<BotVersionRow> {
  // A real tx on Db, a savepoint inside a caller's tx: a 23505 rolls back only this insert, so the retry can run.
  const attempt = () =>
    (db as Db).transaction(async (t) => {
      const [row] = await t
        .insert(botVersions)
        .values({
          botId: input.botId,
          number: sql<number>`(select coalesce(max("number"), 0) + 1 from "bot_versions" where "bot_id" = ${input.botId})`,
          graph: input.graph,
          valid: input.valid,
          createdBy: input.createdBy,
          label: input.label ?? null,
        })
        .returning();
      return row;
    });
  try {
    return await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // ponytail: one retry covers two saves of the same bot racing for the same number; a third concurrent save gets the error.
    return attempt();
  }
}

// ---------- runs ----------

export async function insertRun(db: Db | Tx, values: NewBotRun): Promise<BotRunRow> {
  try {
    const [row] = await db.insert(botRuns).values(values).returning();
    return row;
  } catch (err) {
    // the only unique constraint on bot_runs besides the random id is bot_runs_one_active_per_chat_bot
    if (isUniqueViolation(err)) throw conflict('Este chatbot já está em execução nesta conversa');
    throw err;
  }
}

export async function getRun(db: Db | Tx, id: string): Promise<BotRunRow | null> {
  const [row] = await db.select().from(botRuns).where(eq(botRuns.id, id));
  return row ?? null;
}

/** SELECT … FOR UPDATE: call inside the tx that re-checks and changes the run's state. */
export async function lockRun(tx: Tx, id: string): Promise<BotRunRow | null> {
  const [row] = await tx.select().from(botRuns).where(eq(botRuns.id, id)).for('update');
  return row ?? null;
}

// ---------- DTOs ----------

/** One query per aggregate, not per row. */
export async function toBotDtos(db: Db | Tx, rows: BotRow[]): Promise<BotDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const publishedIds = rows.flatMap((r) => (r.publishedVersionId ? [r.publishedVersionId] : []));

  const latest = await db
    .select({ botId: botVersions.botId, n: max(botVersions.number) })
    .from(botVersions)
    .where(inArray(botVersions.botId, ids))
    .groupBy(botVersions.botId);
  const published = publishedIds.length
    ? await db.select({ id: botVersions.id, n: botVersions.number }).from(botVersions).where(inArray(botVersions.id, publishedIds))
    : [];
  const active = await db
    .select({ botId: botRuns.botId, n: count() })
    .from(botRuns)
    .where(and(inArray(botRuns.botId, ids), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])))
    .groupBy(botRuns.botId);

  const latestBy = new Map(latest.map((r) => [r.botId, r.n ?? 0]));
  const publishedBy = new Map(published.map((r) => [r.id, r.n]));
  const activeBy = new Map(active.map((r) => [r.botId, r.n]));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    status: r.status,
    startChannelIds: r.startChannelIds,
    manualStart: r.manualStart,
    manualTitle: r.manualTitle,
    manualUnlisted: r.manualUnlisted,
    publishedVersionId: r.publishedVersionId,
    publishedVersionNumber: r.publishedVersionId ? (publishedBy.get(r.publishedVersionId) ?? null) : null,
    latestVersionNumber: latestBy.get(r.id) ?? 0,
    runCount: r.runCount,
    activeRunCount: activeBy.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function toBotDto(db: Db | Tx, row: BotRow): Promise<BotDto> {
  const [dto] = await toBotDtos(db, [row]);
  return dto;
}

/** number desc; the graph is not loaded (see BotVersionDto for that). */
export async function toBotVersionSummaries(db: Db | Tx, bot: BotRow): Promise<BotVersionSummaryDto[]> {
  const rows = await db
    .select({
      id: botVersions.id,
      botId: botVersions.botId,
      number: botVersions.number,
      valid: botVersions.valid,
      label: botVersions.label,
      createdByName: users.name,
      createdAt: botVersions.createdAt,
    })
    .from(botVersions)
    .leftJoin(users, eq(users.id, botVersions.createdBy))
    .where(eq(botVersions.botId, bot.id))
    .orderBy(desc(botVersions.number));
  return rows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString(), published: v.id === bot.publishedVersionId }));
}

export async function toBotRunDto(db: Db | Tx, row: BotRunRow): Promise<BotRunDto> {
  const [bot] = await db.select({ name: bots.name }).from(bots).where(eq(bots.id, row.botId));
  const [starter] = row.startedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.startedBy)) : [];
  return {
    id: row.id,
    botId: row.botId,
    botName: bot?.name ?? '',
    chatId: row.chatId,
    state: row.state,
    currentNodeId: row.currentNodeId,
    depth: row.depth,
    startedByName: starter?.name ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
