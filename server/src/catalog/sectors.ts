import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SectorDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { chats, sectors, userSectors } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

const IdParams = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(60);
const Create = z.object({ name, isDefault: z.boolean().optional() });
// isDefault only accepts true: a sector stops being the default when another one becomes it.
const Patch = z
  .object({ name: name.optional(), position: z.number().int().min(0).optional(), isDefault: z.literal(true).optional() })
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (s: typeof sectors.$inferSelect): SectorDto => ({
  id: s.id,
  name: s.name,
  position: s.position,
  isDefault: s.isDefault,
});

export function registerSectorRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/sectors', async () => {
    const rows = await ctx.db.select().from(sectors).orderBy(asc(sectors.position), asc(sectors.name));
    return rows.map(toDto);
  });

  app.post('/api/sectors', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const row = await ctx.db.transaction(async (tx) => {
      // Unset first: the partial unique index allows a single is_default = true.
      if (b.isDefault) await tx.update(sectors).set({ isDefault: false }).where(eq(sectors.isDefault, true));
      const count = await tx.$count(sectors);
      // The first sector becomes the default: without one, every inbound message fails (getDefaultSectorId).
      const [created] = await tx
        .insert(sectors)
        .values({ id: crypto.randomUUID(), name: b.name, position: count, isDefault: b.isDefault ?? count === 0 })
        .returning();
      return created;
    });
    return toDto(row);
  });

  app.patch('/api/sectors/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    const row = await ctx.db.transaction(async (tx) => {
      if (b.isDefault) {
        await tx.update(sectors).set({ isDefault: false }).where(and(eq(sectors.isDefault, true), ne(sectors.id, id)));
      }
      const [updated] = await tx.update(sectors).set(b).where(eq(sectors.id, id)).returning();
      if (!updated) throw notFound('Setor não encontrado'); // also rolls back the unset above
      return updated;
    });
    return toDto(row);
  });

  app.delete('/api/sectors/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    await ctx.db.transaction(async (tx) => {
      const [s] = await tx.select().from(sectors).where(eq(sectors.id, id));
      if (!s) throw notFound('Setor não encontrado');
      if (s.isDefault) throw conflict('O setor padrão não pode ser excluído');
      if (await tx.$count(chats, eq(chats.sectorId, id))) throw conflict('Este setor tem conversas e não pode ser excluído');
      if ((await getTriageMenu(tx)).options.some((o) => o.sectorId === id)) {
        throw conflict('Este setor está no menu de triagem');
      }
      await tx.delete(userSectors).where(eq(userSectors.sectorId, id));
      await tx.delete(sectors).where(eq(sectors.id, id));
    });
    return reply.code(204).send();
  });
}
