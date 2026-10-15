import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserDto } from '@talk/shared';
import { hashPassword } from '../auth/password.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { sectors, userSectors, users } from '../db/schema.js';
import { sendAvatarFile, userAvatarUrl } from '../media/avatar-files.js';
import type { AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';

const IdParams = z.object({ id: z.uuid() });
const fields = {
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'agent']),
  signature: z.string().trim().max(120).nullable().optional(),
  sectorIds: z.array(z.uuid()).max(50),
};
const Create = z.object({ ...fields, role: fields.role.default('agent'), sectorIds: fields.sectorIds.default([]) });
const Patch = z
  .object({ ...fields, active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { error: 'Nada para alterar' });
type UserPatch = z.infer<typeof Patch>;

async function listUserDtos(db: Db, where?: SQL): Promise<UserDto[]> {
  const rows = await db.select().from(users).where(where).orderBy(asc(users.name));
  const links = rows.length
    ? await db.select().from(userSectors).where(inArray(userSectors.userId, rows.map((u) => u.id)))
    : [];
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    signature: u.signature,
    active: u.active,
    sectorIds: links.filter((l) => l.userId === u.id).map((l) => l.sectorId),
    avatarUrl: userAvatarUrl(u),
  }));
}

async function getUserDto(db: Db, id: string): Promise<UserDto> {
  const [u] = await listUserDtos(db, eq(users.id, id));
  if (!u) throw notFound('Usuário não encontrado');
  return u;
}

async function setSectors(tx: Tx, userId: string, sectorIds: string[]): Promise<void> {
  const ids = [...new Set(sectorIds)];
  if (ids.length && (await tx.$count(sectors, inArray(sectors.id, ids))) !== ids.length) throw badRequest('Setor inexistente');
  await tx.delete(userSectors).where(eq(userSectors.userId, userId));
  if (ids.length) await tx.insert(userSectors).values(ids.map((sectorId) => ({ userId, sectorId })));
}

// Spec §6: deactivating a user or resetting the password deletes all their sessions and
// disconnects their sockets.
async function updateUser(ctx: AppCtx, actor: AuthUser, id: string, p: UserPatch): Promise<UserDto> {
  if (id === actor.id && (p.active === false || p.role === 'agent')) {
    throw badRequest('Você não pode desativar nem rebaixar o próprio usuário');
  }
  const passwordHash = p.password ? await hashPassword(p.password) : undefined;
  const killSessions = p.active === false || passwordHash !== undefined;
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select({ role: users.role }).from(users).where(eq(users.id, id));
    if (!current) throw notFound('Usuário não encontrado');
    const set = {
      name: p.name,
      email: p.email,
      role: p.role,
      // A real role change resets the admin-only view preference (stale 'ver todos' must not survive a demote/promote).
      seeAllSectors: p.role !== undefined && p.role !== current.role ? false : undefined,
      active: p.active,
      passwordHash,
      signature: p.signature === undefined ? undefined : p.signature || null,
    };
    if (p.email && (await tx.$count(users, and(eq(users.email, p.email), ne(users.id, id))))) {
      throw conflict('E-mail já cadastrado');
    }
    if (Object.values(set).some((v) => v !== undefined)) await tx.update(users).set(set).where(eq(users.id, id));
    if (p.sectorIds) await setSectors(tx, id, p.sectorIds);
    if (killSessions) await deleteUserSessions(tx, id);
  });
  // A live socket keeps the role/sectors it had at connect time: drop it so the client reconnects fresh.
  if (killSessions || p.role !== undefined || p.sectorIds !== undefined) ctx.hub.disconnectUser(id);
  return getUserDto(ctx.db, id);
}

export function registerUserRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/users', async () => listUserDtos(ctx.db));

  // Any logged-in user (agents' pictures show in every inbox); the auth plugin rejects anonymous /api/*.
  app.get('/api/users/:id/avatar', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [row] = await ctx.db.select({ path: users.avatarPath }).from(users).where(eq(users.id, id));
    return sendAvatarFile(reply, ctx.config.mediaDir, row?.path);
  });

  app.post('/api/users', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Create.parse(req.body);
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(b.password);
    await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          id,
          name: b.name,
          email: b.email,
          passwordHash,
          role: b.role,
          signature: b.signature || null,
          active: true,
          createdAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (!row) throw conflict('E-mail já cadastrado');
      await setSectors(tx, id, b.sectorIds);
    });
    return getUserDto(ctx.db, id);
  });

  app.patch('/api/users/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    return updateUser(ctx, req.user, id, Patch.parse(req.body));
  });

  // Soft delete: users stay referenced by messages, notes and events.
  app.delete('/api/users/:id', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { id } = IdParams.parse(req.params);
    return updateUser(ctx, req.user, id, { active: false });
  });
}
