import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TagDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { contactTags, tags } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(30),
  emoji: z.string().trim().max(16).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Cor inválida' }),
  position: z.number().int().min(0).optional(),
};
const Create = z.object(fields);
const Patch = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (t: typeof tags.$inferSelect): TagDto => ({
  id: t.id,
  name: t.name,
  emoji: t.emoji,
  color: t.color,
  position: t.position,
});

export function registerTagRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/tags', async () => {
    const rows = await ctx.db.select().from(tags).orderBy(asc(tags.position), asc(tags.name));
    return rows.map(toDto);
  });

  app.post('/api/tags', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const [row] = await ctx.db
      .insert(tags)
      .values({
        id: crypto.randomUUID(),
        name: b.name,
        emoji: b.emoji || null,
        color: b.color.toLowerCase(),
        position: b.position ?? (await ctx.db.$count(tags)),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Já existe uma etiqueta com este nome');
    return toDto(row);
  });

  app.patch('/api/tags/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    if (b.name && (await ctx.db.$count(tags, and(eq(tags.name, b.name), ne(tags.id, id))))) {
      throw conflict('Já existe uma etiqueta com este nome');
    }
    const [row] = await ctx.db
      .update(tags)
      .set({
        name: b.name,
        emoji: b.emoji === undefined ? undefined : b.emoji || null,
        color: b.color?.toLowerCase(),
        position: b.position,
      })
      .where(eq(tags.id, id))
      .returning();
    if (!row) throw notFound('Etiqueta não encontrada');
    return toDto(row);
  });

  app.delete('/api/tags/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db.transaction(async (tx) => {
      await tx.delete(contactTags).where(eq(contactTags.tagId, id));
      return tx.delete(tags).where(eq(tags.id, id)).returning({ id: tags.id });
    });
    if (deleted.length === 0) throw notFound('Etiqueta não encontrada');
    return reply.code(204).send();
  });
}
