import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, isNull, max, min, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import {
  appointments, chatEvents, chatTags, chats, contacts, deletedChats, historyImports, messages, scheduledMessages, umblerMap,
} from '../db/schema.js';
import { messagePreview } from '../messages/dto.js';
import { saveMedia } from '../messages/media.js';
import { formatSignature, stripSignature } from '../messages/signature.js';
import { matchCandidates, pairUp, type Candidate } from './match.js';
import {
  UmblerError, checkStop, getAll, isGone, maps, orgQuery, pages, saveProgress, upsertContact, type ImportRun, type Query,
  type UmblerChat, type UmblerClient, type UmblerMessage,
} from './umbler.js';

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

// ---------- files (§7.8) ----------

const FILE_CONCURRENCY = 4;
/** §7.8: below this, the import stops with disk_full before the next file. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

type Saved = { path: string; size: number; sha256: string; mime: string };
type FileOutcome = Saved | 'expired' | 'temporary';
interface FileJob { key: string; file: NonNullable<Incoming['file']> }

const isSaved = (f: FileOutcome | undefined): f is Saved => typeof f === 'object';
const mediaOf = (s: Saved) => ({ mediaPath: s.path, mediaSize: s.size, mediaSha256: s.sha256, mediaMime: s.mime, mediaStatus: null });

/** Up to 4 downloads at a time, outside any transaction; the free space is checked before each file. */
async function downloadFiles(run: ImportRun, jobs: FileJob[]): Promise<Map<string, FileOutcome>> {
  const out = new Map<string, FileOutcome>();
  const dir = run.ctx.config.mediaDir;
  let next = 0;
  let full = false;
  async function worker(): Promise<void> {
    while (!full && next < jobs.length) {
      const job = jobs[next++]!;
      if (!job.file.url) {
        out.set(job.key, 'expired'); // no link, or Umbler itself failed to download it
        continue;
      }
      if ((await run.freeBytes(dir)) < MIN_FREE_BYTES) {
        full = true;
        throw new UmblerError('disk_full');
      }
      const got = await run.client.file(job.file.url);
      if ('failed' in got) {
        out.set(job.key, got.failed === 'gone' ? 'expired' : 'temporary');
        continue;
      }
      const mime = job.file.mime || got.mime;
      out.set(job.key, { ...(await saveMedia(dir, got.data, mime, job.file.name)), mime });
    }
  }
  await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, jobs.length) }, worker));
  return out;
}

// ---------- chats (§7.6) ----------

interface ChatRun {
  state: 'open' | 'closed';
  localId: string | null; // our chat: created, joined (merged) or mapped by an earlier run
  merged: boolean;
  contactId: string;
  channelId: string;
  until: Date | null; // deleted_chats tombstone of a new chat (§7.6)
  temporary: boolean; // a file failed for now: no done_at, so a new run retries it (§7.8)
}

/** The contact of the chat: mapped, or created from chat.contact (§7.4). Null = skip (deleted here, or no phone nor LID). */
async function contactOf(run: ImportRun, chat: UmblerChat): Promise<string | null> {
  const { db } = run.ctx;
  const p = run.progress;
  const [mapped] = await db
    .select({ localId: umblerMap.localId })
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'contact'), eq(umblerMap.umblerId, chat.contact.id)));
  if (mapped) {
    const [found] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, mapped.localId));
    if (!found) p.chats.skippedDeleted += 1; // the contact was deleted here: it does not come back
    return found?.id ?? null;
  }
  const id = await db.transaction(async (tx) => {
    const created = await upsertContact(tx, chat.contact, p.contacts);
    await saveProgress(tx, run);
    return created;
  });
  if (!id) p.chats.skippedNoAddress += 1;
  return id;
}

async function lastImportedAt(run: ImportRun, chatId: string): Promise<Date | null> {
  const [row] = await run.ctx.db
    .select({ at: max(messages.sentAt) })
    .from(messages)
    .innerJoin(umblerMap, and(eq(umblerMap.kind, 'message'), eq(umblerMap.localId, messages.id)))
    .where(eq(messages.chatId, chatId));
  return row?.at ?? null;
}

