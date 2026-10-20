import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatCircle, PencilSimple, Prohibit, X } from '@phosphor-icons/react';
import type { ContactDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ADDRESS_FIELDS, ContactForm } from './ContactForm';
import { CustomFieldsEditor } from './CustomFieldsEditor';
import { NotesList } from './NotesList';
import { TagsEditor } from './TagsEditor';
import { contactLabel, formatPhone } from '../../lib/format';
import { Avatar } from '../Avatar';
import { confirmDialog } from '../../lib/confirm';
import { FavoritesList } from '../conversation/FavoritesList';

const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`h-10 border-b-2 px-2.5 text-sm ${active ? 'border-primary font-semibold text-fg' : 'border-transparent font-medium text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

interface Props {
  contactId: string;
  chatId?: string;
  onClose: () => void;
  /** A column beside the conversation instead of a modal drawer (wide screens). */
  docked?: boolean;
  /** Spec 2026-10-19 §5: a click in "Favoritas" brings that message into view. */
  onJumpToMessage?: (messageId: string) => void;
}

export function ContactPanel({ contactId, chatId, onClose, docked = false, onJumpToMessage }: Props) {
  const [tab, setTab] = useState<'contact' | 'chat'>('contact');
  const contact = useQuery({ queryKey: qk.contact(contactId), queryFn: () => api.contacts.get(contactId) });

  useEffect(() => {
    if (docked) return; // a column is not a dialog: Escape belongs to the conversation
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, docked]);

  const body = (
    <>
      <header role="tablist" className="flex items-center gap-1 border-b border-border px-3 pt-2">
        <TabButton active={tab === 'contact'} onClick={() => setTab('contact')}>Contato</TabButton>
        {chatId && (
          <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>Detalhes da conversa</TabButton>
        )}
        <button
          type="button"
          aria-label="Fechar"
          onClick={onClose}
          className="ml-auto flex size-9 items-center justify-center rounded-lg text-muted hover:bg-sidebar-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'chat' && chatId ? (
          <ChatDetailsTab
            chatId={chatId}
            onJump={(messageId) => {
              onJumpToMessage?.(messageId);
              if (!docked) onClose(); // a drawer covers the conversation: get out of the way
            }}
          />
        ) : contact.data ? (
          <ContactTab contact={contact.data} onClose={onClose} />
        ) : (
          <p className="text-sm text-muted">{contact.isError ? 'Contato não encontrado.' : 'Carregando…'}</p>
        )}
      </div>
    </>
  );

  if (docked) {
    return (
      <aside aria-label="Contato" className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-surface">
        {body}
      </aside>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" aria-hidden onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Contato" className="relative flex h-full w-full max-w-md flex-col bg-surface shadow-xl">
        {body}
      </aside>
    </div>
  );
}

function ContactTab({ contact, onClose }: { contact: ContactDto; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const setContact = (dto: ContactDto) => {
    qc.setQueryData(qk.contact(dto.id), dto);
    void qc.invalidateQueries({ queryKey: qk.contactList({}) }); // {} partially matches every list filter
  };
  const block = useMutation({
    mutationFn: (blocked: boolean) => api.contacts.block(contact.id, blocked),
    onSuccess: setContact,
  });
  const start = useMutation({
    mutationFn: () => api.chats.start({ contactId: contact.id }),
    onSuccess: (chat) => {
      onClose();
      navigate(`/chats/${chat.id}`);
    },
  });

  if (editing) {
    return (
      <ContactForm
        contact={contact}
        onCancel={() => setEditing(false)}
        onSaved={(dto) => {
          setContact(dto);
          setEditing(false);
        }}
      />
    );
  }

  async function toggleBlock() {
    const ok = await confirmDialog(
      contact.blocked
        ? { title: 'Desbloquear este contato?', body: 'As mensagens dele voltarão a ser recebidas.', confirmLabel: 'Desbloquear', danger: false }
        : { title: 'Bloquear este contato?', body: 'As mensagens dele deixarão de ser recebidas.', confirmLabel: 'Bloquear' },
    );
    if (ok) block.mutate(!contact.blocked);
  }

  const address = ADDRESS_FIELDS.map(([key]) => contact.address?.[key]).filter(Boolean).join(', ');
  const error = start.error ?? block.error;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Avatar name={contact.name} src={contact.avatarUrl} className="size-12 text-base bg-primary text-white" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{contactLabel(contact)}</p>
          <p className="text-sm text-muted">{formatPhone(contact.phone)}</p>
          {contact.blocked && <span className="text-xs font-medium text-danger">Bloqueado</span>}
        </div>
        <button type="button" aria-label="Editar contato" onClick={() => setEditing(true)} className="rounded p-2 hover:bg-sidebar-hover">
          <PencilSimple size={18} />
        </button>
      </div>

      <button
        type="button"
        disabled={contact.blocked || start.isPending}
        onClick={() => start.mutate()}
        className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
      >
        <ChatCircle size={16} /> Nova conversa
      </button>
      {error && <p role="alert" className="text-sm text-danger">{error.message}</p>}

      <Section title="Etiquetas">
        <TagsEditor contact={contact} />
      </Section>

      <Section title="Observações">
        <NotesList contactId={contact.id} />
      </Section>

      <Section title="Dados do contato">
        <Rows
          rows={[
            ['Celular', formatPhone(contact.phone) || '—'],
            ['Telefone fixo', formatPhone(contact.landline) || '—'],
            ['E-mail', contact.email ?? '—'],
            ['Endereço', address || '—'],
            ['LID', contact.lid ?? '—'],
            ['Criado em', dateTime(contact.createdAt)],
          ]}
        />
      </Section>

      <Section title="Campos personalizados">
        <CustomFieldsEditor contact={contact} />
      </Section>

      <Section title="Todas as conversas deste contato">
        <ContactChats contactId={contact.id} onNavigate={onClose} />
      </Section>

      <button
        type="button"
        onClick={() => void toggleBlock()}
        disabled={block.isPending}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-danger hover:bg-danger/15 disabled:opacity-50"
      >
        <Prohibit size={16} /> {contact.blocked ? 'Desbloquear contato' : 'Bloquear contato'}
      </button>
    </div>
  );
}

function ContactChats({ contactId, onNavigate }: { contactId: string; onNavigate: () => void }) {
  const chats = useQuery({ queryKey: qk.contactChats(contactId), queryFn: () => api.contacts.chats(contactId) });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: () => api.sectors.list() }).data ?? [];
  if (!chats.data?.length) return <p className="text-sm text-muted">Nenhuma conversa visível.</p>;
  return (
    <ul className="divide-y divide-border">
      {chats.data.map((c) => (
        <li key={c.id}>
          <Link to={`/chats/${c.id}`} onClick={onNavigate} className="block rounded px-1 py-2 hover:bg-sidebar-hover">
            <div className="flex justify-between text-sm">
              <span className="font-medium">{sectors.find((s) => s.id === c.sectorId)?.name ?? '—'}</span>
              <span className={c.state === 'open' ? 'text-link' : 'text-muted'}>
                {c.state === 'open' ? 'Aberta' : 'Finalizada'}
              </span>
            </div>
            <p className="truncate text-xs text-muted">
              {dateTime(c.lastMessageAt)}
              {c.lastMessagePreview ? ` · ${c.lastMessagePreview}` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ChatDetailsTab({ chatId, onJump }: { chatId: string; onJump: (messageId: string) => void }) {
  // Same cache entry as Task 17 and the WS handler, so the tab follows live updates.
  const chat = useQuery({ queryKey: qk.chat(chatId), queryFn: () => api.chats.get(chatId) });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: () => api.sectors.list() }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: () => api.users.list() }).data ?? [];
  const channels = useQuery({ queryKey: qk.channels, queryFn: () => api.channels.list() }).data ?? [];
  if (!chat.data) return <p className="text-sm text-muted">{chat.isError ? 'Conversa não encontrada.' : 'Carregando…'}</p>;
  const c = chat.data;
  const rows: Array<[string, string]> = [
    ['Canal', channels.find((x) => x.id === c.channelId)?.name ?? '—'],
    ['Setor', sectors.find((x) => x.id === c.sectorId)?.name ?? '—'],
    ['Atendente', c.ownerId ? (users.find((u) => u.id === c.ownerId)?.name ?? '—') : 'Sem atendente'],
    ['Status', c.state === 'open' ? (c.waiting ? 'Aberta · esperando resposta' : 'Aberta') : 'Finalizada'],
    ['Visibilidade', c.private ? 'Privada' : 'Pública'],
    ['Iniciada em', dateTime(c.createdAt)],
    ['Última mensagem', dateTime(c.lastMessageAt)],
  ];
  if (c.closedAt) rows.push(['Finalizada em', dateTime(c.closedAt)]);
  return (
    <div className="space-y-6">
      <Rows rows={rows} />
      <Section title="Favoritas">
        <FavoritesList chatId={chatId} onJump={onJump} />
      </Section>
    </div>
  );
}
