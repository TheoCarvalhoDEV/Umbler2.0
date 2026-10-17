// Rules of the message actions (spec 2026-10-16 §3–§7), shared so the bubble menu (web) offers exactly what the
// API (server) accepts. Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

/** Who reacted, deleted or edited: an agent in the system, the contact, or the office's own phone. */
export type MessageChangeSource = 'office' | 'contact' | 'phone';

/** WhatsApp lets the sender edit for about 15 min and delete for everyone for about 2 days (spec §4, §5). */
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
export const RECENT_STICKERS_LIMIT = 40;
export const STICKER_MAX_BYTES = 1024 * 1024;
export const DELETED_REASON = 'Mensagem apagada';

/** The fields the rules read. A MessageDto fits, and so does a messages row passed as `{ ...row, deleted: row.deletedAt }`. */
export interface ActionTarget {
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  authorId: string | null;
  sentAt: string | Date;
  /** Truthy = deleted for everyone. */
  deleted?: unknown;
}

/**
 * Why an action is refused. `expired`: the action applies to this message but its time is over, so the menu shows
 * it disabled with `reason` as the hint. Otherwise the menu leaves it out. The API answers 409 with `reason` either way.
 */
export interface ActionBlock { reason: string; expired: boolean }

const block = (reason: string, expired = false): ActionBlock => ({ reason, expired });
const age = (m: ActionTarget, now: number) => now - new Date(m.sentAt).getTime();
/** Notes and pending/failed sends have no WhatsApp id to point a reaction, quote, edit or delete at. */
const noWhatsAppId = (m: ActionTarget) => m.kind === 'note' || m.status === 'pending' || m.status === 'failed';

export function reactBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (noWhatsAppId(m)) return block('Esta mensagem não aceita reação');
  return null;
}

export function replyBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (noWhatsAppId(m)) return block('Esta mensagem não pode ser citada');
  return null;
}

/** Spec §5: only text, or the caption of an image/video, sent by this very agent (never bot, triage or phone), for 15 min. */
export function editBlock(m: ActionTarget, userId: string | null, now: number): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.direction !== 'out' || m.authorId === null || m.authorId !== userId || noWhatsAppId(m)) {
    return block('Só dá para editar mensagens enviadas por você');
  }
  const editable = m.kind === 'text' || ((m.kind === 'image' || m.kind === 'video') && !!m.body);
  if (!editable) return block('Só dá para editar texto ou legenda');
  if (age(m, now) > EDIT_WINDOW_MS) return block('Só até 15 min após o envio', true);
  return null;
}

/** Spec §4: any office message (agent, bot, triage, phone) with a WhatsApp id, for 48 h; any agent who sees the chat. */
export function deleteBlock(m: ActionTarget, now: number): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.direction !== 'out' || noWhatsAppId(m)) return block('Só dá para apagar mensagens enviadas pelo escritório');
  if (age(m, now) > DELETE_WINDOW_MS) return block('Só até 48 h após o envio', true);
  return null;
}

/** Spec §7: notes and deleted messages are never forwarded; an unsupported message has nothing to send. */
export function forwardBlock(m: ActionTarget): ActionBlock | null {
  if (m.deleted) return block(DELETED_REASON);
  if (m.kind === 'note' || m.kind === 'unsupported') return block('Esta mensagem não pode ser encaminhada');
  return null;
}

/** Spec §3 "um emoji só": one grapheme that is a pictograph or a flag (skin tones and ZWJ families count as one). */
export function isSingleEmoji(s: string): boolean {
  const graphemes = [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s)];
  // ponytail: keycaps (1️⃣) and other non-pictographic emoji are refused; widen the class if someone misses one
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
}
