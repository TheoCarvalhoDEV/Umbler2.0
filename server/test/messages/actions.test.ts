import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, messages } from '../../src/db/schema.js';
import { handleInbound } from '../../src/messages/ingest.js';
import { enableSeeAll, loginAs } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { PHONE, minutesAgo, seedMsg, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const call = (method: 'POST' | 'DELETE' | 'PATCH' | 'GET', url: string, payload?: object, headers = w.headers) =>
  w.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0]!;
const sentBy = (method: string) => w.ctx.wa.sent.filter((s) => s.method === method);
const eventsOfKind = async (kind: string) => (await eventsOf(w.ctx, w.chatId)).filter((e) => e.kind === kind);

describe('POST /api/messages/:id/reaction', () => {
  const react = (id: string, emoji: string, headers = w.headers) => call('POST', `/api/messages/${id}/reaction`, { emoji }, headers);

  it('reacts, swaps and removes the office reaction on WhatsApp', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, externalId: 'WA-IN' });

    const first = await react(id, '👍');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id, officeReaction: '👍', reaction: null });
    expect((await react(id, '❤️')).json().officeReaction).toBe('❤️');
    expect((await react(id, '❤️')).json().officeReaction).toBeNull(); // the same emoji again removes it

    const key = { address: PHONE, externalId: 'WA-IN', fromMe: false };
    expect(sentBy('sendReaction').map((s) => s.payload)).toEqual([
      { key, emoji: '👍' },
      { key, emoji: '❤️' },
      { key, emoji: '' },
    ]);
    expect(w.ctx.hub.events.filter((e) => e.type === 'message.updated' && e.messageId === id)).toHaveLength(3);
  });

  it('refuses a non-emoji, a pending send, a note, a hidden chat and a closed chat', async () => {
    const id = await seedMsg(w);
    expect((await react(id, 'ok')).json()).toEqual({ error: 'Escolha um emoji' });
    const pending = await seedMsg(w, { status: 'pending', externalId: null });
    expect((await react(pending, '👍')).statusCode).toBe(409);
    const note = await seedMsg(w, { kind: 'note', externalId: null });
    expect((await react(note, '👍')).statusCode).toBe(409);
    const bruno = await loginAs(w.app, w.s.agentB.email);
    expect((await react(id, '👍', bruno.headers)).statusCode).toBe(404);
    await w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
    const closed = await react(id, '👍');
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toEqual({ error: 'Conversa finalizada' });
    expect(sentBy('sendReaction')).toEqual([]);
  });

  it('turns an Evolution failure into a 502 in Portuguese and logs no text', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'texto do cliente' });
    w.ctx.wa.failNext(new Error('Evolution POST /message/sendReaction/talk-test failed: 500 {"text":"texto do cliente"}'));

    const res = await react(id, '👍');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível reagir no WhatsApp. Tente de novo.' });
    expect((await row(id)).officeReaction).toBeNull();
    expect(logged).toHaveBeenCalledWith('message reaction failed', { messageId: id, err: 'Error' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('texto do cliente');
    logged.mockRestore();
  });
});

