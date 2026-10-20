import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BULK_MAX, CHAT_SORTS, SEARCH_MAX_CHARS, SEARCH_MIN_CHARS } from '@talk/shared';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import type { AppCtx } from '../ctx.js';
import { downloadMediaForUser } from '../history/media.js';
import { bulkClose, bulkRead, bulkTransfer, closeChatAndStopBots } from '../inbox/bulk.js';
import {
  assumeChat, deleteChat, getChatForUser, markChatRead, markChatUnread, pinChat, reopenChat, setChatPrivacy,
  setChatTags, startChat, transferChat, type ChatRow,
} from '../inbox/chats.js';
import { getChatDetail, getTimeline, listChats, searchChat, toChatDetail } from '../inbox/queries.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest } from '../lib/http-error.js';
import {
  deleteMessageForEveryone, deleteNote, editMessage, forwardMessage, listFavorites, listMessageEdits, listRecentStickers,
  reactToMessage, setFavorite,
} from '../messages/actions.js';
import { addNote, resendMessage, sendAgentMessage, type SendInput } from '../messages/send.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  tab: z.enum(['inbox', 'waiting', 'closed']).default('inbox'),
  q: z.string().max(100).optional(),
  sectorId: z.uuid().optional(),
  ownerId: z.union([z.literal('none'), z.uuid()]).optional(),
  tagId: z.uuid().optional(),
  chatTagId: z.uuid().optional(),
  sort: z.enum(CHAT_SORTS).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
