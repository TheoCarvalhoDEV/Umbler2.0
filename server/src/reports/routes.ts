import { and, asc, count, countDistinct, eq, gte, inArray, isNotNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPORT_MAX_DAYS, isoToOfficeLocal, officeDayRange, shiftOfficeDate, type ReportDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { botRuns, chatEvents, chats, messages, sectors, users } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http-error.js';

const Query = z.object({ from: z.iso.date(), to: z.iso.date() });
const DAY = 86_400_000;
// ponytail: a first reply or a client message more than 2 days outside the period is not measured; widen if it shows.
const LOOK_AROUND = 2 * DAY;

/** Office date, weekday (0 = Monday) and hour of an instant, memoized per UTC hour (the office offset is whole hours). */
const walls = new Map<number, { day: string; weekday: number; hour: number }>();
function wall(d: Date) {
  const key = Math.floor(d.getTime() / 3_600_000);
  let w = walls.get(key);
  if (!w) {
    const local = isoToOfficeLocal(new Date(key * 3_600_000).toISOString());
    const day = local.slice(0, 10);
    w = { day, weekday: (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7, hour: Number(local.slice(11, 13)) };
    walls.set(key, w);
  }
  return w;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return Math.round(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
}

const seconds = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000;

/** ReportDto for office dates from..to (both included). The rules are on ReportDto. */
export async function buildReport(db: Db, from: string, to: string): Promise<ReportDto> {
  const start = officeDayRange(from).from;
  const end = officeDayRange(to).to;
  const inPeriod = (d: Date) => d >= start && d < end;
  const real = eq(chats.history, false);

  const created = await db
    .select({ id: chats.id, sectorId: chats.sectorId, at: chats.createdAt })
    .from(chats)
    .where(and(real, gte(chats.createdAt, start), lt(chats.createdAt, end)));
  const closed = await db
    .select({ sectorId: chats.sectorId, at: chats.closedAt })
    .from(chats)
    .where(and(real, eq(chats.state, 'closed'), gte(chats.closedAt, start), lt(chats.closedAt, end)));
  const [live] = await db
    .select({ open: count(), waiting: sql<number>`count(*) filter (where ${chats.waiting})`.mapWith(Number) })
    .from(chats)
    .where(eq(chats.state, 'open'));
  const [bots] = await db
    .select({ n: countDistinct(botRuns.chatId) })
    .from(botRuns)
    .where(and(gte(botRuns.createdAt, start), lt(botRuns.createdAt, end)));
  const closers = await db
    .select({ authorId: chatEvents.authorId, n: count() })
    .from(chatEvents)
    .where(and(eq(chatEvents.kind, 'closed'), isNotNull(chatEvents.authorId), gte(chatEvents.createdAt, start), lt(chatEvents.createdAt, end)))
    .groupBy(chatEvents.authorId);
  const rows = await db
    .select({ chatId: messages.chatId, at: messages.sentAt, dir: messages.direction, authorId: messages.authorId })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        real,
        ne(messages.kind, 'note'),
        gte(messages.sentAt, new Date(start.getTime() - LOOK_AROUND)),
        lt(messages.sentAt, new Date(end.getTime() + LOOK_AROUND)),
      ),
    )
    .orderBy(asc(messages.chatId), asc(messages.sentAt), asc(messages.createdAt));

  const byChat = new Map<string, typeof rows>();
  for (const m of rows) {
    const list = byChat.get(m.chatId);
    if (list) list.push(m);
    else byChat.set(m.chatId, [m]);
  }
  const createdIn = new Map(created.map((c) => [c.id, c.sectorId]));
  const firsts: Array<{ sectorId: string; authorId: string; sec: number }> = [];
  const waits: number[] = [];
  const peak = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const work = new Map<string, { chats: Set<string>; messages: number }>();
  for (const [chatId, list] of byChat) {
    const sectorId = createdIn.get(chatId);
    const first = list[0]!;
    let firstDone = sectorId === undefined || first.dir !== 'in'; // only chats the client started in the period
    let turn: Date | null = null; // the client's oldest message since the office last wrote
    for (const m of list) {
      if (m.dir === 'in') {
        turn ??= m.at;
        if (inPeriod(m.at)) {
          const w = wall(m.at);
          const row = peak[w.weekday]!;
          row[w.hour] = (row[w.hour] ?? 0) + 1;
        }
        continue;
      }
      if (m.authorId) {
        if (!firstDone) firsts.push({ sectorId: sectorId!, authorId: m.authorId, sec: seconds(first.at, m.at) });
        firstDone = true;
        if (inPeriod(m.at)) {
          if (turn) waits.push(seconds(turn, m.at));
          const w = work.get(m.authorId) ?? { chats: new Set<string>(), messages: 0 };
          w.chats.add(chatId);
          w.messages += 1;
          work.set(m.authorId, w);
        }
      }
      turn = null; // the chatbot, triage or the office phone also answered
    }
  }

  const days: ReportDto['days'] = [];
  for (let d = from; d <= to; d = shiftOfficeDate(d, 1)) days.push({ day: d, newChats: 0, closedChats: 0 });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const c of created) byDay.get(wall(c.at).day)!.newChats += 1;
  for (const c of closed) byDay.get(wall(c.at!).day)!.closedChats += 1;

  const sectorRows = await db.select({ id: sectors.id, name: sectors.name }).from(sectors).orderBy(asc(sectors.position), asc(sectors.name));
  const closedBy = new Map(closers.map((c) => [c.authorId!, c.n]));
  const ids = [...new Set([...work.keys(), ...closedBy.keys(), ...firsts.map((f) => f.authorId)])];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];

  return {
    from,
    to,
    totals: {
      newChats: created.length,
      closedChats: closed.length,
      openNow: live?.open ?? 0,
      waitingNow: live?.waiting ?? 0,
      firstResponseSec: median(firsts.map((f) => f.sec)),
      within15Pct: firsts.length ? Math.round((100 * firsts.filter((f) => f.sec <= 900).length) / firsts.length) : null,
      replySec: median(waits),
      botChats: bots?.n ?? 0,
    },
    days,
    sectors: sectorRows.map((s) => ({
      ...s,
      newChats: created.filter((c) => c.sectorId === s.id).length,
      closedChats: closed.filter((c) => c.sectorId === s.id).length,
      firstResponseSec: median(firsts.filter((f) => f.sectorId === s.id).map((f) => f.sec)),
    })),
    agents: people
      .map((u) => ({
        ...u,
        chats: work.get(u.id)?.chats.size ?? 0,
        closedChats: closedBy.get(u.id) ?? 0,
        messages: work.get(u.id)?.messages ?? 0,
        firstResponseSec: median(firsts.filter((f) => f.authorId === u.id).map((f) => f.sec)),
      }))
      .sort((a, b) => b.chats - a.chats || b.closedChats - a.closedChats || a.name.localeCompare(b.name, 'pt-BR')),
    peak,
  };
}

export function registerReportRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/reports', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const { from, to } = Query.parse(req.query);
    if (from > to || (Date.parse(to) - Date.parse(from)) / DAY + 1 > REPORT_MAX_DAYS) throw badRequest('Período inválido');
    return buildReport(ctx.db, from, to);
  });
}
