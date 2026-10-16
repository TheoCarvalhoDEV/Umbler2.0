import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stopRunsForChat } from '../bots/engine.js';
import { applyBotRunningBehavior } from '../bots/hooks.js';
import type { AppCtx } from '../ctx.js';
import {
  assumeChat, closeChat, getChatForUser, markChatRead, pinChat, reopenChat, setChatPrivacy, startChat, transferChat,
  type ChatRow,
} from '../inbox/chats.js';
import { getChatDetail, getTimeline, listChats, toChatDetail } from '../inbox/queries.js';
import type { AuthUser } from '../inbox/visibility.js';
import { HttpError, badRequest } from '../lib/http-error.js';
import { deleteMessageForEveryone, reactToMessage } from '../messages/actions.js';
import { addNote, resendMessage, sendAgentMessage, type SendInput } from '../messages/send.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  tab: z.enum(['inbox', 'waiting', 'closed']).default('inbox'),
  q: z.string().max(100).optional(),
  sectorId: z.uuid().optional(),
  ownerId: z.union([z.literal('none'), z.uuid()]).optional(),
  tagId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const timelineQuery = z.object({
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
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
const textBody = z.object({
  text: z.string().trim().min(1).max(4096),
  signature: z.boolean().default(true),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
const multipartFields = z.object({
  text: z.string().trim().max(4096).optional(),
  signature: z.stringbool().default(true),
  asVoice: z.stringbool().default(false),
  replyToId: z.uuid().optional(),
  botAction: botActionField,
});
const noteBody = z.object({ text: z.string().trim().min(1).max(4096) });
/** Spec §3: one emoji, or '' to remove (isSingleEmoji checks it in reactToMessage). */
const reactionBody = z.object({ emoji: z.string().max(32) });

async function readMultipart(req: FastifyRequest): Promise<SendInput> {
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
  if (!file) throw badRequest('Arquivo ausente');
  const f = multipartFields.parse(fields);
  return {
    file, text: f.text || undefined, signature: f.signature, asVoice: f.asVoice, replyToId: f.replyToId, botAction: f.botAction,
  };
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

    r.get('/api/chats/:id', async (req) => getChatDetail(ctx, req.user, idParams.parse(req.params).id));

    r.get('/api/chats/:id/timeline', async (req) => {
      const { id } = idParams.parse(req.params);
      return getTimeline(ctx, req.user, id, timelineQuery.parse(req.query));
    });

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
    action('close', async (user, id, body) => {
      const closed = await closeChat(ctx, user, id, {
        sendClosingMessage: closeBody.parse(body ?? {}).sendClosingMessage,
        // Closing text is the office's canned message, so it goes without the agent signature.
        // botAction 'keep': closing never asks, the runs are stopped right below.
        sendClosing: async (text: string) =>
          (await sendAgentMessage(ctx, user, id, { text, signature: false, botAction: 'keep' })).status !== 'failed',
      });
      // Spec §5.5: closing the chat stops every bot run in it.
      await stopRunsForChat(ctx, id, { userId: user.id, reason: 'chat_closed' });
      return closed;
    });

    r.post('/api/chats/:id/read', async (req, reply) => {
      await markChatRead(ctx, req.user, idParams.parse(req.params).id);
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

    r.post('/api/chats/:id/messages', async (req) => {
      const { id } = idParams.parse(req.params);
      const input: SendInput = req.isMultipart() ? await readMultipart(req) : textBody.parse(req.body);
      return sendAgentMessage(ctx, req.user, id, input);
    });

    r.post('/api/chats/:id/notes', async (req) => {
      const { id } = idParams.parse(req.params);
      return addNote(ctx, req.user, id, noteBody.parse(req.body).text);
    });

    r.post('/api/messages/:id/resend', async (req) =>
      resendMessage(ctx, req.user, idParams.parse(req.params).id),
    );

    r.post('/api/messages/:id/reaction', async (req) =>
      reactToMessage(ctx, req.user, idParams.parse(req.params).id, reactionBody.parse(req.body).emoji),
    );

    r.delete('/api/messages/:id', async (req) => deleteMessageForEveryone(ctx, req.user, idParams.parse(req.params).id));
  });
}
