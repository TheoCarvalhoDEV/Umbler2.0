import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { connectChannel, createChannel, getChannelQrById, importChannelHistory, listChannels } from './service.js';

const createBody = z.object({ name: z.string().trim().min(1).max(60) });
const idParams = z.object({ id: z.uuid() });
const period = z.enum(['3m', '12m', 'all']);
const connectBody = z.object({ historyPeriod: period.optional() });
const importBody = z.object({ period });

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
    return connectChannel(ctx, id, connectBody.parse(request.body ?? {}));
  });

  // §5.6: the QR shown to the admin comes from qrcode.updated (stored in memory by ingest); polled by the UI.
  app.get('/api/channels/:id/qr', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return getChannelQrById(ctx, id);
  });

  // History spec §5.1: copy what Evolution already stored for the channel, in the chosen period.
  app.post('/api/channels/:id/history-import', async (request) => {
    await requireAdmin(request);
    const { id } = idParams.parse(request.params);
    return importChannelHistory(ctx, id, importBody.parse(request.body).period);
  });
}
