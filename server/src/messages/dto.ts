import { desc, eq } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { botRuns, bots, messageEdits, messageFavorites, messages, users } from '../db/schema.js';
import { userAvatarUrl } from '../media/avatar-files.js';

type MessageRow = typeof messages.$inferSelect;

export const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);

const PREVIEW_LABEL: Record<MessageDto['kind'], string> = {
  text: '',
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎬 Vídeo',
  document: '📄 Documento',
  sticker: 'Figurinha',
  note: 'Nota',
  unsupported: 'Mensagem não suportada',
};

/**
 * The single source of `chats.last_message_preview` (ingest, agent send, triage system text):
 * the text (unsigned for agent sends), else a label for media without caption; max 100 chars.
 * Labels match the web's `previewText` (Task 17).
 */
export function messagePreview(kind: MessageDto['kind'], body: string | null): string {
  return (body || PREVIEW_LABEL[kind]).slice(0, 100);
}

export async function toMessageDto(db: Db | Tx, row: MessageRow): Promise<MessageDto> {
  const [author] = row.authorId
    ? await db.select({ id: users.id, name: users.name, avatarPath: users.avatarPath }).from(users).where(eq(users.id, row.authorId))
    : [];
  const [reply] = row.replyToId
    ? await db.select({ id: messages.id, body: messages.body, kind: messages.kind }).from(messages).where(eq(messages.id, row.replyToId))
    : [];
  const [bot] = row.botRunId
    ? await db.select({ name: bots.name }).from(botRuns).innerJoin(bots, eq(bots.id, botRuns.botId)).where(eq(botRuns.id, row.botRunId))
    : [];
  // Only deleted/edited rows pay for these lookups.
  const [deleter] = row.deletedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.deletedBy)) : [];
  const [lastEdit] = row.editedAt
    ? await db
        .select({ source: messageEdits.source, newTextUnavailable: messageEdits.newTextUnavailable })
        .from(messageEdits)
        .where(eq(messageEdits.messageId, row.id))
        .orderBy(desc(messageEdits.editedAt))
        .limit(1)
    : [];
  // ponytail: one primary-key lookup per message; join it into the timeline query if a page of 100 ever gets slow.
  const [favorite] = await db
    .select({ at: messageFavorites.createdAt, byName: users.name })
    .from(messageFavorites)
    .leftJoin(users, eq(users.id, messageFavorites.userId))
    .where(eq(messageFavorites.messageId, row.id));

  return {
    id: row.id,
    chatId: row.chatId,
    direction: row.direction,
    kind: row.kind,
    body: row.body,
    media: row.mediaPath
      ? { url: `/api/media/${row.id}`, mime: row.mediaMime ?? 'application/octet-stream', name: row.mediaName, size: row.mediaSize }
      : null,
    // A media message without a stored file (§5.1 step 6). Ingest also sets error 'mídia indisponível'
    // when the download fails; while a download is still running this is briefly true and the
    // message.updated that follows the download carries the file.
    mediaUnavailable: row.mediaPath == null && MEDIA_KINDS.has(row.kind),
    // §5.5: WhatsApp no longer has the file (history older than 3 weeks, or a 400 on download); never retried
    mediaExpired: row.mediaStatus === 'expired',
    authorId: row.authorId,
    authorName: author?.name ?? null,
    authorAvatarUrl: author ? userAvatarUrl(author) : null,
    replyTo: reply ?? null,
    reaction: row.reaction,
    status: row.status,
    error: row.error,
    sentAt: row.sentAt.toISOString(),
    botRunId: row.botRunId,
    botName: bot?.name ?? null,
    officeReaction: row.officeReaction,
    deleted: row.deletedAt
      ? { at: row.deletedAt.toISOString(), source: row.deletedSource ?? 'office', byName: deleter?.name ?? null }
      : null,
    edited: row.editedAt
      ? {
          at: row.editedAt.toISOString(),
          source: lastEdit?.source ?? 'office',
          newTextUnavailable: lastEdit?.newTextUnavailable ?? false,
        }
      : null,
    forwarded: row.forwardedFromId !== null,
    favorite: favorite ? { at: favorite.at.toISOString(), byName: favorite.byName ?? null } : null,
  };
}
