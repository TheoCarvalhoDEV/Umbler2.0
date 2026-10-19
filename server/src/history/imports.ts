import { randomUUID } from 'node:crypto';
import { desc, inArray } from 'drizzle-orm';
import type { HistoryImportDto, HistoryPeriod } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { historyImports } from '../db/schema.js';
import { conflict } from '../lib/http-error.js';

export type HistoryImportRow = typeof historyImports.$inferSelect;

/** §5.1: the 409 when the channel already has an import running. */
export const IMPORT_RUNNING = 'Já existe uma importação em andamento';

export function toHistoryImportDto(r: HistoryImportRow): HistoryImportDto {
  return {
    id: r.id,
    period: r.period,
    state: r.state,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    messagesImported: r.messagesImported,
    contactsCreated: r.contactsCreated,
    oldestMessageAt: r.oldestMessageAt ? r.oldestMessageAt.toISOString() : null,
    error: r.error,
  };
}

/** The newest import of each channel: the one Configurações › Canais shows. */
export async function latestImports(db: Db | Tx, channelIds: string[]): Promise<Map<string, HistoryImportRow>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([historyImports.channelId])
    .from(historyImports)
    .where(inArray(historyImports.channelId, channelIds))
    .orderBy(historyImports.channelId, desc(historyImports.startedAt));
  return new Map(rows.map((r) => [r.channelId, r]));
}

/** A running import, due now (the worker runs it on its next beat). 409 IMPORT_RUNNING while one runs (partial unique index). */
export async function startHistoryImport(
  ctx: AppCtx,
  channelId: string,
  input: { period: HistoryPeriod; auto: boolean },
): Promise<HistoryImportRow> {
  const now = ctx.botRuntime.now();
  const [row] = await ctx.db
    .insert(historyImports)
    .values({ id: randomUUID(), channelId, period: input.period, auto: input.auto, state: 'running', startedAt: now, lastNewAt: now, nextRunAt: now })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict(IMPORT_RUNNING);
  await ctx.hub.publishChannel(channelId);
  return row;
}
