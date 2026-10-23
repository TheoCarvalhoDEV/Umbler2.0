import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DotsThreeVerticalIcon } from '@phosphor-icons/react';
import { request } from '../../lib/api';
import { button, field as fieldBox, fieldHint, iconButtonGhost, menu, menuItem, pageTitle, sectionTitle } from '../ui';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; // GET: the Canais page polls the channel QR

// Task 15's request() with the path first, which reads better in the settings screens.
export function send<T = unknown>(path: string, method: Method, body?: unknown): Promise<T> {
  return request<T>(method, path, body);
}

// Runs the given thunk (one or several requests) and then refetches the listed qk.* keys.
export function useSend(...refresh: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const btn = button('secondary', 'sm'); // dense toolbars (bot editor)
export const btnSecondary = button('secondary');
export const btnPrimary = button('primary');
export const btnDanger = button('danger');
export const field = `mt-1.5 ${fieldBox}`;

/** Sunken block inside the page card: danger zone, notes, QR code, read-only data. */
export const block = 'rounded-block bg-sunken p-4';
/** Help text under a control. */
export const hint = fieldHint;
export const okText = 'text-[13px] font-semibold text-success';

/** Every settings page starts with it. action: the page's main button (Novo setor…), at the right. */
export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className={pageTitle}>{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </header>
  );
}

/** A group of settings under a title. No gray block around it: that stays for danger zones and notes. */
export function SettingsSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className={sectionTitle}>{title}</h2>
      {description && <p className="mt-0.5 text-[13px] leading-[18px] text-muted">{description}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** One setting: label and description at the left, its control at the right (below it on a narrow screen).
 * wide: the control takes a full line under the label (a long text, a group of options). */
export function SettingRow(props: { label: string; description?: ReactNode; control: ReactNode; htmlFor?: string; wide?: boolean }) {
  const labelClass = 'block text-sm font-semibold text-fg';
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-b border-border py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1 basis-56">
        {props.htmlFor ? (
          <label htmlFor={props.htmlFor} className={labelClass}>
            {props.label}
          </label>
        ) : (
          <span className={labelClass}>{props.label}</span>
        )}
        {props.description && <p className="mt-0.5 text-[13px] leading-[18px] text-muted">{props.description}</p>}
      </div>
      <div className={props.wide ? 'w-full' : 'shrink-0'}>{props.control}</div>
    </div>
  );
}

/** On/off pill. A native button, so Enter and Space flip it. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-primary' : 'bg-field'
      }`}
    >
      <span aria-hidden className={`size-5 rounded-full bg-surface shadow-float transition-transform ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

/** A message as the contact receives it: a small sent bubble (the signature preview, the triage menu). */
export function SentBubble({ children }: { children: ReactNode }) {
  return (
    <div className="w-fit max-w-full rounded-card rounded-br-md bg-bubble-out px-3.5 py-2.5 text-sm text-fg sm:max-w-[360px]">
      {children}
      <p className="mt-1 text-right text-[11px] leading-[14px] text-bubble-meta tabular-nums">10:30</p>
    </div>
  );
}

/** A settings list item, drawn like a chat list item. leading sits in a 40px round chip (an Avatar fills it).
 * children: an area under the line, indented to the title (Canais: QR and history); the item then gets a divider
 * instead of the hover fill. */
export function ListRow(props: {
  leading: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const line = (
    <>
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-soft text-accent-ink">{props.leading}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold">{props.title}</span>
          {props.badges}
        </div>
        {props.subtitle && <p className="truncate text-[13px] leading-[18px] text-muted">{props.subtitle}</p>}
      </div>
      {props.actions && <div className="flex shrink-0 items-center gap-1">{props.actions}</div>}
    </>
  );
  if (!props.children) {
    return <li className="flex items-center gap-3 rounded-item px-2.5 py-2.5 transition-colors hover:bg-sidebar-hover">{line}</li>;
  }
  return (
    <li className="border-b border-border pb-3 last:border-b-0">
      <div className="flex items-center gap-3 px-2.5 py-2.5">{line}</div>
      <div className="px-2.5 sm:pl-[62px]">{props.children}</div>
    </li>
  );
}

/** download: the item is a download link to that URL (Exportar) instead of a button. */
export type RowMenuItem = { label: string; onSelect?: () => void; download?: string; danger?: boolean; disabled?: boolean };

/** The ⋮ menu of a ListRow (as the chat list's "Opções da conversa"). Closes on a choice, Escape or a click outside.
 * false/null items are skipped, for `cond && {…}`. */
export function RowMenu({ label, items }: { label: string; items: Array<RowMenuItem | false | null | undefined> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className={iconButtonGhost}
      >
        <DotsThreeVerticalIcon size={20} weight="bold" aria-hidden />
      </button>
      {open && (
        <div id={id} className={`${menu} absolute right-0 z-10 mt-1 min-w-44`}>
          {items.map((item) => {
            if (!item) return null;
            const className = `${menuItem} whitespace-nowrap ${item.danger ? 'text-danger' : ''}`;
            return item.download ? (
              <a key={item.label} href={item.download} download onClick={() => setOpen(false)} className={className}>
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className={className}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** An empty list: round tinted icon chip (as "Selecione uma conversa"), a line, a hint and maybe the create button. */
export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span aria-hidden className="grid size-14 place-items-center rounded-full bg-primary-soft text-accent-ink">
        {icon}
      </span>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        {hint && <p className="mt-1 text-[13px] leading-[18px] text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** Descartar / Salvar of a form page, stuck to the bottom of the page card while there are unsaved changes, then
 * "Alterações salvas." for 3 s after saved turns true. Inside a <form>, leave out onSave: Salvar submits it. */
export function SaveBar(props: {
  dirty: boolean;
  saving: boolean;
  onSave?: () => void;
  onDiscard: () => void;
  error?: unknown;
  saved?: boolean;
  /** Salvar disabled (invalid form). */
  disabled?: boolean;
  /** What it says after a save; "Alterações salvas." by default (Compromissos: "Lembretes salvos."). */
  savedText?: string;
}) {
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!props.saved) return;
    setJustSaved(true);
    const timer = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [props.saved]);
  if (!props.dirty && !justSaved) return null;

  return (
    <div className="sticky bottom-4 z-10 mt-7 flex flex-wrap items-center justify-end gap-2 rounded-block border border-border bg-surface px-4 py-2.5 shadow-pop">
      {props.dirty ? (
        <>
          <div className="mr-auto min-w-0">
            {props.error ? <ErrorText error={props.error} /> : <p className="text-[13px] text-muted">Alterações não salvas.</p>}
          </div>
          <button type="button" onClick={props.onDiscard} disabled={props.saving} className={btnSecondary}>
            Descartar
          </button>
          <button
            type={props.onSave ? 'button' : 'submit'}
            onClick={props.onSave}
            disabled={props.saving || props.disabled}
            className={btnPrimary}
          >
            Salvar
          </button>
        </>
      ) : (
        <p role="status" className={`${okText} mr-auto py-2.5`}>
          {props.savedText ?? 'Alterações salvas.'}
        </p>
      )}
    </div>
  );
}

export function ErrorText({ error, className = '' }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={`my-2 text-[13px] font-semibold text-danger ${className}`}>
      {error instanceof Error ? error.message : 'Não foi possível concluir. Tente de novo.'}
    </p>
  );
}

export function Loading({ error }: { error: unknown }) {
  return error ? <ErrorText error={error} /> : <p className="text-sm text-muted">Carregando…</p>;
}
