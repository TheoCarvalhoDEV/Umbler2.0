import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import type { ChannelDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels } from '../db/schema.js';
import { notFound } from '../lib/http-error.js';
import type { ChannelStatus } from '../whatsapp/types.js';

type ChannelRow = typeof channels.$inferSelect;

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

export function toChannelDto(row: ChannelRow): ChannelDto {
  return { id: row.id, name: row.name, status: row.status, phone: row.phone };
}

export async function listChannels(db: Db | Tx): Promise<ChannelDto[]> {
  const rows = await db.select().from(channels).orderBy(asc(channels.createdAt));
  return rows.map(toChannelDto);
}

export async function getChannelByInstance(db: Db | Tx, instance: string): Promise<ChannelRow | null> {
  const [row] = await db.select().from(channels).where(eq(channels.evolutionInstance, instance)).limit(1);
  return row ?? null;
}

export async function createChannel(ctx: AppCtx, name: string): Promise<ChannelDto> {
  const id = randomUUID();
  const instance = `talk-${id.slice(0, 8)}`;
  const [row] = await ctx.db
    .insert(channels)
    .values({ id, name, kind: 'whatsapp_qr', evolutionInstance: instance, status: 'disconnected' })
    .returning();
  try {
    await ctx.wa.createInstance(instance, `${ctx.config.webhookBaseUrl}/webhooks/evolution/${ctx.config.webhookSecret}`);
  } catch (err) {
    // no orphan channel the admin can never connect
    await ctx.db.delete(channels).where(eq(channels.id, id));
    throw err;
  }
  return toChannelDto(row!);
}

export async function connectChannel(ctx: AppCtx, channelId: string): Promise<{ qrBase64: string | null }> {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!row) throw notFound();
  const { qrBase64 } = await ctx.wa.connect(row.evolutionInstance);
  // The first QR comes back here; later ones arrive as qrcode.updated webhooks (ingest → setChannelQr).
  if (qrBase64) setChannelQr(ctx, row.evolutionInstance, qrBase64);
  // no QR means Evolution already holds an open session: ask instead of assuming "connecting"
  const status = qrBase64 ? 'connecting' : await ctx.wa.connectionState(row.evolutionInstance);
  await setChannelStatus(ctx, row.evolutionInstance, status);
  return { qrBase64 };
}

/** GET /api/channels/:id/qr: the latest QR while the channel is not connected (spec §5.6). */
export async function getChannelQrById(ctx: AppCtx, channelId: string): Promise<{ qrBase64: string | null }> {
  const [row] = await ctx.db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!row) throw notFound();
  return { qrBase64: row.status === 'connected' ? null : getChannelQr(ctx, row.evolutionInstance) };
}

/**
 * Single implementation, also used by messages/ingest.ts for connection.update webhooks.
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

// ponytail: sequential, first Evolution failure aborts the rest; fine for one number, use Promise.allSettled when there are many channels
export async function syncChannelStatuses(ctx: AppCtx): Promise<void> {
  const rows = await ctx.db.select({ instance: channels.evolutionInstance }).from(channels);
  for (const { instance } of rows) {
    await setChannelStatus(ctx, instance, await ctx.wa.connectionState(instance));
  }
}
