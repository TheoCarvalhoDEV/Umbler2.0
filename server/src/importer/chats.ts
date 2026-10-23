import { messages } from '../db/schema.js';
import { formatSignature } from '../messages/signature.js';
import type { Query, UmblerClient, UmblerMessage } from './umbler.js';

// Spec 2026-10-21 importar-umbler §7.6-7.8: Umbler chats and their messages, page by page.

/** §4: the first relative-messages page starts here; the next one at the last eventAtUTC - 1 ms. */
export const FIRST_EVENT = '2000-01-01T00:00:00Z';
export const MESSAGES_TAKE = 250; // the route's maximum

/** §4: direct conversations only, hidden ones included, without the token owner's pinned chats mixed in. */
export function chatQuery(org: string, state: 'open' | 'closed'): Query {
  return {
    organizationId: org,
    ContactTypes: ['DirectMessage'],
    Visibility: ['Show', 'Hide', 'HideUntilNextMessage'],
    IncludePinneds: false,
    ...(state === 'open'
      ? { ChatState: 'Open', ChatOrderBy: 'CreatedAtUTC', Order: 'Asc' }
      : { ChatState: 'Closed', ChatOrderBy: 'ClosedAtUTC', Order: 'Desc' }),
  };
}

export interface MessagePage { hasMessagesBeforeAllowedOrganizationPlan?: boolean; messages?: UmblerMessage[] }

/** One relative-messages page from `from` on (§4), without timeline events. "Analisar" reads with it too (§5.1). */
export function fetchMessagePage(client: UmblerClient, org: string, chatId: string, from: Date): Promise<MessagePage> {
  return client.get<MessagePage>(
    '/v1/chats/{chatId}/relative-messages/',
    { organizationId: org, FromEventUTC: from.toISOString(), Direction: 'TakeAfter', Take: MESSAGES_TAKE, IncludeMetadata: false },
    { chatId },
  );
}

// ---------- §7.7: one Umbler message as one of our rows ----------

type Kind = (typeof messages.$inferSelect)['kind'];
type Status = (typeof messages.$inferSelect)['status'];

export interface Incoming {
  umblerId: string;
  at: Date;
  direction: 'in' | 'out';
  kind: Kind;
  body: string | null;
  /** §8.2: what the WhatsApp history stored for it (a location or a contact card is 'unsupported' with no text there) */
  matchKind: Kind;
  matchText: string | null;
  authorUmblerId: string | null;
  bot: boolean;
  status: Status;
  reaction: string | null;
  officeReaction: string | null;
  replyUmblerId: string | null;
  deletedAt: Date | null;
  editedAt: Date | null;
  redacted: boolean;
  file: { url: string | null; mime: string | null; name: string | null; size: number | null } | null;
}

const KEPT = new Set(['MessageModel', 'SentMessageModel']);
const STATUS: Record<string, Status> = { Read: 'read', Played: 'read', Received: 'delivered', Failed: 'failed', Error: 'failed' };
const TEXT_TYPES = new Set(['Text', 'Url', 'ListReply', 'ButtonReply', 'QuickReply']);
const MEDIA_TYPES: Record<string, Kind> = { Image: 'image', Gif: 'image', Video: 'video', Audio: 'audio', Sticker: 'sticker', File: 'document' };

function latestReaction(m: UmblerMessage, sources: string[]): string | null {
  const list = (m.reactions ?? []).filter((r) => sources.includes(r.source ?? ''));
  list.sort((a, b) => Date.parse(a.eventAtUTC) - Date.parse(b.eventAtUTC));
  return list.at(-1)?.emoji ?? null;
}

function locationText(l: NonNullable<UmblerMessage['location']>): string {
  const label = (l.name || l.address || '').trim();
  return `Localização: ${label ? `${label} ` : ''}https://maps.google.com/?q=${l.latitude},${l.longitude}`;
}

function contactText(list: NonNullable<UmblerMessage['contacts']>): string {
  return list.map((c) => ['Contato:', c.name?.trim(), ...(c.phoneNumbers ?? [])].filter(Boolean).join(' ')).join('\n');
}

/** §7.7; null for what is never a message of its own (timeline items, loose reactions). */
export function toIncoming(m: UmblerMessage): Incoming | null {
  if (!KEPT.has(m._t) || m.messageType === 'Reaction') return null;
  const at = new Date(m.eventAtUTC);
  const type = m.messageType ?? 'Unsupported';
  const content = m.content ?? null;
  const note = m.isPrivate === true;
  const redacted = !note && m.messageState === 'Redacted';
  const direction = note || m.source !== 'Contact' ? 'out' : 'in'; // Member, Bot and External (the phone) are the office
  let kind: Kind;
  let body: string | null;
  let asStored: Kind | null = null; // how the WhatsApp history stores it, when that differs
  if (note) {
    kind = 'note';
    body = content;
  } else if (redacted) {
    kind = 'unsupported';
    body = null;
  } else if (type === 'Location' && m.location) {
    kind = 'text';
    body = locationText(m.location);
    asStored = 'unsupported';
  } else if (type === 'Contact' && m.contacts?.length) {
    kind = 'text';
    body = contactText(m.contacts);
    asStored = 'unsupported';
  } else if (TEXT_TYPES.has(type) || (type === 'List' && content)) {
    kind = 'text';
    // the signature line the client received, as this system stores its own sends
    body = direction === 'out' && m.prefix && content !== null ? formatSignature(content, m.prefix) : content;
  } else if (MEDIA_TYPES[type]) {
    kind = MEDIA_TYPES[type]!;
    body = m.file?.caption ?? content;
  } else {
    kind = 'unsupported'; // Payment, Order, Poll, Carousel, CallAttempt, Unsupported
    body = content;
  }
  const media = !note && !redacted && MEDIA_TYPES[type] !== undefined;
  return {
    umblerId: m.id,
    at,
    direction,
    kind,
    body,
    matchKind: asStored ?? kind,
    matchText: asStored ? null : body,
    authorUmblerId: m.sentByOrganizationMember?.id ?? null,
    bot: m.source === 'Bot',
    status: note ? 'sent' : (STATUS[m.messageState ?? ''] ?? 'sent'),
    reaction: latestReaction(m, ['Contact']),
    officeReaction: latestReaction(m, ['Member', 'External']),
    replyUmblerId: m.inReplyTo?.id ?? null,
    deletedAt: m.messageState === 'Deleted' ? at : null,
    editedAt: m.messageState === 'Edited' ? new Date(m.latestEdit?.senderAtUTC ?? m.eventAtUTC) : null,
    redacted,
    file: media
      ? {
          url: m.file?.failDownload ? null : (m.file?.url ?? null),
          mime: m.file?.contentType ?? null,
          name: m.file?.originalName ?? null,
          size: m.file?.originalSizeBytes ?? null,
        }
      : null,
  };
}

const byTime = (a: Incoming, b: Incoming) => a.at.getTime() - b.at.getTime() || a.umblerId.localeCompare(b.umblerId);
