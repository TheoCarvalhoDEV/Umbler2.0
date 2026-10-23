import { describe, expect, it } from 'vitest';
import type { ChatEventDto, MessageDto, TimelineItem } from '@talk/shared';
import { ApiError } from '../../lib/api';
import {
  buildTimelineRows, dayLabel, deletedTag, editedTag, errorMessage, eventText, isConflict, mergeTimelinePages, newerCursor,
  isSendKey, olderCursor, previewText, resultsLabel,
} from './model';

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

describe('eventText for scheduled messages and automatic rules (spec 2026-10-20 agendamentos)', () => {
  it('describes each new kind in Portuguese, dates in Cuiabá time', () => {
    const sendAt = '2026-10-21T12:00:00.000Z'; // 08:00 in Cuiabá
    expect(eventText(event({ kind: 'message_scheduled', authorName: 'Bia', data: { scheduledId: 's1', sendAt } }), new Map())).toBe(
      'Mensagem agendada por Bia para 21/10/2026 08:00',
    );
    expect(
      eventText(event({ kind: 'message_scheduled', authorName: 'Bia', data: { scheduledId: 's1', sendAt, edited: true } }), new Map()),
    ).toBe('Mensagem agendada alterada por Bia para 21/10/2026 08:00');
    expect(eventText(event({ kind: 'scheduled_canceled', authorName: 'Bia', data: { scheduledId: 's1' } }), new Map())).toBe(
      'Mensagem agendada cancelada por Bia',
    );
    expect(eventText(event({ kind: 'returned_to_queue', data: { minutes: 30, previousOwnerId: 'u-ana' } }), new Map())).toBe(
      'Devolvida à fila: sem resposta há 30 min',
    );
    expect(eventText(event({ kind: 'closed', data: { closingMessageSent: true, reason: 'inactivity', hours: 24 } }), new Map())).toBe(
      'Finalizada por inatividade',
    );
    expect(eventText(event({ kind: 'closed', authorName: 'Bia' }), new Map())).toBe('Conversa finalizada por Bia');
  });
});

describe('eventText for appointments (spec 2026-10-21 compromissos §6)', () => {
  it('says marcado, remarcado and cancelado, with the date in Cuiabá time', () => {
    const data = { appointmentId: 'a1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z' }; // 14:00 in Cuiabá
    expect(eventText(event({ kind: 'appointment_scheduled', authorName: 'Bia', data }), new Map())).toBe(
      'Compromisso “Audiência” marcado por Bia para 21/10/2026 14:00',
    );
    expect(eventText(event({ kind: 'appointment_scheduled', authorName: 'Bia', data: { ...data, edited: true } }), new Map())).toBe(
      'Compromisso “Audiência” remarcado por Bia para 21/10/2026 14:00',
    );
    expect(
      eventText(event({ kind: 'appointment_canceled', authorName: 'Bia', data: { appointmentId: 'a1', title: 'Audiência' } }), new Map()),
    ).toBe('Compromisso “Audiência” cancelado por Bia');
  });
});

describe('eventText for history events', () => {
  it('describes an import into a history chat and a contact merge', () => {
    expect(eventText(event({ kind: 'history_imported', data: { count: 1234 } }), new Map())).toBe(
      'Histórico do WhatsApp importado: 1.234 mensagens',
    );
    expect(eventText(event({ kind: 'contact_merged' }), new Map())).toBe('Contato sem número juntado a este contato');
  });
});

describe('eventText for the Umbler import (spec 2026-10-21 importar-umbler §10)', () => {
  it('describes an imported chat and one joined into a chat here', () => {
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 1234 } }), new Map())).toBe('Conversa importada do Umbler Talk: 1.234 mensagens');
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 3, merged: true } }), new Map())).toBe(
      '3 mensagens de uma conversa aberta no Umbler Talk juntadas a esta',
    );
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 1 } }), new Map())).toBe('Conversa importada do Umbler Talk: 1 mensagem');
    expect(eventText(event({ kind: 'umbler_imported', data: { count: 1, merged: true } }), new Map())).toBe(
      '1 mensagem de uma conversa aberta no Umbler Talk juntada a esta',
    );
  });
});

