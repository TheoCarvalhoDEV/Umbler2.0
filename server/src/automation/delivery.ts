// Spec 2026-10-20 agendamentos §3.3: the scheduled-message beat. pending → sending is claimed under FOR UPDATE SKIP LOCKED
// in one transaction; the outcome is written only while the row is still 'sending'. So a row goes out at most once, and
// a row left in 'sending' by a restart fails instead of going out again (WhatsApp may already have it).
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { chats, scheduledMessages } from '../db/schema.js';
import { startChat } from '../inbox/chats.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { HttpError } from '../lib/http-error.js';
import { sendAgentMessage } from '../messages/send.js';

const BATCH = 20;
/** Later than this past its time (the server was down), a row fails instead of going out. */
export const LATE_MS = 60 * 60_000;
/** A row 'sending' for longer was interrupted. */
export const STUCK_MS = 10 * 60_000;

export const FAIL = {
  late: 'Não enviada: o sistema estava fora do ar no horário agendado',
  authorInactive: 'Não enviada: o autor do agendamento está desativado',
  noAccess: 'Não enviada: o autor não tem mais acesso a esta conversa',
  refused: 'O WhatsApp não aceitou a mensagem; ela pode ser reenviada na conversa',
  stuck: 'Envio interrompido; confira a conversa antes de agendar de novo',
  unexpected: 'Erro inesperado',
} as const;

type Outcome = { status: 'sent'; messageId: string } | { status: 'failed'; error: string; messageId?: string | null };

function notifyFailure(ctx: AppCtx, row: { chatId: string; authorId: string }, error: string, now: Date): void {
  ctx.hub.notifyUser(row.authorId, {
    id: randomUUID(), chatId: row.chatId, title: 'Mensagem agendada não enviada', text: error, botName: '',
    kind: 'scheduled_failed', createdAt: now.toISOString(),
  });
}

/** Writes the outcome if the row is still 'sending', refreshes the original chat's screens and tells the author of a failure. */
async function finish(ctx: AppCtx, id: string, outcome: Outcome, now: Date): Promise<void> {
  const [row] = await ctx.db
    .update(scheduledMessages)
    .set({
      status: outcome.status,
      error: outcome.status === 'failed' ? outcome.error : null,
      messageId: outcome.messageId ?? null,
      finishedAt: now,
    })
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'sending')))
    .returning({ chatId: scheduledMessages.chatId, authorId: scheduledMessages.authorId });
  if (!row) return;
  await ctx.hub.publishChat(row.chatId);
  if (outcome.status === 'failed') notifyFailure(ctx, row, outcome.error, now);
}

async function deliverOne(ctx: AppCtx, id: string, now: Date): Promise<Outcome> {
  const [row] = await ctx.db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id));
  if (!row) return { status: 'failed', error: FAIL.unexpected }; // its chat was deleted meanwhile: finish() finds nothing
  if (now.getTime() - row.sendAt.getTime() > LATE_MS) return { status: 'failed', error: FAIL.late };
  const author = await loadAuthUser(ctx.db, row.authorId); // null when deactivated
  if (!author) return { status: 'failed', error: FAIL.authorInactive };
  const [origin] = await ctx.db.select().from(chats).where(eq(chats.id, row.chatId));
  if (!origin) return { status: 'failed', error: FAIL.unexpected };
  try {
    // "Nova conversa" (§5.3a): the contact's open chat on that number when the author sees it, else a new one in the
    // original sector owned by the author; an open chat the author cannot see is startChat's 409.
    const chat = await startChat(ctx, author, { contactId: origin.contactId, sectorId: origin.sectorId, channelId: origin.channelId });
    const message = await sendAgentMessage(ctx, author, chat.id, {
      text: row.body,
      signature: row.signature,
      botAction: 'keep', // spec §3.3: a running chatbot goes on
      scheduled: true,
      storedFile: row.mediaPath
        ? { path: row.mediaPath, mime: row.mediaMime ?? 'application/octet-stream', name: row.mediaName ?? 'arquivo', size: row.mediaSize ?? 0, sha256: row.mediaSha256 }
        : undefined,
    });
    return message.status === 'failed'
      ? { status: 'failed', error: FAIL.refused, messageId: message.id }
      : { status: 'sent', messageId: message.id };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: 'failed', error: err.status === 404 ? FAIL.noAccess : err.message.replace(/\.$/, '') };
  }
}

/** Rows left in 'sending' longer than STUCK_MS: failed, never sent again. */
export async function failStuckScheduled(ctx: AppCtx, now: Date): Promise<number> {
  const rows = await ctx.db
    .update(scheduledMessages)
    .set({ status: 'failed', error: FAIL.stuck, finishedAt: now })
    .where(and(eq(scheduledMessages.status, 'sending'), lt(scheduledMessages.claimedAt, new Date(now.getTime() - STUCK_MS))))
    .returning({ chatId: scheduledMessages.chatId, authorId: scheduledMessages.authorId });
  for (const row of rows) {
    await ctx.hub.publishChat(row.chatId);
    notifyFailure(ctx, row, FAIL.stuck, now);
  }
  return rows.length;
}

/** One beat: fail the stuck rows, then claim and send the due ones, one at a time. Returns how many went out. */
export async function deliverDueScheduled(ctx: AppCtx, now: Date = ctx.botRuntime.now()): Promise<number> {
  await failStuckScheduled(ctx, now);
  const ids = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.status, 'pending'), lte(scheduledMessages.sendAt, now)))
      .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.id))
      .limit(BATCH)
      .for('update', { skipLocked: true });
    const claimed = rows.map((r) => r.id);
    if (claimed.length) {
      await tx.update(scheduledMessages).set({ status: 'sending', claimedAt: now }).where(inArray(scheduledMessages.id, claimed));
    }
    return claimed;
  });

  let sent = 0;
  for (const id of ids) {
    let outcome: Outcome;
    try {
      outcome = await deliverOne(ctx, id, now);
    } catch (err) {
      // one broken row must not hold back the rest of the batch
      console.error('scheduled message failed', { id, err: errorTag(err) });
      outcome = { status: 'failed', error: FAIL.unexpected };
    }
    await finish(ctx, id, outcome, now);
    if (outcome.status === 'sent') sent += 1;
  }
  return sent;
}
