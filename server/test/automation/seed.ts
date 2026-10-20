import type { AppCtx } from '../../src/ctx.js';
import { botRuns, botVersions, bots, scheduledMessages } from '../../src/db/schema.js';

type ScheduledInsert = typeof scheduledMessages.$inferInsert;

/** A scheduled-message row written directly (no route, no event). */
export async function insertScheduled(
  ctx: AppCtx,
  values: Pick<ScheduledInsert, 'chatId' | 'authorId' | 'sendAt'> & Partial<ScheduledInsert>,
): Promise<typeof scheduledMessages.$inferSelect> {
  const [row] = await ctx.db
    .insert(scheduledMessages)
    .values({ body: 'Lembrete: audiência amanhã às 9h', signature: false, ...values })
    .returning();
  return row!;
}

let seq = 0;
/** A chatbot run waiting for the contact's reply: a "running bot" for spec §3.3 and §4. */
export async function runningBot(ctx: AppCtx, chatId: string, contactId: string): Promise<string> {
  seq += 1;
  const [bot] = await ctx.db.insert(bots).values({ name: `Recepção ${seq}` }).returning();
  const [version] = await ctx.db
    .insert(botVersions)
    .values({ botId: bot!.id, number: 1, graph: { nodes: [], edges: [] }, valid: true })
    .returning();
  const [run] = await ctx.db
    .insert(botRuns)
    .values({ botId: bot!.id, versionId: version!.id, chatId, contactId, state: 'waiting_reply', currentNodeId: 'n1' })
    .returning();
  return run!.id;
}
