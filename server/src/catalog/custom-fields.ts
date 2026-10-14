import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustomFieldDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { contactFieldValues, customFields } from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/http-error.js';

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['text', 'number', 'date', 'cpf', 'cnpj']),
  position: z.number().int().min(0).optional(),
};
const Create = z.object(fields);
const Patch = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });

const toDto = (f: typeof customFields.$inferSelect): CustomFieldDto => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  position: f.position,
});

export function registerCustomFieldRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/custom-fields', async () => {
    const rows = await ctx.db.select().from(customFields).orderBy(asc(customFields.position), asc(customFields.name));
    return rows.map(toDto);
  });

  app.post('/api/custom-fields', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const [row] = await ctx.db
      .insert(customFields)
      .values({ id: crypto.randomUUID(), name: b.name, kind: b.kind, position: b.position ?? (await ctx.db.$count(customFields)) })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Já existe um campo com este nome');
    return toDto(row);
  });

  app.patch('/api/custom-fields/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const b = Patch.parse(req.body);
    if (b.name && (await ctx.db.$count(customFields, and(eq(customFields.name, b.name), ne(customFields.id, id))))) {
      throw conflict('Já existe um campo com este nome');
    }
    // ponytail: renaming a field breaks {{campo.<old name>}} in quick answers; the render just yields ''.
    const [row] = await ctx.db.update(customFields).set(b).where(eq(customFields.id, id)).returning();
    if (!row) throw notFound('Campo não encontrado');
    return toDto(row);
  });

  app.delete('/api/custom-fields/:id', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    const deleted = await ctx.db.transaction(async (tx) => {
      await tx.delete(contactFieldValues).where(eq(contactFieldValues.fieldId, id));
      return tx.delete(customFields).where(eq(customFields.id, id)).returning({ id: customFields.id });
    });
    if (deleted.length === 0) throw notFound('Campo não encontrado');
    return reply.code(204).send();
  });
}
