import { SEARCH_LIMIT, type ChatEventDto, type MessageDto, type TimelineItem } from '@talk/shared';
import { ApiError, type TimelineCursor } from '../../lib/api';

export const TIMELINE_PAGE_SIZE = 50;

/** Spec 2026-10-19 §4: a message to bring into view; a new `seq` jumps again to the same message. */
export interface TimelineFocus { messageId: string; seq: number }
export const FOCUS_HIGHLIGHT_MS = 3000;

/**
 * Anchored timeline: the cursor of the next older page, or undefined at the start of the chat. The page around a message
 * asked for half a page on each side, so a full older half means there may be more.
 */
export function olderCursor(page: TimelineItem[], param: TimelineCursor, size: number): TimelineCursor | undefined {
  const first = page[0];
  if (!first) return undefined;
  if ('around' in param) {
    const i = page.findIndex((it) => it.id === param.around);
    return i >= Math.floor(size / 2) ? { before: first.id } : undefined;
  }
  return page.length < size ? undefined : { before: first.id };
}

/** Anchored timeline: the cursor of the next newer page, or undefined once the present is loaded. */
export function newerCursor(page: TimelineItem[], param: TimelineCursor, size: number): TimelineCursor | undefined {
  const last = page.at(-1);
  if (!last) return undefined;
  if ('around' in param) {
    const i = page.findIndex((it) => it.id === param.around);
    return i >= 0 && page.length - 1 - i >= Math.floor(size / 2) ? { after: last.id } : undefined;
  }
  return page.length < size ? undefined : { after: last.id };
}

export type TimelineRow =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'item'; key: string; item: TimelineItem };

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const itemKey = (it: TimelineItem) => `${it.type}:${it.id}`;
const itemTime = (it: TimelineItem) => (it.type === 'message' ? it.sentAt : it.createdAt);

/**
 * Infinite-query pages (pages[0] = newest, each ascending) → one ascending list. Ties keep the server's order
 * (sent_at, created_at, id): pages are concatenated oldest-first and the sort is stable, with no id tie-break.
 */
export function mergeTimelinePages(pages: TimelineItem[][]): TimelineItem[] {
  const byKey = new Map<string, TimelineItem>();
  for (const page of pages.slice().reverse()) {
    for (const it of page) byKey.set(itemKey(it), it); // newer page overwrites the value; Map keeps the first position
  }
  return [...byKey.values()].sort((a, b) => Date.parse(itemTime(a)) - Date.parse(itemTime(b)));
}

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (localDay(d) === localDay(now)) return 'Hoje';
  if (localDay(d) === localDay(yesterday)) return 'Ontem';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function buildTimelineRows(items: TimelineItem[], now: Date): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let lastDay = '';
  for (const item of items) {
    const day = localDay(new Date(itemTime(item)));
    if (day !== lastDay) {
      rows.push({ kind: 'date', key: `day:${day}`, label: dayLabel(itemTime(item), now) });
      lastDay = day;
    }
    rows.push({ kind: 'item', key: itemKey(item), item });
  }
  return rows;
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_PREVIEW: Record<string, string> = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎬 Vídeo',
  document: '📄 Documento',
  sticker: 'Figurinha',
  unsupported: 'Mensagem não suportada',
};

export function previewText(body: string | null, kind: string): string {
  return body?.trim() || KIND_PREVIEW[kind] || 'Mensagem';
}

/** "Buscar na conversa" counter (spec 2026-10-19 §4). The server stops at SEARCH_LIMIT, so a full page reads "50+". */
export function resultsLabel(n: number): string {
  if (n === 0) return 'Nenhum resultado';
  if (n === 1) return '1 resultado';
  // ponytail: exactly 50 matches also reads "50+"; ask the server for one more row if that ever confuses someone
  return n >= SEARCH_LIMIT ? `${n}+ resultados` : `${n} resultados`;
}

