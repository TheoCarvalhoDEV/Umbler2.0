import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { connectChannel, createChannel, getChannelQrById, listChannels } from './service.js';

const createBody = z.object({ name: z.string().trim().min(1).max(60) });
const idParams = z.object({ id: z.uuid() });

export function registerChannelRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/channels', async (request) => {
    await requireUser(request);
    return listChannels(ctx.db);
  });

  app.post('/api/channels', async (request) => {
    await requireAdmin(request);
    const { name } = createBody.parse(request.body);
    return createChannel(ctx, name);
  });

  app.post('/api/channels/:id/connect', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return connectChannel(ctx, id);
  });

  // §5.6: the QR shown to the admin comes from qrcode.updated (stored in memory by ingest); polled by the UI.
  app.get('/api/channels/:id/qr', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return getChannelQrById(ctx, id);
  });
}
