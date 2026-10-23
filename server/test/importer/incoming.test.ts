import { describe, expect, it } from 'vitest';
import { toIncoming } from '../../src/importer/chats.js';
import type { UmblerMessage } from '../../src/importer/umbler.js';
import { umblerMessage } from '../fakes/umbler-api.js';

const AT = '2026-09-01T12:00:00Z';
const m = (over: Record<string, unknown> = {}) => umblerMessage('U1', AT, over) as unknown as UmblerMessage;
const file = (over: Record<string, unknown> = {}) => ({
  url: 'https://utalk-wamedia.s3.amazonaws.com/x/y/z', contentType: 'image/jpeg', originalName: 'foto.jpg', originalSizeBytes: 1234,
  caption: null, failDownload: false, ...over,
});

describe('toIncoming (spec 2026-10-21 importar-umbler §7.7)', () => {
  it('direction and status: the contact is in; Member, Bot and External (the phone) are out', () => {
    expect(toIncoming(m())).toMatchObject({ umblerId: 'U1', at: new Date(AT), direction: 'in', kind: 'text', body: 'texto U1', status: 'read', bot: false });
    expect(toIncoming(m({ source: 'Member', sentByOrganizationMember: { id: 'M_ANA' } }))).toMatchObject({ direction: 'out', authorUmblerId: 'M_ANA' });
    expect(toIncoming(m({ source: 'Bot' }))).toMatchObject({ direction: 'out', bot: true, authorUmblerId: null });
    expect(toIncoming(m({ source: 'External' }))).toMatchObject({ direction: 'out', authorUmblerId: null });
    const status = (messageState: string) => toIncoming(m({ messageState }))!.status;
    expect(['Read', 'Played', 'Received', 'Failed', 'Error', 'Sent', 'Processing'].map(status)).toEqual([
      'read', 'read', 'delivered', 'failed', 'failed', 'sent', 'sent',
    ]);
  });

  it('text: an out message with prefix gets the signature line the client received; media: the caption wins', () => {
    expect(toIncoming(m({ source: 'Member', prefix: 'Financeiro - Ana', content: 'Segue o boleto' }))!.body).toBe('*Financeiro - Ana:*\nSegue o boleto');
    expect(toIncoming(m({ prefix: 'Maria', content: 'Oi' }))!.body).toBe('Oi'); // only the office signs
    expect(toIncoming(m({ messageType: 'Image', content: 'texto', file: file({ caption: 'legenda' }) }))).toMatchObject({
      kind: 'image', body: 'legenda', matchKind: 'image', matchText: 'legenda',
      file: { url: 'https://utalk-wamedia.s3.amazonaws.com/x/y/z', mime: 'image/jpeg', name: 'foto.jpg', size: 1234 },
    });
    expect(toIncoming(m({ messageType: 'Image', content: 'só content', file: file() }))!.body).toBe('só content');
    expect(toIncoming(m({ messageType: 'Image', file: file({ failDownload: true }) }))!.file!.url).toBeNull();
  });

  it('types: Gif is an image, File a document, replies and a bot question with text are text, the rest unsupported', () => {
    const kind = (messageType: string, over: Record<string, unknown> = {}) => toIncoming(m({ messageType, file: file(), ...over }))?.kind;
    expect(['Text', 'Url', 'ListReply', 'ButtonReply', 'QuickReply'].map((t) => kind(t))).toEqual(['text', 'text', 'text', 'text', 'text']);
    expect(['Image', 'Gif', 'Video', 'Audio', 'Sticker', 'File'].map((t) => kind(t))).toEqual(['image', 'image', 'video', 'audio', 'sticker', 'document']);
    expect(kind('List', { content: 'Escolha uma opção' })).toBe('text');
    expect(kind('List', { content: null })).toBe('unsupported');
    expect(['Payment', 'Order', 'Poll', 'Carousel', 'CallAttempt', 'Unsupported'].map((t) => kind(t))).toEqual(Array(6).fill('unsupported'));
    expect(toIncoming(m({ messageType: 'Poll', content: 'Qual horário?' }))).toMatchObject({ body: 'Qual horário?', file: null });
  });

  it('a location and a contact card become text (decision §7.7), and compare as WhatsApp stores them (§8)', () => {
    expect(toIncoming(m({ messageType: 'Location', location: { latitude: '-15.6', longitude: '-56.1', name: 'Escritório', address: null } }))).toMatchObject({
      kind: 'text', body: 'Localização: Escritório https://maps.google.com/?q=-15.6,-56.1', matchKind: 'unsupported', matchText: null,
    });
    expect(toIncoming(m({ messageType: 'Location', location: { latitude: '1', longitude: '2' } }))!.body).toBe('Localização: https://maps.google.com/?q=1,2');
    expect(toIncoming(m({ messageType: 'Contact', contacts: [{ name: 'Dr. Paulo', phoneNumbers: ['+55 65 3322-1100', '+55 65 99999-0000'] }] }))).toMatchObject({
      kind: 'text', body: 'Contato: Dr. Paulo +55 65 3322-1100 +55 65 99999-0000', matchKind: 'unsupported',
    });
  });

  it('a note is out and sent, and never compares with WhatsApp; reactions keep the newest of each side', () => {
    expect(toIncoming(m({ isPrivate: true, source: 'Member', content: 'Ligar amanhã', messageState: 'Received' }))).toMatchObject({
      kind: 'note', direction: 'out', status: 'sent', body: 'Ligar amanhã', matchKind: 'note',
    });
    const reactions = [
      { emoji: '👍', source: 'Contact', eventAtUTC: '2026-09-01T12:01:00Z' },
      { emoji: '❤️', source: 'Contact', eventAtUTC: '2026-09-01T12:03:00Z' },
      { emoji: '🙏', source: 'External', eventAtUTC: '2026-09-01T12:02:00Z' },
    ];
    expect(toIncoming(m({ reactions }))).toMatchObject({ reaction: '❤️', officeReaction: '🙏' });
    expect(toIncoming(m({ inReplyTo: { id: 'U0', chatId: 'X' } }))!.replyUmblerId).toBe('U0');
  });

  it('deleted, edited and redacted; timeline items and loose reactions are not messages', () => {
    expect(toIncoming(m({ messageState: 'Deleted' }))).toMatchObject({ deletedAt: new Date(AT), body: 'texto U1' });
    expect(toIncoming(m({ messageState: 'Edited', latestEdit: { senderAtUTC: '2026-09-01T12:05:00Z' } }))!.editedAt).toEqual(
      new Date('2026-09-01T12:05:00Z'),
    );
    expect(toIncoming(m({ messageState: 'Edited' }))!.editedAt).toEqual(new Date(AT));
    expect(toIncoming(m({ messageState: 'Redacted', messageType: 'Image', file: file() }))).toMatchObject({
      kind: 'unsupported', body: null, redacted: true, file: null,
    });
    expect(toIncoming(m({ _t: 'ChatClosedMetadataModel' }))).toBeNull();
    expect(toIncoming(m({ messageType: 'Reaction' }))).toBeNull();
    expect(toIncoming(m({ _t: 'SentMessageModel' }))).not.toBeNull();
  });
});
