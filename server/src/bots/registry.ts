import type { BlockType, BotNode, BotStopReason } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { ChatRow } from '../inbox/chats.js';
import type { MessageKind } from '../whatsapp/types.js';
import type { BotRunRow } from './repo.js';
import { actionBlocks } from './blocks/actions.js';
import { actionBlocks2 } from './blocks/actions-2.js';
import { conditionBlocks } from './blocks/conditions.js';
import { finishBlocks } from './blocks/finish.js';
import { startBlocks } from './blocks/start.js';

// Block modules import BlockError from './block-error.js', never from here: this file imports the block
// families, so a runtime import back into it is an ESM cycle (TDZ ReferenceError on `...xBlocks`).
export { BlockError } from './block-error.js';

export interface InboundReply {
  messageId: string;
  kind: MessageKind;
  body: string | null;
  mediaMime: string | null;
  mediaName: string | null;
  createdAt: Date; // messages.created_at of the stored reply
}

export interface BotActor { botId: string; botName: string; runId: string }

export type ResumeEvent =
  | { kind: 'reply'; reply: InboundReply }
  | { kind: 'timeout' } // waiting_reply and timeout_at passed
  | { kind: 'timer' } // waiting_timer and wake_at passed
  | { kind: 'flow'; outcome: 'finished' | 'failed' | 'stopped' }; // child of call_flow ended

export type BlockResult =
  | { next: string } // handle id from outputsOf
  | { wait: 'reply'; timeoutAt: Date | null }
  | { wait: 'timer'; wakeAt: Date }
  | { wait: 'flow' }
  | { end: 'finished' }
  | { end: 'failed'; error: string }
  | { end: 'stopped'; reason: BotStopReason };

export interface BotCtx {
  app: AppCtx;
  now: Date; // app.botRuntime.now() at step start
  chat: ChatRow; // fresh at step start; a block that changes the chat assigns the returned row back
  bot: { id: string; name: string };
  actor: BotActor;
  render(text: string): Promise<string>;
  lastInbound(): Promise<InboundReply | null>;
  startChild(botId: string): Promise<BotRunRow>;
  stopOtherRuns(chatId: string, reason: BotStopReason): Promise<void>;
}

/** Blocks may mutate run.vars and run.retries in place; the engine saves both with the step. Blocks never write bot_runs. */
export interface BlockDefinition {
  type: BlockType;
  run(ctx: BotCtx, run: BotRunRow, node: BotNode): Promise<BlockResult>;
  resume?(ctx: BotCtx, run: BotRunRow, node: BotNode, ev: ResumeEvent): Promise<BlockResult>;
}

export type BlockRegistry = Partial<Record<BlockType, BlockDefinition>>;

export const defaultRegistry: BlockRegistry = { ...startBlocks, ...conditionBlocks, ...actionBlocks, ...actionBlocks2, ...finishBlocks };
