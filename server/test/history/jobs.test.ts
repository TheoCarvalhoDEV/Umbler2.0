import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, historyImports, messages } from '../../src/db/schema.js';
import { listChannels, setChannelQr, setChannelStatus } from '../../src/channels/service.js';
import { IMPORT_RUNNING, startHistoryImport } from '../../src/history/imports.js';
import { periodStart, runBackfill, runImportPass } from '../../src/history/jobs.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { statusOf } from '../inbox/fixtures.js';
import { rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;
const MIN = 60_000;
const T0 = new Date('2026-10-14T13:00:00Z'); // the fake clock's start
const after = (ms: number) => new Date(T0.getTime() + ms);

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const imports = () => ctx.db.select().from(historyImports);
const channelPublishes = () => ctx.hub.events.filter((e) => e.type === 'channel' && e.channelId === s.channelId).length;

describe('periodStart', () => {
  it('goes back 3 or 12 calendar months; "Tudo" starts in 2009', () => {
    expect(periodStart('3m', T0)).toEqual(new Date('2026-07-14T13:00:00Z'));
    expect(periodStart('12m', T0)).toEqual(new Date('2025-10-14T13:00:00Z'));
    expect(periodStart('all', T0)).toEqual(new Date('2009-01-01T00:00:00Z'));
  });
});

describe('startHistoryImport', () => {
  it('creates a running import due now and publishes the channel', async () => {
    const imp = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    expect(imp).toMatchObject({ channelId: s.channelId, period: '12m', auto: false, state: 'running', startedAt: T0, nextRunAt: T0, messagesImported: 0 });
    expect(channelPublishes()).toBe(1);
  });

  it(`answers 409 "${IMPORT_RUNNING}" while one runs`, async () => {
    await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const err = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, message: IMPORT_RUNNING });
  });
});

describe('runImportPass', () => {
  it('stops 30 min before now: a 5-min-old row is left to the webhook, and the back-fill copies it later', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'velha', at: '2026-10-10T12:00:00Z' }), rec({ id: 'viva', at: '2026-10-14T12:55:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });

    await runImportPass(ctx, imp.id);
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId)).toEqual(['velha']);

    await ctx.db.update(channels).set({ backfillUntil: new Date('2026-10-14T12:00:00Z') }).where(eq(channels.id, s.channelId));
    ctx.clock.set(new Date('2026-10-14T13:40:00Z'));
    await runBackfill(ctx, s.channelId);
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId).sort()).toEqual(['velha', 'viva']);
  });

  it('a manual import copies its period once and ends done with the counts and the oldest date', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }), rec({ id: 'b', at: '2026-08-20T09:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });

    const row = await runImportPass(ctx, imp.id);

    expect(row).toMatchObject({
      state: 'done', finishedAt: T0, nextRunAt: null, messagesImported: 2, contactsCreated: 1,
      oldestMessageAt: new Date('2026-08-20T09:00:00Z'), error: null,
    });
    expect(await runImportPass(ctx, imp.id)).toBeNull(); // a finished import never runs again
  });

  it('only copies the chosen period', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'antiga', at: '2026-06-01T12:00:00Z' }), rec({ id: 'recente', at: '2026-09-01T12:00:00Z' }));
    const three = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    expect((await runImportPass(ctx, three.id))?.messagesImported).toBe(1);
    const twelve = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    expect((await runImportPass(ctx, twelve.id))?.messagesImported).toBe(1); // only the one the first pass left out
    expect(await ctx.db.$count(messages)).toBe(2);
  });

  it('publishes the progress after each page that brought something', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }), rec({ id: 'b', at: '2026-09-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    const before = channelPublishes();
    await runImportPass(ctx, imp.id);
    expect(channelPublishes() - before).toBe(3); // October page, September page, the final state
  });

  it('an automatic import repeats every 2 min while news arrive and ends after 10 min without any (§5.1)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a1', at: '2026-10-01T10:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });

    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', messagesImported: 1, lastNewAt: T0, nextRunAt: after(2 * MIN) });

    ctx.clock.advance(2 * MIN);
    ctx.wa.historyRecords.push(rec({ id: 'a2', at: '2026-10-02T10:00:00Z' })); // the phone is still sending
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', messagesImported: 2, lastNewAt: after(2 * MIN), nextRunAt: after(4 * MIN) });

    ctx.clock.advance(8 * MIN); // 8 min without news
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'running', nextRunAt: after(12 * MIN) });

    ctx.clock.advance(2 * MIN); // 10 min without news
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'done', finishedAt: after(12 * MIN), nextRunAt: null, messagesImported: 2 });
  });

  it('an automatic import ends after 60 min even while news keep coming', async () => {
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });
    await ctx.db.update(historyImports).set({ startedAt: new Date(T0.getTime() - 61 * MIN) }).where(eq(historyImports.id, imp.id));
    ctx.wa.historyRecords.push(rec({ id: 'n1', at: '2026-10-01T10:00:00Z' }));
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'done', messagesImported: 1 });
  });

  it('an Evolution failure ends it failed with only the error name and status, keeping what came in; it can run again (§9)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'f1', at: '2026-10-10T10:00:00Z' }), rec({ id: 'f2', at: '2026-09-10T10:00:00Z' }));
    const real = ctx.wa.findMessages;
    let n = 0;
    ctx.wa.findMessages = async (instance, q) => {
      n += 1;
      if (n === 2) throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 500 {"message":"Maria Souza"}', 500);
      return real(instance, q);
    };
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: true });

    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'failed', error: 'GatewayError 500', messagesImported: 1, nextRunAt: null });
    expect(logged.mock.calls.flat().join(' ')).not.toContain('Maria');
    await expect(startHistoryImport(ctx, s.channelId, { period: '3m', auto: false })).resolves.toMatchObject({ state: 'running' });
  });
});

