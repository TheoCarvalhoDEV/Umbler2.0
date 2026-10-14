import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEvolutionWebhook } from '../../src/whatsapp/parse.js';
import { lidFromJid } from '../../src/whatsapp/phone.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/evolution/${name}.json`, import.meta.url), 'utf8'));

const INSTANCE = 'talk-test';
const PHONE = '5565999999999'; // fixtures carry the 12-digit JID 556599999999@s.whatsapp.net
const LID = lidFromJid('201234567890123@lid');
const T = new Date(1760440000 * 1000);

describe('parseEvolutionWebhook — content messages', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['text-in', {
      externalId: 'MSG-TEXT-IN', direction: 'in', phone: PHONE, lid: null, pushName: 'Maria Teste',
      kind: 'text', body: 'Olá, preciso de ajuda', hasMedia: false, mediaMime: null, mediaName: null,
      replyToExternalId: null, sentAt: T,
    }],
    ['text-reply-in', { externalId: 'MSG-REPLY-IN', kind: 'text', body: 'Sobre isso aqui', replyToExternalId: 'MSG-OUT-0001', sentAt: T }],
    ['ephemeral-text-in', { externalId: 'MSG-EPHEMERAL-IN', kind: 'text', body: 'Mensagem temporária', hasMedia: false }],
    ['image-in', { externalId: 'MSG-IMAGE-IN', kind: 'image', body: 'Foto do documento', hasMedia: true, mediaMime: 'image/jpeg', mediaName: null, sentAt: T }],
    ['audio-in', { externalId: 'MSG-AUDIO-IN', kind: 'audio', body: null, hasMedia: true, mediaMime: 'audio/ogg; codecs=opus' }],
    ['video-in', { externalId: 'MSG-VIDEO-IN', kind: 'video', body: null, hasMedia: true, mediaMime: 'video/mp4' }],
    ['document-in', { externalId: 'MSG-DOC-IN', kind: 'document', body: 'Segue o contrato', hasMedia: true, mediaMime: 'application/pdf', mediaName: 'contrato.pdf' }],
    ['sticker-in', { externalId: 'MSG-STICKER-IN', kind: 'sticker', body: null, hasMedia: true, mediaMime: 'image/webp' }],
    ['location-in', { externalId: 'MSG-LOCATION-IN', kind: 'unsupported', body: null, hasMedia: false, mediaMime: null }],
    ['from-phone-out', { externalId: 'MSG-PHONE-OUT', direction: 'out', phone: PHONE, pushName: null, kind: 'text', body: 'Respondi pelo celular' }],
    ['lid-alt-in', { externalId: 'MSG-LID-ALT-IN', direction: 'in', phone: PHONE, lid: LID, pushName: 'Maria Teste' }],
    ['lid-sender-pn-in', { externalId: 'MSG-LID-PN-IN', phone: PHONE, lid: LID }],
    ['lid-only-in', { externalId: 'MSG-LID-ONLY-IN', phone: null, lid: LID }],
    ['pn-lid-alt-in', { externalId: 'MSG-PN-LID-IN', phone: PHONE, lid: LID }],
  ];

  it.each(cases)('%s', (name, expected) => {
    const events = parseEvolutionWebhook(fixture(name));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'message', instance: INSTANCE, ...expected });
  });

  it('keeps { key, message } as raw for media download', () => {
    const body = fixture('image-in');
    const [event] = parseEvolutionWebhook(body);
    expect(event).toMatchObject({ type: 'message', raw: { key: body.data.key, message: body.data.message } });
  });

  it('uses now when messageTimestamp is missing', () => {
    const body = fixture('text-in');
    delete body.data.messageTimestamp;
    const [event] = parseEvolutionWebhook(body);
    if (event.type !== 'message') throw new Error('expected message');
    expect(Math.abs(event.sentAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('parses every item when data is an array', () => {
    const a = fixture('text-in');
    const b = fixture('image-in');
    const events = parseEvolutionWebhook({ ...a, data: [a.data, b.data] });
    expect(events.map((e) => (e.type === 'message' ? e.externalId : e.type))).toEqual(['MSG-TEXT-IN', 'MSG-IMAGE-IN']);
  });
});

describe('parseEvolutionWebhook — reactions, statuses, connection, qrcode', () => {
  const cases: Array<[string, InboundEvent]> = [
    ['reaction', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: '👍' }],
    ['reaction-removed', { type: 'reaction', instance: INSTANCE, targetExternalId: 'MSG-OUT-0001', emoji: null }],
    ['status-delivered', { type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status: 'delivered' }],
    ['status-read', { type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status: 'read' }],
    ['connection-open', { type: 'connection', instance: INSTANCE, status: 'connected', phone: '5565988887777' }],
    ['qrcode', { type: 'qrcode', instance: INSTANCE, qrBase64: 'data:image/png;base64,iVBORw0KGgo=' }],
  ];

  it.each(cases)('%s', (name, expected) => {
    expect(parseEvolutionWebhook(fixture(name))).toEqual([expected]);
  });

  it.each([
    ['SERVER_ACK', 'sent'],
    ['DELIVERY_ACK', 'delivered'],
    ['READ', 'read'],
    ['PLAYED', 'read'],
    ['ERROR', 'failed'],
  ])('maps status %s to %s', (raw, status) => {
    const body = fixture('status-delivered');
    body.data.status = raw;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'status', instance: INSTANCE, externalId: 'MSG-OUT-0001', status }]);
  });

  it.each(['PENDING', 'DELETED', 'constructor'])('ignores status %s', (raw) => {
    const body = fixture('status-delivered');
    body.data.status = raw;
    expect(parseEvolutionWebhook(body)).toMatchObject([{ type: 'ignored' }]);
  });

  it.each([
    ['open', 'connected'],
    ['connecting', 'connecting'],
    ['close', 'disconnected'],
  ])('maps connection state %s to %s', (state, status) => {
    const body = fixture('connection-open');
    body.data.state = state;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'connection', instance: INSTANCE, status, phone: '5565988887777' }]);
  });

  it('gives phone null when connection.update has no wuid (connecting/close)', () => {
    const body = fixture('connection-open');
    body.data.state = 'close';
    delete body.data.wuid;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'connection', instance: INSTANCE, status: 'disconnected', phone: null }]);
  });

  it('ignores an unknown connection state', () => {
    const body = fixture('connection-open');
    body.data.state = 'refused';
    expect(parseEvolutionWebhook(body)).toMatchObject([{ type: 'ignored' }]);
  });
});

