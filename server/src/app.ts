import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './auth/plugin.js';
import { authRoutes } from './auth/routes.js';
import { registerCustomFieldRoutes } from './catalog/custom-fields.js';
import { registerChannelRoutes } from './channels/routes.js';
import { chatRoutes } from './chats/routes.js';
import { registerQuickAnswerRoutes } from './catalog/quick-answers.js';
import { registerSectorRoutes } from './catalog/sectors.js';
import { registerSettingsRoutes } from './catalog/settings.js';
import { registerTagRoutes } from './catalog/tags.js';
import { registerUserRoutes } from './catalog/users.js';
import { registerContactRoutes } from './contacts/routes.js';
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
  // Root-level and early so every route module (auth's avatar upload, quick answers, chats) can read multipart bodies.
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
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

  registerSectorRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerCustomFieldRoutes(app, ctx);
  registerContactRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerQuickAnswerRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  await chatRoutes(app, ctx);
  registerChannelRoutes(app, ctx);

  // Spec §2: the compiled React front is served at /. Any other GET outside /api, /ws and /webhooks is a
  // client-side route, so it gets index.html. Keep this block last in buildApp.
  const dist = ctx.config.webDistDir;
  const spa = dist !== null && existsSync(join(dist, 'index.html'));
  if (spa) await app.register(fastifyStatic, { root: dist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const clientRoute =
      req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/ws') && !req.url.startsWith('/webhooks/');
    if (spa && clientRoute) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'Não encontrado' });
  });

  return app;
}
