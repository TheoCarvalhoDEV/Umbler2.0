import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { lidFromJid, phoneFromJid } from '../whatsapp/phone.js';
import { placeRecords, realName, writeHistoryEvents, type ChannelRef, type ContactNames, type PlaceResult } from './place.js';

/** §5.2: findMessages page size; each page is placed in one transaction. */
export const PAGE_SIZE = 500;

export interface CopyTotals {
  inserted: number;
  contactsCreated: number;
  oldest: Date | null;
}

/** UTC calendar months covering [from, to], newest first; both bounds inclusive (Evolution floors to seconds). */
export function monthlyWindows(from: Date, to: Date): Array<{ gte: Date; lte: Date }> {
  const out: Array<{ gte: Date; lte: Date }> = [];
  let end = to;
  while (end >= from) {
    const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    out.push({ gte: monthStart < from ? from : monthStart, lte: end });
    end = new Date(monthStart.getTime() - 1000);
  }
  return out;
}

/** Address-book names Evolution keeps (DATABASE_SAVE_DATA_CONTACTS); best effort. */
async function loadContactNames(ctx: AppCtx, instance: string): Promise<ContactNames> {
  const names: ContactNames = new Map();
  try {
    for (const c of await ctx.wa.findContacts(instance)) {
      const name = realName(c.pushName);
      if (!name) continue;
      const phone = phoneFromJid(c.remoteJid);
      const lid = lidFromJid(c.remoteJid);
      if (phone) names.set(`p:${phone}`, name);
      if (lid) names.set(`l:${lid}`, name);
    }
  } catch (err) {
    // without names a contact shows its number, or "Contato sem número"
    console.error('history: findContacts failed', errorTag(err));
  }
  return names;
}

/**
 * Copies Evolution's stored messages with messageTimestamp in [from, to] as history (§5.2–5.4): monthly windows
 * newest first, every page of each. `onPage` sees each page's result (progress). Throws on the first Evolution
 * failure; what was copied before stays, and its history_imported events are still written.
 */
export async function copyRange(
  ctx: AppCtx,
  channel: ChannelRef,
  from: Date,
  to: Date,
  onPage?: (r: PlaceResult) => Promise<void>,
): Promise<CopyTotals> {
  const totals: CopyTotals = { inserted: 0, contactsCreated: 0, oldest: null };
  const names = await loadContactNames(ctx, channel.evolutionInstance);
  const seen = new Set<string>();
  const historyCounts = new Map<string, number>();
  try {
    for (const w of monthlyWindows(from, to)) {
      // ponytail: OFFSET pages over "messageTimestamp DESC" with no tiebreaker may swap a row at a page edge inside a
      // same-second group (measured: never at offset 500); only a later import pass over the same window (an automatic import's 2-min repeats, or a new import) picks a missed row up;
      // the back-fill covers just backfill_until - 10 min .. now - 30 min, so it recovers one only inside that window.
      for (let page = 1, pages = 1; page <= pages; page += 1) {
        const res = await ctx.wa.findMessages(channel.evolutionInstance, { gte: w.gte, lte: w.lte, page, offset: PAGE_SIZE });
        pages = res.pages;
        const r = await placeRecords(ctx, channel, res.records, { names, seen });
        totals.inserted += r.inserted;
        totals.contactsCreated += r.contactsCreated;
        if (r.oldest && (!totals.oldest || r.oldest < totals.oldest)) totals.oldest = r.oldest;
        for (const [id, n] of r.historyCounts) historyCounts.set(id, (historyCounts.get(id) ?? 0) + n);
        if (onPage) await onPage(r);
      }
    }
  } finally {
    // best effort: a failure here must not mask the Evolution error that is propagating
    await writeHistoryEvents(ctx, historyCounts).catch((err: unknown) => console.error('history: writing events failed', errorTag(err)));
  }
  return totals;
}