describe('DELETE /api/messages/:id', () => {
  const del = (id: string) => call('DELETE', `/api/messages/${id}`);

  it('deletes an office message for everyone, keeps its text and logs who did it', async () => {
    const id = await seedMsg(w, { body: 'Mensagem errada', externalId: 'WA-OUT', sentAt: minutesAgo(60) });

    const res = await del(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, body: 'Mensagem errada', deleted: { source: 'office', byName: w.s.agentA.name } });
    expect(sentBy('deleteForEveryone').map((s) => s.payload)).toEqual([{ key: { address: PHONE, externalId: 'WA-OUT', fromMe: true } }]);
    expect(await eventsOfKind('message_deleted')).toMatchObject([
      { authorId: w.s.agentA.id, data: { messageId: id, source: 'office' } },
    ]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'message.updated', chatId: w.chatId, messageId: id });
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
  });

  it('deletes bot and phone sends too, never inbound messages', async () => {
    const bot = await seedMsg(w, { authorId: null });
    expect((await del(bot)).statusCode).toBe(200);
    // a send from the office phone: outgoing, no author, no bot run (ingest stores fromMe messages this way)
    const phone = await seedMsg(w, { authorId: null, botRunId: null });
    expect((await del(phone)).statusCode).toBe(200);
    expect(await row(phone)).toMatchObject({ deletedSource: 'office' });
    const inbound = await seedMsg(w, { direction: 'in', authorId: null });
    const res = await del(inbound);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Só dá para apagar mensagens enviadas pelo escritório' });
  });

  it('stops at 48 h with the hint text', async () => {
    const id = await seedMsg(w, { sentAt: minutesAgo(48 * 60 + 1) });
    expect((await del(id)).json()).toEqual({ error: 'Só até 48 h após o envio' });
    expect(sentBy('deleteForEveryone')).toEqual([]);
  });

  it('a second delete is 409 and calls Evolution once (Review Focus 4)', async () => {
    const id = await seedMsg(w);
    expect((await del(id)).statusCode).toBe(200);
    const again = await del(id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: 'Mensagem apagada' });
    expect(sentBy('deleteForEveryone')).toHaveLength(1);
  });

  it('rolls back when Evolution fails (Review Focus 3)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'segredo do cliente' });
    w.ctx.wa.failNext();

    const res = await del(id);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível apagar no WhatsApp. Tente de novo.' });
    expect(await row(id)).toMatchObject({ deletedAt: null, deletedBy: null, deletedSource: null });
    expect(await eventsOfKind('message_deleted')).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('segredo');
    logged.mockRestore();
  });

  it('keeps the 502 when the rollback itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'segredo do cliente' });
    vi.spyOn(w.ctx.wa, 'deleteForEveryone').mockImplementation(async () => {
      vi.spyOn(w.ctx.db, 'update').mockImplementation(() => { throw new Error('db down: segredo do cliente'); });
      throw new Error('evolution down');
    });

    const res = await del(id);

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível apagar no WhatsApp. Tente de novo.' });
    expect(logged).toHaveBeenCalledWith('message rollback failed', { messageId: id, err: 'Error' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('segredo');
    logged.mockRestore();
  });

  it('a deleted message can no longer be quoted', async () => {
    const id = await seedMsg(w);
    await del(id);
    const res = await call('POST', `/api/chats/${w.chatId}/messages`, { text: 'Sobre aquela', replyToId: id });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Mensagem apagada não pode ser citada' });
  });
});