describe('automatic import on a new QR pairing (§5.1)', () => {
  beforeEach(async () => {
    await ctx.db.update(channels).set({ status: 'connecting', historyPeriod: '12m' }).where(eq(channels.id, s.channelId));
  });

  it('connected after a QR was shown starts an automatic import with the channel period', async () => {
    setChannelQr(ctx, s.instance, 'data:image/png;base64,QR');
    await setChannelStatus(ctx, s.instance, 'connected', '5565988887777');
    expect(await imports()).toMatchObject([{ channelId: s.channelId, period: '12m', auto: true, state: 'running' }]);
  });

  it('a session Evolution resumes by itself (no QR) imports nothing', async () => {
    await setChannelStatus(ctx, s.instance, 'connected');
    expect(await imports()).toEqual([]);
  });

  it('while an import runs, a new pairing does not start a second one', async () => {
    await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    setChannelQr(ctx, s.instance, 'data:image/png;base64,QR');
    expect(await statusOf(setChannelStatus(ctx, s.instance, 'connected'))).toBe(200);
    expect(await imports()).toHaveLength(1);
  });
});

describe('channel DTO', () => {
  it('lists the period, the disconnection time and the newest import of each channel', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'a', at: '2026-10-10T12:00:00Z' }));
    const imp = await startHistoryImport(ctx, s.channelId, { period: '12m', auto: false });
    await runImportPass(ctx, imp.id);

    expect(await listChannels(ctx.db)).toEqual([
      {
        id: s.channelId, name: 'WhatsApp teste', status: 'connected', phone: null, historyPeriod: '3m', disconnectedAt: null,
        historyImport: {
          id: imp.id, period: '12m', state: 'done', startedAt: T0.toISOString(), finishedAt: T0.toISOString(),
          messagesImported: 1, contactsCreated: 1, oldestMessageAt: '2026-10-10T12:00:00.000Z', error: null,
        },
      },
    ]);
  });

  it('disconnectedAt is set when the channel drops, kept while it stays down, cleared when it connects (§7)', async () => {
    await setChannelStatus(ctx, s.instance, 'disconnected');
    const first = (await listChannels(ctx.db))[0]!.disconnectedAt;
    expect(first).toEqual(expect.any(String));
    await setChannelStatus(ctx, s.instance, 'disconnected', '5565911112222'); // only the phone changes
    expect((await listChannels(ctx.db))[0]!.disconnectedAt).toBe(first);
    await setChannelStatus(ctx, s.instance, 'connected');
    expect((await listChannels(ctx.db))[0]!.disconnectedAt).toBeNull();
  });
});

describe('error masking (ruling)', () => {
  it('records the Evolution error even when writing the history events fails afterwards', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'm1', at: '2026-10-10T10:00:00Z' }), rec({ id: 'm2', at: '2026-09-10T10:00:00Z' }));
    const real = ctx.wa.findMessages;
    let n = 0;
    ctx.wa.findMessages = async (instance, q) => {
      n += 1;
      if (n === 2) {
        vi.spyOn(ctx.db, 'transaction').mockRejectedValue(new Error('events down'));
        throw new GatewayError('Evolution failed', 502);
      }
      return real(instance, q);
    };
    const imp = await startHistoryImport(ctx, s.channelId, { period: '3m', auto: false });
    expect(await runImportPass(ctx, imp.id)).toMatchObject({ state: 'failed', error: 'GatewayError 502' });
  });
});
