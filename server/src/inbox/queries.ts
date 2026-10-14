import { and, eq } from 'drizzle-orm';
import type { ChatListItem } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import { chatPins, contactTags, contacts } from '../db/schema.js';
import type { ChatRow } from './chats.js';

// Task 13 adds listChats, getChatDetail and getTimeline to this file. Keep this signature:
// the realtime hub (Task 8) calls it once per connected user on every chat change.
export async function toChatListItem(db: Db | Tx, chat: ChatRow, userId: string): Promise<ChatListItem> {
  const [contact] = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.id, chat.contactId));
  const tagRows = await db
    .select({ tagId: contactTags.tagId })
    .from(contactTags)
    .where(eq(contactTags.contactId, chat.contactId));
  const pinRows = await db
    .select({ chatId: chatPins.chatId })
    .from(chatPins)
    .where(and(eq(chatPins.userId, userId), eq(chatPins.chatId, chat.id)));

  return {
    id: chat.id,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    channelId: chat.channelId,
    sectorId: chat.sectorId,
    ownerId: chat.ownerId,
    state: chat.state,
    waiting: chat.waiting,
    private: chat.private,
    unread: chat.unread,
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    lastMessagePreview: chat.lastMessagePreview,
    pinned: pinRows.length > 0,
    tagIds: tagRows.map((r) => r.tagId),
  };
}
