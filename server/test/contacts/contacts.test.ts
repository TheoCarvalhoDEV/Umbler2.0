import { afterEach, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { chats, contacts } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { enableSeeAll, loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let admin: Record<string, string>;
let agentA: Record<string, string>;
let agentB: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  admin = (await loginAs(app, seed.admin.email)).headers;
  agentA = (await loginAs(app, seed.agentA.email)).headers;
  agentB = (await loginAs(app, seed.agentB.email)).headers;
});

afterEach(async () => {
  await app.close();
});

function call(method: Method, url: string, headers: Record<string, string>, payload?: object) {
  return app.inject({ method, url, headers, payload });
}

async function createContact(payload: object) {
  const res = await call('POST', '/api/contacts', agentA, payload);
  expect(res.statusCode).toBe(200);
  return res.json();
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

it('creates a contact with a normalized phone and rejects duplicates and invalid phones', async () => {
  const c = await createContact({ name: 'Maria Souza', phone: '556599991111' }); // 12 digits, gains the 9
  expect(c).toMatchObject({ name: 'Maria Souza', phone: '5565999991111', blocked: false, tagIds: [], fields: {} });

  expect((await call('POST', '/api/contacts', agentA, { phone: '+55 (65) 99999-1111' })).statusCode).toBe(409);
  expect((await call('POST', '/api/contacts', agentA, { phone: 'abc' })).statusCode).toBe(400);

  const got = await call('GET', `/api/contacts/${c.id}`, agentB);
  expect(got.json()).toEqual(c);
  expect((await call('GET', `/api/contacts/${crypto.randomUUID()}`, agentA)).statusCode).toBe(404);

  const other = await createContact({ name: 'Outro', phone: '5565999992222' });
  expect((await call('PATCH', `/api/contacts/${other.id}`, agentA, { phone: '65 99999-1111' })).statusCode).toBe(409);
  const patched = await call('PATCH', `/api/contacts/${c.id}`, agentA, {
    email: 'maria@example.com',
    landline: '6532221111',
    address: { cidade: 'Cuiabá', uf: 'MT' },
  });
  expect(patched.json()).toMatchObject({
    phone: '5565999991111',
    email: 'maria@example.com',
    landline: '6532221111',
    address: { cidade: 'Cuiabá', uf: 'MT' },
  });
});

it('searches by name or phone, filters by tag and paginates by most recently updated', async () => {
  const a = await createContact({ name: 'Ana Lima', phone: '5565999990001' });
  const b = await createContact({ name: 'Bruno Lima', phone: '5565999990002' });
  const c = await createContact({ name: 'Carla Dias', phone: '556532221111' });
  const tag = (await call('POST', '/api/tags', admin, { name: 'Cliente', color: '#22c55e' })).json();
  for (const x of [a, b, c]) {
    expect((await call('PUT', `/api/contacts/${x.id}/tags`, agentA, { tagIds: [tag.id] })).statusCode).toBe(200);
  }
  // Deterministic order: a (newest), c, b (oldest).
  const at = (id: string, iso: string) => ctx.db.update(contacts).set({ updatedAt: new Date(iso) }).where(eq(contacts.id, id));
  await at(b.id, '2026-01-01T00:00:01.000Z');
  await at(c.id, '2026-01-01T00:00:02.000Z');
  await at(a.id, '2026-01-01T00:00:03.000Z');

  expect(ids((await call('GET', '/api/contacts?q=lima', agentA)).json().items)).toEqual([a.id, b.id]);
  const byPhone = await call('GET', `/api/contacts?q=${encodeURIComponent('(65) 99999-0002')}`, agentA);
  expect(ids(byPhone.json().items)).toEqual([b.id]);
  expect(ids((await call('GET', '/api/contacts?q=3222', agentA)).json().items)).toEqual([c.id]);

  const page1 = (await call('GET', `/api/contacts?tagId=${tag.id}&limit=2`, agentA)).json();
  expect(ids(page1.items)).toEqual([a.id, c.id]);
  expect(page1.nextCursor).toEqual(expect.any(String));
  const page2 = (await call('GET', `/api/contacts?tagId=${tag.id}&limit=2&cursor=${page1.nextCursor}`, agentA)).json();
  expect(ids(page2.items)).toEqual([b.id]);
  expect(page2.nextCursor).toBeNull();

  expect((await call('GET', '/api/contacts?cursor=lixo', agentA)).statusCode).toBe(400);
  // Date.parse accepts "1", Postgres does not: must be 400, not 500.
  const loose = Buffer.from('1|00000000-0000-4000-8000-000000000001').toString('base64url');
  expect((await call('GET', `/api/contacts?cursor=${loose}`, agentA)).statusCode).toBe(400);
});

it('sets tags, custom fields and the blocked flag', async () => {
  const c = await createContact({ name: 'João', phone: '5565999993333' });
  const field = (await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' })).json();
  const tag = (await call('POST', '/api/tags', admin, { name: 'VIP', color: '#ff0000' })).json();

  expect((await call('PUT', `/api/contacts/${c.id}/tags`, agentA, { tagIds: [tag.id] })).json().tagIds).toEqual([tag.id]);
  expect((await call('PUT', `/api/contacts/${c.id}/tags`, agentA, { tagIds: [crypto.randomUUID()] })).statusCode).toBe(400);

  const withField = await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [field.id]: '123.456.789-00' });
  expect(withField.json().fields).toEqual({ [field.id]: '123.456.789-00' });
  const cleared = await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [field.id]: '' });
  expect(cleared.json().fields).toEqual({});
  expect((await call('PUT', `/api/contacts/${c.id}/fields`, agentA, { [crypto.randomUUID()]: 'x' })).statusCode).toBe(400);

  expect((await call('POST', `/api/contacts/${c.id}/block`, agentA, { blocked: true })).json().blocked).toBe(true);
  expect((await call('POST', `/api/contacts/${c.id}/block`, agentA, { blocked: false })).json().blocked).toBe(false);
});

