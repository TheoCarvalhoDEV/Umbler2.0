import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { users } from '../db/schema.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, forbidden } from '../lib/http-error.js';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatarFile, writeAvatarFile } from '../media/avatar-files.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_COOKIE, authUser, requireAdmin, requireUser } from './plugin.js';
import { createSession, deleteSession } from './sessions.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

const ViewBody = z.object({ seeAllSectors: z.boolean() });

const USER_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BAD_AVATAR = 'Envie uma imagem JPEG, PNG ou WebP de até 2 MB no campo "file"';

/** The `file` part of a multipart body, as { data, ext }; 400 for anything else (type, size, field, not multipart). */
async function readAvatarUpload(req: FastifyRequest): Promise<{ data: Buffer; ext: string }> {
  try {
    const part = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
    if (!part || part.fieldname !== 'file') throw badRequest(BAD_AVATAR);
    const data = await part.toBuffer(); // throws (413) past the limit
    if (!USER_AVATAR_TYPES.includes(part.mimetype)) throw badRequest(BAD_AVATAR);
    return { data, ext: AVATAR_TYPES[part.mimetype]! };
  } catch (err) {
    // @fastify/multipart: 413 file too large, 406 not multipart, ...
    if (err instanceof HttpError) throw err;
    if (typeof (err as { statusCode?: unknown }).statusCode === 'number') throw badRequest(BAD_AVATAR);
    throw err;
  }
}

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

  // "Ver todos os setores": admin-only view preference; every read reloads AuthUser, so nothing else to refresh.
  app.put('/api/auth/me/view', { preHandler: requireAdmin }, async (req) => {
    const { seeAllSectors } = ViewBody.parse(req.body);
    const id = authUser(req).id;
    await ctx.db.update(users).set({ seeAllSectors }).where(eq(users.id, id));
    return loadAuthUser(ctx.db, id);
  });

  // Own profile picture. A new file name per upload, so the URL (and the browser cache) changes with it.
  const setAvatar = async (id: string, path: string | null) => {
    const [old] = await ctx.db.select({ path: users.avatarPath }).from(users).where(eq(users.id, id));
    await ctx.db.update(users).set({ avatarPath: path }).where(eq(users.id, id));
    if (old?.path && old.path !== path) await removeAvatarFile(ctx.config.mediaDir, old.path);
    return loadAuthUser(ctx.db, id);
  };

  app.post('/api/auth/me/avatar', { preHandler: requireUser }, async (req) => {
    const id = authUser(req).id;
    const { data, ext } = await readAvatarUpload(req);
    const path = `avatars/users/${id}-${Date.now().toString(36)}${ext}`;
    await writeAvatarFile(ctx.config.mediaDir, path, data);
    return setAvatar(id, path);
  });

  app.delete('/api/auth/me/avatar', { preHandler: requireUser }, async (req) => setAvatar(authUser(req).id, null));
};
