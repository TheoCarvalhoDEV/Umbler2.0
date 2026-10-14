import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { WsEvent } from '@talk/shared';
import type { AppCtx } from '../../src/ctx.js';
import { chats, contacts } from '../../src/db/schema.js';
import { createHub } from '../../src/realtime/hub.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let port: number;
let cookie: string;
const opened: WebSocket[] = [];

beforeAll(async () => {
  const base = await makeTestCtx();
  // The route test needs real fan-out, so swap the recording hub for the real one.
  ctx = { ...base, hub: createHub(() => base.db) };
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  ({ cookie } = await loginAs(app, s.agentA.email));
});

afterAll(async () => {
  for (const ws of opened) ws.terminate();
  await app.close();
});

function connect(opts: { origin?: string; cookie?: string }): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: opts.origin,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
  });
  opened.push(ws);
  return ws;
}

// Resolves 'open' on a successful upgrade, or ws's error message, e.g. 'Unexpected server response: 403'.
function outcome(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', (err) => resolve(err.message));
  });
}

function nextEvent(ws: WebSocket): Promise<WsEvent> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString()) as WsEvent));
  });
}

describe('GET /ws', () => {
  it('rejects an upgrade from another origin with 403', async () => {
    const ws = connect({ origin: 'https://evil.example', cookie });
    expect(await outcome(ws)).toBe('Unexpected server response: 403');
  });

  it('rejects an upgrade without Origin header with 403', async () => {
    const ws = connect({ cookie });
    expect(await outcome(ws)).toBe('Unexpected server response: 403');
  });

  it('rejects an upgrade without session cookie with 401', async () => {
    const ws = connect({ origin: ctx.config.appOrigin });
    expect(await outcome(ws)).toBe('Unexpected server response: 401');
  });

  it('rejects an upgrade with an unknown session token with 401', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie: 'sid=token-que-nao-existe' });
    expect(await outcome(ws)).toBe('Unexpected server response: 401');
  });

  it('delivers chat.updated for a visible chat after a publish', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie });
    expect(await outcome(ws)).toBe('open');

    const contactId = randomUUID();
    await ctx.db.insert(contacts).values({ id: contactId, name: 'Ana Prado', phone: '5565999991234' });
    const chatId = randomUUID();
    await ctx.db.insert(chats).values({
      id: chatId, contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: null,
      state: 'open', waiting: true, private: false, triagePending: false, unread: 1,
    });

    const received = nextEvent(ws);
    await ctx.hub.publishChat(chatId);

    expect(await received).toEqual({
      type: 'chat.updated',
      chat: expect.objectContaining({ id: chatId, sectorId: s.sectorA, contact: { id: contactId, name: 'Ana Prado', phone: '5565999991234' } }),
    });
  });

  it('closes the socket when the user is disconnected', async () => {
    const ws = connect({ origin: ctx.config.appOrigin, cookie });
    expect(await outcome(ws)).toBe('open');

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ctx.hub.disconnectUser(s.agentA.id);

    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});
