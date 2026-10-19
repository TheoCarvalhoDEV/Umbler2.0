import { describe, expect, it } from 'vitest';
import {
  DELETE_WINDOW_MS, EDIT_WINDOW_MS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, noteDeleteBlock, noteEditBlock,
  reactBlock, replyBlock, type ActionTarget,
} from '@talk/shared';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const out = (over: Partial<ActionTarget> = {}): ActionTarget => ({
  direction: 'out', kind: 'text', body: 'Olá', status: 'sent', authorId: 'u1', sentAt: ago(60_000), deleted: null, ...over,
});

describe('message action rules', () => {
  it('lets the author edit a text, or a caption, for 15 minutes', () => {
    expect(editBlock(out(), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ kind: 'image', body: 'legenda' }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ kind: 'video', body: 'legenda' }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ sentAt: ago(EDIT_WINDOW_MS) }), 'u1', NOW)).toBeNull();
    expect(editBlock(out({ sentAt: ago(EDIT_WINDOW_MS + 1) }), 'u1', NOW)).toEqual({
      reason: 'Só até 15 min após o envio', expired: true,
    });
  });

  it('never edits someone else, a bot, the phone, a failed send or a non-text message', () => {
    const notYours = { reason: 'Só dá para editar mensagens enviadas por você', expired: false };
    expect(editBlock(out(), 'u2', NOW)).toEqual(notYours);
    expect(editBlock(out({ authorId: null }), null, NOW)).toEqual(notYours); // bot, triage and office phone have no author
    expect(editBlock(out({ direction: 'in', authorId: null }), 'u1', NOW)).toEqual(notYours);
    expect(editBlock(out({ status: 'failed' }), 'u1', NOW)).toEqual(notYours);
    const notText = { reason: 'Só dá para editar texto ou legenda', expired: false };
    expect(editBlock(out({ kind: 'document', body: 'Segue' }), 'u1', NOW)).toEqual(notText);
    expect(editBlock(out({ kind: 'image', body: null }), 'u1', NOW)).toEqual(notText);
    expect(editBlock(out({ kind: 'audio', body: null }), 'u1', NOW)).toEqual(notText);
  });

  it('deletes for everyone only office messages with a WhatsApp id, for 48 hours', () => {
    expect(deleteBlock(out({ authorId: null }), NOW)).toBeNull(); // bot, triage and phone sends are the office too
    expect(deleteBlock(out({ sentAt: ago(DELETE_WINDOW_MS) }), NOW)).toBeNull();
    expect(deleteBlock(out({ sentAt: ago(DELETE_WINDOW_MS + 1) }), NOW)).toEqual({
      reason: 'Só até 48 h após o envio', expired: true,
    });
    const notOffice = { reason: 'Só dá para apagar mensagens enviadas pelo escritório', expired: false };
    expect(deleteBlock(out({ direction: 'in' }), NOW)).toEqual(notOffice);
    expect(deleteBlock(out({ kind: 'note' }), NOW)).toEqual(notOffice);
    expect(deleteBlock(out({ status: 'pending' }), NOW)).toEqual(notOffice);
  });

  it('reacts to and quotes any message that has a WhatsApp id', () => {
    expect(reactBlock(out({ direction: 'in' }))).toBeNull();
    expect(reactBlock(out())).toBeNull();
    expect(reactBlock(out({ status: 'pending' }))).toEqual({ reason: 'Esta mensagem não aceita reação', expired: false });
    expect(reactBlock(out({ kind: 'note' }))?.expired).toBe(false);
    expect(replyBlock(out({ direction: 'in' }))).toBeNull();
    expect(replyBlock(out({ status: 'failed' }))).toEqual({ reason: 'Esta mensagem não pode ser citada', expired: false });
  });

  it('forwards anything with content except notes and unsupported messages', () => {
    expect(forwardBlock(out({ direction: 'in', kind: 'image' }))).toBeNull();
    expect(forwardBlock(out({ status: 'failed' }))).toBeNull(); // the content is ours; the WhatsApp id does not matter
    expect(forwardBlock(out({ kind: 'note' }))).toEqual({ reason: 'Esta mensagem não pode ser encaminhada', expired: false });
    expect(forwardBlock(out({ kind: 'unsupported' }))?.expired).toBe(false);
  });

  it('refuses every action on a deleted message, whatever else is true', () => {
    const deleted = out({ deleted: new Date() });
    const gone = { reason: 'Mensagem apagada', expired: false };
    expect(reactBlock(deleted)).toEqual(gone);
    expect(replyBlock(deleted)).toEqual(gone);
    expect(forwardBlock(deleted)).toEqual(gone);
    expect(editBlock(deleted, 'u1', NOW)).toEqual(gone);
    expect(deleteBlock(deleted, NOW)).toEqual(gone);
  });

  it('accepts exactly one emoji', () => {
    for (const e of ['👍', '❤️', '😂', '🙏', '👍🏽', '👨‍👩‍👧', '🇧🇷']) expect(isSingleEmoji(e)).toBe(true);
    for (const e of ['', 'a', '👍👍', 'ok👍', '1', ' ']) expect(isSingleEmoji(e)).toBe(false);
  });
});

describe('note rules (spec 2026-10-19 §3)', () => {
  const note = (over: Partial<ActionTarget> = {}) => out({ kind: 'note', ...over });
  const notAuthor = { reason: 'Só quem escreveu a nota pode editá-la', expired: false };
  const notANote = { reason: 'Esta mensagem não é uma nota', expired: false };

  it('only the author edits a note, with no time limit', () => {
    expect(noteEditBlock(note({ sentAt: ago(30 * 24 * 3_600_000) }), 'u1')).toBeNull();
    expect(noteEditBlock(note(), 'u2')).toEqual(notAuthor);
    expect(noteEditBlock(note({ authorId: null }), null)).toEqual(notAuthor);
    expect(noteEditBlock(out(), 'u1')).toEqual(notANote);
  });

  it('the author or an admin deletes a note; nobody deletes a message that is not a note through it', () => {
    expect(noteDeleteBlock(note(), 'u1', false)).toBeNull();
    expect(noteDeleteBlock(note(), 'u2', true)).toBeNull();
    expect(noteDeleteBlock(note(), 'u2', false)).toEqual({
      reason: 'Só quem escreveu a nota ou um administrador pode apagá-la', expired: false,
    });
    expect(noteDeleteBlock(out(), 'u1', true)).toEqual(notANote);
  });
});
