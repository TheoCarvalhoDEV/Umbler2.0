import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { users } from '../db/schema.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError, forbidden } from '../lib/http-error.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, authUser, requireUser } from './plugin.js';
import { createSession, deleteSession } from './sessions.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

function loginEmail(body: unknown): string {
  const email = (body as { email?: unknown } | null)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export const authRoutes: FastifyPluginAsync<{ ctx: AppCtx }> = async (app, { ctx }) => {
  // Verified when the email does not exist, so a wrong email costs the same time as a wrong password.
  // Lives in the plugin closure (Global Constraint: no module-level singletons); computed once per app.
  let dummyHash: Promise<string> | undefined;

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          hook: 'preHandler', // body must be parsed so the key can include the email
          keyGenerator: (req) => `${req.ip}|${loginEmail(req.body)}`,
          errorResponseBuilder: () => new HttpError(429, 'Muitas tentativas. Aguarde um minuto e tente de novo.'),
        },
      },
    },
    async (req, reply) => {
      const { email, password } = LoginBody.parse(req.body);
      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      const ok = await verifyPassword(user?.passwordHash ?? (await (dummyHash ??= hashPassword('dummy-password'))), password);
      if (!user || !ok) throw new HttpError(401, 'E-mail ou senha inválidos');
      if (!user.active) throw forbidden('Usuário desativado');

      const token = await createSession(ctx.db, user.id, ctx.config.sessionDays);
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.config.cookieSecure,
        path: '/',
        // ponytail: browser max (400 days); the real 30-day-idle expiry is enforced server-side in getSessionUser.
        maxAge: 400 * 86_400,
      });
      return loadAuthUser(ctx.db, user.id);
    },
  );

  app.post('/api/auth/logout', { preHandler: requireUser }, async (req, reply) => {
    await deleteSession(ctx.db, req.cookies[SESSION_COOKIE] ?? '');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => authUser(req));
};
