import type { ChatEventDto, TimelineItem } from '@talk/shared';
import { ApiError } from '../../lib/api';

export const TIMELINE_PAGE_SIZE = 50;

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

/** `names` maps sector and user ids to names (UUIDs never collide across tables). */
export function eventText(e: ChatEventDto, names: Map<string, string>): string {
  const name = (v: unknown) => (typeof v === 'string' ? names.get(v) : undefined);
  const by = e.authorName ? ` por ${e.authorName}` : '';
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
      return `Conversa tornada ${e.data.private === true ? 'privada' : 'pública'}${by}`;
    case 'closed':
      return `Conversa finalizada${by}`;
    case 'reopened':
      return `Conversa reaberta${by}`;
    case 'triage_routed':
      return `Triagem: encaminhada para ${name(e.data.sectorId) ?? 'outro setor'}`;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Ocorreu um erro';
}

/** §7: 409 = the chat changed under us (another agent acted first). */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}
