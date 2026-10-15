import { inArray } from 'drizzle-orm';
import type { BotAction } from '@talk/shared';
import { getBotRunningBehavior } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { bots } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { botRunningError } from '../lib/http-error.js';
import { resumeOnReply, runningRunsForChat, startRun, stopRunsForChat } from './engine.js';
import type { InboundReply } from './registry.js';
import { findChannelBot } from './repo.js';

const errName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Spec §5.1 "Por canal": a chat just opened by an inbound message starts the oldest active published bot of
 * its channel. true = a bot took the chat, so the caller skips the triage. Never throws: a failed start
 * falls back to the triage, and the log gets ids and the error name only.
 */
export async function startChannelBot(ctx: AppCtx, chat: ChatRow): Promise<boolean> {
  const bot = await findChannelBot(ctx.db, chat.channelId);
  if (!bot) return false;
  try {
    await startRun(ctx, { botId: bot.id, chatId: chat.id, entry: 'channel', startedBy: null });
    return true;
  } catch (err) {
    console.error('channel bot start failed', { botId: bot.id, chatId: chat.id, err: errName(err) });
    return false;
  }
}

/** Spec §5.4: called by ingest after the reply is committed. Never throws, so one bad run cannot drop the rest of a webhook batch. */
export async function resumeBotsOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number> {
  try {
    return await resumeOnReply(ctx, chatId, reply);
  } catch (err) {
    console.error('bot resume failed', { chatId, messageId: reply.messageId, err: errName(err) });
    return 0;
  }
}

/**
 * Spec §5.5: what an agent action (send, manual transfer) does to the chat's running bots.
 * The caller has already checked that the user can see the chat (404 first, so a 409 never leaks bot names).
 */
export async function applyBotRunningBehavior(
  ctx: AppCtx,
  user: AuthUser,
  chatId: string,
  botAction: BotAction | undefined,
  reason: 'agent_message' | 'transfer',
): Promise<void> {
  const runs = await runningRunsForChat(ctx.db, chatId);
  if (runs.length === 0) return;
  const effective = botAction ?? (await getBotRunningBehavior(ctx.db));
  if (effective === 'keep') return;
  if (effective === 'stop') {
    await stopRunsForChat(ctx, chatId, { userId: user.id, reason });
    return;
  }
  const names = await ctx.db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...new Set(runs.map((r) => r.botId))]));
  const nameOf = new Map(names.map((b) => [b.id, b.name]));
  throw botRunningError(runs.map((r) => ({ id: r.id, botName: nameOf.get(r.botId) ?? 'Chatbot' })));
}