/** §7.6: a new open chat (or the contact's open chat here: join), or a closed one in Finalizados with its `closed` event. */
async function createChat(tx: Tx, run: ImportRun, chat: UmblerChat, st: ChatRun): Promise<string> {
  const m = maps(run);
  const p = run.progress;
  const sectorId = (chat.sector && m.sectors[chat.sector.id]) || m.defaultSector;
  const member = chat.organizationMember ? m.members[chat.organizationMember.id] : undefined;
  const createdAt = new Date(chat.createdAtUTC);
  const base = {
    id: randomUUID(), contactId: st.contactId, channelId: st.channelId, sectorId, private: chat.private ?? false,
    triagePending: false, history: false, createdAt,
  };
  let chatId: string;
  if (st.state === 'open') {
    const [row] = await tx
      .insert(chats)
      .values({
        ...base,
        ownerId: member?.active ? member.id : null, // inactive or "Sem atendente": the sector's queue
        state: 'open',
        waiting: chat.waiting ?? false,
        waitingSince: chat.waiting && chat.waitingSinceUTC ? new Date(chat.waitingSinceUTC) : null,
        unread: chat.totalUnread ?? 0,
      })
      .onConflictDoNothing() // chats_one_open_per_contact_channel
      .returning({ id: chats.id });
    if (row) {
      chatId = row.id;
      p.chats.openCreated += 1;
    } else {
      // decision §7.6: join. The chat here stays the current one (sector, owner, privacy, waiting); unread adds up.
      const [open] = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.contactId, st.contactId), eq(chats.channelId, st.channelId), eq(chats.state, 'open')));
      if (!open) throw new Error('umbler: open chat insert conflicted but none was found');
      chatId = open.id;
      await tx.update(chats).set({ unread: sql`${chats.unread} + ${chat.totalUnread ?? 0}` }).where(eq(chats.id, chatId));
      st.merged = true;
      p.chats.openMerged += 1;
    }
  } else {
    const closedAt = chat.closedAtUTC ? new Date(chat.closedAtUTC) : createdAt;
    const [row] = await tx
      .insert(chats)
      .values({ ...base, ownerId: member?.id ?? null, state: 'closed', waiting: false, unread: 0, closedAt })
      .returning({ id: chats.id });
    chatId = row!.id;
    const closedBy = (chat.closedBy && m.members[chat.closedBy.id]?.id) || null;
    // "Conversa finalizada por X" at the original time (addEvent would stamp clock_timestamp())
    await tx.insert(chatEvents).values({ id: randomUUID(), chatId, kind: 'closed', data: {}, authorId: closedBy, createdAt: closedAt });
    p.chats.closed += 1;
  }
  const tagIds = [...new Set((chat.tags ?? []).flatMap((t) => (m.tags[t.id] ? [m.tags[t.id]!] : [])))];
  if (tagIds.length) await tx.insert(chatTags).values(tagIds.map((tagId) => ({ chatId, tagId }))).onConflictDoNothing();
  await tx.insert(umblerMap).values({ kind: 'chat', umblerId: chat.id, localId: chatId });
  return chatId;
}

/**
 * last_message_at / preview from the newest message that is not a note. A WhatsApp-history chat also spans its
 * messages, and is deleted when a match took its last one (§8); its scheduled messages and appointments move to `into`
 * first (the chat its messages went to), as history/merge.ts absorb does, because the delete would cascade them away.
 */
