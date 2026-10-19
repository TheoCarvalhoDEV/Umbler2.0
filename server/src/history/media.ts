import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, messages } from '../db/schema.js';
import { getChatForUser } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest, notFound } from '../lib/http-error.js';
import { MEDIA_KINDS, toMessageDto } from '../messages/dto.js';
import { MEDIA_UNAVAILABLE } from '../messages/ingest.js';
import { saveMedia } from '../messages/media.js';
import { GatewayError } from '../whatsapp/types.js';
import { MEDIA_MAX_AGE_MS } from './place.js';

export type MediaOutcome = 'saved' | 'expired' | 'failed' | 'skipped';

/**
 * §5.5: one download by key.id (Evolution looks the message up in its own DB), saved like live media. A 400 means
 * WhatsApp no longer has the file: expired, never retried. Anything else may be retried with "Baixar".
 * 'skipped' = nothing to do (already has a file, already expired, or no WhatsApp id).
 */
export async function downloadMessageMedia(ctx: AppCtx, messageId: string): Promise<MediaOutcome> {
  const [found] = await ctx.db
    .select({ msg: messages, instance: channels.evolutionInstance })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, messageId));
  if (!found || found.msg.mediaPath || found.msg.mediaStatus === 'expired' || !found.msg.externalId) return 'skipped';
  const { msg, instance } = found;
  const stillMissing = and(eq(messages.id, msg.id), isNull(messages.mediaPath)); // a double click or the queue got there first

  let outcome: MediaOutcome;
  try {
    const media = await ctx.wa.downloadMediaById(instance, msg.externalId!);
    const name = msg.mediaName ?? media.fileName ?? null;
    const saved = await saveMedia(ctx.config.mediaDir, Buffer.from(media.base64, 'base64'), media.mime, name);
    const [done] = await ctx.db
      .update(messages)
      .set({
        mediaPath: saved.path, mediaSize: saved.size, mediaMime: media.mime, mediaName: name, mediaSha256: saved.sha256,
        mediaStatus: null, error: null,
      })
      .where(stillMissing)
      .returning({ id: messages.id });
    if (!done) {
      await rm(join(ctx.config.mediaDir, saved.path), { force: true }); // the other download won: no orphan file
      return 'skipped';
    }
    outcome = 'saved';
  } catch (err) {
    const expired = err instanceof GatewayError && err.status === 400;
    if (!expired) console.error('history: media download failed', { messageId: msg.id, err: errorTag(err) });
    await ctx.db
      .update(messages)
      .set(expired ? { mediaStatus: 'expired', error: null } : { mediaStatus: null, error: MEDIA_UNAVAILABLE })
      .where(stillMissing);
    outcome = expired ? 'expired' : 'failed';
  }
  await ctx.hub.publishMessage(msg.chatId, 'message.updated', msg.id);
  return outcome;
}

/**
 * §5.5 queue: downloads queued history media one at a time, newest first, for connected channels only, until the
 * queue is empty or `signal` aborts. Returns how many it tried.
 */
export async function drainMediaQueue(ctx: AppCtx, signal?: AbortSignal): Promise<number> {
  let tried = 0;
  while (!signal?.aborted) {
    // Queued so long ago that WhatsApp dropped the file meanwhile (e.g. the app was down for weeks): no call needed.
    const cutoff = new Date(ctx.botRuntime.now().getTime() - MEDIA_MAX_AGE_MS);
    await ctx.db
      .update(messages)
      .set({ mediaStatus: 'expired' })
      .where(and(eq(messages.mediaStatus, 'queued'), lt(messages.sentAt, cutoff)));
    const [next] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(eq(messages.mediaStatus, 'queued'), eq(channels.status, 'connected')))
      .orderBy(desc(messages.sentAt))
      .limit(1);
    if (!next) break;
    if ((await downloadMessageMedia(ctx, next.id)) === 'skipped') {
      await ctx.db.update(messages).set({ mediaStatus: null }).where(eq(messages.id, next.id)); // not downloadable: leave the queue
    }
    tried += 1;
  }
  return tried;
}

/** "Baixar" (§5.5): one try for a media message the user can see; 502 on a temporary failure. */
export async function downloadMediaForUser(ctx: AppCtx, user: AuthUser, messageId: string): Promise<MessageDto> {
  const [msg] = await ctx.db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw notFound();
  await getChatForUser(ctx, user, msg.chatId); // 404 when the user cannot see the chat
  if (!MEDIA_KINDS.has(msg.kind)) throw badRequest('Esta mensagem não tem arquivo.');
  if (!msg.mediaPath && msg.mediaStatus !== 'expired') {
    if ((await downloadMessageMedia(ctx, msg.id)) === 'failed') throw new HttpError(502, 'Não foi possível baixar o arquivo. Tente de novo.');
  }
  const [fresh] = await ctx.db.select().from(messages).where(eq(messages.id, msg.id));
  return toMessageDto(ctx.db, fresh!);
}
