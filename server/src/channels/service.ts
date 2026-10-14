import { and, eq, ne, or, sql } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels } from '../db/schema.js';
import type { ChannelStatus } from '../whatsapp/types.js';

export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<typeof channels.$inferSelect | null> {
  const [row] = await db.select().from(channels).where(eq(channels.evolutionInstance, instance)).limit(1);
  return row ?? null;
}

// ponytail: the latest QR per instance lives in memory (spec §5.6: shown from qrcode.updated), keyed by the
// ctx's Db so every app/test ctx gets its own map (no state shared across ctxs). Lost on restart: the admin
// clicks "Conectar" again. Move it to a table if several app processes ever run.
const qrByDb = new WeakMap<Db, Map<string, string>>();

/** Stores (or with null clears) the latest QR image of an instance. */
export function setChannelQr(ctx: AppCtx, instance: string, qrBase64: string | null): void {
  let byInstance = qrByDb.get(ctx.db);
  if (!byInstance) {
    byInstance = new Map();
    qrByDb.set(ctx.db, byInstance);
  }
  if (qrBase64) byInstance.set(instance, qrBase64);
  else byInstance.delete(instance);
}

export function getChannelQr(ctx: AppCtx, instance: string): string | null {
  return qrByDb.get(ctx.db)?.get(instance) ?? null;
}

/**
 * Updates channels.status (and channels.phone when a phone is given: connection.update `wuid`);
 * publishes channel.status only when something actually changed. A null phone keeps the stored number.
 * Unknown instance → no-op. Reaching 'connected' clears the stored QR.
 */
export async function setChannelStatus(ctx: AppCtx, instance: string, status: ChannelStatus, phone: string | null = null): Promise<void> {
  const changed = phone
    ? or(ne(channels.status, status), sql`${channels.phone} is distinct from ${phone}`)
    : ne(channels.status, status);
  const [row] = await ctx.db
    .update(channels)
    .set(phone ? { status, phone } : { status })
    .where(and(eq(channels.evolutionInstance, instance), changed))
    .returning({ id: channels.id });
  if (status === 'connected') setChannelQr(ctx, instance, null);
  if (row) await ctx.hub.publishChannel(row.id);
}
