import { randomUUID } from 'node:crypto';
import type { AppCtx } from '../../src/ctx.js';
import { chatEvents, chats, contacts, messages } from '../../src/db/schema.js';
import type { ChatEventKind } from '../../src/inbox/events.js';

export interface SeedChatOpts {
  channelId: string;
  sectorId: string;
  ownerId?: string | null;
  contactId?: string;
  name?: string | null;
  phone?: string | null;
  state?: 'open' | 'closed';
  waiting?: boolean;
  private?: boolean;
  unread?: number;
  at?: Date;
  /** Defaults to `at`. */
  createdAt?: Date;
  waitingSince?: Date | null;
}

export async function seedChat(ctx: AppCtx, o: SeedChatOpts): Promise<{ chatId: string; contactId: string }> {
  const at = o.at ?? new Date();
  let contactId = o.contactId;
  if (!contactId) {
    contactId = randomUUID();
    await ctx.db.insert(contacts).values({
      id: contactId, name: o.name ?? 'Contato', phone: o.phone ?? null, blocked: false, createdAt: at, updatedAt: at,
    });
  }
  const chatId = randomUUID();
  const state = o.state ?? 'open';
  await ctx.db.insert(chats).values({
    id: chatId, contactId, channelId: o.channelId, sectorId: o.sectorId, ownerId: o.ownerId ?? null,
    state, waiting: o.waiting ?? false, private: o.private ?? false, triagePending: false,
    unread: o.unread ?? 0, lastMessageAt: at, lastMessagePreview: 'oi', createdAt: o.createdAt ?? at,
    waitingSince: o.waitingSince ?? null,
    closedAt: state === 'closed' ? at : null,
  });
  return { chatId, contactId };
}

export async function seedMessage(
  ctx: AppCtx, chatId: string, channelId: string, at: Date,
  extra: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(messages).values({
    id, chatId, channelId, direction: 'in', kind: 'text', body: 'msg', status: 'delivered',
    sentAt: at, createdAt: at, ...extra,
  });
  return id;
}

export async function seedEvent(ctx: AppCtx, chatId: string, kind: ChatEventKind, at: Date): Promise<string> {
  const id = randomUUID();
  await ctx.db.insert(chatEvents).values({ id, chatId, kind, data: {}, authorId: null, createdAt: at });
  return id;
}
