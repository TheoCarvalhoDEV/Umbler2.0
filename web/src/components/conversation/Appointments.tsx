import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from '@phosphor-icons/react';
import {
  APPOINTMENT_LIMITS, REMINDER_UNITS, SCHEDULE_MAX_AHEAD_MS, SCHEDULE_TEXT_MAX, appointmentTimeProblem, fillReminderText,
  appointmentStatusProblem, formatOfficeDateTime, isoToOfficeLocal, officeLocalToIso, reminderSendAt, reminderTextProblem, remindersProblem,
  scheduleTimeProblem, type AppointmentDto, type AppointmentReminderDto, type AppointmentStatus, type ChatDetail, type ContactDto, type ReminderInput,
  type ReminderUnit,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { contactLabel } from '../../lib/format';
import {
  badge, badgeTone, button, checkbox, field, fieldArea, fieldError, fieldHint, fieldLabel, fieldSelect, menuItem,
} from '../ui';
import { Actions, Modal } from './ChatDialogs';
import { errorMessage } from './model';

// "Não será enviado": a warning about one line, not an error of the form
const warning = 'mt-1.5 text-xs leading-4 font-semibold text-warning';
const UNIT_LABELS: Record<ReminderUnit, string> = { days: 'dias antes', hours: 'horas antes' };
/** decision 10: the lead amount is a list of the allowed numbers, so it is never out of range */
function amountsOf(unit: ReminderUnit): number[] {
  const { min, max } = APPOINTMENT_LIMITS[unit];
  return Array.from({ length: max - min + 1 }, (_, k) => min + k);
}

/** "2 dias antes", "1 hora antes" (spec 2026-10-21 compromissos §6). */
export function reminderLead(r: { amount: number; unit: ReminderUnit }): string {
  const word = r.unit === 'days' ? (r.amount === 1 ? 'dia' : 'dias') : r.amount === 1 ? 'hora' : 'horas';
  return `${r.amount} ${word} antes`;
}

/** A reminder's situation (spec §6). */
export function reminderStatus(r: AppointmentReminderDto): string {
  switch (r.status) {
    case 'pending':
      return `Pendente · ${formatOfficeDateTime(r.sendAt)}`;
    case 'sending':
      return 'Enviando…';
    case 'sent':
      return 'Enviado';
    case 'failed':
      return `Falhou: ${r.error ?? ''}`;
    case 'canceled':
      return 'Cancelado';
    case 'skipped':
      return 'Não criado: o horário de envio já tinha passado';
  }
}

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Agendado', confirmed: 'Confirmado', attended: 'Compareceu', missed: 'Faltou',
};
export const STATUS_TONE: Record<AppointmentStatus, keyof typeof badgeTone> = {
  scheduled: 'neutral', confirmed: 'accent', attended: 'success', missed: 'danger',
};

/** The appointment lists and the scheduled-message lists (a reminder is one): both under ['chats']. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: qk.appointments }), qc.invalidateQueries({ queryKey: qk.scheduled })]);
}

/** The values "Vai sair assim" fills in. */
export interface ReminderSample { nome: string; titulo: string; startsAt: string }

/**
 * The reminder lines of the form and of Configurações → Compromissos (spec §3.2, §4): lead time, text, the placeholders,
 * the problem of the line or "Vai sair assim". With `startsAt` (the form), a line whose send time passed says "Não será enviado".
 */
