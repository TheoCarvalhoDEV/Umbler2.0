import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import { copyRange, monthlyWindows } from '../../src/history/copy.js';
import { GatewayError } from '../../src/whatsapp/types.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { LID, LID_JID, rec } from './records.js';

type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

let ctx: Ctx;
let s: Awaited<ReturnType<typeof seedBasics>>;
let channel: { id: string; evolutionInstance: string };
let logged: ReturnType<typeof vi.spyOn>;

const FROM = new Date('2026-08-01T00:00:00Z');
const TO = new Date('2026-10-14T13:00:00Z');

beforeEach(async () => {
  ctx = await makeTestCtx();
  s = await seedBasics(ctx);
  channel = { id: s.channelId, evolutionInstance: s.instance };
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('monthlyWindows', () => {
  it('splits by UTC calendar month, newest first, with inclusive whole-second bounds', () => {
    expect(monthlyWindows(new Date('2026-07-16T12:00:00Z'), new Date('2026-10-14T13:00:00Z'))).toEqual([
      { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-14T13:00:00Z') },
      { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-30T23:59:59Z') },
      { gte: new Date('2026-08-01T00:00:00Z'), lte: new Date('2026-08-31T23:59:59Z') },
      { gte: new Date('2026-07-16T12:00:00Z'), lte: new Date('2026-07-31T23:59:59Z') },
    ]);
    expect(monthlyWindows(new Date('2026-10-14T13:00:00Z'), new Date('2026-10-14T12:00:00Z'))).toEqual([]);
  });
});

describe('copyRange', () => {
  it('reads every page of every window, copies each message once and writes one event per history chat', async () => {
    const start = Date.parse('2026-10-02T00:00:00Z');
    for (let i = 0; i < 501; i += 1) ctx.wa.historyRecords.push(rec({ id: `o${i}`, at: new Date(start + i * 60_000).toISOString() }));
    // Evolution stored this one twice (two history chunks overlap)
    ctx.wa.historyRecords.push(rec({ id: 's1', at: '2026-09-10T08:00:00Z' }), rec({ id: 's1', at: '2026-09-10T08:00:00Z' }));

    const totals = await copyRange(ctx, channel, FROM, TO);

    expect(totals).toEqual({ inserted: 502, contactsCreated: 1, oldest: new Date('2026-09-10T08:00:00Z') });
    expect(ctx.wa.findCalls.map((c) => [c.gte.slice(0, 7), c.page, c.offset])).toEqual([
      ['2026-10', 1, 500],
      ['2026-10', 2, 500],
      ['2026-09', 1, 500],
      ['2026-08', 1, 500],
    ]);
    expect(await ctx.db.$count(messages)).toBe(502);
    const [chat] = await ctx.db.select().from(chats);
    const events = await ctx.db.select().from(chatEvents).where(eq(chatEvents.chatId, chat!.id));
    expect(events.map((e) => [e.kind, e.data])).toEqual([['history_imported', { count: 502 }]]);
  });

  it('only reads inside [from, to]', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'antes', at: '2026-07-31T23:59:59Z' }), rec({ id: 'dentro', at: '2026-08-01T00:00:00Z' }));
    expect((await copyRange(ctx, channel, FROM, TO)).inserted).toBe(1);
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId)).toEqual(['dentro']);
  });

  it("names contacts from Evolution's Contact table, ignoring digits-only names", async () => {
    ctx.wa.contactRecords.push(
      { remoteJid: LID_JID, pushName: 'Maria Souza' },
      { remoteJid: '556588887777@s.whatsapp.net', pushName: '556588887777' },
    );
    ctx.wa.historyRecords.push(
      rec({ id: 'l1', at: '2026-10-01T10:00:00Z', jid: LID_JID }),
      rec({ id: 'p1', at: '2026-10-01T11:00:00Z', jid: '556588887777@s.whatsapp.net' }),
    );
    await copyRange(ctx, channel, FROM, TO);
    const rows = await ctx.db.select({ phone: contacts.phone, lid: contacts.lid, name: contacts.name }).from(contacts);
    expect(rows).toEqual(
      expect.arrayContaining([
        { phone: null, lid: LID, name: 'Maria Souza' },
        { phone: '5565988887777', lid: null, name: null },
      ]),
    );
  });

  it('copies without names when findContacts fails, logging only the error name', async () => {
    ctx.wa.findContacts = async () => {
      throw new Error('Evolution POST /chat/findContacts/talk-test failed: 500 Maria Souza');
    };
    ctx.wa.historyRecords.push(rec({ id: 'p1', at: '2026-10-01T10:00:00Z' }));
    expect((await copyRange(ctx, channel, FROM, TO)).inserted).toBe(1);
    expect(logged).toHaveBeenCalledWith('history: findContacts failed', 'Error');
  });

  it('stops at the first Evolution failure and keeps what was already copied (§9)', async () => {
    ctx.wa.historyRecords.push(rec({ id: 'out1', at: '2026-10-05T10:00:00Z' }), rec({ id: 'set1', at: '2026-09-05T10:00:00Z' }));
    const real = ctx.wa.findMessages;
    let n = 0;
    ctx.wa.findMessages = async (instance, q) => {
      n += 1;
      if (n === 2) throw new GatewayError('Evolution POST /chat/findMessages/talk-test failed: 500 ', 500);
      return real(instance, q);
    };

    await expect(copyRange(ctx, channel, FROM, TO)).rejects.toMatchObject({ name: 'GatewayError', status: 500 });
    expect((await ctx.db.select().from(messages)).map((m) => m.externalId)).toEqual(['out1']);
    // the event for what did come in is still written
    expect((await ctx.db.select().from(chatEvents)).map((e) => e.data)).toEqual([{ count: 1 }]);
  });
});
