import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chats, messageEdits, messageFavorites, messages, userSectors } from '../../src/db/schema.js';
import { enableSeeAll, loginAs } from '../helpers.js';
import { eventsOf } from '../inbox/fixtures.js';
import { seedMsg, setupActions, type ActionsWorld } from './actions-seed.js';

let w: ActionsWorld;
beforeEach(async () => {
  w = await setupActions();
});
afterEach(async () => {
  await w.app.close();
});

const call = (method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers = w.headers) =>
  w.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const note = (extra: Partial<typeof messages.$inferInsert> = {}) =>
  seedMsg(w, { kind: 'note', externalId: null, body: 'Cliente pede retorno', ...extra });
const row = async (id: string) => (await w.ctx.db.select().from(messages).where(eq(messages.id, id)))[0];
const eventsOfKind = async (kind: string) => (await eventsOf(w.ctx, w.chatId)).filter((e) => e.kind === kind);
const closeChat = () => w.ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, w.chatId));
/** Bruno (agentB) is not in sector A: he cannot see the chat. */
const outsider = async () => (await loginAs(w.app, w.s.agentB.email)).headers;
/** Bruno joins sector A: he sees the chat but wrote nothing in it. */
const brunoInSectorA = async () => {
  await w.ctx.db.insert(userSectors).values({ userId: w.s.agentB.id, sectorId: w.s.sectorA });
  return (await loginAs(w.app, w.s.agentB.email)).headers;
};
const adminSeeingAll = async () => {
  await enableSeeAll(w.ctx, w.s.admin);
  return (await loginAs(w.app, w.s.admin.email)).headers;
};

describe('PATCH /api/messages/:id on a note (spec 2026-10-19 §3)', () => {
  it('the author edits a note: new text, the old one in the history, no WhatsApp call and no timeline event (Review Focus 4)', async () => {
    const id = await note();

    const res = await call('PATCH', `/api/messages/${id}`, { text: 'Cliente pede retorno amanhã' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      kind: 'note', body: 'Cliente pede retorno amanhã', edited: { source: 'office', newTextUnavailable: false },
    });
    expect((await call('GET', `/api/messages/${id}/edits`)).json()).toMatchObject([
      { previousBody: 'Cliente pede retorno', source: 'office', editedByName: w.s.agentA.name },
    ]);
    expect(w.ctx.wa.sent).toEqual([]);
    expect(await eventsOfKind('message_edited')).toEqual([]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'message.updated', chatId: w.chatId, messageId: id });
  });

  it('nobody else edits it, not even an admin; a hidden chat is 404 and a closed chat 409', async () => {
    const id = await note();
    expect((await call('PATCH', `/api/messages/${id}`, { text: 'x' }, await outsider())).statusCode).toBe(404);
    for (const headers of [await brunoInSectorA(), await adminSeeingAll()]) {
      const res = await call('PATCH', `/api/messages/${id}`, { text: 'outro texto' }, headers);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Só quem escreveu a nota pode editá-la' });
    }
    await closeChat();
    expect((await call('PATCH', `/api/messages/${id}`, { text: 'tarde' })).json()).toEqual({ error: 'Conversa finalizada' });
    expect((await row(id))!.body).toBe('Cliente pede retorno');
    expect(await w.ctx.db.select().from(messageEdits)).toEqual([]);
  });
});

