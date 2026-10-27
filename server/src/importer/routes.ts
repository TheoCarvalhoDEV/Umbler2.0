import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UmblerAnalysisDto, UmblerImportDto, UmblerImportStatusDto, UmblerMappingDto, UmblerProgressDto } from '@talk/shared';
import { getAutoRules } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { channels, sectors, umblerImports, users } from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { emptyProgress, type UmblerImportRow } from './job.js';

// Spec 2026-10-21 importar-umbler §6, §10: "Importar do Umbler" (admins only; every POST passes the global Origin check).

export const UMBLER_RUNNING = 'Já existe uma importação do Umbler em andamento';
export const NO_TOKEN = 'Token do Umbler não configurado';
export const BLOCK_RULES =
  'Desligue as Regras automáticas antes de importar: elas finalizariam ou devolveriam à fila as conversas abertas importadas e poderiam enviar a mensagem de encerramento a clientes.';
export const BLOCK_READ_TEST = 'A leitura marcou uma conversa como lida no Umbler. A importação foi bloqueada para não alterar o Umbler.';
// decisions: these three are not in the spec
export const BAD_MAPPING = 'Escolha um destino para cada canal, setor e atendente.';
export const NOT_ANALYZED = 'Analise o Umbler antes de importar.';
export const NOT_FAILED = 'Só uma importação que parou pode continuar.';
export const NOT_NEWEST = 'Existe uma análise mais recente do Umbler. Recarregue a página e importe a partir dela.';

const idParams = z.object({ id: z.uuid() });
const startBody = z.object({
  mapping: z.object({
    channels: z.record(z.string(), z.string()),
    sectors: z.record(z.string(), z.string()),
    members: z.record(z.string(), z.string()),
  }),
});

/** §6.3, checked on every read and again right before start / resume (the rules may have been switched on meanwhile). */
export async function importBlocks(db: Db, row: UmblerImportRow): Promise<string[]> {
  const blocks: string[] = [];
  const rules = await getAutoRules(db);
  if (rules.returnToQueue.enabled || rules.closeInactive.enabled) blocks.push(BLOCK_RULES);
  if (row.analysis?.readTest === 'marked') blocks.push(BLOCK_READ_TEST);
  return blocks;
}

function progressDto(p: UmblerImportRow['progress']): UmblerProgressDto | null {
  if (!p) return null;
  const { maps: _maps, phaseStart: _start, ...rest } = p; // ids and resume state: the screen has no use for them
  return rest;
}

