import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAvatarUpload } from '../../src/auth/routes.js';
import { messages, users } from '../../src/db/schema.js';
import { HttpError } from '../../src/lib/http-error.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { TEST_ORIGIN, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const URL_RE = (id: string) => new RegExp(`^/api/users/${id}/avatar\\?v=[0-9a-f]{8}$`);

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let auth: { cookie: string; headers: Record<string, string> };

function multipart(file: { field?: string; mime: string; data: Buffer }) {
  const boundary = '----talkavatarboundary';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'file'}"; filename="foto"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (file: Parameters<typeof multipart>[0], headers = auth.headers) => {
  const { payload, contentType } = multipart(file);
  return app.inject({ method: 'POST', url: '/api/auth/me/avatar', headers: { ...headers, 'content-type': contentType }, payload });
};
const userRow = async (id: string) => (await ctx.db.select().from(users).where(eq(users.id, id)))[0]!;
const userFiles = async (id: string) =>
  (await readdir(join(ctx.config.mediaDir, 'avatars/users')).catch(() => [] as string[])).filter((f) => f.startsWith(id));

beforeEach(async () => {
  ctx = await makeTestCtx();
  ({ app } = await makeTestApp(ctx));
  seed = await seedBasics(ctx);
  auth = await loginAs(app, seed.agentA.email);
});

afterEach(async () => {
  await app.close();
});