async function refreshChat(tx: Tx, chatId: string, into?: string): Promise<'removed' | 'open' | 'closed'> {
  const [chat] = await tx.select({ state: chats.state, history: chats.history }).from(chats).where(eq(chats.id, chatId));
  if (!chat) return 'removed';
  const [last] = await tx
    .select({ kind: messages.kind, body: messages.body, direction: messages.direction, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), ne(messages.kind, 'note')))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const patch: Partial<typeof chats.$inferInsert> = {
    lastMessageAt: last?.sentAt ?? null,
    // the preview is unsigned, as for this system's own sends
    lastMessagePreview: last ? messagePreview(last.kind, last.direction === 'out' && last.body ? stripSignature(last.body) : last.body) : null,
  };
  if (chat.history) {
    const [span] = await tx.select({ first: min(messages.sentAt), last: max(messages.sentAt) }).from(messages).where(eq(messages.chatId, chatId));
    if (!span?.first) {
      if (into) {
        // spec 2026-10-20 agendamentos §3.3 and 2026-10-21 compromissos §3.8: they follow the chat (reminders with their appointment)
        await tx.update(scheduledMessages).set({ chatId: into }).where(eq(scheduledMessages.chatId, chatId));
        await tx.update(appointments).set({ chatId: into }).where(eq(appointments.chatId, chatId));
      }
      await tx.delete(chats).where(eq(chats.id, chatId));
      return 'removed';
    }
    patch.createdAt = span.first;
    patch.closedAt = span.last;
  }
  await tx.update(chats).set(patch).where(eq(chats.id, chatId));
  return chat.state;
}

async function replyOf(tx: Tx, i: Incoming, page: Map<string, string>): Promise<string | null> {
  if (!i.replyUmblerId) return null;
  const here = page.get(i.replyUmblerId);
  if (here) return here;
  const [row] = await tx
    .select({ id: messages.id })
    .from(umblerMap)
    .innerJoin(messages, eq(messages.id, umblerMap.localId))
    .where(and(eq(umblerMap.kind, 'message'), eq(umblerMap.umblerId, i.replyUmblerId)));
  return row?.id ?? null; // §7.7: quoted message imported already (any chat), else none
}

