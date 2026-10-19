import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, chats, historyImports, messages } from '../../src/db/schema.js';
import { startHistoryImport } from '../../src/history/imports.js';
import { createHistoryWorker, runBackfill } from '../../src/history/jobs.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';
import { PHONE, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;

beforeEach(async () => {
  ctx = await makeTestCtx(); // fake clock: 2026-10-14T13:00:00Z
  s = await seedBasics(ctx);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const until = async () => (await ctx.db.select().from(channels).where(eq(channels.id, s.channelId)))[0]!.backfillUntil;
const setUntil = (iso: string) => ctx.db.update(channels).set({ backfillUntil: new Date(iso) }).where(eq(channels.id, s.channelId));
const externalIds = async () => (await ctx.db.select().from(messages)).map((m) => m.externalId).sort();

describe('runBackfill (§6)', () => {
  it('the first run only sets the watermark 30 min back and copies nothing', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'velha', at: '2026-10-14T10:00:00Z' }));
    expect(await runBackfill(ctx, s.channelId)).toBe(0);
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
    expect(ctx.wa.findCalls).toEqual([]);
  });

  it('copies what the app missed between backfill_until − 10 min and now − 30 min, then advances', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    ctx.wa.historyRecords.push(
      rec({ id: 'antes', at: '2026-10-14T11:49:00Z' }), // before the 10-min overlap: an earlier run covered it
      rec({ id: 'folga', at: '2026-10-14T11:55:00Z' }), // inside the overlap
      rec({ id: 'perdida', at: '2026-10-14T12:20:00Z' }),
      rec({ id: 'recente', at: '2026-10-14T12:45:00Z' }), // last 30 min: still the webhook's
    );

    expect(await runBackfill(ctx, s.channelId)).toBe(2);

    expect(await externalIds()).toEqual(['folga', 'perdida']);
    expect(ctx.wa.findCalls).toEqual([
      { instance: s.instance, gte: '2026-10-14T11:50:00.000Z', lte: '2026-10-14T12:30:00.000Z', page: 1, offset: 500 },
    ]);
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
  });

  it('what it copies is history only, even into the open chat: no unread, no waiting, no bot or triage', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    const contactId = await newContact(ctx, { phone: PHONE });
    const chatId = await insertChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, contactId });
    ctx.wa.historyRecords.push(rec({ id: 'perdida', at: '2026-10-14T12:20:00Z' }));

    expect(await runBackfill(ctx, s.channelId)).toBe(1);

    const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
    expect(chat).toMatchObject({ unread: 0, waiting: false, triagePending: false });
    expect((await ctx.db.select().from(messages))[0]!.chatId).toBe(chatId);
    expect(ctx.wa.sent).toEqual([]);
  });

  it('an Evolution failure keeps backfill_until, so the next run retries the same window', async () => {
    await setUntil('2026-10-14T12:00:00Z');
    ctx.wa.findMessages = async () => {
      throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 502 ', 502);
    };
    await expect(runBackfill(ctx, s.channelId)).rejects.toMatchObject({ status: 502 });
    expect(await until()).toEqual(new Date('2026-10-14T12:00:00Z'));
  });
});

describe('createHistoryWorker', () => {
  it('a tick runs due imports and back-fills at the first tick, then only every 5 min', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const worker = createHistoryWorker(ctx);

    await worker.tick();
    const [done] = await ctx.db.select().from(historyImports).where(eq(historyImports.id, imp.id));
    expect(done).toMatchObject({ state: 'done', messagesImported: 1 });
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));

    ctx.clock.advance(1 * MIN);
    await worker.tick();
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));

    ctx.clock.advance(4 * MIN); // 5 min after the first back-fill
    await worker.tick();
    expect(await until()).toEqual(new Date('2026-10-14T12:35:00Z'));
  });

  it('resumes an automatic import left running by a previous process (Review Focus 5)', async () => {
    const at = (iso: string) => new Date(iso);
    const [left] = await ctx.db
      .insert(historyImports)
      .values({
        channelId: s.channelId, period: '3m', auto: true, state: 'running', startedAt: at('2026-10-14T12:50:00Z'),
        lastNewAt: at('2026-10-14T12:58:00Z'), nextRunAt: at('2026-10-14T12:59:00Z'), messagesImported: 40,
      })
      .returning();
    ctx.wa.historyRecords.push(rec({ id: 'tardia', at: '2026-10-10T12:00:00Z' })); // the phone kept sending

    await createHistoryWorker(ctx).tick();

    const [row] = await ctx.db.select().from(historyImports).where(eq(historyImports.id, left!.id));
    expect(row).toMatchObject({ state: 'running', messagesImported: 41, lastNewAt: at('2026-10-14T13:00:00Z'), nextRunAt: at('2026-10-14T13:02:00Z') });
  });

  it('start runs a beat at once (back-fill at boot) and stop waits for it', async () => {
    const worker = createHistoryWorker(ctx);
    worker.start();
    worker.start(); // idempotent
    await worker.stop();
    expect(await until()).toEqual(new Date('2026-10-14T12:30:00Z'));
  });
});
