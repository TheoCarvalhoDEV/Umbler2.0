import { eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import { users } from '../db/schema.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, forbidden } from '../lib/http-error.js';
import { AVATAR_MAX_BYTES, AVATAR_TYPES, removeAvatarFile, writeAvatarFile } from '../media/avatar-files.js';
import { hashPassword, verifyPassword } from './password.js';
import { preferencesSchema } from './preferences.js';
import { SESSION_COOKIE, authUser, requireAdmin, requireUser } from './plugin.js';
import { createSession, deleteSession } from './sessions.js';

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1).max(200),
});

const ViewBody = z.object({ seeAllSectors: z.boolean() });

const USER_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const BAD_AVATAR = 'Envie uma imagem JPEG, PNG ou WebP de até 2 MB no campo "file"';

/** The `file` part of a multipart body, as { data, ext }; 400 for anything else (type, size, field, not multipart). */
export async function readAvatarUpload(req: FastifyRequest): Promise<{ data: Buffer; ext: string }> {
  try {
    const part = await req.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
    if (!part) throw badRequest(BAD_AVATAR);
    const data = await part.toBuffer(); // drains the part either way; throws (413) past the limit
    if (part.fieldname !== 'file' || !USER_AVATAR_TYPES.includes(part.mimetype)) throw badRequest(BAD_AVATAR);
    return { data, ext: AVATAR_TYPES[part.mimetype]! };
  } catch (err) {
    // @fastify/multipart: 413 file too large, 406 not multipart, ... Client errors only: a 5xx stays a 500.
    if (err instanceof HttpError) throw err;
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status < 500) throw badRequest(BAD_AVATAR);
    throw err;
  }
}

const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60_000;

export const authRoutes: FastifyPluginAsync<{ ctx: AppCtx }> = async (app, { ctx }) => {
  // Verified when the email does not exist, so a wrong email costs the same time as a wrong password.
  // Lives in the plugin closure (Global Constraint: no module-level singletons); computed once per app.
  let dummyHash: Promise<string> | undefined;
  // Wrong passwords per email, across IPs: 10 in a row lock that login for 15 min.
  // ponytail: in memory, one process; move to a table if the app ever runs replicas.
  const failures = new Map<string, { n: number; until: number }>();

  app.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          // Per IP on onRequest (the default hook): rotating emails cannot reach argon2 past this.
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.ip,
          errorResponseBuilder: () => new HttpError(429, 'Muitas tentativas. Aguarde um minuto e tente de novo.'),
        },
      },
    },
    async (req, reply) => {
      const { email, password } = LoginBody.parse(req.body);
      const f = failures.get(email);
      if (f && f.until > Date.now()) throw new HttpError(429, 'Muitas tentativas para este usuário. Aguarde 15 minutos.');
      const [user] = await ctx.db
        .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);
      const ok = await verifyPassword(user?.passwordHash ?? (await (dummyHash ??= hashPassword('dummy-password'))), password);
      if (!user || !ok) {
        if (failures.size > 10_000) failures.clear(); // ponytail: memory cap against email rotation
        const cur = failures.get(email) ?? { n: 0, until: 0 };
        cur.n += 1;
        if (cur.n >= LOCK_AFTER) Object.assign(cur, { n: 0, until: Date.now() + LOCK_MS });
        failures.set(email, cur);
        throw new HttpError(401, 'E-mail ou senha inválidos');
      }
      failures.delete(email);
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
    // Sockets keep the scope they had at connect time: drop them so every open tab reconnects and refetches.
    ctx.hub.disconnectUser(id);
    return loadAuthUser(ctx.db, id);
  });

  // Spec 2026-10-19 §6: any user, own preferences. jsonb || merges the named fields in one UPDATE, so two tabs
  // saving different fields at the same time both stick (no read-modify-write).
  app.put('/api/auth/me/preferences', { preHandler: requireUser }, async (req) => {
    const patch = preferencesSchema.parse(req.body);
    const id = authUser(req).id;
    await ctx.db
      .update(users)
      .set({ preferences: sql`${users.preferences} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(users.id, id));
    return loadAuthUser(ctx.db, id);
  });

  // Own profile picture. A new file name per upload, so the URL (and the browser cache) changes with it.
  // `path` is already on disk. The row is locked while it is swapped, so of two uploads at once the second
  // sees the first's file as the old one; the old file goes only after the commit, the new one if the update fails.
  const setAvatar = async (id: string, path: string | null) => {
    let old: string | null | undefined;
    try {
      old = await ctx.db.transaction(async (tx) => {
        const [row] = await tx.select({ path: users.avatarPath }).from(users).where(eq(users.id, id)).for('update');
        await tx.update(users).set({ avatarPath: path }).where(eq(users.id, id));
        return row?.path;
      });
    } catch (err) {
      // Cleanup must not replace the original error.
      if (path) await removeAvatarFile(ctx.config.mediaDir, path).catch(() => {});
      throw err;
    }
    // Colleagues' screens show this picture in the agent list and on the chats.
    ctx.hub.publishUsersChanged();
    // Best-effort: the swap is committed, a leftover old file must not fail the request.
    if (old && old !== path) await removeAvatarFile(ctx.config.mediaDir, old).catch((e) => app.log.warn({ err: (e as Error).name }, 'old avatar not removed'));
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