export function ReminderRows(props: {
  reminders: ReminderInput[];
  onChange: (next: ReminderInput[]) => void;
  /** null: no preview yet (no date). */
  sample: ReminderSample | null;
  /** The contact's name for {nome}; undefined where there is no contact (Configurações). */
  contactName?: string | null;
  startsAt?: Date | null;
}) {
  const { reminders, onChange } = props;
  const set = (i: number, patch: Partial<ReminderInput>) => onChange(reminders.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const now = new Date();
  return (
    <div className="flex flex-col gap-3">
      {reminders.map((r, i) => {
        const problem = reminderTextProblem(r.text, props.contactName);
        const late = !!props.startsAt && !!scheduleTimeProblem(reminderSendAt(props.startsAt, r.amount, r.unit), now);
        return (
          // key: the position; every value lives in `reminders`, so removing a line shifts nothing stale
          <div key={i} role="group" aria-label={`Lembrete ${i + 1}`} className="rounded-block bg-sunken p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-24">
                <select
                  aria-label="Antecedência"
                  value={r.amount}
                  onChange={(e) => set(i, { amount: Number(e.target.value) })}
                  className={fieldSelect}
                >
                  {amountsOf(r.unit).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-40">
                <select
                  aria-label="Unidade"
                  value={r.unit}
                  onChange={(e) => {
                    const unit = e.target.value as ReminderUnit;
                    set(i, { unit, amount: Math.min(r.amount, APPOINTMENT_LIMITS[unit].max) });
                  }}
                  className={fieldSelect}
                >
                  {REMINDER_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {UNIT_LABELS[u]}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" onClick={() => onChange(reminders.filter((_, j) => j !== i))} className={`${button('ghost', 'sm')} ml-auto`}>
                Remover
              </button>
            </div>
            <label className="mt-2 block">
              <span className={fieldLabel}>Texto do lembrete</span>
              <textarea
                rows={3}
                maxLength={SCHEDULE_TEXT_MAX}
                value={r.text}
                onChange={(e) => set(i, { text: e.target.value })}
                className={fieldArea}
              />
            </label>
            <p className={fieldHint}>{'Marcadores: {nome}, {titulo}, {data}, {hora}'}</p>
            {problem ? (
              <p className={fieldError}>{problem}</p>
            ) : (
              props.sample &&
              r.text.trim() && <p className={fieldHint}>Vai sair assim: {fillReminderText(r.text.trim(), props.sample)}</p>
            )}
            {late && <p className={warning}>Não será enviado: o horário de envio já passou</p>}
          </div>
        );
      })}
      {reminders.length < APPOINTMENT_LIMITS.remindersMax && (
        <button
          type="button"
          onClick={() => onChange([...reminders, { amount: 1, unit: 'days', text: '' }])}
          className={`${button('secondary', 'sm')} self-start`}
        >
          <PlusIcon size={14} aria-hidden /> Adicionar lembrete
        </button>
      )}
    </div>
  );
}

/** Read-only: each reminder's lead time and situation (decision 3: reminders are only chosen when the appointment is made). */
function ReminderStatusList({ reminders }: { reminders: AppointmentReminderDto[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-[13px] leading-[18px]">
      {reminders.map((r) => (
        <li key={r.id} className="flex flex-wrap gap-x-1.5">
          <span className="font-semibold text-fg">{reminderLead(r)}</span>
          <span aria-hidden className="text-muted">
            ·
          </span>
          <span className={r.status === 'failed' ? 'text-danger' : 'text-muted'}>{reminderStatus(r)}</span>
        </li>
      ))}
    </ul>
  );
}

type DialogProps = {
  /** New, in this chat (the conversation's dialog). */
  chatId?: string;
  /** The chat's contact name, for {nome} and the preview. */
  contactName?: string | null;
  /** Edit this one. Without it and without chatId (the Agenda), "Cliente" picks the contact and the server picks the chat. */
  appointment?: AppointmentDto;
  onClose: () => void;
};

/**
 * "Novo compromisso" / "Editar compromisso" (spec 2026-10-21 compromissos §3.1–3.3). The time is typed in Cuiabá time.
 * A new one starts with the default reminders of Configurações; an edit changes title, time and note only.
 */
export function AppointmentDialog(props: DialogProps) {
  const dialogTitle = props.appointment ? 'Editar compromisso' : 'Novo compromisso';
  const defaults = useQuery({
    queryKey: qk.appointmentReminders, queryFn: api.settings.appointmentReminders.get, enabled: !props.appointment,
  });
  if (!props.appointment && !defaults.data) {
    return (
      <Modal title={dialogTitle} onCancel={props.onClose}>
        {defaults.isError ? (
          <>
            <p role="alert" className={fieldError}>
              {errorMessage(defaults.error)}
            </p>
            <div className="mt-4 flex justify-end">
              <button type="button" className={button('secondary')} onClick={props.onClose}>
                Fechar
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Carregando…</p>
        )}
      </Modal>
    );
  }
  return <AppointmentForm {...props} dialogTitle={dialogTitle} defaults={defaults.data?.reminders ?? []} />;
}

function AppointmentForm(props: DialogProps & { dialogTitle: string; defaults: ReminderInput[] }) {
  const refresh = useRefresh();
  const a = props.appointment;
  const ids = { client: useId(), title: useId(), when: useId(), note: useId() };
  const initialLocal = a ? isoToOfficeLocal(a.startsAt) : '';
  const [contact, setContact] = useState<ContactDto | null>(null);
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState(a?.title ?? '');
  const [local, setLocal] = useState(initialLocal);
  const [note, setNote] = useState(a?.note ?? '');
  const [reminders, setReminders] = useState(props.defaults);
  const [signature, setSignature] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickContact = !a && !props.chatId;
  // {nome}: the chosen contact's name on the Agenda (undefined until one is chosen), else the chat's contact
  const contactName = pickContact ? (contact ? contact.name : undefined) : props.contactName;
  const iso = officeLocalToIso(local);
  const startsAt = iso ? new Date(iso) : null;
  const now = Date.now();
  const term = query.trim();
  // ponytail: one request per keystroke (cached per term), like "Nova conversa"
  const search = { q: term, limit: 8 };
  const results = useQuery({
    queryKey: qk.contactList(search),
    queryFn: () => api.contacts.list(search),
    enabled: pickContact && !contact && term.length >= 2,
  });

  async function save() {
    const kept = !!a && local === initialLocal; // a kept time is not checked again: it may have passed
    const problem =
      (pickContact && !contact ? 'Escolha o cliente' : null) ??
      (!title.trim() ? 'Digite o título' : null) ??
      (kept ? null : appointmentTimeProblem(startsAt, new Date())) ??
      (a ? null : remindersProblem(reminders, startsAt, contactName));
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      if (a) {
        const patch = {
          ...(title.trim() !== a.title ? { title: title.trim() } : {}),
          ...(kept ? {} : { startsAt: iso! }),
          ...(note.trim() !== (a.note ?? '') ? { note: note.trim() || null } : {}),
        };
        if (Object.keys(patch).length) await api.appointments.update(a.id, patch);
      } else {
        await api.appointments.create({
          ...(contact ? { contactId: contact.id } : { chatId: props.chatId }),
          title: title.trim(),
          startsAt: iso!,
          ...(note.trim() ? { note: note.trim() } : {}),
          signature,
          reminders,
        });
      }
      await refresh();
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Modal title={props.dialogTitle} onCancel={props.onClose}>
      <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
        {pickContact &&
          (contact ? (
            <div>
              <span className={fieldLabel}>Cliente</span>
              <div className="flex h-11 items-center gap-2 rounded-block bg-sunken pr-1.5 pl-3.5 text-sm font-semibold tabular-nums">
                <span className="flex-1 truncate">{contactLabel(contact)}</span>
                <button type="button" onClick={() => setContact(null)} className={button('secondary', 'sm')}>
                  Trocar
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor={ids.client} className={fieldLabel}>
                Cliente
              </label>
              <input id={ids.client} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome ou telefone" className={field} />
              {!!results.data?.items.length && (
                <ul className="mt-1 max-h-40 overflow-y-auto rounded-block border border-border p-1">
                  {results.data.items.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setContact(c)} className={`${menuItem} tabular-nums`}>
                        {contactLabel(c)}
                        {c.name && c.phone ? ` · ${contactLabel({ name: null, phone: c.phone })}` : ''}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        <div>
          <label htmlFor={ids.title} className={fieldLabel}>
            Título
          </label>
          <input
            id={ids.title}
            value={title}
            maxLength={APPOINTMENT_LIMITS.titleMax}
            placeholder="Ex.: Audiência, Retorno de documento"
            onChange={(e) => setTitle(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label htmlFor={ids.when} className={fieldLabel}>
            Data e hora (horário de Cuiabá)
          </label>
          <input
            id={ids.when}
            type="datetime-local"
            value={local}
            min={isoToOfficeLocal(new Date(now).toISOString())}
            max={isoToOfficeLocal(new Date(now + SCHEDULE_MAX_AHEAD_MS).toISOString())}
            onChange={(e) => setLocal(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label htmlFor={ids.note} className={fieldLabel}>
            Observação interna (não é enviada ao cliente)
          </label>
          <textarea
            id={ids.note}
            rows={2}
            maxLength={APPOINTMENT_LIMITS.noteMax}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={fieldArea}
          />
        </div>
        <div>
          <span className={fieldLabel}>Lembretes</span>
          {a ? (
            <ReminderStatusList reminders={a.reminders} />
          ) : (
            <ReminderRows
              reminders={reminders}
              onChange={setReminders}
              contactName={contactName}
              startsAt={startsAt}
              sample={startsAt && (!pickContact || contact) ? { nome: contactName ?? '', titulo: title.trim(), startsAt: startsAt.toISOString() } : null}
            />
          )}
        </div>
        {!a && (
          <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold">
            <input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} className={checkbox} />
            Enviar com minha assinatura
          </label>
        )}
      </div>
      <Actions busy={busy} error={error} confirmLabel="Salvar" onCancel={props.onClose} onConfirm={() => void save()} />
    </Modal>
  );
}

/** One appointment (spec §3.4–3.5): when, what, for whom (page), by whom, the note, its reminders; Editar / Cancelar when canEdit. */
export function AppointmentItem({ item, page = false }: { item: AppointmentDto; page?: boolean }) {
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // the same rule as the server, so the buttons offered are the ones it accepts
  const now = new Date();
  const allows = (s: AppointmentStatus) =>
    appointmentStatusProblem({ startsAt: new Date(item.startsAt), canceledAt: item.canceledAt ? new Date(item.canceledAt) : null }, s, now) === null;
  const mark = item.canMark;
  const canConfirm = mark && allows('confirmed');
  const canAttend = mark && allows('attended');

  async function setStatus(status: AppointmentStatus) {
    setError(null);
    try {
      await api.appointments.setStatus(item.id, status);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function cancel() {
    const ok = await confirmDialog({
      title: 'Cancelar o compromisso?',
      body: 'Os lembretes que ainda não saíram não serão enviados.',
      confirmLabel: 'Cancelar compromisso',
      cancelLabel: 'Manter compromisso',
    });
    if (!ok) return;
    setError(null);
    try {
      await api.appointments.cancel(item.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <li className="flex flex-wrap items-start gap-3 py-3">
      <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[18px] text-muted">
          <span className="font-bold text-fg tabular-nums">{formatOfficeDateTime(item.startsAt)}</span>
          <span className="font-bold text-fg">{item.title}</span>
          {page && (
            <Link to={`/chats/${item.chatId}`} className="font-bold text-link hover:underline">
              {contactLabel(item.contact)}
            </Link>
          )}
          <span>por {item.authorName}</span>
          {item.canceledAt ? (
            <span className={`${badge} ${badgeTone.neutral}`}>Cancelado</span>
          ) : (
            <span className={`${badge} ${badgeTone[STATUS_TONE[item.status]]}`}>{APPOINTMENT_STATUS_LABELS[item.status]}</span>
          )}
        </p>
        {item.note && (
          <div className="rounded-block bg-sunken px-2.5 py-1.5 text-[13px] leading-[18px] text-fg">
            <p className="text-xs font-bold text-muted">Observação interna</p>
            <p className="break-words whitespace-pre-wrap">{item.note}</p>
          </div>
        )}
        <ReminderStatusList reminders={item.reminders} />
        {error && (
          <p role="alert" className={fieldError}>
            {error}
          </p>
        )}
      </div>
      {(canConfirm || canAttend || (mark && item.status === 'missed' && item.canEdit)) && (
        <span className="flex w-full flex-wrap items-center gap-2">
          {canConfirm && (
            <button
              type="button"
              onClick={() => void setStatus(item.status === 'confirmed' ? 'scheduled' : 'confirmed')}
              className={button('secondary', 'sm')}
            >
              {item.status === 'confirmed' ? 'Desfazer confirmação' : 'Confirmar'}
            </button>
          )}
          {canAttend &&
            (['attended', 'missed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={item.status === s}
                onClick={() => void setStatus(item.status === s ? 'scheduled' : s)}
                className={button('secondary', 'sm')}
              >
                {APPOINTMENT_STATUS_LABELS[s]}
              </button>
            ))}
          {item.status === 'missed' && item.canEdit && (
            <button type="button" onClick={() => setEditing(true)} className={button('secondary', 'sm')}>
              Remarcar
            </button>
          )}
        </span>
      )}
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
      {editing && <AppointmentDialog appointment={item} onClose={() => setEditing(false)} />}
    </li>
  );
}

/** Spec §3.4: "Compromissos de <cliente>": the contact's upcoming appointments in every chat of theirs the user sees. */
export function ChatAppointmentsDialog({ chat, onClose }: { chat: Pick<ChatDetail, 'id' | 'contact'>; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: qk.chatAppointments(chat.id), queryFn: () => api.appointments.listForChat(chat.id) });
  return (
    <Modal title={`Compromissos de ${contactLabel(chat.contact)}`} onCancel={onClose}>
      <div className="max-h-[60vh] overflow-y-auto">
        {list.isPending && <p className="text-sm text-muted">Carregando…</p>}
        {list.isError && (
          <p role="alert" className={fieldError}>
            {errorMessage(list.error)}
          </p>
        )}
        {list.data?.length === 0 && <p className="text-sm text-muted">Nenhum compromisso marcado com este cliente.</p>}
        {!!list.data?.length && (
          <ul className="divide-y divide-border">
            {list.data.map((a) => (
              <AppointmentItem key={a.id} item={a} />
            ))}
          </ul>
        )}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
        <Link to="/agendamentos?aba=compromissos" className="text-[13px] font-bold text-link hover:underline">
          Ver todos os compromissos
        </Link>
        <span className="flex flex-wrap gap-2">
          <button type="button" onClick={onClose} className={button('secondary')}>
            Fechar
          </button>
          <button type="button" onClick={() => setCreating(true)} className={button('primary')}>
            <PlusIcon size={16} aria-hidden /> Novo compromisso
          </button>
        </span>
      </div>
      {creating && <AppointmentDialog chatId={chat.id} contactName={chat.contact.name} onClose={() => setCreating(false)} />}
    </Modal>
  );
}
