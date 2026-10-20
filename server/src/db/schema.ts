import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  BotGraph, BotRunState, BotRunStep, BotRunVars, ChatEventKind, HistoryImportState, HistoryPeriod, MessageChangeSource,
  UserPreferences,
} from '@talk/shared';

// ponytail: enums are text + TS unions (contract); no pg enums to migrate.
const id = () => uuid('id').primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<'admin' | 'agent'>().notNull(),
  signature: text('signature'),
  active: boolean('active').notNull().default(true),
  seeAllSectors: boolean('see_all_sectors').notNull().default(false),
  avatarPath: text('avatar_path'),
  createdAt: createdAt(),
  // Spec 2026-10-19 §6: only what the user changed; readPreferences (auth/preferences.ts) fills in the defaults.
  preferences: jsonb('preferences').$type<Partial<UserPreferences>>().notNull().default({}),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(), // SHA-256 hex of the cookie token
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const sectors = pgTable(
  'sectors',
  {
    id: id(),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [uniqueIndex('sectors_one_default').on(t.isDefault).where(sql`${t.isDefault} = true`)],
);

export const userSectors = pgTable(
  'user_sectors',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sectorId: uuid('sector_id').notNull().references(() => sectors.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sectorId] })],
);

export const channels = pgTable('channels', {
  id: id(),
  name: text('name').notNull(),
  kind: text('kind').$type<'whatsapp_qr'>().notNull().default('whatsapp_qr'),
  evolutionInstance: text('evolution_instance').notNull().unique(),
  status: text('status').$type<'disconnected' | 'connecting' | 'connected'>().notNull().default('disconnected'),
  phone: text('phone'),
  createdAt: createdAt(),
  historyPeriod: text('history_period').$type<HistoryPeriod>().notNull().default('3m'), // §5.1: what a QR pairing imports
  backfillUntil: timestamp('backfill_until', { withTimezone: true }), // §6: Evolution rows up to here were copied
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }), // §7: start of the current outage (admin banner)
});

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    name: text('name'),
    phone: text('phone'), // canonical 13 digits (normalizePhoneBR)
    lid: text('lid'),
    email: text('email'),
    landline: text('landline'),
    address: jsonb('address').$type<Record<string, string>>(),
    blocked: boolean('blocked').notNull().default(false),
    avatarPath: text('avatar_path'),
    avatarCheckedAt: timestamp('avatar_checked_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('contacts_phone_unique').on(t.phone).where(sql`${t.phone} is not null`),
    uniqueIndex('contacts_lid_unique').on(t.lid).where(sql`${t.lid} is not null`),
  ],
);

export const customFields = pgTable('custom_fields', {
  id: id(),
  name: text('name').notNull().unique(),
  kind: text('kind').$type<'text' | 'number' | 'date' | 'cpf' | 'cnpj'>().notNull(),
  position: integer('position').notNull().default(0),
});

export const contactFieldValues = pgTable(
  'contact_field_values',
  {
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    fieldId: uuid('field_id').notNull().references(() => customFields.id, { onDelete: 'cascade' }),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.fieldId] })],
);

export const contactNotes = pgTable('contact_notes', {
  id: id(),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  createdAt: createdAt(),
});

export const tags = pgTable('tags', {
  id: id(),
  name: varchar('name', { length: 30 }).notNull().unique(),
  emoji: text('emoji'),
  color: text('color').notNull(),
  position: integer('position').notNull().default(0),
});

export const contactTags = pgTable(
  'contact_tags',
  {
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] })],
);

export const chats = pgTable(
  'chats',
  {
    id: id(),
    contactId: uuid('contact_id').notNull().references(() => contacts.id),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    sectorId: uuid('sector_id').notNull().references(() => sectors.id),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    state: text('state').$type<'open' | 'closed'>().notNull().default('open'),
    waiting: boolean('waiting').notNull().default(false),
    private: boolean('private').notNull().default(false),
    triagePending: boolean('triage_pending').notNull().default(false),
    unread: integer('unread').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    lastMessagePreview: text('last_message_preview'),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    history: boolean('history').notNull().default(false), // §5.3: imported from the phone; closed, read-only, visible to all
    // spec 2026-10-20 §3: the oldest contact message still unanswered; null whenever `waiting` is false
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chats_one_open_per_contact_channel')
      .on(t.contactId, t.channelId)
      .where(sql`${t.state} = 'open'`),
    index('chats_last_message_at_idx').on(t.lastMessageAt),
    // §5.3: later imports append to the contact's one history chat on the channel
    uniqueIndex('chats_one_history_per_contact_channel')
      .on(t.contactId, t.channelId)
      .where(sql`${t.history} = true`),
  ],
);

