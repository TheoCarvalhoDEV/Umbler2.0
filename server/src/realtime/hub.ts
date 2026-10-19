import { eq } from 'drizzle-orm';
import type { NotificationDto, WsEvent } from '@talk/shared';
import { loadChannelDto } from '../channels/service.js';
import type { Db } from '../db/client.js';
import { chats, messages } from '../db/schema.js';
import { toChatListItem } from '../inbox/queries.js';
import { canSee, loadAuthUser, type AuthUser } from '../inbox/visibility.js';
import { toMessageDto } from '../messages/dto.js';

type Socket = { send(data: string): void; close(): void };

export interface Hub {
  register(user: AuthUser, socket: Socket): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>;
  /** The chat no longer exists (merged away): every connected client drops it. */
  publishChatRemoved(chatId: string): void;
  publishChannel(channelId: string): Promise<void>;
  /** Chatbot "Notificar atendente": WS only, to the listed users who can see the chat. */
  publishNotification(chatId: string, userIds: string[], notification: NotificationDto): Promise<void>;
  publishUsersChanged(): void;
}

function send(socket: Socket, event: WsEvent): void {
  try {
    socket.send(JSON.stringify(event));
  } catch {
    // Socket already closing; its close handler unregisters it.
  }
}

// Visibility is recomputed from the DB on every publish (§5.5): the user (with sectorIds) is loaded
// once per connected user per publish, never cached per socket, so a transfer or a sector change
// takes effect on the next event.
// ponytail: one loadAuthUser per connected user per publish; fine for an office of ~20 agents,
// batch the user/sector load into one query if the number of connected users grows.
export function createHub(getDb: () => Db): Hub {
  const byUser = new Map<string, Set<Socket>>();

  return {
    register(user, socket) {
      let set = byUser.get(user.id);
      if (!set) {
        set = new Set();
        byUser.set(user.id, set);
      }
      const own = set;
      own.add(socket);
      return () => {
        own.delete(socket);
        if (own.size === 0 && byUser.get(user.id) === own) byUser.delete(user.id);
      };
    },

    disconnectUser(userId) {
      const set = byUser.get(userId);
      if (!set) return;
      byUser.delete(userId);
      for (const socket of set) socket.close();
    },

    async publishChat(chatId) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      if (!chat) return;
      for (const [userId, sockets] of [...byUser]) {
        const user = await loadAuthUser(db, userId);
        const event: WsEvent = user && canSee(user, chat)
          ? { type: 'chat.updated', chat: await toChatListItem(db, chat, userId) }
          : { type: 'chat.removed', chatId };
        for (const socket of [...sockets]) send(socket, event);
      }
    },

    publishChatRemoved(chatId) {
      for (const sockets of [...byUser.values()]) for (const socket of [...sockets]) send(socket, { type: 'chat.removed', chatId });
    },

    async publishMessage(chatId, type, messageId) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
      if (!chat || !row) return;
      const event: WsEvent = { type, message: await toMessageDto(db, row) };
      for (const [userId, sockets] of [...byUser]) {
        const user = await loadAuthUser(db, userId);
        if (user && canSee(user, chat)) for (const socket of [...sockets]) send(socket, event);
      }
    },

    async publishChannel(channelId) {
      if (byUser.size === 0) return;
      const channel = await loadChannelDto(getDb(), channelId); // with the import progress (history spec §5.6)
      if (!channel) return;
      const event: WsEvent = { type: 'channel.status', channel };
      for (const sockets of [...byUser.values()]) for (const socket of [...sockets]) send(socket, event);
    },

    // ponytail: WS-only; offline agents miss it — add a notifications table when 2b's "notificar só se online" lands.
    async publishNotification(chatId, userIds, notification) {
      if (byUser.size === 0) return;
      const db = getDb();
      const [chat] = await db.select().from(chats).where(eq(chats.id, chatId));
      if (!chat) return;
      const event: WsEvent = { type: 'notification', notification };
      for (const userId of new Set(userIds)) {
        const sockets = byUser.get(userId);
        if (!sockets) continue;
        const user = await loadAuthUser(db, userId);
        if (user && canSee(user, chat)) for (const socket of [...sockets]) send(socket, event);
      }
    },
    publishUsersChanged() {
      for (const sockets of [...byUser.values()]) for (const socket of [...sockets]) send(socket, { type: 'users.changed' });
    },
  };
}

export function createRecordingHub(): Hub & {
  events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }>;
} {
  const events: Array<{ type: string; chatId?: string; messageId?: string; channelId?: string; userId?: string }> = [];
  return {
    events,
    register: () => () => {},
    disconnectUser: (userId) => { events.push({ type: 'disconnect', userId }); },
    publishChat: async (chatId) => { events.push({ type: 'chat', chatId }); },
    publishChatRemoved: (chatId) => { events.push({ type: 'chat.removed', chatId }); },
    publishMessage: async (chatId, type, messageId) => { events.push({ type, chatId, messageId }); },
    publishChannel: async (channelId) => { events.push({ type: 'channel', channelId }); },
    publishNotification: async (chatId, userIds) => {
      for (const userId of userIds) events.push({ type: 'notification', chatId, userId });
    },
    publishUsersChanged: () => { events.push({ type: 'users.changed' }); },
  };
}
