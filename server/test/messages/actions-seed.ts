import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { botRuns, botVersions, bots, messages } from '../../src/db/schema.js';
import { seedChat } from '../chats/seed.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

export const PHONE = '5565999999999';
export type Ctx = Awaited<ReturnType<typeof makeTestCtx>>;

export interface ActionsWorld {
  ctx: Ctx;
  app: FastifyInstance;
  s: Awaited<ReturnType<typeof seedBasics>>;
  chatId: string;
  contactId: string;
  /** agentA's session (Origin included). */
  headers: Record<string, string>;
}

/** agentA's open chat (sector A, owner agentA) with a phone contact. */
export async function setupActions(): Promise<ActionsWorld> {
  const ctx = await makeTestCtx();
  const s = await seedBasics(ctx);
  const { app } = await makeTestApp(ctx);
  const { chatId, contactId } = await seedChat(ctx, { channelId: s.channelId, sectorId: s.sectorA, ownerId: s.agentA.id, phone: PHONE });
  const { headers } = await loginAs(app, s.agentA.email);
  return { ctx, app, s, chatId, contactId, headers };
}

export const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

let seq = 0;
/** A stored message in the world's chat. Defaults: an `out` text by agentA, sent 1 min ago, with a WhatsApp id. */
export async function seedMsg(w: ActionsWorld, extra: Partial<typeof messages.$inferInsert> = {}): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await w.ctx.db.insert(messages).values({
    id, chatId: w.chatId, channelId: w.s.channelId, direction: 'out', kind: 'text', body: `texto ${seq}`,
    authorId: w.s.agentA.id, externalId: `WA-${seq}`, status: 'sent', sentAt: minutesAgo(1), ...extra,
  });
  return id;
}

/** Writes `bytes` under mediaDir and returns the relative path, to put in messages.media_path. */
export async function seedFile(w: ActionsWorld, rel: string, bytes: Buffer): Promise<string> {
  await mkdir(dirname(join(w.ctx.config.mediaDir, rel)), { recursive: true });
  await writeFile(join(w.ctx.config.mediaDir, rel), bytes);
  return rel;
}

/** A chatbot run waiting for the contact: with the default behavior ('ask'), sends in that chat get 409 BOT_RUNNING. */
export async function seedWaitingRun(w: ActionsWorld, chatId = w.chatId, contactId = w.contactId): Promise<void> {
  const [bot] = await w.ctx.db.insert(bots).values({ name: `Recepção ${randomUUID().slice(0, 8)}` }).returning();
  const [version] = await w.ctx.db
    .insert(botVersions)
    .values({ botId: bot!.id, number: 1, graph: { nodes: [], edges: [] }, valid: true })
    .returning();
  await w.ctx.db
    .insert(botRuns)
    .values({ botId: bot!.id, versionId: version!.id, chatId, contactId, state: 'waiting_reply', currentNodeId: 'n1' });
}
