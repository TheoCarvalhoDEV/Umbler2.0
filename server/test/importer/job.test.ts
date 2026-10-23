import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, contactNotes, contacts, historyImports, messages, umblerImports, umblerMap } from '../../src/db/schema.js';
import { createHistoryWorker } from '../../src/history/jobs.js';
import { emptyProgress, runUmblerJob, umblerBeat, type JobDeps } from '../../src/importer/job.js';
import type { UmblerClient } from '../../src/importer/umbler.js';
import { umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { analyze, depsOf, importWorld, rowOf, startImport, type World } from './world.js';

let w: World;
beforeEach(async () => {
  w = await importWorld();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

type Obj = Record<string, unknown>;
const joao = { id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: null };
let chatsOf: { open: Obj; unread: Obj; older: Obj; newer: Obj };
/** Two open chats (one with unread messages) and two finished ones, two messages each; notes for Maria. */
function givenOffice(): void {
  const open = umblerChat({ createdAtUTC: '2026-10-01T10:00:00Z' });
  const unread = umblerChat({ createdAtUTC: '2026-09-01T10:00:00Z', totalUnread: 1, contact: joao, lastMessage: { id: 'X', source: 'Contact', messageState: 'Received' } });
  const older = umblerChat({ open: false, createdAtUTC: '2026-03-01T10:00:00Z', closedAtUTC: '2026-03-01T11:00:00Z' });
  const newer = umblerChat({ open: false, createdAtUTC: '2026-06-01T10:00:00Z', closedAtUTC: '2026-06-01T11:00:00Z', contact: joao });
  chatsOf = { open, unread, older, newer };
  for (const [i, chat] of [open, unread, older, newer].entries()) {
    const day = String(chat.createdAtUTC).slice(0, 10);
    w.fake.world.chats.push(chat);
    w.fake.world.messages[chat.id as string] = [umblerMessage(`A${i}`, `${day}T10:00:00Z`), umblerMessage(`B${i}`, `${day}T10:01:00Z`)];
  }
  w.fake.world.notes.C1 = [{ _t: 'NoteModel', id: 'N1', content: 'Retornar', pinned: false, createdBy: 'M_ANA', createdAtUTC: '2026-08-01T10:00:00Z' }];
  w.fake.world.notes.C2 = [];
  w.fake.world.notes.C3 = [];
}
const relativeChatIds = () => w.fake.calls(/relative-messages/).map((r) => r.path.split('/')[4]);
const counts = async () => ({
  contacts: await w.ctx.db.$count(contacts),
  chats: await w.ctx.db.$count(chats),
  messages: await w.ctx.db.$count(messages),
  notes: await w.ctx.db.$count(contactNotes),
  mapped: await w.ctx.db.$count(umblerMap, eq(umblerMap.kind, 'message')),
});
/** A client that stops the job (as the worker's stop() does) right after the call `when` matches. */
function stoppingAt(when: (route: string, query: Obj, params: Obj) => boolean): JobDeps {
  const abort = new AbortController();
  const client: UmblerClient = {
    async get<T>(route: string, query: Obj = {}, params: Record<string, string> = {}) {
      const res = await w.client.get<T>(route, query as never, params);
      if (when(route, query, params)) abort.abort();
      return res;
    },
    file: (url) => w.client.file(url),
  };
  return { ...depsOf(w), client, signal: abort.signal };
}

describe('Importar (spec 2026-10-21 importar-umbler §9)', () => {
  it('runs the five phases in order (open chats, notes, closed newest first) and ends with the report', async () => {
    givenOffice();
    const row = await startImport(w, await analyze(w));

    expect(row).toMatchObject({ state: 'done', phase: 'closed_chats', error: null });
    expect(row.finishedAt).not.toBeNull();
    // the open chat without unread messages first (§5.2), then the one with them; finished ones newest first (§9.1)
    expect(relativeChatIds()).toEqual([chatsOf.open.id, chatsOf.unread.id, chatsOf.newer.id, chatsOf.older.id]);
    const paths = w.fake.requests.map((r) => r.path);
    const firstNotes = paths.findIndex((p) => p.endsWith('/notes/'));
    expect(firstNotes).toBeGreaterThan(paths.lastIndexOf(`/api/v1/chats/${chatsOf.unread.id}/relative-messages/`));
    expect(firstNotes).toBeLessThan(paths.indexOf(`/api/v1/chats/${chatsOf.newer.id}/relative-messages/`));
    expect(w.fake.calls(/\/contacts\/C2\/chats\/$/).map((r) => r.query.get('ChatState'))).toEqual(['Open']); // the unread check
    expect(row.report).toMatchObject({
      contacts: { created: 2, completed: 0, lidOnly: 1, skipped: 1 },
      notes: 1,
      chats: { openCreated: 2, closed: 2 },
      messages: { total: 8, matched: 0 },
    });
    expect(row.report!.durationMs).toBeGreaterThanOrEqual(0);
    expect(await counts()).toEqual({ contacts: 3, chats: 4, messages: 8, notes: 1, mapped: 8 });
  });

  it('stops with umbler_marked_read when an open chat lost its unread count without an agent reply (§5.2)', async () => {
    givenOffice();
    w.fake.world.marksRead = chatsOf.unread.id as string; // reading it marks it as read in Umbler
    const row = await startImport(w, await analyze(w));
    expect(row).toMatchObject({ state: 'failed', error: 'umbler_marked_read', phase: 'open_chats' });
    expect(relativeChatIds()).toEqual([chatsOf.open.id, chatsOf.unread.id]); // at most one chat affected
  });

  it('a stop in the middle of the contacts or of a chat leaves it running; the next beat goes on without duplicates (§9.3)', async () => {
    givenOffice();
    w.fake.world.maxTake = 2; // contacts in two pages
    w.fake.world.messages[chatsOf.newer.id as string] = Array.from({ length: 251 }, (_, i) =>
      umblerMessage(`L${i}`, new Date(Date.UTC(2026, 5, 1, 10, 0, 0) + i * 1000).toISOString()),
    ); // two message pages
    const analyzed = await analyze(w);

    let row = await startImport(w, analyzed, stoppingAt((route, query) => route === '/v1/contacts/' && query.Skip === 2));
    expect(row).toMatchObject({ state: 'running', phase: 'contacts' });

    await runUmblerJob(w.ctx, stoppingAt((route, _q, params) => route.includes('relative-messages') && params.chatId === chatsOf.newer.id));
    row = await rowOf(w, analyzed.id);
    expect(row).toMatchObject({ state: 'running', phase: 'closed_chats' });
    expect(await w.ctx.db.$count(messages)).toBe(4 + 250); // the open chats, the first page of the long chat, then the stop

    await runUmblerJob(w.ctx, depsOf(w));
    row = await rowOf(w, analyzed.id);
    expect(row.state).toBe('done');
    expect(await counts()).toEqual({ contacts: 3, chats: 4, messages: 257, notes: 1, mapped: 257 });
    expect(row.report).toMatchObject({ contacts: { created: 2, lidOnly: 1 }, chats: { openCreated: 2, closed: 2 }, messages: { total: 257 }, notes: 1 });
  });

  it('a resumed phase walks its list again without counting its skips twice', async () => {
    givenOffice();
    const web = umblerChat({
      open: false, createdAtUTC: '2026-07-01T10:00:00Z', closedAtUTC: '2026-07-01T11:00:00Z',
      channel: { _t: 'ChatWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site' },
    }); // finished after `newer` closed: listed before it
    const empty = umblerChat({ open: false, createdAtUTC: '2026-06-15T10:00:00Z', closedAtUTC: '2026-06-15T11:00:00Z' });
    w.fake.world.chats.push(web, empty);
    w.fake.world.messages[empty.id as string] = [];
    const analyzed = await analyze(w);
    await startImport(w, analyzed, stoppingAt((route, _q, params) => route.includes('relative-messages') && params.chatId === chatsOf.newer.id));
    expect(await rowOf(w, analyzed.id)).toMatchObject({ state: 'running', phase: 'closed_chats' });

    await runUmblerJob(w.ctx, depsOf(w));

    const row = await rowOf(w, analyzed.id);
    expect(row.state).toBe('done');
    expect(row.report!.chats).toMatchObject({ skippedChannel: 1, skippedEmpty: 1, closed: 2 });
    expect(row.report).not.toHaveProperty('phaseStart');
  });

  it('"Analisar de novo" + "Importar" brings only what is missing; a finished closed chat costs no message call (§9.2)', async () => {
    givenOffice();
    await startImport(w, await analyze(w));
    const before = await counts();
    w.fake.world.messages[chatsOf.open.id as string]!.push(umblerMessage('C0', '2026-10-01T10:05:00Z'));
    const extra = umblerChat({ open: false, createdAtUTC: '2026-07-01T10:00:00Z', closedAtUTC: '2026-07-01T11:00:00Z' });
    w.fake.world.chats.push(extra);
    w.fake.world.messages[extra.id as string] = [umblerMessage('E1', '2026-07-01T10:00:00Z')];
    const calls = w.fake.requests.length;

    const second = await startImport(w, await analyze(w));

    expect(second.state).toBe('done');
    expect(await counts()).toEqual({ ...before, chats: before.chats + 1, messages: before.messages + 2, mapped: before.mapped + 2 });
    const relative = w.fake.requests.slice(calls).filter((r) => r.path.includes('relative-messages')).map((r) => r.path.split('/')[4]);
    expect(relative).toEqual([chatsOf.open.id, chatsOf.unread.id, extra.id]); // the old finished ones: none
  });

  it('waits while a WhatsApp history import runs (§9.3)', async () => {
    givenOffice();
    const [history] = await w.ctx.db
      .insert(historyImports)
      .values({ channelId: w.s.channelId, period: '3m', auto: false, state: 'running' })
      .returning();
    const deps: JobDeps = {
      ...depsOf(w),
      sleep: async (ms) => {
        w.sleeps.push(ms);
        await w.ctx.db.update(historyImports).set({ state: 'done' }).where(eq(historyImports.id, history!.id));
      },
    };
    const row = await startImport(w, await analyze(w), deps);
    expect(row.state).toBe('done');
    expect(w.sleeps).toContain(15_000);
  });

  it('without UMBLER_TOKEN an active row fails with umbler_token; the worker runs the job in its own loop', async () => {
    await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() });
    await umblerBeat(w.ctx, new AbortController().signal); // makeTestCtx: umblerToken null
    expect((await w.ctx.db.select().from(umblerImports))[0]).toMatchObject({ state: 'failed', error: 'umbler_token' });

    const [row] = await w.ctx.db.insert(umblerImports).values({ state: 'analyzing', progress: emptyProgress() }).returning();
    const worker = createHistoryWorker(w.ctx, { umblerClient: () => w.client });
    worker.start();
    await vi.waitFor(async () => expect((await rowOf(w, row!.id)).state).toBe('analyzed'), { timeout: 10_000, interval: 50 });
    await worker.stop();
  });
});