describe('POST /api/auth/me/avatar', () => {
  it('saves a jpeg/png/webp under avatars/users and returns Me with avatarUrl', async () => {
    const res = await upload({ mime: 'image/png', data: PNG });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: seed.agentA.id, avatarUrl: expect.stringMatching(URL_RE(seed.agentA.id)) });

    const row = await userRow(seed.agentA.id);
    expect(row.avatarPath).toMatch(new RegExp(`^avatars/users/${seed.agentA.id}[^/]*\\.png$`));
    expect(await readFile(join(ctx.config.mediaDir, row.avatarPath!))).toEqual(PNG);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth.headers });
    expect(me.json().avatarUrl).toBe(res.json().avatarUrl);
  });

  it('a new upload changes the URL and removes the previous file', async () => {
    const first = (await upload({ mime: 'image/png', data: PNG })).json().avatarUrl;
    const firstPath = (await userRow(seed.agentA.id)).avatarPath!;
    const second = await upload({ mime: 'image/jpeg', data: PNG });
    expect(second.statusCode).toBe(200);
    expect(second.json().avatarUrl).not.toBe(first);
    const row = await userRow(seed.agentA.id);
    expect(row.avatarPath).toMatch(/\.jpg$/);
    expect(existsSync(join(ctx.config.mediaDir, firstPath))).toBe(false);

    const third = await upload({ mime: 'image/jpeg', data: PNG }); // same type again: still a new URL
    expect(third.json().avatarUrl).not.toBe(second.json().avatarUrl);
  });

  it('two uploads in a row (or at once) leave exactly one file for the user', async () => {
    await upload({ mime: 'image/png', data: PNG });
    await upload({ mime: 'image/jpeg', data: PNG });
    expect(await userFiles(seed.agentA.id)).toHaveLength(1);

    await Promise.all([upload({ mime: 'image/png', data: PNG }), upload({ mime: 'image/webp', data: PNG })]);
    const files = await userFiles(seed.agentA.id);
    expect(files).toHaveLength(1);
    expect(`avatars/users/${files[0]}`).toBe((await userRow(seed.agentA.id)).avatarPath);
  });

  it('a failed update removes the new file and keeps the old picture', async () => {
    await upload({ mime: 'image/png', data: PNG });
    const before = (await userRow(seed.agentA.id)).avatarPath;
    await ctx.db.execute(sql`CREATE FUNCTION fail_avatar() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await ctx.db.execute(sql`CREATE TRIGGER fail_avatar BEFORE UPDATE OF avatar_path ON users FOR EACH ROW EXECUTE FUNCTION fail_avatar()`);

    expect((await upload({ mime: 'image/jpeg', data: PNG })).statusCode).toBe(500);
    expect((await userRow(seed.agentA.id)).avatarPath).toBe(before);
    expect((await userFiles(seed.agentA.id)).map((f) => `avatars/users/${f}`)).toEqual([before]);
  });

  it('tells every connected screen that the users changed, on upload and on removal', async () => {
    ctx.hub.events.length = 0;
    await upload({ mime: 'image/png', data: PNG });
    await app.inject({ method: 'DELETE', url: '/api/auth/me/avatar', headers: auth.headers });
    expect(ctx.hub.events.filter((e) => e.type === 'users.changed')).toHaveLength(2);
  });

  it('rejects other types, files over 2 MB, a missing file and a non-multipart body with 400', async () => {
    expect((await upload({ mime: 'image/gif', data: PNG })).statusCode).toBe(400);
    expect((await upload({ mime: 'image/svg+xml', data: Buffer.from('<svg/>') })).statusCode).toBe(400);
    expect((await upload({ mime: 'image/png', data: Buffer.alloc(2 * 1024 * 1024 + 1) })).statusCode).toBe(400);
    expect((await upload({ field: 'outro', mime: 'image/png', data: PNG })).statusCode).toBe(400);
    const json = await app.inject({ method: 'POST', url: '/api/auth/me/avatar', headers: auth.headers, payload: { file: 'x' } });
    expect(json.statusCode).toBe(400);
    expect((await userRow(seed.agentA.id)).avatarPath).toBeNull();
  });

  it('needs a session and the Origin header', async () => {
    expect((await upload({ mime: 'image/png', data: PNG }, { origin: TEST_ORIGIN })).statusCode).toBe(401);
    expect((await upload({ mime: 'image/png', data: PNG }, { cookie: auth.cookie })).statusCode).toBe(403);
  });
});

describe('readAvatarUpload', () => {
  const failingReq = (statusCode: number) =>
    ({ file: async () => { throw Object.assign(new Error('multipart'), { statusCode }); } }) as unknown as FastifyRequest;

  it('maps 4xx errors from the multipart parser to 400 and lets 5xx through untouched', async () => {
    await expect(readAvatarUpload(failingReq(413))).rejects.toMatchObject({ status: 400 });
    const err = await readAvatarUpload(failingReq(503)).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 503 });
  });
});

describe('DELETE /api/auth/me/avatar', () => {
  it('removes the picture and returns Me without avatarUrl', async () => {
    await upload({ mime: 'image/webp', data: PNG });
    const path = (await userRow(seed.agentA.id)).avatarPath!;
    const res = await app.inject({ method: 'DELETE', url: '/api/auth/me/avatar', headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: seed.agentA.id, avatarUrl: null });
    expect((await userRow(seed.agentA.id)).avatarPath).toBeNull();
    expect(existsSync(join(ctx.config.mediaDir, path))).toBe(false);
  });
});

describe('GET /api/users/:id/avatar and the DTOs', () => {
  it('serves the picture to any logged-in user with the same headers as the contact avatar', async () => {
    await upload({ mime: 'image/png', data: PNG });
    const other = await loginAs(app, seed.agentB.email);
    const res = await app.inject({ method: 'GET', url: `/api/users/${seed.agentA.id}/avatar`, headers: other.headers });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe('sandbox');
  });

  it('is 404 without a picture or for an unknown user, 401 without a session', async () => {
    const get = (id: string, headers?: Record<string, string>) => app.inject({ method: 'GET', url: `/api/users/${id}/avatar`, headers });
    expect((await get(seed.agentB.id, auth.headers)).statusCode).toBe(404);
    expect((await get(randomUUID(), auth.headers)).statusCode).toBe(404);
    await ctx.db.update(users).set({ avatarPath: '../../etc/passwd.png' }).where(eq(users.id, seed.agentB.id));
    expect((await get(seed.agentB.id, auth.headers)).statusCode).toBe(404);
    expect((await get(seed.agentA.id)).statusCode).toBe(401);
  });

  it('UserDto and MessageDto carry the URL', async () => {
    const url = (await upload({ mime: 'image/png', data: PNG })).json().avatarUrl;
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: auth.headers });
    const byId = new Map(list.json().map((u: { id: string; avatarUrl: string | null }) => [u.id, u.avatarUrl]));
    expect(byId.get(seed.agentA.id)).toBe(url);
    expect(byId.get(seed.agentB.id)).toBeNull();

    const { chat } = await findOrOpenChat(ctx.db, {
      contactId: (await app.inject({ method: 'POST', url: '/api/contacts', headers: auth.headers, payload: { phone: '5565999990001' } })).json().id,
      channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: seed.agentA.id, waiting: false, triagePending: false, createdBy: null },
    });
    await ctx.db.insert(messages).values([
      { chatId: chat.id, channelId: seed.channelId, direction: 'out', kind: 'note', body: 'nota', authorId: seed.agentA.id, status: 'sent', sentAt: new Date() },
      { chatId: chat.id, channelId: seed.channelId, direction: 'in', kind: 'text', body: 'oi', status: 'sent', sentAt: new Date() },
    ]);
    const timeline = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/timeline`, headers: auth.headers });
    const msgs = timeline.json().filter((i: { type: string }) => i.type === 'message');
    expect(msgs.map((m: { authorAvatarUrl: string | null }) => m.authorAvatarUrl).sort()).toEqual([url, null].sort());
  });
});
