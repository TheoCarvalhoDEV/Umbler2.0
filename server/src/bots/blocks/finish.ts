import type { CloseChatConfig } from '@talk/shared';
import { closeChatAsBot, getClosingMessage } from '../../inbox/chats.js';
import type { BlockRegistry } from '../registry.js';

export const finishBlocks: BlockRegistry = {
  close_chat: {
    type: 'close_chat',
    async run(ctx, _run, node) {
      const c = node.config as unknown as CloseChatConfig;
      let closingText: string | null = null;
      if (c.sendClosingMessage) {
        // The block's own text takes variables; the settings message goes out as is, like a manual close.
        const text = c.closingText?.trim() ? await ctx.render(c.closingText) : await getClosingMessage(ctx.app.db);
        closingText = text.trim() || null;
      }
      ctx.chat = await closeChatAsBot(ctx.app, ctx.actor, ctx.chat.id, { closingText });
      await ctx.stopOtherRuns(ctx.chat.id, 'chat_closed');
      return { end: 'finished' };
    },
  },
};
