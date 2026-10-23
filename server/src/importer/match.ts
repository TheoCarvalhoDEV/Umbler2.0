import { and, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { chats, messages, umblerMap } from '../db/schema.js';
import { stripSignature } from '../messages/signature.js';

// Spec 2026-10-21 importar-umbler §8: the Umbler API has no WhatsApp id, so an Umbler message and a WhatsApp-history row
// are the same message when contact, channel, direction, class and text agree within MATCH_WINDOW_MS. Both directions
// use this module: the Umbler import (importer/chats.ts) and the WhatsApp history copy (history/place.ts).

/** §8.4, the calibration knob: the report shows the largest difference found. */
export const MATCH_WINDOW_MS = 10_000;
const MEDIA = new Set(['image', 'video', 'audio', 'document', 'sticker']);

export interface Comparable {
  direction: 'in' | 'out';
  kind: string;
  text: string | null;
  at: Date;
}
export interface Candidate extends Comparable {
  id: string;
  chatId: string;
  authorId: string | null;
  mediaPath: string | null;
}

/** §8.3: the text both sides compare (media without caption = ''). */
export function normalizeText(text: string | null): string {
  return stripSignature((text ?? '').normalize('NFC').replace(/\r\n/g, '\n')).trim();
}

// §8.2-8.3: direction, class (a GIF is an image in Umbler and a video on WhatsApp: both are 'media') and text.
// ponytail: compares the normalized strings, which is the same test as comparing their SHA-256 (spec §8.3).
function signature(c: Comparable): string {
  const cls = c.kind === 'text' ? 'text' : MEDIA.has(c.kind) ? 'media' : 'other';
  return `${c.direction}|${cls}|${normalizeText(c.text)}`;
}

/**
 * §8 one to one: `items` in time order; each takes the free candidate with the same signature and the smallest
 * |Δt| ≤ MATCH_WINDOW_MS (a tie goes to the older one). The answer is aligned with `items` (null = no match).
 * ponytail: O(items × candidates) per page (≤ 250 × a few hundred); index candidates by signature if a page gets slow.
 */
export function pairUp<C extends Comparable>(items: Comparable[], candidates: C[]): Array<{ row: C; diffMs: number } | null> {
  const free = candidates.map((row) => ({ row, sig: signature(row), used: false }));
  return items.map((item) => {
    const sig = signature(item);
    let best: (typeof free)[number] | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const f of free) {
      if (f.used || f.sig !== sig) continue;
      const diff = Math.abs(f.row.at.getTime() - item.at.getTime());
      if (diff > MATCH_WINDOW_MS) continue;
      if (diff < bestDiff || (diff === bestDiff && best && f.row.at < best.row.at)) {
        best = f;
        bestDiff = diff;
      }
    }
    if (!best) return null;
    best.used = true;
    return { row: best.row, diffMs: bestDiff };
  });
}

/**
 * §8.1-8.2: the contact's rows on the channel, in any of its chats, in [first - 10 s, last + 10 s], notes left out.
 * 'ours': rows not imported from Umbler (the Umbler import looks for them). 'umbler': rows imported from Umbler that have
 * no WhatsApp id yet (the WhatsApp history copy looks for them).
 */
export async function matchCandidates(
  db: Db | Tx,
  scope: { contactId: string; channelId: string },
  items: Array<{ at: Date }>,
  side: 'ours' | 'umbler',
): Promise<Candidate[]> {
  if (items.length === 0) return [];
  const times = items.map((i) => i.at.getTime());
  const where = and(
    eq(chats.contactId, scope.contactId),
    eq(messages.channelId, scope.channelId),
    ne(messages.kind, 'note'),
    gte(messages.sentAt, new Date(Math.min(...times) - MATCH_WINDOW_MS)),
    lte(messages.sentAt, new Date(Math.max(...times) + MATCH_WINDOW_MS)),
  );
  const imported = and(eq(umblerMap.kind, 'message'), eq(umblerMap.localId, messages.id));
  const query = db
    .select({
      id: messages.id, chatId: messages.chatId, direction: messages.direction, kind: messages.kind, text: messages.body,
      at: messages.sentAt, authorId: messages.authorId, mediaPath: messages.mediaPath,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId));
  return side === 'ours'
    ? await query.leftJoin(umblerMap, imported).where(and(where, isNull(umblerMap.localId)))
    : await query.innerJoin(umblerMap, imported).where(and(where, isNull(messages.externalId)));
}

/** Any message imported from Umbler at all: without one, the history copy skips the reverse match (§8, one cheap read per batch). */
export async function hasUmblerMessages(db: Db | Tx): Promise<boolean> {
  const [row] = await db.select({ id: umblerMap.localId }).from(umblerMap).where(eq(umblerMap.kind, 'message')).limit(1);
  return row !== undefined;
}

/**
 * §8 the other way: a WhatsApp history message that is an Umbler row only gives it its WhatsApp id (counted as already
 * there). Covers a QR read after the switch, when the phone sends the last ~3.5 months again. True when it claimed one.
 */
export async function claimUmblerTwin(
  tx: Tx,
  scope: { contactId: string; channelId: string },
  ev: Comparable & { externalId: string },
): Promise<boolean> {
  const [pair] = pairUp([ev], await matchCandidates(tx, scope, [ev], 'umbler'));
  if (!pair) return false;
  await tx.update(messages).set({ externalId: ev.externalId }).where(eq(messages.id, pair.row.id));
  return true;
}
