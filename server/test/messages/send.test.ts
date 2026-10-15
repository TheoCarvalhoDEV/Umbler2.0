import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { addNote, failInterruptedSends, markSent, resendMessage, sendAgentMessage } from '../../src/messages/send.js';
import { handleInbound } from '../../src/messages/ingest.js';
import type { AuthUser } from '../../src/inbox/visibility.js';

const PHONE = '5565999990001';

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let agentA: AuthUser;

beforeEach(async () => {
  ctx = await makeTestCtx();
  ctx.config.mediaDir = await mkdtemp(join(tmpdir(), 'talk-media-'));
  seed = await seedBasics(ctx);
  agentA = { ...seed.agentA, signature: null };
});

async function openChat(opts: { sectorId?: string; ownerId?: string | null; private?: boolean } = {}): Promise<string> {
  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'Maria Souza', phone: PHONE });
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId: seed.channelId,
    init: { sectorId: opts.sectorId ?? seed.sectorA, ownerId: opts.ownerId ?? null, waiting: true, triagePending: true, createdBy: null },
  });
  await ctx.db.update(chats).set({ unread: 3, private: opts.private ?? false }).where(eq(chats.id, chat.id));
  return chat.id;
}

async function getChat(chatId: string) {
  const [row] = await ctx.db.select().from(chats).where(eq(chats.id, chatId));
  return row!;
}

describe('sendAgentMessage — text', () => {
  it('sends with signature, assigns the owner, clears waiting/unread/triage and publishes', async () => {
    const chatId = await openChat();
    const sendText = vi.spyOn(ctx.wa, 'sendText');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: '  Olá, tudo bem?  ', signature: true });

    const expected = `*Financeiro - ${agentA.name}:*\nOlá, tudo bem?`;
    expect(sendText).toHaveBeenCalledWith('talk-test', PHONE, expected, undefined);
    expect(dto).toMatchObject({ chatId, direction: 'out', kind: 'text', body: expected, status: 'sent', error: null, authorId: agentA.id });

    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, dto.id));
    expect(row!.externalId).toMatch(/^fake-/);

    const chat = await getChat(chatId);
    expect(chat).toMatchObject({ ownerId: agentA.id, waiting: false, unread: 0, triagePending: false, lastMessagePreview: 'Olá, tudo bem?' });
    expect(chat.lastMessageAt).not.toBeNull();

    const events = await ctx.db.select().from(chatEvents).where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'assigned')));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ ownerId: agentA.id, previousOwnerId: null });

    const published = ctx.hub.events.filter((e) => e.messageId === dto.id).map((e) => e.type);
    expect(published).toEqual(['message.created', 'message.updated']);
  });

  it('sends plain text when signature is off and keeps an existing owner', async () => {
    const chatId = await openChat({ ownerId: seed.admin.id });
    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    expect(dto.body).toBe('Oi');
    expect((await getChat(chatId)).ownerId).toBe(seed.admin.id);
    const events = await ctx.db.select().from(chatEvents).where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'assigned')));
    expect(events).toHaveLength(0);
  });

  it('marks the message failed with the error when the gateway throws, then resend succeeds', async () => {
    const chatId = await openChat();
    const sendText = vi.spyOn(ctx.wa, 'sendText');
    ctx.wa.failNext(new Error('Evolution fora do ar'));

    const failed = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    expect(failed).toMatchObject({ status: 'failed', error: 'Evolution fora do ar' });

    const resent = await resendMessage(ctx, agentA, failed.id);
    expect(resent).toMatchObject({ id: failed.id, status: 'sent', error: null, body: 'Oi' });
    expect(sendText).toHaveBeenCalledTimes(2);

    await expect(resendMessage(ctx, agentA, failed.id)).rejects.toMatchObject({ status: 409 });
  });

  it('resend is 404 for a user who cannot see the chat', async () => {
    const chatId = await openChat();
    ctx.wa.failNext();
    const failed = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });
    await expect(resendMessage(ctx, seed.agentB, failed.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects an empty message (400) and a closed chat (409)', async () => {
    const chatId = await openChat();
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: '   ', signature: true })).rejects.toMatchObject({ status: 400 });
    await ctx.db.update(chats).set({ state: 'closed', closedAt: new Date() }).where(eq(chats.id, chatId));
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: true })).rejects.toMatchObject({ status: 409 });
    expect(ctx.wa.sent).toHaveLength(0);
  });
});