export const chatPins = pgTable(
  'chat_pins',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chatId] })],
);

/** Spec 2026-10-20 §5: the conversation's own tags, from the same catalog as the contact's. */
export const chatTags = pgTable(
  'chat_tags',
  {
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.tagId] })],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channels.id),
    direction: text('direction').$type<'in' | 'out'>().notNull(),
    kind: text('kind')
      .$type<'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported'>()
      .notNull(),
    body: text('body'),
    mediaPath: text('media_path'), // relative to config.mediaDir
    mediaMime: text('media_mime'),
    mediaSize: integer('media_size'),
    mediaName: text('media_name'),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }), // null = contact, phone or system
    replyToId: uuid('reply_to_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    externalId: text('external_id'), // null for notes and pending sends
    reaction: text('reaction'),
    status: text('status').$type<'pending' | 'sent' | 'delivered' | 'read' | 'failed'>().notNull().default('pending'),
    error: text('error'),
    botRunId: uuid('bot_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }), // set = sent by a chatbot
    // Message actions (spec 2026-10-16 §8). `reaction` is the contact's; this is the office's (agent or office phone).
    officeReaction: text('office_reaction'),
    // Deleted for everyone: the text stays for the team, the bubble shows who deleted it.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }), // office deletes only
    deletedSource: text('deleted_source').$type<MessageChangeSource>(),
    editedAt: timestamp('edited_at', { withTimezone: true }), // previous texts live in message_edits
    forwardedFromId: uuid('forwarded_from_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    mediaSha256: text('media_sha256'), // hex digest of the stored file; dedupes the recent stickers (spec §6)
    mediaStatus: text('media_status').$type<'queued' | 'expired'>(), // §5.5 history media: waiting for the queue, or gone from WhatsApp
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // NULLs never collide, so notes/pending rows coexist; ingest uses ON CONFLICT (channel_id, external_id).
    uniqueIndex('messages_channel_external_unique').on(t.channelId, t.externalId),
    index('messages_chat_sent_idx').on(t.chatId, t.sentAt),
    index('messages_media_queued_idx').on(t.sentAt).where(sql`${t.mediaStatus} = 'queued'`),
  ],
);

export const chatEvents = pgTable(
  'chat_events',
  {
    id: id(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ChatEventKind>().notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('chat_events_chat_idx').on(t.chatId, t.createdAt)],
);

export const quickAnswers = pgTable('quick_answers', {
  id: id(),
  name: text('name').notNull(),
  body: text('body').notNull(),
  attachmentPath: text('attachment_path'), // relative to config.mediaDir
  visibility: text('visibility').$type<'all' | 'owner'>().notNull().default('all'),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(), // 'closing_message' | 'triage_menu'
  value: jsonb('value').$type<unknown>().notNull(),
});

export const bots = pgTable('bots', {
  id: id(),
  name: text('name').notNull().unique(),
  description: text('description').notNull().default(''),
  status: text('status').$type<'active' | 'paused'>().notNull().default('paused'),
  startChannelIds: uuid('start_channel_ids').array().notNull().default(sql`'{}'::uuid[]`), // empty = never starts by channel
  manualStart: boolean('manual_start').notNull().default(false),
  manualTitle: text('manual_title').notNull().default(''),
  manualUnlisted: boolean('manual_unlisted').notNull().default(false),
  publishedVersionId: uuid('published_version_id').references((): AnyPgColumn => botVersions.id, { onDelete: 'set null' }),
  runCount: integer('run_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const botVersions = pgTable(
  'bot_versions',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    graph: jsonb('graph').$type<BotGraph>().notNull(),
    valid: boolean('valid').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bot_versions_bot_number_unique').on(t.botId, t.number)],
); // immutable: no code path UPDATEs a bot_versions row (test/bots/repo.test.ts scans src for it)

export const botRuns = pgTable(
  'bot_runs',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => bots.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').notNull().references(() => botVersions.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    state: text('state').$type<BotRunState>().notNull().default('running'),
    currentNodeId: text('current_node_id').notNull(),
    waitNodeId: text('wait_node_id'),
    wakeAt: timestamp('wake_at', { withTimezone: true }),
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
    waitingSince: timestamp('waiting_since', { withTimezone: true }), // clock_timestamp() when entering waiting_reply (Review Focus 1)
    retries: integer('retries').notNull().default(0), // invalid attempts on the current ask node; reset on every node change
    vars: jsonb('vars').$type<BotRunVars>().notNull().default({}),
    steps: jsonb('steps').$type<BotRunStep[]>().notNull().default([]),
    depth: integer('depth').notNull().default(0),
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => botRuns.id, { onDelete: 'set null' }),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }), // null = channel or call_flow
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('bot_runs_state_wake_idx').on(t.state, t.wakeAt),
    index('bot_runs_state_timeout_idx').on(t.state, t.timeoutAt),
    index('bot_runs_chat_idx').on(t.chatId),
    // spec §3 "max 1 non-terminal run per (chat, bot)": root runs only, so call_flow may re-enter the same bot (depth limit applies).
    // Keep the state list in sync with NON_TERMINAL_RUN_STATES (shared/src/bots.ts).
    uniqueIndex('bot_runs_one_active_per_chat_bot')
      .on(t.chatId, t.botId)
      .where(sql`${t.state} in ('running','waiting_reply','waiting_timer','waiting_flow') and ${t.depth} = 0`),
  ],
);

