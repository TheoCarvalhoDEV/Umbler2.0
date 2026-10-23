// Spec 2026-10-20 agendamentos §4: the two automatic rules, batched. The selection is a hint; the UPDATE in
// returnChatToQueue / closeChatForInactivity re-checks it, so running twice (or racing an agent) never repeats an effect.
import { and, asc, eq, gte, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import { NON_TERMINAL_RUN_STATES } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import { getAutoRules } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { botRuns, chatEvents, chats, scheduledMessages } from '../db/schema.js';
import { closeChatForInactivity, getClosingMessage, returnChatToQueue } from '../inbox/chats.js';
import { OPEN_STATUSES } from './scheduled.js';

const BATCH = 50;
/** Events that give the chat an owner: "Devolver à fila" counts from the newest of them (spec §4.1). */
const OWNER_EVENTS = ['created', 'assigned', 'transferred', 'bot_transferred'] as const;

const one = sql`1`;

function noRunningBot(ctx: AppCtx) {
  return notExists(
    ctx.db.select({ one }).from(botRuns).where(and(eq(botRuns.chatId, chats.id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES]))),
  );
}

async function returnStaleChats(ctx: AppCtx, minutes: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000);
  const rows = await ctx.db
    .select({ id: chats.id, ownerId: chats.ownerId })
    .from(chats)
    .where(
      and(
        eq(chats.state, 'open'),
        eq(chats.waiting, true),
        eq(chats.private, false),
        eq(chats.history, false),
        eq(chats.triagePending, false),
        isNotNull(chats.ownerId),
        // a chat that waited from before waiting_since existed counts from its last message (spec 2026-10-20 lista §3)
        sql`coalesce(${chats.waitingSince}, ${chats.lastMessageAt}, ${chats.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        // whoever took it last gets the whole N minutes
        notExists(
          ctx.db
            .select({ one })
            .from(chatEvents)
            .where(and(eq(chatEvents.chatId, chats.id), inArray(chatEvents.kind, [...OWNER_EVENTS]), gte(chatEvents.createdAt, cutoff))),
        ),
        noRunningBot(ctx),
      ),
    )
    .orderBy(asc(chats.id))
    .limit(BATCH);
  let returned = 0;
  for (const r of rows) {
    try {
      if (await returnChatToQueue(ctx, r.id, r.ownerId!, minutes)) returned += 1;
    } catch (err) {
      console.error('auto rule failed', { rule: 'return_to_queue', chatId: r.id, err: errorTag(err) });
    }
  }
  return returned;
}

async function closeInactiveChats(ctx: AppCtx, hours: number, sendClosingMessage: boolean, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const rows = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.state, 'open'),
        eq(chats.waiting, false),
        eq(chats.history, false),
        eq(chats.triagePending, false),
        sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        noRunningBot(ctx), // the chatbot has its own inactivity
        // a pending scheduled message keeps the chat open; an appointment's reminder does not (spec 2026-10-21 compromissos
        // §3.6, decision 10): it may be 30 days away, and its send opens a new chat in the original sector anyway
        notExists(
          ctx.db
            .select({ one })
            .from(scheduledMessages)
            .where(
              and(eq(scheduledMessages.chatId, chats.id), inArray(scheduledMessages.status, OPEN_STATUSES), isNull(scheduledMessages.reminderId)),
            ),
        ),
      ),
    )
    .orderBy(asc(chats.id))
    .limit(BATCH);
  const closingText = sendClosingMessage ? (await getClosingMessage(ctx.db)) || null : null;
  let closed = 0;
  for (const r of rows) {
    try {
      if (await closeChatForInactivity(ctx, r.id, { closingText, hours, now })) closed += 1;
    } catch (err) {
      console.error('auto rule failed', { rule: 'close_inactive', chatId: r.id, err: errorTag(err) });
    }
  }
  return closed;
}

/** One beat of both rules (each only when an admin turned it on). */
export async function runAutoRules(ctx: AppCtx, now: Date = ctx.botRuntime.now()): Promise<{ returned: number; closed: number }> {
  const rules = await getAutoRules(ctx.db);
  const returned = rules.returnToQueue.enabled ? await returnStaleChats(ctx, rules.returnToQueue.minutes, now) : 0;
  const closed = rules.closeInactive.enabled
    ? await closeInactiveChats(ctx, rules.closeInactive.hours, rules.closeInactive.sendClosingMessage, now)
    : 0;
  if (returned || closed) console.info('auto rules', { returned, closed });
  return { returned, closed };
}