describe('DELETE /api/notes/:id (spec 2026-10-19 §3)', () => {
  it('the author deletes a note: the row, its history and its star go; the timeline says who did it', async () => {
    const id = await note();
    await call('PATCH', `/api/messages/${id}`, { text: 'Cliente pede retorno amanhã' });
    await call('PUT', `/api/messages/${id}/favorite`);

    const res = await call('DELETE', `/api/notes/${id}`);

    expect(res.statusCode).toBe(204);
    expect(await row(id)).toBeUndefined();
    expect(await w.ctx.db.select().from(messageEdits)).toEqual([]);
    expect(await w.ctx.db.select().from(messageFavorites)).toEqual([]);
    expect(await eventsOfKind('note_deleted')).toMatchObject([{ authorId: w.s.agentA.id, data: {} }]);
    expect(w.ctx.hub.events).toContainEqual({ type: 'chat', chatId: w.chatId });
    expect(w.ctx.wa.sent).toEqual([]);
    expect((await call('DELETE', `/api/notes/${id}`)).statusCode).toBe(404); // a second click
  });

  it("an admin deletes anyone's note; another agent who sees the chat does not (Review Focus 3)", async () => {
    const id = await note();
    const refused = await call('DELETE', `/api/notes/${id}`, undefined, await brunoInSectorA());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Só quem escreveu a nota ou um administrador pode apagá-la' });
    expect(await row(id)).toBeDefined();
    expect((await call('DELETE', `/api/notes/${id}`, undefined, await adminSeeingAll())).statusCode).toBe(204);
    expect(await eventsOfKind('note_deleted')).toMatchObject([{ authorId: w.s.admin.id }]);
  });

  it('never removes a message that is not a note, and refuses in a closed chat (Review Focus 3)', async () => {
    const text = await seedMsg(w);
    const res = await call('DELETE', `/api/notes/${text}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Esta mensagem não é uma nota' });
    expect(await row(text)).toBeDefined();

    const id = await note();
    await closeChat();
    expect((await call('DELETE', `/api/notes/${id}`)).json()).toEqual({ error: 'Conversa finalizada' });
    expect(await row(id)).toBeDefined();
    expect(await eventsOfKind('note_deleted')).toEqual([]);
  });
});

describe('favorites (spec 2026-10-19 §5)', () => {
  const star = (id: string, headers = w.headers) => call('PUT', `/api/messages/${id}/favorite`, undefined, headers);
  const unstar = (id: string, headers = w.headers) => call('DELETE', `/api/messages/${id}/favorite`, undefined, headers);
  const list = async (headers = w.headers) => {
    const res = await call('GET', `/api/chats/${w.chatId}/favorites`, undefined, headers);
    expect(res.statusCode).toBe(200);
    return res.json() as Array<{ id: string; favorite: unknown }>;
  };

  it('one shared star per message: the first who marks it keeps the name; anyone who sees the chat removes it', async () => {
    const id = await seedMsg(w, { direction: 'in', authorId: null, body: 'Prazo dia 20' });

    const res = await star(id);

    expect(res.statusCode).toBe(200);
    expect(res.json().favorite).toMatchObject({ byName: w.s.agentA.name });
    const bruno = await brunoInSectorA();
    expect((await star(id, bruno)).json().favorite).toMatchObject({ byName: w.s.agentA.name });
    expect((await list(bruno)).map((m) => m.id)).toEqual([id]);
    expect((await unstar(id, bruno)).json().favorite).toBeNull();
    expect(await list()).toEqual([]);
    expect(w.ctx.hub.events.filter((e) => e.type === 'message.updated' && e.messageId === id)).toHaveLength(3);
    expect(w.ctx.wa.sent).toEqual([]);
  });

  it('lists the newest star first; a message deleted for everyone and a closed chat count', async () => {
    const older = await seedMsg(w, { direction: 'in', authorId: null, deletedAt: new Date(), deletedSource: 'contact' });
    const newer = await seedMsg(w);
    await star(older);
    await star(newer);
    await closeChat();
    const last = await seedMsg(w);
    expect((await star(last)).statusCode).toBe(200);
    expect((await list()).map((m) => m.id)).toEqual([last, newer, older]);
  });

  it('404 for a hidden chat or an unknown message, in every route (Review Focus 6)', async () => {
    const id = await seedMsg(w);
    const bruno = await outsider();
    expect((await star(id, bruno)).statusCode).toBe(404);
    expect((await unstar(id, bruno)).statusCode).toBe(404);
    expect((await call('GET', `/api/chats/${w.chatId}/favorites`, undefined, bruno)).statusCode).toBe(404);
    expect((await star(randomUUID())).statusCode).toBe(404);
    expect(await w.ctx.db.select().from(messageFavorites)).toEqual([]);
  });
});
