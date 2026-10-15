import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { asc, eq, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { QuickAnswerDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import { quickAnswers } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { mediaResponseHeaders, saveMedia } from '../messages/media.js';
import { buildChatVars, renderQuickAnswer } from '../messages/quick-answers.js';

type QaRow = typeof quickAnswers.$inferSelect;
type Upload = { buffer: Buffer; mime: string; name: string };

const IdParams = z.object({ id: z.uuid() });
const qaFields = {
  name: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  visibility: z.enum(['all', 'owner']),
};
const Create = z.object({ ...qaFields, visibility: qaFields.visibility.default('owner') });
// Multipart fields arrive as strings, JSON as booleans.
const Patch = z
  .object({
    ...qaFields,
    removeAttachment: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true'),
  })
  .partial();
const RenderBody = z.object({ chatId: z.uuid() });

// saveMedia keeps the extension; only inline-safe types need their real mime,
// mediaResponseHeaders turns everything else into an octet-stream download anyway.
const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const toDto = (q: QaRow): QuickAnswerDto => ({
  id: q.id,
  name: q.name,
  body: q.body,
  hasAttachment: q.attachmentPath !== null,
  visibility: q.visibility,
  ownerId: q.ownerId,
});
const canView = (u: AuthUser, q: QaRow) => q.visibility === 'all' || q.ownerId === u.id;
const canEdit = (u: AuthUser, q: QaRow) => q.ownerId === u.id || (u.role === 'admin' && q.visibility === 'all');

async function readInput(req: FastifyRequest): Promise<{ fields: Record<string, unknown>; file: Upload | null }> {
  if (!req.isMultipart()) return { fields: (req.body ?? {}) as Record<string, unknown>, file: null };
  const fields: Record<string, unknown> = {};
  let file: Upload | null = null;
  for await (const part of req.parts()) {
    if (part.type === 'file') file = { buffer: await part.toBuffer(), mime: part.mimetype, name: part.filename };
    else fields[part.fieldname] = part.value;
  }
  return { fields, file };
}

async function load(ctx: AppCtx, user: AuthUser, id: string): Promise<QaRow> {
  const [row] = await ctx.db.select().from(quickAnswers).where(eq(quickAnswers.id, id));
  if (!row || !canView(user, row)) throw notFound('Resposta rápida não encontrada');
  return row;
}

async function store(ctx: AppCtx, file: Upload | null): Promise<string | null> {
  return file ? (await saveMedia(ctx.config.mediaDir, file.buffer, file.mime, file.name)).path : null;
}

function assertCanSetVisibility(user: AuthUser, visibility: 'all' | 'owner' | undefined): void {
  if (visibility === 'all' && user.role !== 'admin') throw forbidden('Só administradores criam respostas para todos');
}

export function registerQuickAnswerRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/quick-answers', async (req) => {
    const rows = await ctx.db
      .select()
      .from(quickAnswers)
      .where(or(eq(quickAnswers.visibility, 'all'), eq(quickAnswers.ownerId, req.user.id)))
      .orderBy(asc(quickAnswers.name));
    return rows.map(toDto);
  });

  app.post('/api/quick-answers', async (req) => {
    const { fields, file } = await readInput(req);
    const b = Create.parse(fields);
    assertCanSetVisibility(req.user, b.visibility);
    const [row] = await ctx.db
      .insert(quickAnswers)
      .values({
        id: crypto.randomUUID(),
        name: b.name,
        body: b.body,
        visibility: b.visibility,
        ownerId: req.user.id,
        attachmentPath: await store(ctx, file),
        createdAt: new Date(),
      })
      .returning();
    return toDto(row);
  });

  app.patch('/api/quick-answers/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { fields, file } = await readInput(req);
    const qa = await load(ctx, req.user, id);
    if (!canEdit(req.user, qa)) throw forbidden();
    const b = Patch.parse(fields);
    assertCanSetVisibility(req.user, b.visibility);
    // Hiding someone else's shared answer would remove it from the whole office and lock the admin out of it.
    if (b.visibility === 'owner' && qa.ownerId !== null && qa.ownerId !== req.user.id) {
      throw forbidden('Só o dono torna a resposta particular');
    }
    // ponytail: a replaced/removed attachment file stays on disk; add cleanup if /data/media grows.
    const attachmentPath = file ? await store(ctx, file) : b.removeAttachment ? null : undefined;
    // An ownerless (imported) answer made private goes to whoever did it; otherwise nobody could see or edit it.
    const ownerId = b.visibility === 'owner' && qa.ownerId === null ? req.user.id : undefined;
    const set = { name: b.name, body: b.body, visibility: b.visibility, attachmentPath, ownerId };
    if (Object.values(set).every((v) => v === undefined)) return toDto(qa);
    const [row] = await ctx.db.update(quickAnswers).set(set).where(eq(quickAnswers.id, id)).returning();
    return toDto(row);
  });

  app.delete('/api/quick-answers/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const qa = await load(ctx, req.user, id);
    if (!canEdit(req.user, qa)) throw forbidden();
    await ctx.db.delete(quickAnswers).where(eq(quickAnswers.id, id));
    return reply.code(204).send();
  });

  // Fills the variables for the composer; never sends anything (spec §5.7).
  app.post('/api/quick-answers/:id/render', async (req) => {
    const qa = await load(ctx, req.user, IdParams.parse(req.params).id);
    const chat = await getChatForUser(ctx, req.user, RenderBody.parse(req.body).chatId);
    return { text: renderQuickAnswer(qa.body, await buildChatVars(ctx.db, chat, req.user)) };
  });

  // Spec §4: an attachment of an owner-only answer is served to its owner only (load() → 404).
  app.get('/api/quick-answers/:id/attachment', async (req, reply) => {
    const qa = await load(ctx, req.user, IdParams.parse(req.params).id);
    if (!qa.attachmentPath) throw notFound('Esta resposta não tem anexo');
    const fileName = basename(qa.attachmentPath);
    const mime = MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
    return reply
      .headers(mediaResponseHeaders(mime, fileName))
      .send(createReadStream(join(ctx.config.mediaDir, qa.attachmentPath)));
  });
}
