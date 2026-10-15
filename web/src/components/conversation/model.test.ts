import { describe, expect, it } from 'vitest';
import type { ChatEventDto, MessageDto, TimelineItem } from '@talk/shared';
import { ApiError } from '../../lib/api';
import { buildTimelineRows, dayLabel, errorMessage, eventText, isConflict, mergeTimelinePages, previewText } from './model';

// local wall-clock times, so the day boundaries match the browser's time zone
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();
const NOW = new Date(2026, 9, 14, 15, 0); // 14/10/2026 15:00 local

function msg(id: string, sentAt: string, over: Partial<MessageDto> = {}): TimelineItem {
  return {
    type: 'message', id, chatId: 'c1', direction: 'in', kind: 'text', body: id, media: null, mediaUnavailable: false,
    authorId: null, authorName: null, authorAvatarUrl: null, replyTo: null, reaction: null, status: 'read', error: null, sentAt, ...over,
  };
}

function ev(id: string, createdAt: string, over: Partial<ChatEventDto> = {}): TimelineItem {
  return { type: 'event', id, chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt, ...over };
}

function event(over: Partial<ChatEventDto>): ChatEventDto {
  return { id: 'e', chatId: 'c1', kind: 'created', data: {}, authorName: null, createdAt: at(2026, 10, 14, 9), ...over };
}

describe('dayLabel', () => {
  it('says Hoje, Ontem, or dd/mm/aaaa', () => {
    expect(dayLabel(at(2026, 10, 14, 0, 1), NOW)).toBe('Hoje');
    expect(dayLabel(at(2026, 10, 13, 23, 59), NOW)).toBe('Ontem');
    expect(dayLabel(at(2026, 3, 5, 10), NOW)).toBe('05/03/2026');
  });

  it('handles the year boundary', () => {
    expect(dayLabel(at(2026, 12, 31, 22), new Date(2027, 0, 1, 8))).toBe('Ontem');
    expect(dayLabel(at(2026, 12, 30, 22), new Date(2027, 0, 1, 8))).toBe('30/12/2026');
  });
});

describe('buildTimelineRows', () => {
  it('inserts one date separator before the first item of each local day', () => {
    const items = [
      msg('a', at(2026, 10, 12, 9)),
      msg('b', at(2026, 10, 13, 10)),
      ev('e1', at(2026, 10, 14, 8)),
      msg('c', at(2026, 10, 14, 9)),
    ];
    const rows = buildTimelineRows(items, NOW);
    expect(rows.map((r) => (r.kind === 'date' ? `[${r.label}]` : r.item.id))).toEqual([
      '[12/10/2026]', 'a', '[Ontem]', 'b', '[Hoje]', 'e1', 'c',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length); // keys are unique React keys
  });

  it('returns no rows for an empty timeline', () => {
    expect(buildTimelineRows([], NOW)).toEqual([]);
  });
});

describe('mergeTimelinePages', () => {
  it('flattens newest-first pages into one ascending list without duplicates', () => {
    const newest = [msg('c', at(2026, 10, 14, 9), { body: 'versão nova' }), msg('d', at(2026, 10, 14, 10))];
    const older = [msg('a', at(2026, 10, 12, 9)), ev('b', at(2026, 10, 13, 9)), msg('c', at(2026, 10, 14, 9), { body: 'versão velha' })];
    const merged = mergeTimelinePages([newest, older]);
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect((merged[2] as MessageDto).body).toBe('versão nova'); // the newest page wins
  });

  it('keeps the server order for items with the same timestamp (arrival order, not id)', () => {
    const t = at(2026, 10, 14, 9);
    expect(mergeTimelinePages([[msg('m2', t), msg('m1', t)]]).map((i) => i.id)).toEqual(['m2', 'm1']);
  });

  it('keeps the server order for a same-timestamp burst split across a page boundary', () => {
    const t = at(2026, 10, 14, 9);
    const older = [msg('a', at(2026, 10, 14, 8)), msg('z', t)];
    const newest = [msg('b', t), msg('y', t)];
    expect(mergeTimelinePages([newest, older]).map((i) => i.id)).toEqual(['a', 'z', 'b', 'y']);
  });

  it('keeps a message and an event that share an id apart', () => {
    expect(mergeTimelinePages([[msg('x', at(2026, 10, 14, 9)), ev('x', at(2026, 10, 14, 8))]])).toHaveLength(2);
  });
});

describe('eventText', () => {
  const names = new Map([['s-fin', 'Financeiro'], ['u-ana', 'Ana']]);

  it('describes each kind in Portuguese', () => {
    expect(eventText(event({ kind: 'created' }), names)).toBe('Conversa iniciada pelo contato');
    expect(eventText(event({ kind: 'created', data: { by: 'u-bia' }, authorName: 'Bia' }), names)).toBe('Conversa iniciada por Bia');
    expect(eventText(event({ kind: 'assigned', authorName: 'Bia' }), names)).toBe('Bia assumiu a conversa');
    expect(
      eventText(event({ kind: 'transferred', authorName: 'Bia', data: { toSectorId: 's-fin', toOwnerId: 'u-ana' } }), names),
    ).toBe('Conversa transferida por Bia para Financeiro / Ana');
    expect(eventText(event({ kind: 'privacy_changed', authorName: 'Bia', data: { private: true } }), names)).toBe(
      'Conversa tornada privada por Bia',
    );
    expect(eventText(event({ kind: 'privacy_changed', authorName: 'Bia', data: { private: false } }), names)).toBe(
      'Conversa tornada pública por Bia',
    );
    expect(eventText(event({ kind: 'closed', authorName: 'Bia' }), names)).toBe('Conversa finalizada por Bia');
    expect(eventText(event({ kind: 'reopened', authorName: 'Bia' }), names)).toBe('Conversa reaberta por Bia');
    expect(eventText(event({ kind: 'triage_routed', data: { sectorId: 's-fin' } }), names)).toBe(
      'Triagem: encaminhada para Financeiro',
    );
  });
});

describe('small helpers', () => {
  it('previewText falls back to a label per media kind', () => {
    expect(previewText('  oi  ', 'text')).toBe('oi');
    expect(previewText(null, 'image')).toBe('📷 Imagem');
    expect(previewText('', 'audio')).toBe('🎤 Áudio');
    expect(previewText(null, 'whatever')).toBe('Mensagem');
  });

  it('errorMessage and isConflict read ApiError', () => {
    expect(isConflict(new ApiError(409, 'Conflito'))).toBe(true);
    expect(isConflict(new ApiError(404, 'Não encontrado'))).toBe(false);
    expect(errorMessage(new ApiError(404, 'Não encontrado'))).toBe('Não encontrado');
    expect(errorMessage('boom')).toBe('Ocorreu um erro');
  });
});
