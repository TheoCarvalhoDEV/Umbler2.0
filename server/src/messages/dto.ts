import { eq } from 'drizzle-orm';
import type { MessageDto } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { messages, users } from '../db/schema.js';

type MessageRow = typeof messages.$inferSelect;

const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'document', 'sticker']);

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
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, row.authorId))
    : [];
  const [reply] = row.replyToId
    ? await db.select({ id: messages.id, body: messages.body, kind: messages.kind }).from(messages).where(eq(messages.id, row.replyToId))
    : [];

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
    authorId: row.authorId,
    authorName: author?.name ?? null,
    replyTo: reply ?? null,
    reaction: row.reaction,
    status: row.status,
    error: row.error,
    sentAt: row.sentAt.toISOString(),
  };
}
