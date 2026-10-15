import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authUser } from '../auth/plugin.js';
import type { AppCtx } from '../ctx.js';
import { messages } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import { notFound } from '../lib/http-error.js';
import { mediaResponseHeaders } from '../messages/media.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function mediaRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get<{ Params: { messageId: string } }>('/api/media/:messageId', async (req, reply) => {
    const user = authUser(req); // 401 without a session (the auth plugin's hook already rejects anonymous /api/*)
    if (!UUID.test(req.params.messageId)) throw notFound(); // a bad uuid would be a 500 from Postgres

    const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, req.params.messageId));
    if (!msg?.mediaPath) throw notFound();
    await getChatForUser(ctx, user, msg.chatId); // 404 when !canSee

    const root = resolve(ctx.config.mediaDir);
    const file = resolve(root, msg.mediaPath);
    if (!file.startsWith(root + sep)) throw notFound();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw notFound();

    return reply
      .headers({
        ...mediaResponseHeaders(msg.mediaMime ?? 'application/octet-stream', msg.mediaName ?? basename(file)),
        'Content-Length': String(info.size),
      })
      .send(createReadStream(file));
  });
}
