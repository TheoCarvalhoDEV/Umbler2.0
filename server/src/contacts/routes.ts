import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { contacts } from '../db/schema.js';
import { forbidden } from '../lib/http-error.js';
import { sendAvatarFile } from '../media/avatar-files.js';
import {
  createContact,
  createContactNote,
  deleteContactNote,
  exportContactsCsv,
  getContact,
  listContactChats,
  listContactNotes,
  listContacts,
  setContactBlocked,
  setContactFields,
  setContactTags,
  updateContact,
  updateContactNote,
} from './service.js';

const IdParams = z.object({ id: z.uuid() });
const NoteParams = z.object({ id: z.uuid(), noteId: z.uuid() });

// Absent stays undefined (PATCH leaves it alone); '' becomes null (clears it).
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const contactFields = {
  name: optText(120),
  email: optText(200),
  landline: optText(30),
  address: z.record(z.string(), z.string().max(200)).nullable().optional(),
};
const CreateBody = z.object({ ...contactFields, phone: z.string().min(1).max(40) });
const PatchBody = z.object({ ...contactFields, phone: z.string().min(1).max(40).optional() });
const FilterQuery = z.object({
  q: z.string().max(100).optional(),
  tagId: z.uuid().optional(),
  blocked: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
const ListQuery = FilterQuery.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const BlockBody = z.object({ blocked: z.boolean() });
const TagsBody = z.object({ tagIds: z.array(z.uuid()).max(50) });
const FieldsBody = z.record(z.uuid(), z.string().max(500));
const NoteBody = z.object({ body: z.string().trim().min(1).max(5000) });
const NotePatch = z
  .object({ body: z.string().trim().min(1).max(5000).optional(), pinned: z.boolean().optional() })
  .refine((p) => p.body !== undefined || p.pinned !== undefined, { error: 'Nada para alterar' });

export function registerContactRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/contacts', async (req) => listContacts(ctx.db, ListQuery.parse(req.query)));

  // Admin only: it hands over the whole client base (LGPD).
  app.get('/api/contacts/export.csv', async (req, reply) => {
    if (req.user.role !== 'admin') throw forbidden();
    const csv = await exportContactsCsv(ctx.db, FilterQuery.parse(req.query));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="contatos.csv"')
      .send(csv);
  });

  app.post('/api/contacts', async (req) => createContact(ctx, CreateBody.parse(req.body)));

  app.get('/api/contacts/:id', async (req) => getContact(ctx.db, IdParams.parse(req.params).id));

  app.patch('/api/contacts/:id', async (req) => updateContact(ctx, IdParams.parse(req.params).id, PatchBody.parse(req.body)));

  app.post('/api/contacts/:id/block', async (req) =>
    setContactBlocked(ctx, IdParams.parse(req.params).id, BlockBody.parse(req.body).blocked),
  );

  app.put('/api/contacts/:id/tags', async (req) =>
    setContactTags(ctx, IdParams.parse(req.params).id, TagsBody.parse(req.body).tagIds),
  );

  app.put('/api/contacts/:id/fields', async (req) =>
    setContactFields(ctx, IdParams.parse(req.params).id, FieldsBody.parse(req.body)),
  );

  // Any logged-in user (contacts belong to the office); the auth plugin already rejects anonymous /api/*.
  app.get('/api/contacts/:id/avatar', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [row] = await ctx.db.select({ path: contacts.avatarPath }).from(contacts).where(eq(contacts.id, id));
    return sendAvatarFile(reply, ctx.config.mediaDir, row?.path);
  });

  app.get('/api/contacts/:id/chats', async (req) => listContactChats(ctx, req.user, IdParams.parse(req.params).id));

  app.get('/api/contacts/:id/notes', async (req) => listContactNotes(ctx.db, IdParams.parse(req.params).id));

  app.post('/api/contacts/:id/notes', async (req) =>
    createContactNote(ctx, req.user, IdParams.parse(req.params).id, NoteBody.parse(req.body).body),
  );

  app.patch('/api/contacts/:id/notes/:noteId', async (req) => {
    const { id, noteId } = NoteParams.parse(req.params);
    return updateContactNote(ctx, id, noteId, NotePatch.parse(req.body));
  });

  app.delete('/api/contacts/:id/notes/:noteId', async (req, reply) => {
    const { id, noteId } = NoteParams.parse(req.params);
    await deleteContactNote(ctx, id, noteId);
    return reply.code(204).send();
  });
}