export async function toUmblerImportDto(db: Db, row: UmblerImportRow): Promise<UmblerImportDto> {
  return {
    id: row.id,
    state: row.state,
    phase: row.phase,
    analysis: row.analysis,
    progress: progressDto(row.progress),
    report: row.report,
    error: row.error,
    blocks: row.state === 'analyzed' || row.state === 'failed' ? await importBlocks(db, row) : [],
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** §10 start: every Umbler channel, sector and attendant of the analysis has a destination that exists. */
async function validMapping(db: Db, a: UmblerAnalysisDto, m: UmblerMappingDto): Promise<boolean> {
  const ids = async (rows: Promise<Array<{ id: string }>>) => new Set((await rows).map((r) => r.id));
  const ourChannels = await ids(db.select({ id: channels.id }).from(channels));
  const ourSectors = await ids(db.select({ id: sectors.id }).from(sectors));
  const ourUsers = await ids(db.select({ id: users.id }).from(users).where(isNull(users.deletedAt)));
  return (
    a.channels.every((ch) => m.channels[ch.id] === 'none' || (ch.whatsapp && ourChannels.has(m.channels[ch.id] ?? ''))) &&
    a.sectors.every((s) => m.sectors[s.id] === 'create' || ourSectors.has(m.sectors[s.id] ?? '')) &&
    a.members.every((u) => m.members[u.id] === 'create' || m.members[u.id] === 'none' || ourUsers.has(m.members[u.id] ?? ''))
  );
}

const pgCode = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
};

/** → running, after the §6.3 blocks; 409 while another import is active (umbler_imports_one_active). */
async function begin(db: Db, row: UmblerImportRow, patch: Partial<typeof umblerImports.$inferInsert>): Promise<UmblerImportDto> {
  const blocks = await importBlocks(db, row);
  if (blocks.length) throw conflict(blocks[0]);
  let updated: UmblerImportRow | undefined;
  try {
    [updated] = await db
      .update(umblerImports)
      .set({ ...patch, state: 'running', error: null })
      .where(and(eq(umblerImports.id, row.id), eq(umblerImports.state, row.state)))
      .returning();
  } catch (err) {
    if (pgCode(err) === '23505') throw conflict(UMBLER_RUNNING);
    throw err;
  }
  if (!updated) throw conflict(UMBLER_RUNNING); // changed meanwhile
  return toUmblerImportDto(db, updated);
}

async function rowOf(db: Db, id: string): Promise<UmblerImportRow> {
  const [row] = await db.select().from(umblerImports).where(eq(umblerImports.id, id));
  if (!row) throw notFound();
  return row;
}

export function registerUmblerImportRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const admin = (req: FastifyRequest) => {
    if (req.user.role !== 'admin') throw forbidden();
  };

  // the screen polls this every 3 s while it analyzes or imports (§6); never any part of the token
  app.get('/api/umbler-import', async (req): Promise<UmblerImportStatusDto> => {
    admin(req);
    const [row] = await ctx.db.select().from(umblerImports).orderBy(desc(umblerImports.createdAt)).limit(1);
    return { tokenConfigured: ctx.config.umblerToken !== null, current: row ? await toUmblerImportDto(ctx.db, row) : null };
  });

  // the worker picks the row up on its next beat (≤ 15 s)
  app.post('/api/umbler-import/analyze', async (req) => {
    admin(req);
    if (!ctx.config.umblerToken) throw badRequest(NO_TOKEN);
    const [row] = await ctx.db
      .insert(umblerImports)
      .values({ state: 'analyzing', createdBy: req.user.id, progress: emptyProgress() })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict(UMBLER_RUNNING);
    return toUmblerImportDto(ctx.db, row);
  });

  app.post('/api/umbler-import/:id/start', async (req) => {
    admin(req);
    if (!ctx.config.umblerToken) throw badRequest(NO_TOKEN);
    const { id } = idParams.parse(req.params);
    const { mapping } = startBody.parse(req.body);
    const row = await rowOf(ctx.db, id);
    if (row.state !== 'analyzed' || !row.analysis) throw conflict(NOT_ANALYZED);
    // the screen shows only the newest row: an older analysis (another tab, another admin) is stale
    const [newest] = await ctx.db.select({ id: umblerImports.id }).from(umblerImports).orderBy(desc(umblerImports.createdAt)).limit(1);
    if (newest?.id !== row.id) throw conflict(NOT_NEWEST);
    if (!(await validMapping(ctx.db, row.analysis, mapping))) throw badRequest(BAD_MAPPING);
    return begin(ctx.db, row, { phase: 'catalog', mapping, startedAt: new Date() });
  });

  // "Continuar": same phase, same counters
  app.post('/api/umbler-import/:id/resume', async (req) => {
    admin(req);
    if (!ctx.config.umblerToken) throw badRequest(NO_TOKEN);
    const row = await rowOf(ctx.db, idParams.parse(req.params).id);
    if (row.state !== 'failed' || !row.startedAt) throw conflict(NOT_FAILED);
    // the report's duration leaves out the time it sat stopped (updated_at is when it failed: nothing writes it after)
    const startedAt = new Date(row.startedAt.getTime() + Math.max(0, Date.now() - row.updatedAt.getTime()));
    return begin(ctx.db, row, { startedAt });
  });
}