/** Spec §5: one row per edit, holding the text the message had before it. */
export const messageEdits = pgTable(
  'message_edits',
  {
    id: id(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    previousBody: text('previous_body'),
    source: text('source').$type<MessageChangeSource>().notNull(),
    editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }), // null unless source = 'office'
    // WhatsApp's encrypted edit format: the message was edited but the new text never reached us.
    newTextUnavailable: boolean('new_text_unavailable').notNull().default(false),
    // DB now() (microseconds), not a JS Date: two edits in the same millisecond still sort.
    editedAt: timestamp('edited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('message_edits_message_idx').on(t.messageId, t.editedAt)],
);

/** Spec 2026-10-19 §5: the team's shared star. The primary key makes it one star per message; the first who marks it stays. */
export const messageFavorites = pgTable('message_favorites', {
  messageId: uuid('message_id').primaryKey().references(() => messages.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});

export const historyImports = pgTable(
  'history_imports',
  {
    id: id(),
    channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    period: text('period').$type<HistoryPeriod>().notNull(),
    auto: boolean('auto').notNull(), // true = started by a QR pairing: repeats every 2 min while news arrive (§5.1)
    state: text('state').$type<HistoryImportState>().notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    messagesImported: integer('messages_imported').notNull().default(0),
    contactsCreated: integer('contacts_created').notNull().default(0),
    oldestMessageAt: timestamp('oldest_message_at', { withTimezone: true }),
    error: text('error'), // error name/code only (§9)
    lastNewAt: timestamp('last_new_at', { withTimezone: true }), // last pass that inserted something
    nextRunAt: timestamp('next_run_at', { withTimezone: true }), // when the worker runs the next pass; null once finished
  },
  (t) => [
    // §5.1: one import per channel at a time; a second request is a 409
    uniqueIndex('history_imports_one_running_per_channel').on(t.channelId).where(sql`${t.state} = 'running'`),
    index('history_imports_channel_idx').on(t.channelId, t.startedAt),
  ],
);

/** A chat an admin deleted: history imports and back-fills never bring back its (contact, channel) rows up to `until`. */
export const deletedChats = pgTable(
  'deleted_chats',
  {
    id: id(),
    contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    until: timestamp('until', { withTimezone: true }).notNull(),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('deleted_chats_channel_contact_idx').on(t.channelId, t.contactId)],
);
