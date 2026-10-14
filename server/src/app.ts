import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { z } from 'zod';
import type { AppCtx } from './ctx.js';
import { HttpError } from './lib/http-error.js';
import { mediaRoutes } from './media/routes.js';
import { realtimeRoutes } from './realtime/routes.js';
import { registerWebhookRoutes } from './webhooks/routes.js';

export type BuildAppOptions = Pick<FastifyServerOptions, 'logger' | 'trustProxy'>;

export async function buildApp(ctx: AppCtx, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? false });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'Requisição inválida' });
    // Fastify's own client errors (malformed JSON, body too large, rate limit, ...)
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Requisição inválida' });
    }
    // Never log err.message or the whole err (Global Constraint: no message bodies): driver errors embed
    // bound parameters. The stack's first line repeats the message, so only the frames are kept.
    const e = (err ?? {}) as { name?: unknown; code?: unknown; cause?: { code?: unknown }; stack?: unknown };
    req.log.error(
      {
        name: e.name,
        code: e.code ?? e.cause?.code,
        stack: typeof e.stack === 'string' ? e.stack.split('\n').slice(1).join('\n') : undefined,
        correlationId: req.id,
      },
      'unhandled error',
    );
    return reply.status(500).send({ error: 'Ocorreu um erro', correlationId: req.id });
  });

  await app.register(cookie);
  app.register(rateLimit, { global: false });
  // Before authPlugin on purpose: websocket's onRequest hook must run before authPlugin's, otherwise a
  // 403 thrown there for a /ws upgrade skips it and the upgrade socket is never destroyed (leaks).
  await app.register(websocket);
  app.register(authPlugin, { ctx });
  app.register(authRoutes, { ctx });
  app.register(realtimeRoutes(ctx));

  registerWebhookRoutes(app, ctx);
  await mediaRoutes(app, ctx);

  app.get('/api/health', async () => ({ ok: true }));
  // Later tasks register their routes here, passing `ctx`.

  return app;
}