/** §7.8 (1) decide reading only, (2) download outside any transaction, (3) write the page in one transaction. */
async function placePage(run: ImportRun, chat: UmblerChat, st: ChatRun, all: Incoming[]): Promise<void> {
  const { ctx } = run;
  const m = maps(run);
  const p = run.progress;
  const known = new Set(run.analysis.members.map((x) => x.id));
  const items = st.until ? all.filter((i) => i.at > st.until!) : all; // tombstone: deleted here, stays out (§7), also on resume
  if (items.length === 0) return;

  // (1) what is in umbler_map already (a gone local row stays gone), and what §8 matches
  const mappedRows = await ctx.db
    .select({ umblerId: umblerMap.umblerId, id: messages.id, mediaPath: messages.mediaPath, mediaStatus: messages.mediaStatus })
    .from(umblerMap)
    .leftJoin(messages, eq(messages.id, umblerMap.localId))
    .where(and(eq(umblerMap.kind, 'message'), inArray(umblerMap.umblerId, items.map((i) => i.umblerId))));
  const mapped = new Map(mappedRows.map((r) => [r.umblerId, r]));
  const fresh = items.filter((i) => !mapped.has(i.umblerId));
  const comparable = fresh.filter((i) => i.kind !== 'note'); // a note never matches (§8)
  const scope = { contactId: st.contactId, channelId: st.channelId };
  const pairs = pairUp(
    comparable.map((i) => ({ direction: i.direction, kind: i.matchKind, text: i.matchText, at: i.at })),
    await matchCandidates(ctx.db, scope, comparable, 'ours'),
  );
  const match = new Map<string, { row: Candidate; diffMs: number }>();
  comparable.forEach((i, n) => {
    const pair = pairs[n];
    if (pair) match.set(i.umblerId, pair);
  });

  // (2) files: new rows, matched rows without a file (§7.8 "ganho"), and mapped rows whose file was unavailable
  const jobs: FileJob[] = [];
  for (const i of fresh) if (i.file && !match.get(i.umblerId)?.row.mediaPath) jobs.push({ key: i.umblerId, file: i.file });
  const retry = items.filter((i) => {
    const r = mapped.get(i.umblerId);
    return i.file?.url && r?.id && !r.mediaPath && r.mediaStatus === 'expired';
  });
  for (const i of retry) jobs.push({ key: i.umblerId, file: i.file! });
  if (fresh.length === 0 && retry.length === 0) return; // a page read again on a new run: nothing to write
  const files = await downloadFiles(run, jobs);
  if ([...files.values()].includes('temporary')) st.temporary = true;

  // (3) one transaction for the page
  const removed: string[] = [];
  const openSources: string[] = [];
  await ctx.db.transaction(async (tx) => {
    st.localId ??= await createChat(tx, run, chat, st);
    const chatId = st.localId;
    const page = new Map<string, string>();
    const sources = new Set<string>();
    for (const i of fresh) {
      let author: string | null = null;
      if (i.authorUmblerId) {
        author = m.members[i.authorUmblerId]?.id ?? null;
        if (!known.has(i.authorUmblerId)) p.messages.unknownAuthor += 1; // removed from Umbler, or an AI agent (§7.2)
      }
      const file = files.get(i.umblerId);
      const pair = match.get(i.umblerId);
      let id: string;
      if (pair) {
        // §8: nothing is inserted; our row keeps its id, WhatsApp id, status and file, and moves to the imported chat
        id = pair.row.id;
        await tx
          .update(messages)
          .set({
            chatId,
            authorId: pair.row.authorId ?? author,
            ...(i.matchKind !== i.kind ? { kind: i.kind, body: i.body } : {}), // location / contact card: the §7.7 text
            ...(isSaved(file) ? mediaOf(file) : {}),
          })
          .where(eq(messages.id, id));
        if (pair.row.chatId !== chatId) sources.add(pair.row.chatId);
        p.messages.matched += 1;
        p.messages.maxMatchDiffMs = Math.max(p.messages.maxMatchDiffMs, pair.diffMs);
      } else {
        id = randomUUID();
        await tx.insert(messages).values({
          id, chatId, channelId: st.channelId, direction: i.direction, kind: i.kind, body: i.body,
          mediaName: i.file?.name ?? null,
          mediaMime: i.file ? (isSaved(file) ? file.mime : i.file.mime) : null,
          mediaSize: i.file ? (isSaved(file) ? file.size : i.file.size) : null,
          mediaPath: isSaved(file) ? file.path : null,
          mediaSha256: isSaved(file) ? file.sha256 : null,
          mediaStatus: i.file && !isSaved(file) ? 'expired' : null, // "Arquivo não está mais disponível…"
          authorId: author, replyToId: await replyOf(tx, i, page), externalId: null,
          reaction: i.reaction, officeReaction: i.officeReaction, status: i.status,
          deletedAt: i.deletedAt, deletedSource: i.deletedAt ? (i.direction === 'in' ? 'contact' : 'office') : null,
          editedAt: i.editedAt, sentAt: i.at, createdAt: i.at,
        });
      }
      await tx.insert(umblerMap).values({ kind: 'message', umblerId: i.umblerId, localId: id }).onConflictDoNothing();
      page.set(i.umblerId, id);
      p.messages.total += 1;
      if (i.kind === 'note') p.messages.notes += 1;
      if (i.bot) p.messages.bot += 1;
      if (i.redacted) p.messages.redacted += 1;
      if (isSaved(file)) {
        p.files.saved += 1;
        p.files.bytes += file.size;
      } else if (i.file && !(pair?.row.mediaPath)) {
        p.files.expired += 1;
      }
    }
    for (const i of retry) {
      const file = files.get(i.umblerId);
      if (!isSaved(file)) continue;
      await tx.update(messages).set(mediaOf(file)).where(and(eq(messages.id, mapped.get(i.umblerId)!.id!), isNull(messages.mediaPath)));
      p.files.saved += 1;
      p.files.bytes += file.size;
      p.files.expired -= 1;
    }
    await refreshChat(tx, chatId);
    for (const id of sources) {
      const r = await refreshChat(tx, id, chatId);
      if (r === 'removed') removed.push(id);
      else if (r === 'open') openSources.push(id);
    }
    await saveProgress(tx, run);
  });
  for (const id of removed) ctx.hub.publishChatRemoved(id);
  for (const id of openSources) await ctx.hub.publishChat(id);
}

