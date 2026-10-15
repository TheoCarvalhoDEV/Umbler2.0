import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chats, contacts, messages } from '../../src/db/schema.js';
import { messagePreview, toMessageDto } from '../../src/messages/dto.js';
import { makeTestCtx, seedBasics } from '../helpers.js';

async function setup() {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const contactId = randomUUID();
  await ctx.db.insert(contacts).values({ id: contactId, name: 'João Lima', phone: '5565999990001' });
  const chatId = randomUUID();
  await ctx.db.insert(chats).values({
    id: chatId, contactId, channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id,
    state: 'open', waiting: false, private: false, triagePending: false, unread: 0,
  });
  return { ctx, s, chatId };
}

describe('toMessageDto', () => {
  it('maps a stored media message with author name and quoted reply', async () => {
    const { ctx, s, chatId } = await setup();
    const quotedId = randomUUID();
    await ctx.db.insert(messages).values({
      id: quotedId, chatId, channelId: s.channelId, direction: 'in', kind: 'text',
      body: 'Pode mandar o contrato?', externalId: 'ext-1', status: 'sent',
      sentAt: new Date('2026-10-14T12:00:00Z'),
    });
    const id = randomUUID();
    const [row] = await ctx.db.insert(messages).values({
      id, chatId, channelId: s.channelId, direction: 'out', kind: 'document', body: 'Segue',
      mediaPath: '2026/10/abc.pdf', mediaMime: 'application/pdf', mediaSize: 1234, mediaName: 'contrato.pdf',
      authorId: s.agentA.id, replyToId: quotedId, status: 'pending',
      sentAt: new Date('2026-10-14T12:05:00Z'),
    }).returning();

    expect(await toMessageDto(ctx.db, row)).toEqual({
      id, chatId, direction: 'out', kind: 'document', body: 'Segue',
      media: { url: `/api/media/${id}`, mime: 'application/pdf', name: 'contrato.pdf', size: 1234 },
      mediaUnavailable: false,
      authorId: s.agentA.id, authorName: s.agentA.name, authorAvatarUrl: null, botRunId: null, botName: null,
      replyTo: { id: quotedId, body: 'Pode mandar o contrato?', kind: 'text' },
      reaction: null, status: 'pending', error: null,
      sentAt: '2026-10-14T12:05:00.000Z',
    });
  });

  it('flags inbound media whose download failed as unavailable', async () => {
    const { ctx, s, chatId } = await setup();
    const [row] = await ctx.db.insert(messages).values({
      id: randomUUID(), chatId, channelId: s.channelId, direction: 'in', kind: 'image', body: null,
      externalId: 'ext-2', reaction: '👍', status: 'sent', error: 'mídia indisponível',
      sentAt: new Date('2026-10-14T12:10:00Z'),
    }).returning();

    const dto = await toMessageDto(ctx.db, row);

    expect(dto.media).toBeNull();
    expect(dto.mediaUnavailable).toBe(true);
    expect(dto.authorId).toBeNull();
    expect(dto.authorName).toBeNull();
    expect(dto.authorAvatarUrl).toBeNull();
    expect(dto.replyTo).toBeNull();
    expect(dto.reaction).toBe('👍');
  });
});

describe('messagePreview', () => {
  it('uses the body, else a label per kind, capped at 100 chars', () => {
    expect(messagePreview('text', 'Bom dia')).toBe('Bom dia');
    expect(messagePreview('image', 'legenda')).toBe('legenda');
    expect(messagePreview('image', null)).toBe('📷 Imagem');
    expect(messagePreview('audio', null)).toBe('🎤 Áudio');
    expect(messagePreview('video', '')).toBe('🎬 Vídeo');
    expect(messagePreview('document', null)).toBe('📄 Documento');
    expect(messagePreview('sticker', null)).toBe('Figurinha');
    expect(messagePreview('unsupported', null)).toBe('Mensagem não suportada');
    expect(messagePreview('text', 'x'.repeat(150))).toBe('x'.repeat(100));
  });
});
