import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCHEDULE_TEXT_MAX, SCHEDULED_TABS } from '@talk/shared';
import { readParts } from '../chats/routes.js';
import type { AppCtx } from '../ctx.js';
import { cancelScheduled, createScheduled, listChatScheduled, listScheduled, updateScheduled } from './scheduled.js';

const idParams = z.object({ id: z.uuid() });
const text = z.string().trim().min(1).max(SCHEDULE_TEXT_MAX);
const sendAt = z.iso.datetime({ offset: true });
const createJson = z.object({ text, sendAt, signature: z.boolean().default(true) });
/** Multipart: the same fields, before the one file (same limits as a send). */
const createFields = z.object({ text, sendAt, signature: z.stringbool().default(true) });
const patchBody = z
  .object({ text: text.optional(), sendAt: sendAt.optional() })
  .refine((b) => b.text !== undefined || b.sendAt !== undefined, 'Nada para alterar');
const listQuery = z.object({ status: z.enum(SCHEDULED_TABS).default('pending') });

/** Spec 2026-10-20 agendamentos §5. */
export function registerAutomationRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post('/api/chats/:id/scheduled-messages', async (req) => {
    const { id } = idParams.parse(req.params);
    if (req.isMultipart()) {
      const { fields, file } = await readParts(req);
      const f = createFields.parse(fields);
      return createScheduled(ctx, req.user, id, { text: f.text, sendAt: new Date(f.sendAt), signature: f.signature, file });
    }
    const b = createJson.parse(req.body);
    return createScheduled(ctx, req.user, id, { text: b.text, sendAt: new Date(b.sendAt), signature: b.signature });
  });

  app.get('/api/chats/:id/scheduled-messages', async (req) => listChatScheduled(ctx, req.user, idParams.parse(req.params).id));

  app.get('/api/scheduled-messages', async (req) => listScheduled(ctx, req.user, listQuery.parse(req.query).status));

  app.patch('/api/scheduled-messages/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = patchBody.parse(req.body);
    return updateScheduled(ctx, req.user, id, { text: b.text, sendAt: b.sendAt ? new Date(b.sendAt) : undefined });
  });

  app.post('/api/scheduled-messages/:id/cancel', async (req) => cancelScheduled(ctx, req.user, idParams.parse(req.params).id));
}
