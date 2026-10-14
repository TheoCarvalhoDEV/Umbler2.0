import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AppCtx } from '../../src/ctx.js';
import { chatEvents, chats, contacts } from '../../src/db/schema.js';
import { HttpError } from '../../src/lib/http-error.js';

let seq = 0;

/** Inserts a contact with a unique canonical 13-digit phone (or the given one); returns its id. */
export async function newContact(ctx: AppCtx, opts: { phone?: string; name?: string } = {}): Promise<string> {
  seq += 1;
  const id = randomUUID();
  const now = new Date();
  await ctx.db.insert(contacts).values({
    id,
    name: opts.name ?? `Cliente ${seq}`,
    phone: opts.phone ?? `55659${String(seq).padStart(8, '0')}`,
    blocked: false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Inserts a chat row directly (no event, no hub); returns its id. */
export async function insertChat(
  ctx: AppCtx,
  f: { channelId: string; sectorId: string; contactId?: string; ownerId?: string | null; private?: boolean; state?: 'open' | 'closed'; unread?: number },
): Promise<string> {
  const id = randomUUID();
  const state = f.state ?? 'open';
  const contactId = f.contactId ?? (await newContact(ctx));
  await ctx.db.insert(chats).values({
    id,
    contactId,
    channelId: f.channelId,
    sectorId: f.sectorId,
    ownerId: f.ownerId ?? null,
    state,
    waiting: false,
    private: f.private ?? false,
    triagePending: false,
    unread: f.unread ?? 0,
    createdAt: new Date(),
    closedAt: state === 'closed' ? new Date() : null,
  });
  return id;
}

/** Events in insertion order: created_at is DB clock_timestamp() (microseconds, set by addEvent); id only breaks exact ties. */
export async function eventsOf(ctx: AppCtx, chatId: string) {
  return ctx.db
    .select()
    .from(chatEvents)
    .where(eq(chatEvents.chatId, chatId))
    .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id));
}

/** Resolves to 200 on success, the HttpError status on HttpError; rethrows anything else. */
export function statusOf(p: Promise<unknown>): Promise<number> {
  return p.then(
    () => 200,
    (e: unknown) => {
      if (e instanceof HttpError) return e.status;
      throw e;
    },
  );
}
