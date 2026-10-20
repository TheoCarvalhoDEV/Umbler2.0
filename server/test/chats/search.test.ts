import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_LIMIT, type MessageSearchHit } from '@talk/shared';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';
import { seedChat, seedMessage } from './seed.js';

let app: FastifyInstance;
let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let s: Awaited<ReturnType<typeof seedBasics>>;
let chatId: string;
let headers: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  ({ app } = await makeTestApp(ctx));
  ({ chatId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA }));
  ({ headers } = await loginAs(app, s.agentA.email));
});
afterEach(async () => {
  await app.close();
});

const t = (min: number) => new Date(Date.UTC(2026, 9, 18, 12, min));
const msg = (min: number, extra: Parameters<typeof seedMessage>[4]) => seedMessage(ctx, chatId, s.channelId, t(min), extra);
const search = (q: string, h = headers) =>
  app.inject({ method: 'GET', url: `/api/chats/${chatId}/search?q=${encodeURIComponent(q)}`, headers: h });
async function hits(q: string): Promise<MessageSearchHit[]> {
  const res = await search(q);
  expect(res.statusCode).toBe(200);
  return res.json();
}
const ids = async (q: string) => (await hits(q)).map((h) => h.messageId);

describe('GET /api/chats/:id/search (spec 2026-10-19 §4)', () => {
  it('finds texts, captions, notes and file names of this chat only, newest first', async () => {
    const text = await msg(1, { body: 'Segue o contrato de honorários' });
    const caption = await msg(2, { kind: 'image', body: 'Foto do contrato assinado', mediaPath: '2026/10/a.jpg', mediaMime: 'image/jpeg' });
    const note = await msg(3, { direction: 'out', kind: 'note', body: 'Conferir CONTRATO amanhã', authorId: s.agentA.id, status: 'sent' });
    const file = await msg(4, {
      kind: 'document', body: null, mediaName: 'Contrato-Final.pdf', mediaPath: '2026/10/b.pdf', mediaMime: 'application/pdf',
    });
    await msg(5, { body: 'nada a ver' });
    const other = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA });
    await seedMessage(ctx, other.chatId, s.channelId, t(6), { body: 'outro contrato' });

    const found = await hits('contrato');

    expect(found.map((h) => h.messageId)).toEqual([file, note, caption, text]);
    expect(found[0]).toEqual({ messageId: file, kind: 'document', direction: 'in', snippet: 'Contrato-Final.pdf', sentAt: t(4).toISOString() });
    expect(found[1]).toMatchObject({ kind: 'note', direction: 'out', snippet: 'Conferir CONTRATO amanhã' });
  });

  it('folds case and accents, and treats % and _ as plain text (Review Focus 2)', async () => {
    const accents = await msg(1, { body: 'AÇÃO de cobrança: São Paulo' });
    const percent = await msg(2, { body: 'Desconto de 10% no boleto' });
    await msg(3, { body: 'Desconto de 100 reais' });
    const under = await msg(4, { body: 'arquivo processo_123' });
    await msg(5, { body: 'processo 1234' });

    expect(await ids('acao')).toEqual([accents]);
    expect(await ids('COBRANCA')).toEqual([accents]);
    expect(await ids('são paulo')).toEqual([accents]);
    expect(await ids('0%')).toEqual([percent]);
    expect(await ids('o_1')).toEqual([under]);
  });

  it('cuts a long text around the match and keeps the newest 50', async () => {
    await msg(0, { body: `${'a'.repeat(100)} prazo final ${'b'.repeat(200)}` });
    expect((await hits('prazo final'))[0]!.snippet).toBe(`…${'a'.repeat(39)} prazo final ${'b'.repeat(79)}…`);

    for (let i = 1; i <= 55; i++) await msg(i, { body: `prazo ${i}` });
    const many = await hits('prazo');
    expect(many).toHaveLength(SEARCH_LIMIT);
    expect(many[0]!.snippet).toBe('prazo 55');
  });

  it('404 for a chat the user cannot see; 400 under 2 characters; 401 without a session (Review Focus 6)', async () => {
    await msg(1, { body: 'contrato' });
    const bruno = await loginAs(app, s.agentB.email);
    expect((await search('contrato', bruno.headers)).statusCode).toBe(404);
    expect((await search('a')).statusCode).toBe(400);
    expect((await search(' a ')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chatId}/search?q=contrato` })).statusCode).toBe(401);
  });
});