describe('eventText for chatbot events', () => {
  const names = new Map([['s-fin', 'Financeiro'], ['u-ana', 'Ana']]);
  const bot = { botId: 'b1', botName: 'Triagem', runId: 'r1' };

  it('describes each bot kind in Portuguese', () => {
    expect(eventText(event({ kind: 'bot_started', data: bot }), names)).toBe('Chatbot Triagem iniciado');
    expect(eventText(event({ kind: 'bot_finished', data: bot }), names)).toBe('Chatbot Triagem finalizado');
    expect(eventText(event({ kind: 'bot_stopped', data: { ...bot, reason: 'manual' } }), names)).toBe('Chatbot Triagem parado');
    expect(eventText(event({ kind: 'bot_stopped', authorName: 'Bia', data: { ...bot, reason: 'manual', by: 'u-bia' } }), names)).toBe(
      'Chatbot Triagem parado por Bia',
    );
    expect(eventText(event({ kind: 'bot_failed', data: { ...bot, reason: 'Limite de 5 fluxos encadeados' } }), names)).toBe(
      'Chatbot Triagem falhou: Limite de 5 fluxos encadeados',
    );
    expect(eventText(event({ kind: 'bot_failed', data: bot }), names)).toBe('Chatbot Triagem falhou');
    expect(eventText(event({ kind: 'bot_transferred', data: { ...bot, toSectorId: 's-fin', toOwnerId: 'u-ana' } }), names)).toBe(
      'Chatbot Triagem transferiu para Financeiro · Ana',
    );
    expect(eventText(event({ kind: 'bot_transferred', data: { ...bot, toSectorId: 's-x', toOwnerId: null } }), names)).toBe(
      'Chatbot Triagem transferiu para outro setor',
    );
    expect(eventText(event({ kind: 'bot_note', data: { ...bot, text: 'Cliente VIP' } }), names)).toBe('Nota do chatbot Triagem: Cliente VIP');
    expect(eventText(event({ kind: 'bot_started' }), names)).toBe('Chatbot Chatbot iniciado');
  });

  it('marks privacy changes and closes done by a bot', () => {
    expect(eventText(event({ kind: 'privacy_changed', data: { ...bot, private: true } }), names)).toBe(
      'Conversa tornada privada · Chatbot Triagem',
    );
    expect(eventText(event({ kind: 'closed', data: { ...bot, closingMessageSent: true } }), names)).toBe(
      'Conversa finalizada · Chatbot Triagem',
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
    expect(errorMessage('boom')).toBe('Não foi possível concluir. Tente de novo.');
  });
});

describe('message action texts', () => {
  const names = new Map<string, string>();
  const when = '2026-10-16T12:00:00.000Z';

  it('describes deletes and edits by who made them', () => {
    const del = (data: Record<string, unknown>, authorName: string | null = null) =>
      eventText(event({ kind: 'message_deleted', data, authorName }), names);
    expect(del({ messageId: 'm1', source: 'office' }, 'Bia')).toBe('Mensagem apagada por Bia');
    expect(del({ messageId: 'm1', source: 'contact' })).toBe('Mensagem apagada pelo contato');
    expect(del({ messageId: 'm1', source: 'phone' })).toBe('Mensagem apagada pelo celular');
    expect(eventText(event({ kind: 'message_edited', authorName: 'Bia', data: { messageId: 'm1', source: 'office' } }), names)).toBe(
      'Mensagem editada por Bia',
    );
    expect(eventText(event({ kind: 'message_edited', data: { messageId: 'm1', source: 'contact' } }), names)).toBe(
      'Mensagem editada pelo contato',
    );
  });

  it('labels the bubble tags exactly as the spec', () => {
    expect(deletedTag({ at: when, source: 'contact', byName: null })).toBe('Apagada pelo contato');
    expect(deletedTag({ at: when, source: 'office', byName: 'Ana Lima' })).toBe('Apagada por Ana Lima');
    expect(deletedTag({ at: when, source: 'phone', byName: null })).toBe('Apagada pelo celular');
    expect(editedTag({ at: when, source: 'office', newTextUnavailable: false })).toBe('editada');
    expect(editedTag({ at: when, source: 'contact', newTextUnavailable: false })).toBe('editada pelo contato');
    expect(editedTag({ at: when, source: 'contact', newTextUnavailable: true })).toBe('editada pelo contato (novo texto indisponível)');
    expect(editedTag({ at: when, source: 'phone', newTextUnavailable: false })).toBe('editada pelo celular');
  });
});

describe('note texts (spec 2026-10-19 §3)', () => {
  it('names who deleted a note', () => {
    const names = new Map<string, string>();
    expect(eventText(event({ kind: 'note_deleted', authorName: 'Bia' }), names)).toBe('Nota apagada por Bia');
    expect(eventText(event({ kind: 'note_deleted' }), names)).toBe('Nota apagada');
  });
});

describe('anchored timeline cursors (spec 2026-10-19 §4)', () => {
  const page = (...ids: string[]) => ids.map((id, i) => msg(id, at(2026, 10, 14, 9, i)));

  it('the page around a message pages on from an end only when that half came back full', () => {
    const full = page('a', 'b', 'c', 'd', 'e'); // size 4 → half 2: two older, the target, two newer
    expect(olderCursor(full, { around: 'c' }, 4)).toEqual({ before: 'a' });
    expect(newerCursor(full, { around: 'c' }, 4)).toEqual({ after: 'e' });
    expect(olderCursor(page('c', 'd', 'e'), { around: 'c' }, 4)).toBeUndefined(); // nothing older than c
    expect(newerCursor(page('a', 'b', 'c', 'd'), { around: 'c' }, 4)).toBeUndefined(); // one newer: the present
  });

  it('an after page (the start of a refetch) always pages older from its first item', () => {
    expect(olderCursor(page('d', 'e'), { after: 'c' }, 4)).toEqual({ before: 'd' });
  });

  it('before and after pages stop when one comes back short', () => {
    expect(olderCursor(page('a', 'b', 'c', 'd'), { before: 'x' }, 4)).toEqual({ before: 'a' });
    expect(olderCursor(page('a', 'b'), { before: 'x' }, 4)).toBeUndefined();
    expect(newerCursor(page('a', 'b', 'c', 'd'), { after: 'x' }, 4)).toEqual({ after: 'd' });
    expect(newerCursor(page('a'), { after: 'x' }, 4)).toBeUndefined();
    expect(olderCursor([], { before: 'x' }, 4)).toBeUndefined();
  });
});

describe('resultsLabel (spec 2026-10-19 §4)', () => {
  it('counts the hits; a full page reads 50+', () => {
    expect(resultsLabel(0)).toBe('Nenhum resultado');
    expect(resultsLabel(1)).toBe('1 resultado');
    expect(resultsLabel(12)).toBe('12 resultados');
    expect(resultsLabel(50)).toBe('50+ resultados');
  });
});

describe('isSendKey (spec 2026-10-19 §6)', () => {
  const key = (over: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }> = {}) => ({
    key: over.key ?? 'Enter', shiftKey: !!over.shiftKey, ctrlKey: !!over.ctrlKey, metaKey: !!over.metaKey,
    nativeEvent: { isComposing: !!over.composing },
  });

  it('on: Enter sends, Shift+Enter does not; off: only Ctrl or Cmd+Enter sends; never while composing', () => {
    expect(isSendKey(key(), true)).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), true)).toBe(false);
    expect(isSendKey(key(), false)).toBe(false);
    expect(isSendKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isSendKey(key({ metaKey: true }), false)).toBe(true);
    expect(isSendKey(key({ composing: true }), true)).toBe(false);
    expect(isSendKey(key({ key: 'a' }), true)).toBe(false);
  });
});