describe('sendAgentMessage — webhook echo arriving before the gateway returns', () => {
  it('keeps one message (ours, sent) and drops the phone-typed echo copy', async () => {
    const chatId = await openChat();
    const realSendText = ctx.wa.sendText.bind(ctx.wa);
    vi.spyOn(ctx.wa, 'sendText').mockImplementation(async (instance, phone, text, quoted) => {
      const res = await realSendText(instance, phone, text, quoted);
      // Evolution's messages.upsert echo (fromMe) is ingested while our call is still pending.
      await handleInbound(ctx, [
        {
          type: 'message', instance, externalId: res.externalId, direction: 'out', phone, lid: null,
          pushName: 'Escritório JVO', kind: 'text', body: text, hasMedia: false, mediaMime: null,
          mediaName: null, replyToExternalId: null, sentAt: new Date(), raw: {},
        },
      ]);
      return res;
    });

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false });

    expect(dto).toMatchObject({ status: 'sent', error: null, authorId: agentA.id });
    const rows = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: dto.id, authorId: agentA.id, status: 'sent' });
    expect(rows[0]!.externalId).toMatch(/^fake-/);
    expect(await getChat(chatId)).toMatchObject({ waiting: false, triagePending: false, unread: 0 });
  });
});

describe('markSent — echo committing while our UPDATE waits (real Postgres, READ COMMITTED)', () => {
  it('retries once on a unique violation and keeps only our row, sent', async () => {
    const chatId = await openChat();
    const ourId = randomUUID();
    await ctx.db.insert(messages).values({
      id: ourId, chatId, channelId: seed.channelId, direction: 'out', kind: 'text', body: 'Oi',
      authorId: agentA.id, status: 'pending', sentAt: new Date(),
    });
    // PGlite serializes transactions, so simulate the interleaving: the first attempt's DELETE missed the
    // uncommitted echo, the echo then committed and the UPDATE hit messages_channel_external_unique.
    vi.spyOn(ctx.db, 'transaction').mockImplementationOnce(async () => {
      await ctx.db.insert(messages).values({
        id: randomUUID(), chatId, channelId: seed.channelId, direction: 'out', kind: 'text', body: 'Oi',
        authorId: null, externalId: 'EXT-R', status: 'sent', sentAt: new Date(),
      });
      throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    });

    const res = await markSent(ctx.db, ourId, seed.channelId, 'EXT-R');

    expect(res.echoDropped).toBe(true);
    const rows = await ctx.db.select().from(messages).where(eq(messages.chatId, chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ourId, status: 'sent', externalId: 'EXT-R' });
  });

  it('rethrows any other error', async () => {
    vi.spyOn(ctx.db, 'transaction').mockRejectedValueOnce(new Error('boom'));
    await expect(markSent(ctx.db, randomUUID(), seed.channelId, 'X')).rejects.toThrow('boom');
  });
});

describe('failInterruptedSends', () => {
  it('marks every pending row failed so it can be resent after a restart', async () => {
    const chatId = await openChat();
    const pendingId = randomUUID();
    await ctx.db.insert(messages).values({
      id: pendingId, chatId, channelId: seed.channelId, direction: 'out', kind: 'text', body: 'Oi',
      authorId: agentA.id, status: 'pending', sentAt: new Date(),
    });
    const sent = await sendAgentMessage(ctx, agentA, chatId, { text: 'ok', signature: false });

    await failInterruptedSends(ctx.db);

    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, pendingId));
    expect(row).toMatchObject({ status: 'failed', error: 'Envio interrompido' });
    expect((await ctx.db.select().from(messages).where(eq(messages.id, sent.id)))[0]!.status).toBe('sent');
    expect((await resendMessage(ctx, agentA, pendingId)).status).toBe('sent');
  });
});

describe('sendAgentMessage — contact known only by LID', () => {
  it('addresses the contact as <lid>@lid', async () => {
    const contactId = randomUUID();
    await ctx.db.insert(contacts).values({ id: contactId, name: null, phone: null, lid: '123456789' });
    const { chat } = await findOrOpenChat(ctx.db, {
      contactId, channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: true, triagePending: false, createdBy: null },
    });
    const sendText = vi.spyOn(ctx.wa, 'sendText');

    const dto = await sendAgentMessage(ctx, agentA, chat.id, { text: 'Oi', signature: false });

    expect(sendText).toHaveBeenCalledWith('talk-test', '123456789@lid', 'Oi', undefined);
    expect(dto.status).toBe('sent');
  });

  it('fails with "Contato sem telefone" when there is neither phone nor lid', async () => {
    const contactId = randomUUID();
    await ctx.db.insert(contacts).values({ id: contactId, name: 'Sem nada', phone: null, lid: null });
    const { chat } = await findOrOpenChat(ctx.db, {
      contactId, channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: true, triagePending: false, createdBy: null },
    });
    const dto = await sendAgentMessage(ctx, agentA, chat.id, { text: 'Oi', signature: false });
    expect(dto).toMatchObject({ status: 'failed', error: 'Contato sem telefone' });
  });
});

