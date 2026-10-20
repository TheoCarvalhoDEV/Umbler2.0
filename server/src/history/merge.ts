import { and, eq, isNull } from 'drizzle-orm';
import type { AppCtx } from '../ctx.js';
import type { Tx } from '../db/client.js';
import {
  botRuns, chatEvents, chatTags, chats, contactFieldValues, contactNotes, contactTags, contacts, deletedChats, messages,
} from '../db/schema.js';
import { type ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { type Contact } from '../messages/ingest.js';
import { removeAvatarFile } from '../media/avatar-files.js';

const earliest = (a: Date, b: Date) => (a < b ? a : b);
const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** The phone contact's chat that takes `from` over (same channel, both open or both history), if any. */
async function twinOf(tx: Tx, from: ChatRow, intoId: string): Promise<ChatRow | undefined> {
  if (from.state !== 'open' && !from.history) return undefined;
  const [twin] = await tx
    .select()
    .from(chats)
    .where(
      and(eq(chats.contactId, intoId), eq(chats.channelId, from.channelId), from.history ? eq(chats.history, true) : eq(chats.state, 'open')),
    );
  return twin;
}

/** Moves `from`'s messages and events into `twin`, then deletes `from` (its pins and bot runs go with it). */
async function absorb(tx: Tx, from: ChatRow, twin: ChatRow): Promise<void> {
  await tx.update(messages).set({ chatId: twin.id }).where(eq(messages.chatId, from.id));
  await tx.update(chatEvents).set({ chatId: twin.id }).where(eq(chatEvents.chatId, from.id));
  // spec 2026-10-20 §5: the conversation's tags follow its messages (the delete below would cascade them away)
  const tagRows = await tx.select({ tagId: chatTags.tagId }).from(chatTags).where(eq(chatTags.chatId, from.id));
  if (tagRows.length) {
    await tx.insert(chatTags).values(tagRows.map((t) => ({ chatId: twin.id, tagId: t.tagId }))).onConflictDoNothing();
  }
  await tx.delete(chats).where(eq(chats.id, from.id));
  const newer = from.lastMessageAt !== null && (twin.lastMessageAt === null || from.lastMessageAt > twin.lastMessageAt);
  await tx
    .update(chats)
    .set({
      unread: twin.unread + from.unread,
      ...(newer ? { lastMessageAt: from.lastMessageAt, lastMessagePreview: from.lastMessagePreview } : {}),
      ...(twin.history ? { createdAt: earliest(twin.createdAt, from.createdAt), closedAt: latest(twin.closedAt, from.closedAt) } : {}),
    })
    .where(eq(chats.id, twin.id));
}

/** Joins `from` (LID only) into `into` (has the phone); returns the chats that now hold `from`'s history and the absorbed ones that are gone. */
async function moveContact(tx: Tx, from: Contact, into: Contact): Promise<{ touched: string[]; removed: string[] }> {
  const touched = new Set<string>();
  const removed: string[] = [];
  for (const chat of await tx.select().from(chats).where(eq(chats.contactId, from.id))) {
    const twin = await twinOf(tx, chat, into.id);
    if (twin) {
      await absorb(tx, chat, twin);
      touched.add(twin.id);
      removed.push(chat.id);
    } else {
      await tx.update(chats).set({ contactId: into.id }).where(eq(chats.id, chat.id));
      touched.add(chat.id);
    }
  }
  // Tags and custom fields are united; on a clash the phone contact's value stays (§5.4).
  const tagRows = await tx.select({ tagId: contactTags.tagId }).from(contactTags).where(eq(contactTags.contactId, from.id));
  if (tagRows.length) {
    await tx.insert(contactTags).values(tagRows.map((t) => ({ contactId: into.id, tagId: t.tagId }))).onConflictDoNothing();
  }
  const fieldRows = await tx.select().from(contactFieldValues).where(eq(contactFieldValues.contactId, from.id));
  if (fieldRows.length) {
    await tx
      .insert(contactFieldValues)
      .values(fieldRows.map((f) => ({ contactId: into.id, fieldId: f.fieldId, value: f.value })))
      .onConflictDoNothing();
  }
  await tx.update(contactNotes).set({ contactId: into.id }).where(eq(contactNotes.contactId, from.id));
  await tx.update(botRuns).set({ contactId: into.id }).where(eq(botRuns.contactId, from.id));
  // a deleted chat's tombstone follows the contact, or this very import would bring the conversation back
  await tx.update(deletedChats).set({ contactId: into.id }).where(eq(deletedChats.contactId, from.id));
  await tx.delete(contacts).where(eq(contacts.id, from.id)); // frees the lid (unique); its tag/field rows cascade
  await tx
    .update(contacts)
    .set({
      lid: into.lid ?? from.lid,
      name: into.name ?? from.name,
      email: into.email ?? from.email,
      landline: into.landline ?? from.landline,
      address: into.address ?? from.address,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, into.id));
  for (const id of touched) await addEvent(tx, id, 'contact_merged', {}, null);
  return { touched: [...touched], removed };
}

/**
 * §5.4: for each LID ↔ phone pair seen on a live Evolution row, a contact that has only that LID is joined into the
 * contact with that phone, or just gains the phone when there is none. One short transaction per pair; publishes the
 * chats that changed after commit. Returns how many contacts were joined into another.
 */
export async function mergeLidPairs(ctx: AppCtx, pairs: Array<{ lid: string; phone: string }>): Promise<number> {
  let merged = 0;
  const done = new Set<string>();
  for (const { lid, phone } of pairs) {
    if (done.has(lid)) continue;
    done.add(lid);
    const out = await ctx.db.transaction(async (tx) => {
      const [from] = await tx.select().from(contacts).where(and(eq(contacts.lid, lid), isNull(contacts.phone)));
      if (!from) return null;
      const [into] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
      if (!into) {
        await tx.update(contacts).set({ phone, updatedAt: new Date() }).where(eq(contacts.id, from.id));
        return null;
      }
      return { ...(await moveContact(tx, from, into)), avatarPath: from.avatarPath };
    });
    if (!out) continue;
    merged += 1;
    if (out.avatarPath) await removeAvatarFile(ctx.config.mediaDir, out.avatarPath).catch(() => undefined);
    for (const chatId of out.removed) ctx.hub.publishChatRemoved(chatId);
    for (const chatId of out.touched) await ctx.hub.publishChat(chatId);
  }
  return merged;
}
