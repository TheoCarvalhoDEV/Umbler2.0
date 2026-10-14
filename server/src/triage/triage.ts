import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { channels, chats, contacts, messages, sectors, settings } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { messagePreview } from '../messages/dto.js';

export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }

// Stored shape is snake_case, exactly as spec §4.
const storedMenu = z.object({
  enabled: z.boolean(),
  welcome_text: z.string(),
  invalid_text: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), sector_id: z.string() })),
});

export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'triage_menu'));
  const parsed = storedMenu.safeParse(row?.value);
  if (!parsed.success) return { enabled: false, welcomeText: '', invalidText: '', options: [] };
  const v = parsed.data;
  return {
    enabled: v.enabled,
    welcomeText: v.welcome_text,
    invalidText: v.invalid_text,
    options: v.options.map((o) => ({ key: o.key, label: o.label, sectorId: o.sector_id })),
  };
}

// Lowercase, strip accents, trim, drop surrounding punctuation, collapse inner spaces.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null {
  const t = normalize(text);
  if (!t) return null;
  return (
    menu.options.find((o) => {
      const sectorName = sectorNames.get(o.sectorId);
      if (sectorName === undefined) return false; // sector was deleted
      return [o.key, o.label, sectorName].some((candidate) => normalize(candidate) === t);
    }) ?? null
  );
}

async function loadSectorNames(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  return new Map(rows.map((r) => [r.id, r.name]));
}

// Success path of a send (Task 10 moves this function, unchanged, into messages/send.ts and exports it).
// Evolution's messages.upsert echo can beat the gateway response; ingest then stored an author-less copy
// with our external_id. Drop it so ours keeps the id (otherwise the update hits
// messages_channel_external_unique), then mark ours sent — one transaction.
async function markSent(
  db: Db,
  messageId: string,
  channelId: string,
  externalId: string,
): Promise<{ row: typeof messages.$inferSelect; echoDropped: boolean }> {
  return db.transaction(async (tx) => {
    const gone = await tx
      .delete(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          eq(messages.externalId, externalId),
          isNull(messages.authorId),
          ne(messages.id, messageId),
        ),
      )
      .returning({ id: messages.id });
    const [row] = await tx
      .update(messages)
      .set({ externalId, status: 'sent', error: null })
      .where(eq(messages.id, messageId))
      .returning();
    return { row: row!, echoDropped: gone.length > 0 };
  });
}

// System (bot) text: stored as an `out` message without author, signature or owner change.
// Does not touch waiting/unread; the caller publishes chat.updated.
// Returns { ok: gateway accepted it, echoDropped: an echo copy was removed (its ingest cleared triage_pending) }.
async function sendSystemText(ctx: AppCtx, chat: ChatRow, text: string): Promise<{ ok: boolean; echoDropped: boolean }> {
  const [contact] = await ctx.db.select({ phone: contacts.phone }).from(contacts).where(eq(contacts.id, chat.contactId));
  const [channel] = await ctx.db
    .select({ instance: channels.evolutionInstance })
    .from(channels)
    .where(eq(channels.id, chat.channelId));
  // ponytail: contacts known only by LID get no automatic text; the gateway sends by phone.
  if (!contact?.phone || !channel) return { ok: false, echoDropped: false };

  const now = new Date();
  const id = crypto.randomUUID();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(messages).values({
      id,
      chatId: chat.id,
      channelId: chat.channelId,
      direction: 'out',
      kind: 'text',
      body: text,
      authorId: null,
      status: 'pending',
      sentAt: now,
      createdAt: now,
    });
    await tx
      .update(chats)
      .set({
        lastMessageAt: sql`greatest(${chats.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
        lastMessagePreview: messagePreview('text', text),
      })
      .where(eq(chats.id, chat.id));
  });
  await ctx.hub.publishMessage(chat.id, 'message.created', id);

  let result: { externalId: string } | null = null;
  let error = '';
  try {
    result = await ctx.wa.sendText(channel.instance, contact.phone, text);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  let echoDropped = false;
  if (result) {
    ({ echoDropped } = await markSent(ctx.db, id, chat.channelId, result.externalId));
  } else {
    await ctx.db.update(messages).set({ status: 'failed', error }).where(eq(messages.id, id));
  }
  await ctx.hub.publishMessage(chat.id, 'message.updated', id);
  return { ok: result !== null, echoDropped };
}

export async function startTriage(ctx: AppCtx, chat: ChatRow): Promise<void> {
  const menu = await getTriageMenu(ctx.db);
  if (!menu.enabled) return;
  const sectorNames = await loadSectorNames(ctx.db);
  const options = menu.options.filter((o) => sectorNames.has(o.sectorId));
  if (options.length === 0) return;

  // Flag first: a reply racing the send must already be read as a triage answer.
  const [armed] = await ctx.db
    .update(chats)
    .set({ triagePending: true })
    .where(and(eq(chats.id, chat.id), eq(chats.state, 'open')))
    .returning({ id: chats.id });
  if (!armed) return;

  const lines = options.map((o) => `${o.key} - ${o.label}`).join('\n');
  const welcome = menu.welcomeText.trim();
  const text = welcome ? `${welcome}\n\n${lines}` : lines;

  const sent = await sendSystemText(ctx, chat, text);
  // The contact never saw the options, so do not interpret their next message as an answer.
  if (!sent.ok) await ctx.db.update(chats).set({ triagePending: false }).where(eq(chats.id, chat.id));
  // The dropped echo's ingest (fromMe → out) had cleared triage_pending and waiting: restore both
  // (system messages never touch waiting; `chat` is the creation snapshot the caller passed).
  else if (sent.echoDropped) {
    await ctx.db
      .update(chats)
      .set({ triagePending: true, waiting: chat.waiting })
      .where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
  }
  await ctx.hub.publishChat(chat.id);
}

export async function handleTriageReply(ctx: AppCtx, chat: ChatRow, text: string | null): Promise<boolean> {
  if (!chat.triagePending) return false;
  const menu = await getTriageMenu(ctx.db);
  const sectorNames = await loadSectorNames(ctx.db);
  const option = menu.enabled && text !== null ? matchTriageOption(text, menu, sectorNames) : null;

  // `WHERE triage_pending = true` makes only one concurrent reply win.
  const consumed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(chats)
      .set(option ? { sectorId: option.sectorId, triagePending: false } : { triagePending: false })
      .where(and(eq(chats.id, chat.id), eq(chats.triagePending, true)))
      .returning({ id: chats.id });
    if (!row) return false;
    if (option) await addEvent(tx, chat.id, 'triage_routed', { sectorId: option.sectorId, option: option.key }, null);
    return true;
  });
  if (!consumed) return false;

  if (!option && menu.enabled && menu.invalidText.trim()) await sendSystemText(ctx, chat, menu.invalidText.trim());
  await ctx.hub.publishChat(chat.id);
  return true;
}