describe('sendAgentMessage — visibility and privacy', () => {
  it('agent of another sector gets 404', async () => {
    const chatId = await openChat();
    await expect(sendAgentMessage(ctx, seed.agentB, chatId, { text: 'Oi', signature: false })).rejects.toMatchObject({ status: 404 });
  });

  it('private chat: sector member who is not the owner gets 404; owner and admin can send', async () => {
    const chatId = await openChat({ ownerId: seed.agentA.id, private: true });
    const otherInSectorA: AuthUser = { ...seed.agentB, id: randomUUID(), sectorIds: [seed.sectorA] };
    await expect(sendAgentMessage(ctx, otherInSectorA, chatId, { text: 'Oi', signature: false })).rejects.toMatchObject({ status: 404 });

    expect((await sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false })).status).toBe('sent');
    expect((await sendAgentMessage(ctx, seed.admin, chatId, { text: 'Oi', signature: false })).status).toBe('sent');
    expect(ctx.wa.sent).toHaveLength(2);
  });
});

describe('sendAgentMessage — files', () => {
  it('image: stores the file and sends it with the signed caption', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('fake-png-bytes');

    const dto = await sendAgentMessage(ctx, agentA, chatId, {
      text: 'veja',
      signature: true,
      file: { buffer, mime: 'image/png', name: 'foto.png' },
    });

    expect(sendMedia).toHaveBeenCalledWith(
      'talk-test',
      PHONE,
      { kind: 'image', base64: buffer.toString('base64'), mime: 'image/png', fileName: 'foto.png', caption: `*Financeiro - ${agentA.name}:*\nveja` },
      undefined,
    );
    expect(dto).toMatchObject({ kind: 'image', status: 'sent' });

    const [row] = await ctx.db.select().from(messages).where(eq(messages.id, dto.id));
    expect(row).toMatchObject({ mediaMime: 'image/png', mediaName: 'foto.png', mediaSize: buffer.length });
    expect(await readFile(join(ctx.config.mediaDir, row!.mediaPath!))).toEqual(buffer);
    expect((await getChat(chatId)).lastMessagePreview).toBe('veja');
  });

  it('pdf without text: document with no caption, preview "📄 Documento"', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('%PDF-1.4');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { signature: true, file: { buffer, mime: 'application/pdf', name: 'contrato.pdf' } });

    expect(sendMedia).toHaveBeenCalledWith(
      'talk-test',
      PHONE,
      { kind: 'document', base64: buffer.toString('base64'), mime: 'application/pdf', fileName: 'contrato.pdf' },
      undefined,
    );
    expect(dto).toMatchObject({ kind: 'document', body: null });
    expect((await getChat(chatId)).lastMessagePreview).toBe('📄 Documento');
  });

  it('voice: asVoice sends through sendAudio, ignores text, kind audio', async () => {
    const chatId = await openChat();
    const sendAudio = vi.spyOn(ctx.wa, 'sendAudio');
    const buffer = Buffer.from('ogg-opus-bytes');

    const dto = await sendAgentMessage(ctx, agentA, chatId, {
      text: 'ignorado',
      signature: true,
      asVoice: true,
      file: { buffer, mime: 'audio/ogg; codecs=opus', name: 'gravacao.ogg' },
    });

    expect(sendAudio).toHaveBeenCalledWith('talk-test', PHONE, buffer.toString('base64'), undefined);
    expect(dto).toMatchObject({ kind: 'audio', body: null, status: 'sent' });
    expect((await getChat(chatId)).lastMessagePreview).toBe('🎤 Áudio');
  });

  it('asVoice with a non-audio file is 400', async () => {
    const chatId = await openChat();
    await expect(
      sendAgentMessage(ctx, agentA, chatId, { signature: false, asVoice: true, file: { buffer: Buffer.from('x'), mime: 'image/png', name: 'a.png' } }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('resending a failed image re-reads the stored file', async () => {
    const chatId = await openChat();
    const sendMedia = vi.spyOn(ctx.wa, 'sendMedia');
    const buffer = Buffer.from('jpeg');
    ctx.wa.failNext();
    const failed = await sendAgentMessage(ctx, agentA, chatId, { signature: false, file: { buffer, mime: 'image/jpeg', name: 'a.jpg' } });
    expect(failed.status).toBe('failed');

    const resent = await resendMessage(ctx, agentA, failed.id);
    expect(resent.status).toBe('sent');
    expect(sendMedia).toHaveBeenLastCalledWith(
      'talk-test',
      PHONE,
      { kind: 'image', base64: buffer.toString('base64'), mime: 'image/jpeg', fileName: 'a.jpg' },
      undefined,
    );
  });
});

describe('sendAgentMessage — reply', () => {
  it('sends the quoted key of the original message', async () => {
    const chatId = await openChat();
    const inboundId = randomUUID();
    await ctx.db.insert(messages).values({
      id: inboundId, chatId, channelId: seed.channelId, direction: 'in', kind: 'text',
      body: 'Qual o prazo?', externalId: 'EXT-1', status: 'sent', sentAt: new Date(),
    });
    const sendText = vi.spyOn(ctx.wa, 'sendText');

    const dto = await sendAgentMessage(ctx, agentA, chatId, { text: 'Amanhã.', signature: false, replyToId: inboundId });

    expect(sendText).toHaveBeenCalledWith('talk-test', PHONE, 'Amanhã.', { externalId: 'EXT-1', body: 'Qual o prazo?', fromMe: false });
    expect(dto.replyTo?.id).toBe(inboundId);
  });

  it('voice note reply sends the quoted key too', async () => {
    const chatId = await openChat();
    const inboundId = randomUUID();
    await ctx.db.insert(messages).values({
      id: inboundId, chatId, channelId: seed.channelId, direction: 'in', kind: 'text',
      body: 'Me manda um áudio', externalId: 'EXT-2', status: 'sent', sentAt: new Date(),
    });
    const sendAudio = vi.spyOn(ctx.wa, 'sendAudio');
    const buffer = Buffer.from('ogg');

    await sendAgentMessage(ctx, agentA, chatId, {
      signature: false, asVoice: true, replyToId: inboundId, file: { buffer, mime: 'audio/ogg', name: 'a.ogg' },
    });

    expect(sendAudio).toHaveBeenCalledWith('talk-test', PHONE, buffer.toString('base64'), {
      externalId: 'EXT-2', body: 'Me manda um áudio', fromMe: false,
    });
  });

  it('replyToId from another chat is 400', async () => {
    const chatId = await openChat();
    const otherContact = randomUUID();
    await ctx.db.insert(contacts).values({ id: otherContact, name: 'João', phone: '5565988880000' });
    const { chat: other } = await findOrOpenChat(ctx.db, {
      contactId: otherContact, channelId: seed.channelId,
      init: { sectorId: seed.sectorA, ownerId: null, waiting: false, triagePending: false, createdBy: null },
    });
    const foreignId = randomUUID();
    await ctx.db.insert(messages).values({
      id: foreignId, chatId: other.id, channelId: seed.channelId, direction: 'in', kind: 'text',
      body: 'x', externalId: 'EXT-9', status: 'sent', sentAt: new Date(),
    });
    await expect(sendAgentMessage(ctx, agentA, chatId, { text: 'Oi', signature: false, replyToId: foreignId })).rejects.toMatchObject({ status: 400 });
  });
});

describe('addNote', () => {
  it('stores a note, never calls the gateway, leaves chat flags untouched', async () => {
    const chatId = await openChat();
    const dto = await addNote(ctx, agentA, chatId, '  Cliente pediu retorno amanhã  ');

    expect(dto).toMatchObject({ chatId, kind: 'note', direction: 'out', body: 'Cliente pediu retorno amanhã', authorId: agentA.id });
    expect(ctx.wa.sent).toHaveLength(0);
    expect(await getChat(chatId)).toMatchObject({ waiting: true, unread: 3, triagePending: true, ownerId: null });
    expect(ctx.hub.events.some((e) => e.type === 'message.created' && e.messageId === dto.id)).toBe(true);
  });

  it('empty note is 400; other sector is 404', async () => {
    const chatId = await openChat();
    await expect(addNote(ctx, agentA, chatId, '  ')).rejects.toMatchObject({ status: 400 });
    await expect(addNote(ctx, seed.agentB, chatId, 'x')).rejects.toMatchObject({ status: 404 });
  });

  it('a note cannot be resent', async () => {
    const chatId = await openChat();
    const note = await addNote(ctx, agentA, chatId, 'nota');
    await expect(resendMessage(ctx, agentA, note.id)).rejects.toMatchObject({ status: 409 });
  });
});