/** The first time the chat is complete: the waiting_since fallback (§7.6) and "Conversa importada do Umbler Talk". */
async function finishChat(run: ImportRun, chat: UmblerChat, st: ChatRun): Promise<void> {
  const { ctx } = run;
  if (!st.localId) {
    run.progress.chats.skippedEmpty += 1; // no message at all (§7.6)
    await saveProgress(ctx.db, run);
    return;
  }
  const chatId = st.localId;
  await ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(and(eq(chatEvents.chatId, chatId), eq(chatEvents.kind, 'umbler_imported')));
    if (!event) {
      if (st.state === 'open' && !st.merged) {
        const lastIn = sql`(select max(${messages.sentAt}) from ${messages} where ${messages.chatId} = ${chatId} and ${messages.direction} = 'in')`;
        await tx.update(chats).set({ waitingSince: lastIn }).where(and(eq(chats.id, chatId), eq(chats.waiting, true), isNull(chats.waitingSince)));
      }
      const [{ n }] = await tx
        .select({ n: count() })
        .from(umblerMap)
        .innerJoin(messages, eq(messages.id, umblerMap.localId))
        .where(and(eq(umblerMap.kind, 'message'), eq(messages.chatId, chatId)));
      await tx.insert(chatEvents).values({
        id: randomUUID(), chatId, kind: 'umbler_imported', data: st.merged ? { count: n, merged: true } : { count: n },
        authorId: null, createdAt: new Date(chat.createdAtUTC),
      });
    }
    if (!st.temporary) {
      await tx.update(umblerMap).set({ doneAt: new Date() }).where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id)));
    }
  });
  if (st.state === 'open') await ctx.hub.publishChat(chatId); // §7.6: it shows up in the Entrada; closed ones never publish
}

/**
 * §7.6: copies one Umbler chat page by page (Take=250). Returns false when it made no message call (channel "Não
 * importar", deleted here, no phone nor LID, or a finished closed chat).
 */
export async function importChat(run: ImportRun, chat: UmblerChat, state: 'open' | 'closed'): Promise<boolean> {
  const { ctx } = run;
  const p = run.progress;
  const channelId = run.mapping.channels[chat.channel.id];
  if (!channelId || channelId === 'none') {
    p.chats.skippedChannel += 1;
    return false;
  }
  const [mapped] = await ctx.db
    .select()
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'chat'), eq(umblerMap.umblerId, chat.id)));
  if (mapped) {
    const [local] = await ctx.db.select({ id: chats.id }).from(chats).where(eq(chats.id, mapped.localId));
    if (!local) {
      p.chats.skippedDeleted += 1; // deleted here: never comes back
      return false;
    }
    if (mapped.doneAt && state === 'closed') return false; // §9.2: no message call
  }
  const contactId = await contactOf(run, chat);
  if (!contactId) return false;
  const [tomb] = mapped?.doneAt
    ? []
    : await ctx.db
        .select({ until: max(deletedChats.until) })
        .from(deletedChats)
        .where(and(eq(deletedChats.contactId, contactId), eq(deletedChats.channelId, channelId)));
  const st: ChatRun = {
    state, localId: mapped?.localId ?? null, merged: false, contactId, channelId, until: tomb?.until ?? null, temporary: false,
  };
  // §9.2: a finished open chat is read again from its last imported message - 1 ms; an unfinished one from the start
  // (what is mapped is dropped, and its unavailable files are tried again)
  const last = mapped?.doneAt ? await lastImportedAt(run, mapped.localId) : null;
  let from = last ? new Date(last.getTime() - 1) : new Date(FIRST_EVENT);
  const seen = new Set<string>();
  for (;;) {
    checkStop(run);
    let page: MessagePage;
    try {
      page = await fetchMessagePage(run.client, run.org, chat.id, from);
    } catch (err) {
      if (!isGone(err)) throw err;
      p.gone += 1; // deleted in Umbler during the copy
      return true;
    }
    if (page.hasMessagesBeforeAllowedOrganizationPlan) p.planLimited = true;
    const list = page.messages ?? [];
    const fresh = list.filter((x) => !seen.has(x.id));
    for (const x of fresh) seen.add(x.id);
    const items = fresh.map(toIncoming).filter((i): i is Incoming => i !== null).sort(byTime);
    await placePage(run, chat, st, items);
    // the limit may or may not be inclusive: next page from the last one - 1 ms, ids already seen dropped (§4)
    if (list.length < MESSAGES_TAKE || fresh.length === 0) break;
    from = new Date(Math.max(...list.map((x) => Date.parse(x.eventAtUTC))) - 1);
  }
  await finishChat(run, chat, st);
  return true;
}

