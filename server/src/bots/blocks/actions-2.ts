import { randomUUID } from 'node:crypto';
import { and, count, eq, isNotNull } from 'drizzle-orm';
import type {
  BotNode, BotRunState, CallFlowConfig, NotificationDto, NotifyAgentConfig, PrivacyConfig, TransferAgentConfig, TransferSectorConfig,
} from '@talk/shared';
import { setContactBlocked } from '../../contacts/service.js';
import { chats, contacts, userSectors, users } from '../../db/schema.js';
import { closeChatAsBot, setChatPrivacyAsBot, transferChatAsBot } from '../../inbox/chats.js';
import { HttpError } from '../../lib/http-error.js';
import { BlockError } from '../block-error.js';
import type { BlockRegistry, BlockResult, BotCtx } from '../registry.js';

function cfg<T>(node: BotNode): T {
  return node.config as unknown as T;
}

// The id filters below run in JS on purpose. A malformed id in an old draft would otherwise make Postgres
// throw "invalid input syntax for type uuid", which reaches the run as "Erro inesperado" instead of a reason.
// ponytail: loads every active user / sector link and the open-chat counts per call; fine for an office,
// push the filters into SQL if users grow past a few hundred.

async function ownerIsIn(ctx: BotCtx, sectorId: string): Promise<boolean> {
  const owner = ctx.chat.ownerId;
  if (!owner) return false;
  const rows = await ctx.app.db.select({ sectorId: userSectors.sectorId }).from(userSectors).where(eq(userSectors.userId, owner));
  return rows.some((r) => r.sectorId === sectorId);
}

async function pickAgent(ctx: BotCtx, c: TransferAgentConfig): Promise<string> {
  const db = ctx.app.db;
  if (c.rule === 'specific') {
    const active = new Set((await db.select({ id: users.id }).from(users).where(eq(users.active, true))).map((u) => u.id));
    const id = (c.userIds ?? []).find((u) => active.has(u));
    if (!id) throw new BlockError('Nenhum atendente disponível');
    return id;
  }
  const wanted = new Set(c.sectorIds ?? []);
  const members = await db
    .select({ id: users.id, name: users.name, sectorId: userSectors.sectorId })
    .from(userSectors)
    .innerJoin(users, eq(users.id, userSectors.userId))
    .where(eq(users.active, true));
  const candidates = new Map<string, string>(); // id → name
  for (const m of members) if (wanted.has(m.sectorId)) candidates.set(m.id, m.name);
  if (candidates.size === 0) throw new BlockError('Nenhum atendente disponível');
  const load = await db
    .select({ ownerId: chats.ownerId, n: count() })
    .from(chats)
    .where(and(eq(chats.state, 'open'), isNotNull(chats.ownerId)))
    .groupBy(chats.ownerId);
  const open = new Map(load.map((r) => [r.ownerId, r.n]));
  const [best] = [...candidates].sort(
    ([a, aName], [b, bName]) => (open.get(a) ?? 0) - (open.get(b) ?? 0) || aName.localeCompare(bName, 'pt-BR'),
  );
  return best[0];
}

/** call_flow with continueAfter: the child's state (or the flow resume outcome) → this block's result. */
function flowResult(state: BotRunState): BlockResult {
  if (state === 'finished') return { next: 'next' };
  if (state === 'failed' || state === 'stopped') throw new BlockError('O fluxo acionado não terminou');
  return { wait: 'flow' };
}

export const actionBlocks2: BlockRegistry = {
  transfer_sector: {
    type: 'transfer_sector',
    async run(ctx, _run, node) {
      const c = cfg<TransferSectorConfig>(node);
      const keepOwner = !c.onlyIfAgentAllowed || (await ownerIsIn(ctx, c.sectorId));
      ctx.chat = await transferChatAsBot(
        ctx.app, ctx.actor, ctx.chat.id, keepOwner ? { sectorId: c.sectorId } : { sectorId: c.sectorId, ownerId: null },
      );
      return { next: 'next' };
    },
  },

  transfer_agent: {
    type: 'transfer_agent',
    async run(ctx, _run, node) {
      const ownerId = await pickAgent(ctx, cfg<TransferAgentConfig>(node));
      ctx.chat = await transferChatAsBot(ctx.app, ctx.actor, ctx.chat.id, { ownerId });
      return { next: 'next' };
    },
  },

  privacy: {
    type: 'privacy',
    async run(ctx, _run, node) {
      const c = cfg<PrivacyConfig>(node);
      ctx.chat = await setChatPrivacyAsBot(ctx.app, ctx.actor, ctx.chat.id, c.mode === 'private');
      return { next: 'next' };
    },
  },

  notify_agent: {
    type: 'notify_agent',
    async run(ctx, _run, node) {
      const c = cfg<NotifyAgentConfig>(node);
      const userIds = c.target === 'owner' ? (ctx.chat.ownerId ? [ctx.chat.ownerId] : []) : (c.userIds ?? []);
      if (userIds.length === 0) throw new BlockError('A conversa não tem atendente para notificar');
      const notification: NotificationDto = {
        id: randomUUID(),
        chatId: ctx.chat.id,
        title: (await ctx.render(c.title ?? '')).trim() || `Chatbot ${ctx.bot.name}`,
        text: await ctx.render(c.text ?? ''),
        botName: ctx.bot.name,
        createdAt: ctx.now.toISOString(),
      };
      await ctx.app.hub.publishNotification(ctx.chat.id, userIds, notification);
      return { next: 'next' };
    },
  },

  call_flow: {
    type: 'call_flow',
    async run(ctx, _run, node) {
      const c = cfg<CallFlowConfig>(node);
      // startRun refuses a paused/unpublished bot with an HttpError: keep its message as the run's reason.
      // The depth limit already arrives as a BlockError.
      const child = await ctx.startChild(c.botId).catch((e: unknown) => {
        if (e instanceof HttpError) throw new BlockError(e.message);
        throw e;
      });
      if (!c.continueAfter) return { end: 'finished' };
      // The child ran inside this step and may have closed the chat or blocked the contact: ctx.chat is stale.
      // Same outcome as the engine's step precheck, so the next block never talks to a closed chat.
      const [chat] = await ctx.app.db.select().from(chats).where(eq(chats.id, ctx.chat.id));
      if (chat.state !== 'open') return { end: 'stopped', reason: 'chat_closed' };
      const [contact] = await ctx.app.db.select({ blocked: contacts.blocked }).from(contacts).where(eq(contacts.id, chat.contactId));
      if (contact.blocked) return { end: 'stopped', reason: 'contact_blocked' };
      ctx.chat = chat;
      return flowResult(child.state);
    },
    async resume(_ctx, _run, _node, ev) {
      return flowResult(ev.kind === 'flow' ? ev.outcome : 'failed');
    },
  },

  block_contact: {
    type: 'block_contact',
    async run(ctx) {
      const { contactId } = ctx.chat;
      await setContactBlocked(ctx.app, contactId, true);
      const open = await ctx.app.db
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
      for (const { id } of open) {
        await closeChatAsBot(ctx.app, ctx.actor, id, { closingText: null });
        await ctx.stopOtherRuns(id, 'contact_blocked');
      }
      return { end: 'finished' };
    },
  },
};
