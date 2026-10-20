// Class recipes of the "Mensageiro" look, shared so every screen draws the same button, field, tab and badge.
// Plain strings (not components): callers append layout classes (w-full, mt-2…) but never a second height,
// padding or color — pick another size or variant instead.

const buttonBase =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-bold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const buttonSizes = {
  md: 'h-10 px-4 text-[13px]',
  sm: 'h-8 px-3 text-xs',
} as const;
const buttonVariants = {
  /** The one main action of an area. */
  primary: 'bg-primary text-on-primary hover:bg-primary-hover',
  /** Also Cancelar in a dialog (Dialogos.dc.html). */
  secondary: 'bg-panel text-fg hover:bg-border',
  /** Destructive actions, including the confirm of a destructive dialog (Excluir setor). */
  danger: 'bg-danger-soft text-danger hover:brightness-95',
  /** Text-only action: Cancelar of an inline form, Carregar mais, or Cancelar beside another secondary choice. */
  ghost: 'text-fg hover:bg-panel',
} as const;

export function button(variant: keyof typeof buttonVariants = 'secondary', size: keyof typeof buttonSizes = 'md'): string {
  return `${buttonBase} ${buttonSizes[size]} ${buttonVariants[variant]}`;
}

/** 40px round icon button on a card; needs an aria-label. */
export const iconButton =
  'grid size-10 shrink-0 place-items-center rounded-full bg-panel text-fg-2 transition-colors hover:bg-border disabled:cursor-not-allowed disabled:opacity-50';
/** Same, without a fill: inside the composer, a menu row or a dense toolbar. */
export const iconButtonGhost =
  'grid size-10 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50';
/** Icon button that toggles something on (Contato panel open, search open). */
export const iconButtonOn =
  'grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft text-accent-ink disabled:cursor-not-allowed disabled:opacity-50';
/** Round primary action (Nova conversa). The composer's send button is the same at 44px. */
export const iconButtonPrimary =
  'grid size-10 shrink-0 place-items-center rounded-full bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50';

/** An area of the screen: list, conversation, panel, page body. */
export const card = 'rounded-card bg-surface';

/** Search box: a pill, no border (it is a search, not a form field). Wrap the <input> in a <label> with this. */
export const searchPill =
  'flex h-[42px] items-center gap-2.5 rounded-full bg-panel px-3.5 text-muted focus-within:ring-2 focus-within:ring-primary';
/** The <input> inside searchPill. */
export const searchInput = 'min-w-0 flex-1 bg-transparent text-sm text-fg outline-none';

/** Form field label, shown above the control. */
export const fieldLabel = 'mb-1.5 block text-[13px] font-semibold text-fg';
/** Text input (44px). For a <select> use fieldSelect, for a textarea fieldArea. */
export const field =
  'block h-11 w-full rounded-block border border-field bg-surface px-3.5 text-sm text-fg disabled:opacity-60';
export const fieldArea =
  'block w-full rounded-block border border-field bg-surface px-3.5 py-2.5 text-sm text-fg disabled:opacity-60';
/** <select> with the board's chevron (forced-colors mode keeps the native arrow). */
export const fieldSelect = `${field} appearance-none pr-10 select-chevron forced-colors:appearance-auto`;
export const fieldError = 'mt-1.5 text-xs leading-4 font-semibold text-danger';
/** Help text under a control. */
export const fieldHint = 'mt-1.5 block text-[13px] leading-[18px] font-normal text-muted';
/** Checkbox and radio drawn as on Fundamentos (forced-colors mode keeps the native control). */
export const checkbox =
  'size-[18px] shrink-0 cursor-pointer appearance-none rounded-[6px] border border-field bg-surface checked:border-primary checked:bg-primary checked:check-mark disabled:cursor-not-allowed disabled:opacity-50 forced-colors:appearance-auto';
export const radio =
  'size-[18px] shrink-0 cursor-pointer appearance-none rounded-full border border-field bg-surface checked:border-[5px] checked:border-primary disabled:cursor-not-allowed disabled:opacity-50 forced-colors:appearance-auto';

/** Pill tabs / segmented filters: wrap in role="tablist" with tabList. */
export const tabList = 'flex flex-wrap gap-2';
export function tab(active: boolean): string {
  return `inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
    active ? 'bg-chip-on text-chip-on-fg' : 'bg-panel text-fg-2 hover:bg-border'
  }`;
}

/** Unread count. */
export const unreadBadge =
  'inline-grid h-[22px] min-w-[22px] place-items-center rounded-full bg-primary px-[7px] text-xs font-bold text-on-primary tabular-nums';
/** State badge (Bloqueado, Sem atendente, Padrão…): add one tone. */
export const badge = 'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full px-2 text-xs font-bold';
export const badgeTone = {
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
  brass: 'bg-brass-soft text-brass',
  accent: 'bg-primary-soft text-accent-ink',
  neutral: 'bg-panel text-fg-2',
} as const;

/** Popover / dropdown menu container and its rows. */
export const menu = 'rounded-block bg-surface p-1.5 text-fg shadow-pop';
export const menuItem =
  'flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left text-sm hover:bg-sidebar-hover disabled:cursor-not-allowed disabled:opacity-50';

/** Native <dialog> box (the backdrop comes from index.css). */
export const dialog = 'm-auto w-[min(28rem,calc(100%-2rem))] rounded-card bg-surface p-6 text-fg shadow-pop';
export const dialogTitle = 'text-base leading-[22px] font-bold';

/** Page title (once per screen) and card / section titles. */
export const pageTitle = 'text-[22px] leading-7 font-bold tracking-[-0.02em]';
export const sectionTitle = 'text-base leading-[22px] font-bold';
/** Sub-heading inside a card (Etiquetas, Observações…). */
export const blockTitle = 'text-[13px] leading-[18px] font-bold';