/** dd/mm/aaaa hh:mm in the browser's time zone. */
export function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** `names` maps sector and user ids to names (UUIDs never collide across tables). */
export function eventText(e: ChatEventDto, names: Map<string, string>): string {
  const name = (v: unknown) => (typeof v === 'string' ? names.get(v) : undefined);
  const by = e.authorName ? ` por ${e.authorName}` : '';
  const bot = String(e.data.botName ?? 'Chatbot');
  const viaBot = typeof e.data.botName === 'string' ? ` · Chatbot ${e.data.botName}` : ''; // privacy/close done by a bot
  switch (e.kind) {
    case 'created':
      return e.authorName ? `Conversa iniciada por ${e.authorName}` : 'Conversa iniciada pelo contato';
    case 'assigned':
      return `${e.authorName ?? 'Atendente'} assumiu a conversa`;
    case 'transferred': {
      const to = [name(e.data.toSectorId), name(e.data.toOwnerId)].filter(Boolean).join(' / ');
      return `Conversa transferida${by}${to ? ` para ${to}` : ''}`;
    }
    case 'privacy_changed':
      return `Conversa tornada ${e.data.private === true ? 'privada' : 'pública'}${by}${viaBot}`;
    case 'closed':
      return `Conversa finalizada${by}${viaBot}`;
    case 'reopened':
      return `Conversa reaberta${by}`;
    case 'triage_routed':
      return `Triagem: encaminhada para ${name(e.data.sectorId) ?? 'outro setor'}`;
    case 'bot_started':
      return `Chatbot ${bot} iniciado`;
    case 'bot_finished':
      return `Chatbot ${bot} finalizado`;
    case 'bot_stopped':
      return `Chatbot ${bot} parado${by}`;
    case 'bot_failed':
      return `Chatbot ${bot} falhou${typeof e.data.reason === 'string' && e.data.reason ? `: ${e.data.reason}` : ''}`;
    case 'bot_transferred': {
      const owner = e.data.toOwnerId ? ` · ${name(e.data.toOwnerId) ?? ''}` : '';
      return `Chatbot ${bot} transferiu para ${name(e.data.toSectorId) ?? 'outro setor'}${owner}`;
    }
    case 'bot_note':
      return `Nota do chatbot ${bot}: ${String(e.data.text ?? '')}`;
    case 'message_deleted':
      return `Mensagem apagada${changedBy(e)}`;
    case 'message_edited':
      return `Mensagem editada${changedBy(e)}`;
    case 'history_imported':
      return `Histórico do WhatsApp importado: ${Number(e.data.count ?? 0).toLocaleString('pt-BR')} mensagens`;
    case 'contact_merged':
      return 'Contato sem número juntado a este contato';
    case 'note_deleted':
      return `Nota apagada${by}`;
  }
}

/** Spec §2: changes made on WhatsApp read "pelo contato" / "pelo celular"; the office reads "por <nome>". */
function changedBy(e: ChatEventDto): string {
  if (e.data.source === 'contact') return ' pelo contato';
  if (e.data.source === 'phone') return ' pelo celular';
  return e.authorName ? ` por ${e.authorName}` : '';
}

/** Bubble tag of a message deleted for everyone (spec §4). The text stays visible to the team. */
export function deletedTag(d: NonNullable<MessageDto['deleted']>): string {
  if (d.source === 'contact') return 'Apagada pelo contato';
  if (d.source === 'phone') return 'Apagada pelo celular';
  return `Apagada por ${d.byName ?? 'atendente'}`;
}

/** Bubble tag of an edited message (spec §5). Clicking it shows the previous versions. */
export function editedTag(e: NonNullable<MessageDto['edited']>): string {
  const who = e.source === 'contact' ? ' pelo contato' : e.source === 'phone' ? ' pelo celular' : '';
  return `editada${who}${e.newTextUnavailable ? ' (novo texto indisponível)' : ''}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Não foi possível concluir. Tente de novo.';
}

/** §7: 409 = the chat changed under us (another agent acted first). */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}
