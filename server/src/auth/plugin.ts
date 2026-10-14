import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppCtx } from '../ctx.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, forbidden } from '../lib/http-error.js';
import { getSessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    // Non-null for handlers: the onRequest hook below rejects anonymous /api/* (except login/health).
    user: AuthUser;
  }
}

export const SESSION_COOKIE = 'sid';

const unauthorized = () => new HttpError(401, 'Não autenticado');

const authPluginImpl: FastifyPluginAsync<{ ctx: AppCtx }> = async (app, { ctx }) => {
  app.decorateRequest('user', null as unknown as AuthUser);

  app.addHook('onRequest', async (req) => {
    // Fastify routes on the DECODED path (/%61pi/x reaches /api/x), so classify on the decoded one.
    let path: string;
    try {
      path = decodeURI(req.url.split('?')[0]);
    } catch {
      throw new HttpError(400, 'URL inválida');
    }
    const isApi = path.startsWith('/api/');
    const isWs = path === '/ws';
    if (!isApi && !isWs) return;

    // §6 CSRF: every non-GET /api/* request and the /ws upgrade need Origin === APP_ORIGIN.
    const safeMethod = req.method === 'GET' || req.method === 'HEAD';
    if ((isWs || !safeMethod) && req.headers.origin !== ctx.config.appOrigin) {
      throw forbidden('Origem não permitida');
    }

    // §6: every request validates the session against the database.
    const sid = req.cookies[SESSION_COOKIE];
    if (sid) {
      const user = await getSessionUser(ctx.db, sid, ctx.config.sessionDays);
      if (user) req.user = user;
    }

    // §6: every /api route that reads or changes data requires a session. /ws gets req.user populated
    // above (null when there is no valid session) and answers 401 itself (Task 8).
    if (isApi && !req.user && path !== '/api/auth/login' && path !== '/api/health') throw unauthorized();
  });
};

// Not encapsulated (same effect as fastify-plugin): the decorator and hook apply to every route.
export const authPlugin = Object.assign(authPluginImpl, { [Symbol.for('skip-override')]: true });

export function authUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function requireUser(req: FastifyRequest): Promise<void> {
  authUser(req);
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  if (authUser(req).role !== 'admin') throw forbidden();
}