// ---------- phases 3 and 5 (§9.1) ----------

const HISTORY_WAIT_MS = 15_000;

/** §9.3: the WhatsApp history copy writes into the same chats and §8 assumes one at a time: wait while one runs. */
async function waitForHistory(run: ImportRun): Promise<void> {
  while ((await run.ctx.db.$count(historyImports, eq(historyImports.state, 'running'))) > 0) {
    checkStop(run);
    await run.sleep(HISTORY_WAIT_MS);
  }
}

/** §5.2: after copying a chat that had unread messages, its unread count must not have dropped without an agent reply. */
async function checkUnread(run: ImportRun, before: UmblerChat): Promise<void> {
  const page = await run.client.get<{ items?: UmblerChat[] }>(
    '/v1/contacts/{id}/chats/',
    { ...orgQuery(run), ChatState: 'Open', Skip: 0, Take: 50 },
    { id: before.contact.id },
  );
  const after = page.items?.find((c) => c.id === before.id);
  if (!after) return;
  const agentReplied = after.lastMessage?.source === 'Member' && after.lastMessage.id !== before.lastMessage?.id;
  if ((after.totalUnread ?? 0) < (before.totalUnread ?? 0) && !agentReplied) {
    throw new UmblerError('umbler_marked_read', null, '/v1/contacts/{id}/chats/');
  }
}

/** Phase 3 (§9.1): every open chat listed first; the ones without unread messages copied first (§5.2). */
export async function importOpenChats(run: ImportRun): Promise<void> {
  const list = await getAll<UmblerChat>(run.client, '/v1/chats/', chatQuery(run.org, 'open'));
  const ordered = [...list.filter((c) => !c.totalUnread), ...list.filter((c) => (c.totalUnread ?? 0) > 0)];
  const p = run.progress;
  p.total = ordered.length;
  for (const chat of ordered) {
    checkStop(run);
    await waitForHistory(run);
    const read = await importChat(run, chat, 'open');
    if (read && (chat.totalUnread ?? 0) > 0) await checkUnread(run, chat);
    p.done += 1;
    await saveProgress(run.ctx.db, run);
  }
}

/** Phase 5 (§9.1): finished chats, newest first, one list page at a time (§11: memory of one page). */
export async function importClosedChats(run: ImportRun): Promise<void> {
  const p = run.progress;
  p.total = run.analysis.chats.closed;
  for await (const page of pages<UmblerChat>(run.client, '/v1/chats/', chatQuery(run.org, 'closed'))) {
    for (const chat of page.items) {
      checkStop(run);
      await waitForHistory(run);
      await importChat(run, chat, 'closed');
      p.done += 1;
    }
    await saveProgress(run.ctx.db, run);
  }
}
