import { afterEach, beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

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

const names = (items: Array<{ name: string }>) => items.map((q) => q.name).sort();

it('scopes visibility and editing: "all" is admin-made, "owner" is personal', async () => {
  expect((await call('POST', '/api/quick-answers', agentA, { name: 'Geral', body: 'Olá', visibility: 'all' })).statusCode).toBe(403);

  const mine = (await call('POST', '/api/quick-answers', agentA, { name: 'Minha', body: 'Oi' })).json();
  expect(mine).toMatchObject({ name: 'Minha', body: 'Oi', visibility: 'owner', ownerId: seed.agentA.id, hasAttachment: false });
  const shared = (await call('POST', '/api/quick-answers', admin, { name: 'Geral', body: 'Bom dia', visibility: 'all' })).json();

  expect(names((await call('GET', '/api/quick-answers', agentA)).json())).toEqual(['Geral', 'Minha']);
  expect(names((await call('GET', '/api/quick-answers', agentB)).json())).toEqual(['Geral']);

  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentB, { body: 'x' })).statusCode).toBe(404);
  expect((await call('DELETE', `/api/quick-answers/${mine.id}`, agentB)).statusCode).toBe(404);
  expect((await call('PATCH', `/api/quick-answers/${shared.id}`, agentA, { body: 'x' })).statusCode).toBe(403);
  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentA, { visibility: 'all' })).statusCode).toBe(403);

  expect((await call('PATCH', `/api/quick-answers/${mine.id}`, agentA, { body: 'Oi!' })).json().body).toBe('Oi!');
  expect((await call('PATCH', `/api/quick-answers/${shared.id}`, admin, { name: 'Geral 2' })).json().name).toBe('Geral 2');
  expect((await call('DELETE', `/api/quick-answers/${mine.id}`, agentA)).statusCode).toBe(204);
  expect(names((await call('GET', '/api/quick-answers', agentA)).json())).toEqual(['Geral 2']);
});

it('renders variables from the chat contact, its fields and the current user', async () => {
  const field = (await call('POST', '/api/custom-fields', admin, { name: 'CPF', kind: 'cpf' })).json();
  const contact = (await call('POST', '/api/contacts', agentA, { name: 'Maria Souza', phone: '5565999994444' })).json();
  await call('PUT', `/api/contacts/${contact.id}/fields`, agentA, { [field.id]: '123.456.789-00' });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId: contact.id,
    channelId: seed.channelId,
    init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
  });

  const qa = (
    await call('POST', '/api/quick-answers', admin, {
      name: 'Boas-vindas',
      body: 'Olá {{contato.primeiro_nome}}, sou {{atendente.primeiro_nome}}. CPF: {{campo.cpf}}. E-mail: [{{contato.email}}]',
      visibility: 'all',
    })
  ).json();

  const res = await call('POST', `/api/quick-answers/${qa.id}/render`, agentA, { chatId: chat.id });
  expect(res.statusCode).toBe(200);
  const first = seed.agentA.name.trim().split(/\s+/)[0];
  expect(res.json()).toEqual({ text: `Olá Maria, sou ${first}. CPF: 123.456.789-00. E-mail: []` });

  // agentB cannot see a sector A chat: same 404 as every other chat route.
  expect((await call('POST', `/api/quick-answers/${qa.id}/render`, agentB, { chatId: chat.id })).statusCode).toBe(404);
  expect((await call('POST', `/api/quick-answers/${qa.id}/render`, agentA, { chatId: crypto.randomUUID() })).statusCode).toBe(404);
});

it('stores an optional multipart attachment and serves it only to who can see the answer', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const boundary = '----talk-test-boundary';
  const field = (name: string, value: string) =>
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const payload = Buffer.concat([
    field('name', 'Com anexo'),
    field('body', 'Segue o arquivo'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const created = await app.inject({
    method: 'POST',
    url: '/api/quick-answers',
    headers: { ...agentA, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(created.statusCode).toBe(200);
  const qa = created.json();
  expect(qa).toMatchObject({ name: 'Com anexo', body: 'Segue o arquivo', visibility: 'owner', hasAttachment: true });

  const file = await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentA);
  expect(file.statusCode).toBe(200);
  expect(file.headers['content-type']).toBe('image/png');
  expect(file.headers['x-content-type-options']).toBe('nosniff');
  expect(file.rawPayload.equals(png)).toBe(true);

  expect((await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentB)).statusCode).toBe(404);

  const removed = await call('PATCH', `/api/quick-answers/${qa.id}`, agentA, { removeAttachment: true });
  expect(removed.json().hasAttachment).toBe(false);
  expect((await call('GET', `/api/quick-answers/${qa.id}/attachment`, agentA)).statusCode).toBe(404);
});
