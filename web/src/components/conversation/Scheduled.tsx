import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheckIcon, PaperclipIcon } from '@phosphor-icons/react';
import {
  SCHEDULE_MAX_AHEAD_MS, SCHEDULE_MIN_LEAD_MS, SCHEDULE_TEXT_MAX, formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso,
  scheduleTimeProblem, type ScheduledMessageDto, type ScheduledStatus,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { contactLabel } from '../../lib/format';
import { badge, badgeTone, button, card, field, fieldArea, fieldError, fieldLabel } from '../ui';
import { Actions, Modal } from './ChatDialogs';
import { errorMessage } from './model';

export const scheduledCount = (n: number) => (n === 1 ? '1 mensagem agendada' : `${n} mensagens agendadas`);

export const STATUS_LABELS: Record<ScheduledStatus, string> = {
  pending: 'Pendente', sending: 'Enviando…', sent: 'Enviada', failed: 'Falhou', canceled: 'Cancelada',
};

const STATUS_TONES: Record<ScheduledStatus, string> = {
  pending: badgeTone.neutral, sending: badgeTone.warning, sent: badgeTone.success, failed: badgeTone.danger, canceled: badgeTone.neutral,
};

/**
 * "Agendar mensagem" / "Editar agendamento" (spec 2026-10-20 agendamentos §3.1–3.2). The time is typed in Cuiabá time.
 * `onConfirm` gets the trimmed text and an ISO instant, or undefined for an edit that kept the time. A kept time is not
 * checked again: it may be under 2 minutes away by now. It throws to show its error here.
 */
export function ScheduleDialog(props: {
  title: string;
  confirmLabel: string;
  initialText: string;
  initialSendAt?: string;
  fileName?: string;
  onCancel: () => void;
  onConfirm: (text: string, sendAt: string | undefined) => Promise<unknown>;
}) {
  const initialLocal = props.initialSendAt ? isoToOfficeLocal(props.initialSendAt) : '';
  const [text, setText] = useState(props.initialText);
  const [local, setLocal] = useState(initialLocal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  async function confirm() {
    const value = text.trim();
    if (!value) return setError('Digite a mensagem');
    const kept = props.initialSendAt !== undefined && local === initialLocal;
    const iso = officeLocalToIso(local);
    if (!kept) {
      const problem = scheduleTimeProblem(iso ? new Date(iso) : null, new Date());
      if (problem) return setError(problem);
    }
    setBusy(true);
    setError(null);
    try {
      await props.onConfirm(value, kept ? undefined : (iso ?? undefined));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={props.title} onCancel={props.onCancel}>
      <label className="block">
        <span className={fieldLabel}>Texto da mensagem</span>
        <textarea rows={4} maxLength={SCHEDULE_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} className={fieldArea} />
      </label>
      {props.fileName && (
        // the composer's file chip, read-only here (spec §3.2: the attachment never changes)
        <p className="mt-3 flex items-center gap-2 rounded-block bg-panel px-3 py-2 text-[13px] text-fg">
          <PaperclipIcon size={16} aria-hidden className="shrink-0 text-fg-2" />
          <span className="min-w-0 truncate font-semibold">Anexo: {props.fileName}</span>
        </p>
      )}
      <label className="mt-4 block">
        <span className={fieldLabel}>Data e hora (horário de Cuiabá)</span>
        <input
          type="datetime-local"
          value={local}
          min={isoToOfficeLocal(new Date(now + SCHEDULE_MIN_LEAD_MS).toISOString())}
          max={isoToOfficeLocal(new Date(now + SCHEDULE_MAX_AHEAD_MS).toISOString())}
          onChange={(e) => setLocal(e.target.value)}
          className={field}
        />
      </label>
      <Actions busy={busy} error={error} confirmLabel={props.confirmLabel} onCancel={props.onCancel} onConfirm={() => void confirm()} />
    </Modal>
  );
}

/** One scheduled message: when, what, who; Editar / Cancelar for the author or an admin while pending (spec §3.2). */
export function ScheduledItem({ item, page = false }: { item: ScheduledMessageDto; page?: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: qk.scheduled }); // the strip and every page tab

  async function cancel() {
    const ok = await confirmDialog({
      title: 'Cancelar a mensagem agendada?', confirmLabel: 'Cancelar agendamento', cancelLabel: 'Manter agendamento',
    });
    if (!ok) return;
    setError(null);
    try {
      await api.scheduled.cancel(item.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px] text-muted">
          <span className="font-bold text-fg tabular-nums">{formatOfficeDateTime(item.sendAt)}</span>
          {page && (
            <Link to={`/chats/${item.sentChatId ?? item.chatId}`} className="font-bold text-link hover:underline">
              {contactLabel(item.contact)}
            </Link>
          )}
          <span>por {item.authorName}</span>
          {page && <span className={`${badge} ${STATUS_TONES[item.status]}`}>{STATUS_LABELS[item.status]}</span>}
          {item.attachment && (
            <span className={`${badge} ${badgeTone.neutral}`}>
              <PaperclipIcon size={12} aria-hidden /> Anexo
            </span>
          )}
        </p>
        <p className="line-clamp-2 text-sm break-words whitespace-pre-wrap text-fg">{item.body}</p>
        {item.error && <p className="rounded-block bg-danger-soft px-2.5 py-1.5 text-xs font-semibold text-danger">{item.error}</p>}
        {error && (
          <p role="alert" className={fieldError}>
            {error}
          </p>
        )}
      </div>
      {item.canEdit && (
        <span className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className={button('secondary', 'sm')}>
            Editar
          </button>
          <button type="button" onClick={() => void cancel()} className={button('danger', 'sm')}>
            Cancelar
          </button>
        </span>
      )}
      {editing && (
        <ScheduleDialog
          title="Editar agendamento"
          confirmLabel="Salvar"
          initialText={item.body}
          initialSendAt={item.sendAt}
          fileName={item.attachment?.name}
          onCancel={() => setEditing(false)}
          onConfirm={async (text, sendAt) => {
            await api.scheduled.update(item.id, sendAt ? { text, sendAt } : { text });
            setEditing(false);
            await refresh();
          }}
        />
      )}
    </li>
  );
}

/** Spec §3.2: "N mensagens agendadas" above the composer (or the closed footer), on the same sunken ground; opens the list. */
export function ScheduledStrip({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: qk.chatScheduled(chatId), queryFn: () => api.scheduled.listForChat(chatId) });
  const items = list.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="bg-sunken px-4 pt-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={button('secondary', 'sm')}>
        <CalendarCheckIcon size={16} aria-hidden />
        {scheduledCount(items.length)}
      </button>
      {open && (
        <ul className={`${card} mt-2 max-h-56 divide-y divide-border overflow-y-auto px-3.5 shadow-float`}>
          {items.map((i) => (
            <ScheduledItem key={i.id} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}
