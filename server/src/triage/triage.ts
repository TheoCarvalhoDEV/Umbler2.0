import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { chats, sectors, settings } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import { addEvent } from '../inbox/events.js';
import { sendSystemMessage } from '../messages/send.js';

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
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

/** The trimmed text and, when it has more than one line, each non-empty trimmed line. */
export function answerLines(text: string): string[] {
  const whole = text.trim();
  const lines = whole.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.length > 1 ? [whole, ...lines] : [whole];
}

/** normalize()d answerLines without blanks or repeats: "1\nquero saber do processo" reads as "1" when the whole text matches nothing. */
export function answerCandidates(text: string): string[] {
  return [...new Set(answerLines(text).map(normalize))].filter((c) => c !== '');
}

export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null {
  for (const t of answerCandidates(text)) {
    const option = menu.options.find((o) => {
      const sectorName = sectorNames.get(o.sectorId);
      if (sectorName === undefined) return false; // sector was deleted
      return [o.key, o.label, sectorName].some((candidate) => normalize(candidate) === t);
    });
    if (option) return option;
  }
  return null;
}

async function loadSectorNames(db: Db | Tx): Promise<Map<string, string>> {
  const rows = await db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  return new Map(rows.map((r) => [r.id, r.name]));
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

  const sent = await sendSystemMessage(ctx, chat, { text });
  // The contact never saw the options, so do not interpret their next message as an answer.
  if (!sent.ok) await ctx.db.update(chats).set({ triagePending: false }).where(eq(chats.id, chat.id));
  // The dropped echo's ingest (fromMe → out) also cleared triage_pending (sendSystemMessage restored waiting).
  // Not from the snapshot: `chat` predates the flag armed above.
  else if (sent.echoDropped) {
    await ctx.db.update(chats).set({ triagePending: true }).where(and(eq(chats.id, chat.id), eq(chats.state, 'open')));
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

  if (!option && menu.enabled && menu.invalidText.trim()) await sendSystemMessage(ctx, chat, { text: menu.invalidText.trim() });
  await ctx.hub.publishChat(chat.id);
  return true;
}
