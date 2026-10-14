import { lidFromJid, phoneFromJid } from './phone.js';
import type { ChannelStatus, InboundEvent, MessageKind } from './types.js';

// Evolution payloads are untrusted JSON: read loosely, check every field we use, never throw.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const ignored = (reason: string): InboundEvent => ({ type: 'ignored', reason });

/** Containers Baileys wraps around the real content. */
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage'];
/** Keys that travel next to the content but are not content. */
const META = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'base64', 'mediaUrl']);
// Maps (not object literals) so untrusted keys like "constructor" never hit the prototype.
const MEDIA = new Map<string, MessageKind>([
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
]);
const STATUS = new Map<string, 'sent' | 'delivered' | 'read' | 'failed'>([
  ['SERVER_ACK', 'sent'],
  ['DELIVERY_ACK', 'delivered'],
  ['READ', 'read'],
  ['PLAYED', 'read'],
  ['ERROR', 'failed'],
]);
const CONNECTION = new Map<string, ChannelStatus>([
  ['open', 'connected'],
  ['connecting', 'connecting'],
  ['close', 'disconnected'],
]);

export function parseEvolutionWebhook(body: unknown): InboundEvent[] {
  if (!isObj(body) || typeof body.event !== 'string') return [ignored('invalid payload')];
  const instance = str(body.instance);
  if (!instance) return [ignored('missing instance')];
  const event = body.event.toLowerCase().replace(/_/g, '.');
  const items: unknown[] = Array.isArray(body.data) ? body.data : [body.data];
  if (items.length === 0) return [ignored('empty data')];
  switch (event) {
    case 'messages.upsert':
      return items.map((d) => parseUpsert(instance, d));
    case 'messages.update':
      return items.map((d) => parseUpdate(instance, d));
    case 'connection.update':
      return [parseConnection(instance, body.data)];
    case 'qrcode.updated':
      return [parseQrCode(instance, body.data)];
    default:
      return [ignored(`event ${event}`)];
  }
}

function unwrap(m: unknown): Obj | null {
  if (!isObj(m)) return null;
  for (const w of WRAPPERS) if (isObj(m[w]?.message)) return unwrap(m[w].message);
  return m;
}

/** Baileys timestamps are seconds: number, numeric string or Long {low, high}. */
function toDate(ts: unknown): Date {
  const n = isObj(ts) ? Number(ts.high ?? 0) * 2 ** 32 + (Number(ts.low ?? 0) >>> 0) : Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

function parseUpsert(instance: string, data: unknown): InboundEvent {
  if (!isObj(data) || !isObj(data.key)) return ignored('invalid message');
  const key = data.key;
  const remoteJid = str(key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us')) return ignored('group');
  if (remoteJid.endsWith('@broadcast')) return ignored('broadcast');
  const externalId = str(key.id);
  if (!externalId) return ignored('missing id');
  const fromMe = key.fromMe === true;

  const msg = unwrap(data.message);
  if (!msg || !Object.keys(msg).some((k) => !META.has(k))) return ignored('empty message');
  if (msg.protocolMessage) return ignored('protocol');
  if (msg.editedMessage) return ignored('edit');
  if (isObj(msg.reactionMessage)) {
    // The office reacting from the phone would overwrite the contact's reaction (one slot per message).
    if (fromMe) return ignored('own reaction');
    const target = str(msg.reactionMessage.key?.id);
    if (!target) return ignored('invalid reaction');
    return { type: 'reaction', instance, targetExternalId: target, emoji: str(msg.reactionMessage.text) };
  }

  let kind: MessageKind = 'unsupported';
  let part: Obj = {};
  let body: string | null = null;
  const mediaKey = [...MEDIA.keys()].find((k) => isObj(msg[k]));
  if (typeof msg.conversation === 'string') {
    kind = 'text';
    body = msg.conversation;
  } else if (isObj(msg.extendedTextMessage)) {
    kind = 'text';
    part = msg.extendedTextMessage;
    body = str(part.text);
  } else if (mediaKey) {
    kind = MEDIA.get(mediaKey) ?? 'unsupported';
    part = msg[mediaKey];
    body = str(part.caption);
  }
  const hasMedia = kind !== 'text' && kind !== 'unsupported';

  const jids = [remoteJid, key.remoteJidAlt, key.senderPn].filter((j): j is string => typeof j === 'string');
  const phone = jids.map((j) => phoneFromJid(j)).find((p) => p !== null) ?? null;
  const lid = jids.map((j) => lidFromJid(j)).find((l) => l !== null) ?? null;
  if (!phone && !lid) return ignored('no address');

  return {
    type: 'message',
    instance,
    externalId,
    direction: fromMe ? 'out' : 'in',
    phone,
    lid,
    // On fromMe, Evolution's pushName is the office's own name — never use it as the contact's name.
    pushName: fromMe ? null : str(data.pushName),
    kind,
    body,
    hasMedia,
    mediaMime: hasMedia ? str(part.mimetype) : null,
    mediaName: kind === 'document' ? str(part.fileName) : null,
    replyToExternalId: str(part.contextInfo?.stanzaId) ?? (isObj(data.contextInfo) ? str(data.contextInfo.stanzaId) : null),
    sentAt: toDate(data.messageTimestamp),
    raw: { key, message: data.message },
  };
}

function parseUpdate(instance: string, data: unknown): InboundEvent {
  if (!isObj(data)) return ignored('invalid update');
  const key = isObj(data.key) ? data.key : {};
  const remoteJid = str(data.remoteJid ?? key.remoteJid) ?? '';
  if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) return ignored('group status');
  // Statuses only matter for messages we sent; READ on an inbound message means the office read it on the phone.
  if ((data.fromMe ?? key.fromMe) === false) return ignored('status of inbound message');
  const externalId = str(data.keyId) ?? str(key.id);
  if (!externalId) return ignored('missing id');
  const status = STATUS.get(String(data.status));
  return status ? { type: 'status', instance, externalId, status } : ignored(`status ${String(data.status)}`);
}

function parseConnection(instance: string, data: unknown): InboundEvent {
  if (!isObj(data)) return ignored('unknown connection state');
  const status = CONNECTION.get(String(data.state));
  // wuid = the connected number's own JID (owner); absent while connecting/closed.
  const wuid = str(data.wuid);
  const phone = wuid ? phoneFromJid(wuid) : null;
  return status ? { type: 'connection', instance, status, phone } : ignored('unknown connection state');
}

function parseQrCode(instance: string, data: unknown): InboundEvent {
  const qrBase64 = isObj(data) && isObj(data.qrcode) ? str(data.qrcode.base64) : null;
  return qrBase64 ? { type: 'qrcode', instance, qrBase64 } : ignored('qrcode without image');
}