it('creates, pins, edits and deletes notes', async () => {
  const c = await createContact({ name: 'Rita', phone: '5565999994444' });
  const n1 = (await call('POST', `/api/contacts/${c.id}/notes`, agentA, { body: 'Primeira' })).json();
  expect(n1).toMatchObject({ body: 'Primeira', pinned: false, authorName: seed.agentA.name });
  const n2 = (await call('POST', `/api/contacts/${c.id}/notes`, agentB, { body: 'Segunda' })).json();

  expect((await call('PATCH', `/api/contacts/${c.id}/notes/${n1.id}`, agentA, { pinned: true })).json().pinned).toBe(true);
  expect(ids((await call('GET', `/api/contacts/${c.id}/notes`, agentA)).json())).toEqual([n1.id, n2.id]);

  const edited = await call('PATCH', `/api/contacts/${c.id}/notes/${n2.id}`, agentA, { body: 'Editada' });
  expect(edited.json()).toMatchObject({ id: n2.id, body: 'Editada', authorName: seed.agentB.name });
  expect((await call('PATCH', `/api/contacts/${c.id}/notes/${n2.id}`, agentA, {})).statusCode).toBe(400);

  expect((await call('DELETE', `/api/contacts/${c.id}/notes/${n1.id}`, agentA)).statusCode).toBe(204);
  expect(ids((await call('GET', `/api/contacts/${c.id}/notes`, agentA)).json())).toEqual([n2.id]);
  expect((await call('DELETE', `/api/contacts/${c.id}/notes/${n1.id}`, agentA)).statusCode).toBe(404);
});

it('contact history lists only the chats the user can see', async () => {
  const c = await createContact({ name: 'Paulo', phone: '5565999995555' });
  const init = (sectorId: string) => ({ sectorId, ownerId: null, waiting: false, triagePending: false, createdBy: null });
  const { chat: inB } = await findOrOpenChat(ctx.db, { contactId: c.id, channelId: seed.channelId, init: init(seed.sectorB) });
  await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, inB.id));
  const { chat: inA } = await findOrOpenChat(ctx.db, { contactId: c.id, channelId: seed.channelId, init: init(seed.sectorA) });

  const history = async (headers: Record<string, string>) => {
    const res = await call('GET', `/api/contacts/${c.id}/chats`, headers);
    expect(res.statusCode).toBe(200);
    return ids(res.json()).sort();
  };
  expect(await history(agentA)).toEqual([inA.id]);
  expect(await history(agentB)).toEqual([inB.id]);
  expect(await history(admin)).toEqual([]); // admin without "ver todos" and without sectors
  await enableSeeAll(ctx, seed.admin);
  expect(await history(admin)).toEqual([inA.id, inB.id].sort());
  expect((await call('GET', `/api/contacts/${crypto.randomUUID()}/chats`, agentA)).statusCode).toBe(404);
});
