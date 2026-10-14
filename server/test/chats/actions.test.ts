import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settings } from '../../src/db/schema.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
});
afterEach(async () => {
  await app.close();
});

function multipart(fields: Record<string, string>, file?: { name: string; mime: string; data: Buffer }) {
  const boundary = '----talktestboundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('chat action routes', () => {
  it('assume, read, privacy and close answer with ChatDetail; closing twice is 409', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, waiting: true, unread: 3 });
    const { headers } = await loginAs(app, s.agentA.email);
    const post = (path: string, payload?: object) =>
      app.inject({ method: 'POST', url: `/api/chats/${chatId}/${path}`, headers, ...(payload ? { payload } : {}) });

    const assumed = await post('assume');
    expect(assumed.statusCode).toBe(200);
    expect(assumed.json().ownerId).toBe(s.agentA.id);

    expect((await post('read')).statusCode).toBe(204);
    const detail = await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers });
    expect(detail.json().unread).toBe(0);

    const priv = await post('privacy', { private: true });
    expect(priv.statusCode).toBe(200);
    expect(priv.json().private).toBe(true);
    expect((await post('privacy', { private: 'sim' })).statusCode).toBe(400);

    const closed = await post('close', { sendClosingMessage: false });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().state).toBe('closed');
    expect(closed.json().closedAt).not.toBeNull();
    expect((await post('close', { sendClosingMessage: false })).statusCode).toBe(409);

    const reopened = await post('reopen');
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().state).toBe('open');
  });

  it('transfer answers with the new detail and then hides the chat from the agent', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    const { headers } = await loginAs(app, s.agentA.email);

    const bad = await app.inject({ method: 'POST', url: `/api/chats/${chatId}/transfer`, headers, payload: {} });
    expect(bad.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/transfer`, headers, payload: { sectorId: s.sectorB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sectorId).toBe(s.sectorB);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}`, headers })).statusCode).toBe(404);
  });

  it('close with sendClosingMessage sends settings.closing_message to the contact', async () => {
    await ctx.db
      .insert(settings)
      .values({ key: 'closing_message', value: 'Obrigado pelo contato!' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'Obrigado pelo contato!' } });
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/close`, headers, payload: { sendClosingMessage: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('closed');
    const sent = ctx.wa.sent.find((x) => x.method === 'sendText');
    expect(sent?.phone).toBe('5565999990001');
    expect(JSON.stringify(sent?.payload)).toContain('Obrigado pelo contato!');
  });

  it('pin and unpin answer 204; a fourth pin is 409', async () => {
    const chatIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      chatIds.push((await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA })).chatId);
    }
    const { headers } = await loginAs(app, s.agentA.email);
    const pin = (id: string, method: 'PUT' | 'DELETE') => app.inject({ method, url: `/api/chats/${id}/pin`, headers });

    for (const id of chatIds.slice(0, 3)) expect((await pin(id, 'PUT')).statusCode).toBe(204);
    expect((await pin(chatIds[3], 'PUT')).statusCode).toBe(409);
    expect((await pin(chatIds[0], 'DELETE')).statusCode).toBe(204);
    expect((await pin(chatIds[3], 'PUT')).statusCode).toBe(204);

    const list = (await app.inject({ method: 'GET', url: '/api/chats', headers })).json();
    const pinnedIds = list.items.filter((i: { pinned: boolean }) => i.pinned).map((i: { id: string }) => i.id);
    expect(pinnedIds.sort()).toEqual(chatIds.slice(1).sort());
  });

  it('every action on a chat of another sector is 404 and nothing is sent', async () => {
    const { chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorB, phone: '5511988887777' });
    const { headers } = await loginAs(app, s.agentA.email);
    const calls: Array<{ method: 'POST' | 'PUT'; path: string; payload?: object }> = [
      { method: 'POST', path: 'assume' },
      { method: 'POST', path: 'reopen' },
      { method: 'POST', path: 'read' },
      { method: 'POST', path: 'close', payload: { sendClosingMessage: false } },
      { method: 'POST', path: 'privacy', payload: { private: true } },
      { method: 'POST', path: 'transfer', payload: { sectorId: s.sectorA } },
      { method: 'PUT', path: 'pin' },
      { method: 'POST', path: 'notes', payload: { text: 'x' } },
      { method: 'POST', path: 'messages', payload: { text: 'x', signature: false } },
    ];
    for (const c of calls) {
      const res = await app.inject({
        method: c.method, url: `/api/chats/${chatId}/${c.path}`, headers, ...(c.payload ? { payload: c.payload } : {}),
      });
      expect(res.statusCode, c.path).toBe(404);
    }
    expect(ctx.wa.sent).toHaveLength(0);
  });
});

describe('POST /api/chats (start a conversation)', () => {
  it('creates contact and chat for a new phone, then reuses the open chat', async () => {
    const { headers } = await loginAs(app, s.agentA.email);
    const start = (payload: object) => app.inject({ method: 'POST', url: '/api/chats', headers, payload });

    const first = await start({ phone: '(65) 9999-0002', name: 'Novo Cliente' });
    expect(first.statusCode).toBe(200);
    const chat = first.json();
    expect(chat.contact.phone).toBe('5565999990002');
    expect(chat.contact.name).toBe('Novo Cliente');
    expect(chat.ownerId).toBe(s.agentA.id);
    expect(chat.sectorId).toBe(s.defaultSector);
    expect(chat.state).toBe('open');
    expect(chat.waiting).toBe(false);
    expect(chat.triagePending).toBe(false);

    const again = await start({ phone: '5565999990002' });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(chat.id);

    expect((await start({})).statusCode).toBe(400);
  });
});

describe('POST /api/chats/:id/messages, notes and resend', () => {
  it('sends JSON text through the gateway', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: 'Bom dia', signature: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chatId, direction: 'out', kind: 'text', body: 'Bom dia' });
    expect(ctx.wa.sent.at(-1)).toMatchObject({ method: 'sendText', phone: '5565999990001' });

    const empty = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: '   ', signature: false },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('sends a multipart file as media and rejects multipart without a file', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const body = multipart(
      { text: 'Segue o contrato', signature: 'false' },
      { name: 'contrato.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 teste') },
    );
    const res = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`,
      headers: { ...headers, 'content-type': body.contentType }, payload: body.payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('document');
    expect(res.json().media).not.toBeNull();
    expect(ctx.wa.sent.at(-1)).toMatchObject({ method: 'sendMedia', phone: '5565999990001' });

    const noFile = multipart({ text: 'sem arquivo', signature: 'false' });
    const bad = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`,
      headers: { ...headers, 'content-type': noFile.contentType }, payload: noFile.payload,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('adds an internal note without sending anything, and resends a failed message', async () => {
    const { chatId } = await seedChat(ctx, {
      channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: '5565999990001',
    });
    const { headers } = await loginAs(app, s.agentA.email);

    const note = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/notes`, headers, payload: { text: 'Cliente pediu retorno' },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ kind: 'note', body: 'Cliente pediu retorno' });
    expect(ctx.wa.sent).toHaveLength(0);

    ctx.wa.failNext();
    const failed = await app.inject({
      method: 'POST', url: `/api/chats/${chatId}/messages`, headers, payload: { text: 'Olá', signature: false },
    });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().status).toBe('failed');

    const resent = await app.inject({ method: 'POST', url: `/api/messages/${failed.json().id}/resend`, headers });
    expect(resent.statusCode).toBe(200);
    expect(resent.json().status).not.toBe('failed');
  });
});
