import type { BulkResultDto } from '@talk/shared';

/** Spec 2026-10-20 §4: "X de N concluídas; Y não puderam: <motivo>", each distinct reason once. */
export function bulkSummary(r: BulkResultDto): string {
  const total = r.done.length + r.failed.length;
  const head = `${r.done.length} de ${total} ${total === 1 ? 'concluída' : 'concluídas'}`;
  if (r.failed.length === 0) return `${head}.`;
  const reasons = [...new Set(r.failed.map((f) => f.error))].join(' / ');
  return `${head}; ${r.failed.length} não ${r.failed.length === 1 ? 'pôde' : 'puderam'}: ${reasons}`;
}