/** before = older than, after = newer than, around = centered on a message (spec 2026-10-19 §4); one at a time. */
const timelineQuery = z
  .object({
    before: z.uuid().optional(),
    after: z.uuid().optional(),
    around: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((q) => [q.before, q.after, q.around].filter(Boolean).length <= 1, 'Use um cursor só');
const searchQuery = z.object({ q: z.string().trim().min(SEARCH_MIN_CHARS).max(SEARCH_MAX_CHARS) });
const startBody = z
  .object({
    contactId: z.uuid().optional(),
    phone: z.string().trim().min(8).max(30).optional(),
    name: z.string().trim().max(120).optional(),
    sectorId: z.uuid().optional(),
  })
  .refine((b) => b.contactId !== undefined || b.phone !== undefined, 'Informe o contato ou o telefone');
/** Spec §5.5: the answer to a BOT_RUNNING 409, sent back with the retried request. */
const botActionField = z.enum(['stop', 'keep']).optional();
const transferBody = z
  .object({ sectorId: z.uuid().optional(), ownerId: z.uuid().nullable().optional(), botAction: botActionField })
  .refine((b) => b.sectorId !== undefined || b.ownerId !== undefined, 'Informe o setor ou o atendente');
const privacyBody = z.object({ private: z.boolean() });
const closeBody = z.object({ sendClosingMessage: z.boolean().default(false) });
/** Spec 2026-10-20 §4: 1 to BULK_MAX chats per request; the same destination and choice for all of them. */
const bulkIds = z.array(z.uuid()).min(1).max(BULK_MAX);
const bulkTransferBody = z
  .object({ chatIds: bulkIds, sectorId: z.uuid().optional(), ownerId: z.uuid().nullable().optional() })
  .refine((b) => b.sectorId !== undefined || b.ownerId !== undefined, 'Informe o setor ou o atendente');
const bulkCloseBody = z.object({ chatIds: bulkIds, sendClosingMessage: z.boolean().default(false) });
const bulkReadBody = z.object({ chatIds: bulkIds });
const textBody = z.object({
  text: z.string().trim().min(1).max(4096),
  signature: z.boolean().default(true),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
/** Spec §6: a recent sticker, sent again by the id of the message that carries it. */
const stickerBody = z.object({ stickerFromMessageId: z.uuid(), replyToId: z.uuid().optional(), botAction: botActionField });
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
  asSticker: z.stringbool().default(false),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
const noteBody = z.object({ text: z.string().trim().min(1).max(4096) });
/** Spec §3: one emoji, or '' to remove (isSingleEmoji checks it in reactToMessage). */
const reactionBody = z.object({ emoji: z.string().max(32) });
/** Spec §5: same limits as a text send. */
const editBody = z.object({ text: z.string().trim().min(1).max(4096) });
/** Spec §7: one destination: an open chat, or a contact (+ optional channel; default = the source message's channel). */
const forwardBody = z.union([
  z.object({ chatId: z.uuid(), botAction: botActionField }),
  z.object({ contactId: z.uuid(), channelId: z.uuid().optional(), botAction: botActionField }),
]);

/** Spec 2026-10-20 §5: same limit as the contact's tags. */
const tagsBody = z.object({ tagIds: z.array(z.uuid()).max(50) });

/** Every field and the one file of a multipart body; 413 past 64 MB. The scheduled-message route reads it too. */
export async function readParts(req: FastifyRequest): Promise<{ fields: Record<string, string>; file?: SendInput['file'] }> {
  const fields: Record<string, string> = {};
  let file: SendInput['file'];
  try {
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10 } })) {
      if (part.type === 'file') {
        file = { buffer: await part.toBuffer(), mime: part.mimetype, name: part.filename || 'arquivo' };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
  } catch (err) {
    // @fastify/multipart limit errors carry statusCode 413; map them to our Portuguese message.
    if ((err as { statusCode?: number }).statusCode === 413) {
      throw new HttpError(413, 'Envie um único arquivo de até 64 MB');
    }
    throw err;
  }
  return { fields, file };
}

async function readMultipart(req: FastifyRequest): Promise<SendInput> {
  const { fields, file } = await readParts(req);
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
  return {
    file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, asSticker: f.asSticker, replyToId: f.replyToId,
    botAction: f.botAction,
  };
}

/** JSON send: a recent sticker (`stickerFromMessageId`) or a text. */
function jsonSendInput(body: unknown): SendInput {
  if (body && typeof body === 'object' && 'stickerFromMessageId' in body) return { ...stickerBody.parse(body), signature: false };
  return textBody.parse(body);
}

export async function chatRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  await app.register(async (r) => {
    // buildApp registers multipart at the root; this only covers a bare app. Scoped so a second registration cannot clash.
    if (!r.hasContentTypeParser('multipart/form-data')) await r.register(multipart);

    r.get('/api/chats', async (req) => listChats(ctx, req.user, listQuery.parse(req.query)));

    r.post('/api/chats', async (req) => {
      const chat = await startChat(ctx, req.user, startBody.parse(req.body));
      return toChatDetail(ctx.db, chat, req.user.id);
    });

    // Static paths: find-my-way matches them before /api/chats/:id/…; the answer is 200 with one result per chat.
    r.post('/api/chats/bulk/transfer', async (req) => {
      const { chatIds, ...to } = bulkTransferBody.parse(req.body);
      return bulkTransfer(ctx, req.user, chatIds, to);
    });
    r.post('/api/chats/bulk/close', async (req) => {
      const { chatIds, sendClosingMessage } = bulkCloseBody.parse(req.body);
      return bulkClose(ctx, req.user, chatIds, sendClosingMessage);
    });
    r.post('/api/chats/bulk/read', async (req) => bulkRead(ctx, req.user, bulkReadBody.parse(req.body).chatIds));

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, req.user, idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });

    r.get('/api/chats/:id/search', async (req) =>
      searchChat(ctx, req.user, idParams.parse(req.params).id, searchQuery.parse(req.query).q),
    );

    // The detail is built from the row the service returned, without a second visibility check:
    // after a transfer the caller may no longer see the chat but still gets its new state.
    const action = (path: string, run: (user: AuthUser, id: string, body: unknown) => Promise<ChatRow>) =>
      r.post(`/api/chats/:id/${path}`, async (req) => {
        const { id } = idParams.parse(req.params);
        return toChatDetail(ctx.db, await run(req.user, id, req.body), req.user.id);
      });

    action('assume', (user, id) => assumeChat(ctx, user, id));
    action('reopen', (user, id) => reopenChat(ctx, user, id));
    action('transfer', async (user, id, body) => {
      const { botAction, ...to } = transferBody.parse(body);
      await getChatForUser(ctx, user, id); // 404 before a 409 could reveal bot names
      // ponytail: 'stop' runs before transferChat validates the destination, so a transfer that then fails (400/409)
      // has still stopped the bot; split the ask check from the stop if that ever matters.
      await applyBotRunningBehavior(ctx, user, id, botAction, 'transfer');
      return transferChat(ctx, user, id, to);
    });
    action('privacy', (user, id, body) => setChatPrivacy(ctx, user, id, privacyBody.parse(body).private));
    action('close', (user, id, body) =>
      closeChatAndStopBots(ctx, user, id, closeBody.parse(body ?? {}).sendClosingMessage),
    );

    r.post('/api/chats/:id/read', async (req, reply) => {
      await markChatRead(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    r.post('/api/chats/:id/unread', async (req, reply) => {
      await markChatUnread(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    r.delete('/api/chats/:id', async (req, reply) => {
      await deleteChat(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    r.put('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, req.user, idParams.parse(req.params).id, true);
      return reply.code(204).send();
    });

    r.delete('/api/chats/:id/pin', async (req, reply) => {
      await pinChat(ctx, req.user, idParams.parse(req.params).id, false);
      return reply.code(204).send();
    });

    // The detail is read after the change, so it carries the new chatTagIds.
    r.put('/api/chats/:id/tags', async (req) => {
      const { id } = idParams.parse(req.params);
      return toChatDetail(ctx.db, await setChatTags(ctx, req.user, id, tagsBody.parse(req.body).tagIds), req.user.id);
    });

    r.post('/api/chats/:id/messages', async (req) => {
      const { id } = idParams.parse(req.params);
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : jsonSendInput(req.body);
      return sendAgentMessage(ctx, req.user, id, input);
    });

    r.post('/api/chats/:id/notes', async (req) => {
      const { id } = idParams.parse(req.params);
      return addNote(ctx, req.user, id, noteBody.parse(req.body).text);
    });

    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, req.user, idParams.parse(req.params).id),
    );

    // §5.5 "Baixar": one download by key.id for a media message that has no file yet
    r.post('/api/messages/:id/media', async (req) => downloadMediaForUser(ctx, req.user, idParams.parse(req.params).id));

    r.post('/api/messages/:id/reaction', async (req) =>
      reactToMessage(ctx, req.user, idParams.parse(req.params).id, reactionBody.parse(req.body).emoji),
    );

    r.delete('/api/messages/:id', async (req) => deleteMessageForEveryone(ctx, req.user, idParams.parse(req.params).id));

    r.patch('/api/messages/:id', async (req) =>
      editMessage(ctx, req.user, idParams.parse(req.params).id, editBody.parse(req.body).text),
    );

    r.get('/api/messages/:id/edits', async (req) => listMessageEdits(ctx, req.user, idParams.parse(req.params).id));

    r.get('/api/stickers/recent', async (req) => listRecentStickers(ctx, req.user));

    r.post('/api/messages/:id/forward', async (req) =>
      forwardMessage(ctx, req.user, idParams.parse(req.params).id, forwardBody.parse(req.body)),
    );

    // Spec 2026-10-19 §3: a note leaves the chat for everyone. Editing it is the PATCH above.
    r.delete('/api/notes/:id', async (req, reply) => {
      await deleteNote(ctx, req.user, idParams.parse(req.params).id);
      return reply.code(204).send();
    });

    // Spec 2026-10-19 §5: the shared star.
    r.put('/api/messages/:id/favorite', async (req) => setFavorite(ctx, req.user, idParams.parse(req.params).id, true));
    r.delete('/api/messages/:id/favorite', async (req) => setFavorite(ctx, req.user, idParams.parse(req.params).id, false));
    r.get('/api/chats/:id/favorites', async (req) => listFavorites(ctx, req.user, idParams.parse(req.params).id));
  });
}
