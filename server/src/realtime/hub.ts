import type { AuthUser } from '../inbox/visibility.js';

// Task 7 stub: Task 8 Step 10 overwrites this file with the full version, which adds createHub.
type Socket = { send(data: string): void; close(): void };

export interface Hub {
  register(user: AuthUser, socket: Socket): () => void; // returns unregister
  disconnectUser(userId: string): void;
  publishChat(chatId: string): Promise<void>;
  publishMessage(chatId: string, type: 'message.created' | 'message.updated', messageId: string): Promise<void>;
  publishChannel(channelId: string): Promise<void>;
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
    publishMessage: async (chatId, type, messageId) => { events.push({ type, chatId, messageId }); },
    publishChannel: async (channelId) => { events.push({ type: 'channel', channelId }); },
  };
}