describe('PATCH /api/messages/:id and GET /api/messages/:id/edits', () => {
  const edit = (id: string, text: string, headers = w.headers) => call('PATCH', `/api/messages/${id}`, { text }, headers);
  const history = (id: string, headers = w.headers) => call('GET', `/api/messages/${id}/edits`, undefined, headers);

  it('edits the author text on WhatsApp and keeps the previous version', async () => {
    const id = await seedMsg(w, { body: 'Reunião às 14h', externalId: 'WA-E', sentAt: minutesAgo(5) });

    const res = await edit(id, 'Reunião às 15h');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'Reunião às 15h', edited: { source: 'office', newTextUnavailable: false } });
    expect(sentBy('editText').map((s) => s.payload)).toEqual([
      { key: { address: PHONE, externalId: 'WA-E', fromMe: true }, text: 'Reunião às 15h' },
    ]);
    expect((await history(id)).json()).toMatchObject([
      { previousBody: 'Reunião às 14h', source: 'office', editedByName: w.s.agentA.name, newTextUnavailable: false },
    ]);
    expect(await eventsOfKind('message_edited')).toMatchObject([{ authorId: w.s.agentA.id, data: { messageId: id, source: 'office' } }]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
  });

  it('edits the caption of an image', async () => {
    const id = await seedMsg(w, { kind: 'image', body: 'Foto 1', mediaPath: '2026/10/x.jpg', mediaMime: 'image/jpeg' });
    expect((await edit(id, 'Foto 2')).json()).toMatchObject({ kind: 'image', body: 'Foto 2' });
  });

  it('refuses after 15 minutes, other authors, bots, documents and empty or long text', async () => {
    expect((await edit(await seedMsg(w, { sentAt: minutesAgo(16) }), 'tarde demais')).json()).toEqual({
      error: 'Só até 15 min após o envio',
    });
    await enableSeeAll(w.ctx, w.s.admin);
    const admin = await loginAs(w.app, w.s.admin.email);
    const recent = await seedMsg(w);
    expect((await edit(recent, 'outro autor', admin.headers)).json()).toEqual({ error: 'Só dá para editar mensagens enviadas por você' });
    expect((await edit(await seedMsg(w, { authorId: null }), 'x')).json()).toEqual({
      error: 'Só dá para editar mensagens enviadas por você',
    });
    const doc = await seedMsg(w, { kind: 'document', body: 'Segue', mediaPath: '2026/10/a.pdf' });
    expect((await edit(doc, 'x')).json()).toEqual({ error: 'Só dá para editar texto ou legenda' });
    expect((await edit(recent, '   ')).statusCode).toBe(400);
    expect((await edit(recent, 'x'.repeat(4097))).statusCode).toBe(400);
    expect(sentBy('editText')).toEqual([]);
  });

  it('the same text again changes nothing and calls nobody', async () => {
    const id = await seedMsg(w, { body: 'igual' });
    expect((await edit(id, 'igual')).statusCode).toBe(200);
    expect(sentBy('editText')).toEqual([]);
    expect((await history(id)).json()).toEqual([]);
  });

  it('rolls back the text and the history when Evolution fails (Review Focus 3)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'Valor: R$ 100' });
    w.ctx.wa.failNext();

    const res = await edit(id, 'Valor: R$ 200');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível editar no WhatsApp. Tente de novo.' });
    expect(await row(id)).toMatchObject({ body: 'Valor: R$ 100', editedAt: null });
    expect((await history(id)).json()).toEqual([]);
    expect(await eventsOfKind('message_edited')).toEqual([]);
    expect(JSON.stringify(logged.mock.calls)).not.toContain('R$');
    logged.mockRestore();
  });

  it('keeps the 502 when the rollback itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const id = await seedMsg(w, { body: 'Valor: R$ 100' });
    vi.spyOn(w.ctx.wa, 'editText').mockImplementation(async () => {
      vi.spyOn(w.ctx.db, 'transaction').mockImplementation(() => { throw new Error('db down: R$ 100'); });
      throw new Error('evolution down');
    });

    const res = await edit(id, 'Valor: R$ 200');

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'Não foi possível editar no WhatsApp. Tente de novo.' });
    expect(logged).toHaveBeenCalledWith('message rollback failed', { messageId: id, err: 'Error' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('R$');
    logged.mockRestore();
  });

  it('the webhook echo of our own edit adds no second version (Review Focus 1)', async () => {
    const id = await seedMsg(w, { body: 'antes', externalId: 'WA-ECHO' });
    await edit(id, 'depois');
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-ECHO', fromMe: true, text: 'depois' }]);
    expect((await history(id)).json()).toHaveLength(1);
  });

  it('lists contact edits newest first, the encrypted one as text unavailable; 404 for a hidden chat', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, body: 'oi', externalId: 'WA-C' });
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-C', fromMe: false, text: 'oi, tudo bem?' }]);
    await handleInbound(w.ctx, [{ type: 'edit', instance: w.s.instance, targetExternalId: 'WA-C', fromMe: false, text: null }]);

    expect((await history(id)).json()).toMatchObject([
      { previousBody: 'oi, tudo bem?', source: 'contact', editedByName: null, newTextUnavailable: true },
      { previousBody: 'oi', source: 'contact', editedByName: null, newTextUnavailable: false },
    ]);
    const bruno = await loginAs(w.app, w.s.agentB.email);
    expect((await history(id, bruno.headers)).statusCode).toBe(404);
  });
});
