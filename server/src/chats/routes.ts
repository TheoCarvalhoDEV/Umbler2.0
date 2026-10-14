import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { getChatDetail, getTimeline, listChats } from '../inbox/queries.js';

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  tab: z.enum(['inbox', 'waiting', 'closed']).default('inbox'),
  q: z.string().max(100).optional(),
  sectorId: z.uuid().optional(),
  ownerId: z.union([z.literal('none'), z.uuid()]).optional(),
  tagId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const timelineQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(async (r) => {
    r.get('/api/chats', async (req) => listChats(ctx, req.user, listQuery.parse(req.query)));

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, req.user, idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });
  });
}
