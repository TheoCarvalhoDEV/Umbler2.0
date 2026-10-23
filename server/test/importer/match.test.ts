import { beforeEach, describe, expect, it } from 'vitest';
import { messages, umblerMap } from '../../src/db/schema.js';
import { MATCH_WINDOW_MS, matchCandidates, normalizeText, pairUp, type Comparable } from '../../src/importer/match.js';
import { makeTestCtx, seedBasics } from '../helpers.js';
import { insertChat, newContact } from '../inbox/fixtures.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + s * 1000);
const msg = (o: Partial<Comparable> & { at: Date }): Comparable => ({ direction: 'in', kind: 'text', text: 'Bom dia', ...o });

describe('pairUp (spec 2026-10-21 importar-umbler §8)', () => {
  it('same direction, class and text within 10 s matches; 11 s, the other direction or another text does not', () => {
    const ours = [msg({ at: at(10) })];
    expect(MATCH_WINDOW_MS).toBe(10_000);
    expect(pairUp([msg({ at: at(0) })], ours)).toEqual([{ row: ours[0], diffMs: 10_000 }]);
    expect(pairUp([msg({ at: at(-1) })], ours)).toEqual([null]);
    expect(pairUp([msg({ at: at(10), direction: 'out' })], ours)).toEqual([null]);
    expect(pairUp([msg({ at: at(10), text: 'Bom dia!' })], ours)).toEqual([null]);
  });

  it('drops the signature line, CRLF, the spaces at the ends and compares NFC; a GIF image matches a WhatsApp video', () => {
    expect(normalizeText('*Financeiro - Ana:*\r\nSegue o boleto  ')).toBe('Segue o boleto');
    // the signature line in any form it may reach WhatsApp (Umbler's on-wire format is not verified)
    for (const line of ['*Ana:*', '*Ana*:', '*Ana*', '*Ana*: ', '*Ana:* ']) expect(normalizeText(`${line}\nSegue o boleto`)).toBe('Segue o boleto');
    expect(normalizeText('*Ana*\nSegue o boleto')).toBe(normalizeText('*Financeiro - Ana:*\nSegue o boleto'));
    expect(normalizeText('Segue *o* boleto')).toBe('Segue *o* boleto'); // only a first line of its own
    expect(normalizeText('*Atenção* ao prazo')).toBe('*Atenção* ao prazo');
    const signed = msg({ at: at(0), direction: 'out', text: '*Financeiro - Ana:*\r\nSegue o boleto  ' });
    expect(pairUp([signed], [msg({ at: at(2), direction: 'out', text: 'Segue o boleto' })])[0]).not.toBeNull();
    expect(pairUp([msg({ at: at(0), text: 'Sim, João' })], [msg({ at: at(0), text: 'Sim, João' })])[0]).not.toBeNull();
    const gif = msg({ at: at(0), kind: 'image', text: null });
    expect(pairUp([gif], [msg({ at: at(1), kind: 'video', text: '' })])[0]).not.toBeNull();
    expect(pairUp([gif], [msg({ at: at(1), kind: 'text', text: '' })])[0]).toBeNull();
    // a location or contact card from Umbler compares as WhatsApp's 'unsupported' with no text
    expect(pairUp([msg({ at: at(0), kind: 'unsupported', text: null })], [msg({ at: at(3), kind: 'unsupported', text: null })])[0]).not.toBeNull();
  });

  it('one to one in time order: a burst of equal texts pairs up; each takes the nearest free one, a tie the older', () => {
    const ours = [msg({ at: at(0.5), text: 'ok' }), msg({ at: at(1.2), text: 'ok' })];
    const pairs = pairUp([msg({ at: at(0), text: 'ok' }), msg({ at: at(1), text: 'ok' })], ours);
    expect(pairs.map((p) => p?.row)).toEqual([ours[0], ours[1]]);
    expect(pairUp([msg({ at: at(5), text: 'ok' }), msg({ at: at(5), text: 'ok' }), msg({ at: at(5), text: 'ok' })], [
      msg({ at: at(7), text: 'ok' }),
      msg({ at: at(3), text: 'ok' }),
    ]).map((p) => p?.row.at.getTime())).toEqual([at(3).getTime(), at(7).getTime(), undefined]);
  });
});

describe('matchCandidates (spec §8.1)', () => {
  it("lists the contact's rows on the channel in the window, any chat, never notes; 'ours' are not imported, 'umbler' have no WhatsApp id", async () => {
    const ctx = await makeTestCtx();
    const s = await seedBasics(ctx);
    const contactId = await newContact(ctx);
    const other = await newContact(ctx);
    const historyChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId, state: 'closed', history: true });
    const openChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId });
    const otherChat = await insertChat(ctx, { channelId: s.channelId, sectorId: s.defaultSector, contactId: other });
    const row = async (chatId: string, sentAt: Date, extra: Partial<typeof messages.$inferInsert> = {}) => {
      const [m] = await ctx.db
        .insert(messages)
        .values({ chatId, channelId: s.channelId, direction: 'in', kind: 'text', body: 'Bom dia', status: 'read', sentAt, ...extra })
        .returning({ id: messages.id });
      return m!.id;
    };
    const fromHistory = await row(historyChat, at(0), { externalId: 'wa-1' });
    const fromOpen = await row(openChat, at(9), { externalId: 'wa-2' });
    await row(openChat, at(1), { kind: 'note', direction: 'out' });
    await row(openChat, at(30), { externalId: 'wa-3' }); // outside the window
    await row(otherChat, at(0), { externalId: 'wa-4' });
    const imported = await row(historyChat, at(2));
    const importedWithId = await row(historyChat, at(3), { externalId: 'wa-5' });
    await ctx.db.insert(umblerMap).values([
      { kind: 'message', umblerId: 'U1', localId: imported },
      { kind: 'message', umblerId: 'U2', localId: importedWithId },
    ]);

    const scope = { contactId, channelId: s.channelId };
    const ids = async (side: 'ours' | 'umbler') => (await matchCandidates(ctx.db, scope, [{ at: at(5) }], side)).map((c) => c.id).sort();
    expect(await ids('ours')).toEqual([fromHistory, fromOpen].sort());
    expect(await ids('umbler')).toEqual([imported]);
    expect(await matchCandidates(ctx.db, scope, [], 'ours')).toEqual([]);
  });
});
