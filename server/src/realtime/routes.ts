import type { FastifyPluginAsync } from 'fastify';
import type { AppCtx } from '../ctx.js';

const PING_INTERVAL_MS = 30_000;

// @fastify/websocket is registered by buildApp BEFORE authPlugin (see app.ts), not here.
export function realtimeRoutes(ctx: AppCtx): FastifyPluginAsync {
  return async (app) => {
    app.get('/ws', {
      websocket: true,
      // Runs before the upgrade: replying here answers with plain HTTP and no socket is opened (§6).
      preValidation: async (request, reply) => {
        // Defense in depth for the GET upgrade (Task 6's onRequest hook checks Origin on /ws too).
        if (request.headers.origin !== ctx.config.appOrigin) {
          return reply.code(403).send({ error: 'Origem não permitida' });
        }
        // Task 6's authPlugin already loaded the session (sliding expiry, inactive users rejected) into
        // request.user; on /ws it stays null when there is no valid session, despite the non-null type.
        if (!request.user) return reply.code(401).send({ error: 'Não autenticado' });
      },
    }, (socket, request) => {
      const user = request.user;
      if (!user) {
        socket.close();
        return;
      }
      const unregister = ctx.hub.register(user, socket);

      // Keepalive: a socket that missed the previous pong is dead (sleeping laptop, dropped Wi-Fi).
      let alive = true;
      socket.on('pong', () => { alive = true; });
      const timer = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, PING_INTERVAL_MS);

      socket.on('close', () => {
        clearInterval(timer);
        unregister();
      });
      // Clients never send anything we act on; incoming frames are ignored.
    });
  };
}
