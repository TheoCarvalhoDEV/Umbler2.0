// Importar do Umbler Talk (spec 2026-10-21 importar-umbler §6, §9, §10). Runtime values with no imports: tsx (server)
// and Vite (web) load this source directly.

export const UMBLER_IMPORT_STATES = ['analyzing', 'analyzed', 'running', 'done', 'failed'] as const;
export type UmblerImportState = (typeof UMBLER_IMPORT_STATES)[number];

/** §9.1, in this order. */
export const UMBLER_IMPORT_PHASES = ['catalog', 'contacts', 'open_chats', 'notes', 'closed_chats'] as const;
export type UmblerImportPhase = (typeof UMBLER_IMPORT_PHASES)[number];

/** "Etapa 3 de 5: conversas abertas" (§6.1). */
export const UMBLER_PHASE_LABELS: Record<UmblerImportPhase, string> = {
  catalog: 'cadastros',
  contacts: 'contatos',
  open_chats: 'conversas abertas',
  notes: 'observações dos contatos',
  closed_chats: 'conversas finalizadas',
};

/** §9.4: why an import stopped (umbler_imports.error keeps only the code). `unexpected` is a database or program error. */
export const UMBLER_IMPORT_ERRORS = {
  umbler_token: 'O Umbler recusou o token (expirado ou apagado). Gere outro, troque UMBLER_TOKEN no .env e reinicie o sistema.',
  umbler_429: 'O Umbler limitou as requisições. Clique em Continuar daqui a alguns minutos.',
  umbler_unavailable: 'O Umbler não respondeu. Clique em Continuar para tentar de novo.',
  umbler_marked_read: 'Uma leitura marcou conversa como lida no Umbler; a importação parou por segurança.',
  disk_full: 'Pouco espaço em disco para os arquivos (menos de 2 GB).',
  umbler_400: 'O Umbler recusou uma consulta do importador. Avise o suporte técnico.',
  unexpected: 'Erro inesperado no servidor. Clique em Continuar para tentar de novo.',
} as const;
export type UmblerImportError = keyof typeof UMBLER_IMPORT_ERRORS;

/** Where each Umbler channel, sector and attendant goes (§6.2): one of our ids, 'create' or 'none'. */
export interface UmblerMappingDto {
  /** our channel id or 'none' */
  channels: Record<string, string>;
  /** our sector id or 'create' */
  sectors: Record<string, string>;
  /** our user id, 'create' (inactive user, §7.2) or 'none' */
  members: Record<string, string>;
}

/** "O que foi encontrado" (§6.2). Office data only: no client name, phone or text (§12). */
export interface UmblerAnalysisDto {
  organizationId: string;
  organization: string;
  contacts: { total: number; existing: number; withoutAddress: number };
  chats: { open: number; waiting: number; closed: number; from: string | null; to: string | null };
  channels: Array<{ id: string; name: string; type: string; phone: string | null; whatsapp: boolean; chats: number; proposal: string }>;
  sectors: Array<{ id: string; name: string; proposal: string }>;
  members: Array<{ id: string; name: string; email: string; active: boolean; chats: number; proposal: string }>;
  tags: { new: number; existing: number };
  customFields: { new: number; existing: number; unsupported: string[] };
  quickAnswers: { new: number; existing: number };
  readTest: 'ok' | 'marked' | 'not_done';
  warnings: string[];
}

/** The counters of §6.1 and §6.4; the progress while it runs, the report when it ends. */
export interface UmblerCountsDto {
  sectors: { created: number; existing: number };
  tags: { created: number; existing: number };
  customFields: { created: number; existing: number; unsupported: string[] };
  members: { linked: number; createdInactive: number; none: number };
  quickAnswers: { created: number; existing: number; unmappedVariables: string[]; attachmentErrors: string[] };
  contacts: { created: number; completed: number; lidOnly: number; skipped: number };
  notes: number;
  chats: {
    openCreated: number; openMerged: number; closed: number;
    skippedChannel: number; skippedEmpty: number; skippedDeleted: number; skippedNoAddress: number;
  };
  messages: { total: number; notes: number; bot: number; unknownAuthor: number; redacted: number; matched: number; maxMatchDiffMs: number };
  files: { saved: number; bytes: number; expired: number };
  /** notes or chats deleted in Umbler during the copy (404) */
  gone: number;
  /** relative-messages said the plan hides older messages */
  planLimited: boolean;
}
/** done/total: the current phase ("120 de 135"); chatsRead: the analysis ("N conversas lidas"). */
export interface UmblerProgressDto extends UmblerCountsDto { done: number; total: number; chatsRead: number }
export interface UmblerReportDto extends UmblerCountsDto { durationMs: number }

export interface UmblerImportDto {
  id: string;
  state: UmblerImportState;
  phase: UmblerImportPhase | null;
  analysis: UmblerAnalysisDto | null;
  progress: UmblerProgressDto | null;
  report: UmblerReportDto | null;
  error: UmblerImportError | null;
  /** §6.3 reasons "Importar"/"Continuar" is blocked right now (pt-BR, checked on every read) */
  blocks: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /api/umbler-import */
export interface UmblerImportStatusDto { tokenConfigured: boolean; current: UmblerImportDto | null }

export function emptyUmblerCounts(): UmblerCountsDto {
  return {
    sectors: { created: 0, existing: 0 },
    tags: { created: 0, existing: 0 },
    customFields: { created: 0, existing: 0, unsupported: [] },
    members: { linked: 0, createdInactive: 0, none: 0 },
    quickAnswers: { created: 0, existing: 0, unmappedVariables: [], attachmentErrors: [] },
    contacts: { created: 0, completed: 0, lidOnly: 0, skipped: 0 },
    notes: 0,
    chats: { openCreated: 0, openMerged: 0, closed: 0, skippedChannel: 0, skippedEmpty: 0, skippedDeleted: 0, skippedNoAddress: 0 },
    messages: { total: 0, notes: 0, bot: 0, unknownAuthor: 0, redacted: 0, matched: 0, maxMatchDiffMs: 0 },
    files: { saved: 0, bytes: 0, expired: 0 },
    gone: 0,
    planLimited: false,
  };
}