describe('parseEvolutionWebhook — ignored', () => {
  const cases: Array<[string, string]> = [
    ['group', 'group'],
    ['status-broadcast', 'broadcast'],
    ['protocol-revoke', 'protocol'],
    ['edited', 'edit'],
    ['unknown-event', 'event contacts.update'],
    ['status-inbound', 'status of inbound message'],
  ];

  it.each(cases)('%s', (name, reason) => {
    expect(parseEvolutionWebhook(fixture(name))).toEqual([{ type: 'ignored', reason }]);
  });

  it('ignores a reaction the office sent from the phone', () => {
    const body = fixture('reaction');
    body.data.key.fromMe = true;
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'own reaction' }]);
  });

  it('ignores a message with only metadata (no content)', () => {
    const body = fixture('text-in');
    body.data.message = { messageContextInfo: { deviceListMetadataVersion: 2 } };
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'empty message' }]);
  });

  it('ignores a JID that is neither phone nor LID', () => {
    const body = fixture('text-in');
    body.data.key.remoteJid = '120363000000000001@newsletter';
    expect(parseEvolutionWebhook(body)).toEqual([{ type: 'ignored', reason: 'no address' }]);
  });

  it.each([
    ['null', null],
    ['string', 'texto'],
    ['number', 42],
    ['empty object', {}],
    ['no instance', { event: 'messages.upsert', data: {} }],
    ['no data', { event: 'messages.upsert', instance: 'talk-test' }],
    ['key without id', { event: 'messages.upsert', instance: 'talk-test', data: { key: { remoteJid: '556599999999@s.whatsapp.net' }, message: { conversation: 'x' } } }],
  ])('never throws on malformed payload: %s', (_label, body) => {
    const events = parseEvolutionWebhook(body);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('ignored');
  });
});
