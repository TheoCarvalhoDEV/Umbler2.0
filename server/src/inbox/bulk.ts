// Spec 2026-10-20 §4: bulk transfer, close and mark-read. Each chat goes through the very service the single action
// uses (canSee, open/closed, stale check, closing message, chatbots), one chat at a time, and gets its own result.
import type { BulkResultDto } from '@talk/shared';
import { stopRunsForChat } from '../bots/engine.js';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import { getBotRunningBehavior } from '../catalog/settings.js';
import type { AppCtx } from '../ctx.js';
import { HttpError } from '../lib/http-error.js';
import { sendAgentMessage } from '../messages/send.js';
import { closeChat, getChatForUser, markChatRead, transferChat, validateTransferTarget, type ChatRow } from './chats.js';
import type { AuthUser } from './visibility.js';

/** "Finalizar", single or bulk: the closing message goes out first, then every chatbot run in the chat stops. */
export async function closeChatAndStopBots(ctx: AppCtx, user: AuthUser, chatId: string, sendClosingMessage: boolean): Promise<ChatRow> {
  const closed = await closeChat(ctx, user, chatId, {
    sendClosingMessage,
    // Closing text is the office's canned message, so it goes without the agent signature.
    // botAction 'keep': closing never asks, the runs are stopped right below.
    sendClosing: async (text: string) =>
      (await sendAgentMessage(ctx, user, chatId, { text, signature: false, botAction: 'keep' })).status !== 'failed',
  });
  // Spec §5.5: closing the chat stops every bot run in it.
  await stopRunsForChat(ctx, chatId, { userId: user.id, reason: 'chat_closed' });
  return closed;
}

/** The single action's pt-BR message, short: no final period; a 404 says which thing was not found. */
function reasonOf(err: unknown): string {
  if (!(err instanceof HttpError)) return 'Erro inesperado';
  return err.status === 404 ? 'Conversa não encontrada' : err.message.replace(/\.$/, '');
}

/** Runs `one` for each distinct chat, in order, one at a time. A refusal is that chat's result; the rest go on. */
async function eachChat(chatIds: string[], one: (chatId: string) => Promise<unknown>): Promise<BulkResultDto> {
  const result: BulkResultDto = { done: [], failed: [] };
  for (const chatId of new Set(chatIds)) {
    try {
      await one(chatId);
      result.done.push(chatId);
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error('bulk chat action failed', { chatId, err: err instanceof Error ? err.name : 'unknown' });
      }
      result.failed.push({ chatId, error: reasonOf(err) });
    }
  }
  return result;
}

export async function bulkTransfer(
  ctx: AppCtx,
  user: AuthUser,
  chatIds: string[],
  to: { sectorId?: string; ownerId?: string | null },
): Promise<BulkResultDto> {
  await validateTransferTarget(ctx.db, to); // one 400 for the request, before any chatbot stops
  // There is no one to ask chat by chat: "keep" is honored, "ask" becomes "stop" (like closing does).
  const botAction = (await getBotRunningBehavior(ctx.db)) === 'keep' ? 'keep' : 'stop';
  return eachChat(chatIds, async (chatId) => {
    await getChatForUser(ctx, user, chatId); // 404 first, as in the single route
    await applyBotRunningBehavior(ctx, user, chatId, botAction, 'transfer');
    await transferChat(ctx, user, chatId, to);
  });
}

export async function bulkClose(ctx: AppCtx, user: AuthUser, chatIds: string[], sendClosingMessage: boolean): Promise<BulkResultDto> {
  return eachChat(chatIds, (chatId) => closeChatAndStopBots(ctx, user, chatId, sendClosingMessage));
}

export async function bulkRead(ctx: AppCtx, user: AuthUser, chatIds: string[]): Promise<BulkResultDto> {
  return eachChat(chatIds, (chatId) => markChatRead(ctx, user, chatId));
}
