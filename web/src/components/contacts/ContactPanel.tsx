import { useEffect, useState, type ReactNode } from 'react';
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
import { badge, badgeTone, blockTitle, button, fieldError, iconButton, tab as tabClass, tabList } from '../ui';

const dateTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className={blockTitle}>{title}</h3>
      {children}
    </section>
  );
}

/** Two columns as on the board; a row marked wide (e-mail, address, long status) spans both. */
function Rows({ rows }: { rows: Array<[string, string, wide?: boolean]> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-block bg-sunken p-3.5">
      {rows.map(([k, v, wide]) => (
        <div key={k} className={`flex min-w-0 flex-col ${wide ? 'col-span-2' : ''}`}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="font-semibold tabular-nums [overflow-wrap:anywhere]">{v}</dd>
        </div>
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
      className={tabClass(active)}
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
      <header className="flex items-center gap-1.5 px-[18px] pt-[22px] pb-2">
        <div role="tablist" className={`${tabList} min-w-0 flex-1`}>
          <TabButton active={tab === 'contact'} onClick={() => setTab('contact')}>Contato</TabButton>
          {chatId && (
            <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>Detalhes da conversa</TabButton>
          )}
        </div>
        <button type="button" aria-label="Fechar" onClick={onClose} className={iconButton}>
          <X size={18} />
        </button>
      </header>
      <div className="flex-1 overflow-y-auto px-[18px] pt-3 pb-[22px]">
        {tab === 'chat' && chatId ? (
          <ChatDetailsTab
            chatId={chatId}
            onJump={(messageId) => {
              onJumpToMessage?.(messageId);
              if (!docked) onClose(); // a drawer covers the conversation: get out of the way
            }}
          />
        ) : contact.data ? (
          <ContactTab contact={contact.data} onClose={onClose} besideChat={!!chatId} />
        ) : (
          <p className="text-sm text-muted">{contact.isError ? 'Contato não encontrado.' : 'Carregando…'}</p>
        )}
      </div>
    </>
  );

  if (docked) {
    return (
      <aside aria-label="Contato" className="flex h-full w-[340px] shrink-0 flex-col overflow-hidden rounded-card bg-surface">
        {body}
      </aside>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex justify-end p-3">
      <div className="absolute inset-0 bg-scrim" aria-hidden onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Contato"
        className="relative flex h-full w-full max-w-md flex-col overflow-hidden rounded-card bg-surface shadow-pop"
      >
        {body}
      </aside>
    </div>
  );
}

/** besideChat: the conversation header already has the primary action (Finalizar), so Nova conversa steps down to secondary. */
function ContactTab({ contact, onClose, besideChat }: { contact: ContactDto; onClose: () => void; besideChat: boolean }) {
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

  const editButton = (
    <button type="button" aria-label="Editar contato" onClick={() => setEditing(true)} className={iconButton}>
      <PencilSimple size={18} />
    </button>
  );
  const newChatButton = (
    <button
      type="button"
      disabled={contact.blocked || start.isPending}
      onClick={() => start.mutate()}
      className={besideChat ? button('secondary') : `${button('primary')} w-full`}
    >
      <ChatCircle size={16} /> Nova conversa
    </button>
  );
  const nameBlock = (
    <>
      <p className="w-full truncate text-[17px] leading-6 font-bold">{contactLabel(contact)}</p>
      <p className="text-[13px] leading-[18px] text-muted tabular-nums">{formatPhone(contact.phone)}</p>
      {contact.blocked && <span className={`${badge} ${badgeTone.danger} mt-1`}>Bloqueado</span>}
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      {besideChat ? (
        // Docked beside a conversation (Mensageiro board): centred card head, actions in a row under the phone.
        <div className="flex flex-col items-center text-center">
          <Avatar name={contact.name} src={contact.avatarUrl} className="size-[76px] text-2xl" />
          <div className="mt-2.5 flex w-full min-w-0 flex-col items-center">{nameBlock}</div>
          <div className="mt-3 flex gap-2">
            {newChatButton}
            {editButton}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3.5">
            <Avatar name={contact.name} src={contact.avatarUrl} className="size-14 text-lg" />
            <div className="flex min-w-0 flex-1 flex-col items-start">{nameBlock}</div>
            {editButton}
          </div>
          {newChatButton}
        </>
      )}
      {error && <p role="alert" className={fieldError}>{error.message}</p>}

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
            ['E-mail', contact.email ?? '—', true],
            ['Endereço', address || '—', true],
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
        className={`${button(contact.blocked ? 'secondary' : 'danger')} self-start`}
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
    <ul className="flex flex-col gap-1.5">
      {chats.data.map((c) => (
        <li key={c.id}>
          <Link
            to={`/chats/${c.id}`}
            onClick={onNavigate}
            className="flex flex-col gap-0.5 rounded-item bg-sunken px-3 py-2.5 transition-colors hover:bg-sidebar-hover"
          >
            <div className="flex justify-between gap-2 text-[13px] leading-[18px]">
              <span className="font-bold">{sectors.find((s) => s.id === c.sectorId)?.name ?? '—'}</span>
              <span className={`font-semibold ${c.state === 'open' ? 'text-link' : 'text-muted'}`}>
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
  const rows: Array<[string, string, wide?: boolean]> = [
    ['Canal', channels.find((x) => x.id === c.channelId)?.name ?? '—'],
    ['Setor', sectors.find((x) => x.id === c.sectorId)?.name ?? '—'],
    ['Atendente', c.ownerId ? (users.find((u) => u.id === c.ownerId)?.name ?? '—') : 'Sem atendente', true],
    ['Status', c.state === 'open' ? (c.waiting ? 'Aberta · esperando resposta' : 'Aberta') : 'Finalizada', true],
    ['Visibilidade', c.private ? 'Privada' : 'Pública'],
    ['Iniciada em', dateTime(c.createdAt)],
    ['Última mensagem', dateTime(c.lastMessageAt)],
  ];
  if (c.closedAt) rows.push(['Finalizada em', dateTime(c.closedAt)]);
  return (
    <div className="flex flex-col gap-5">
      <Rows rows={rows} />
      <Section title="Favoritas">
        <FavoritesList chatId={chatId} onJump={onJump} />
      </Section>
    </div>
  );
}
