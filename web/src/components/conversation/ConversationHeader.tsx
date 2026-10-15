import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpRight, ArrowCounterClockwise, Check, LockSimple, LockSimpleOpen, User, UserPlus } from '@phosphor-icons/react';
import type { ChatDetail } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { formatPhone } from '../../lib/format';
import { CloseDialog, TransferDialog } from './ChatDialogs';
import { errorMessage, isConflict } from './model';

function HeaderButton(props: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded p-2 hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40 ${
        props.pressed ? 'bg-panel text-fg' : 'text-muted'
      }`}
    >
      {props.children}
    </button>
  );
}

type Action =
  | { kind: 'assume' }
  | { kind: 'reopen' }
  | { kind: 'transfer'; to: { sectorId: string; ownerId: string | null } }
  | { kind: 'privacy'; private: boolean }
  | { kind: 'close'; sendClosingMessage: boolean };

function runAction(chatId: string, a: Action): Promise<ChatDetail> {
  switch (a.kind) {
    case 'assume':
      return api.chats.assume(chatId);
    case 'reopen':
      return api.chats.reopen(chatId);
    case 'transfer':
      return api.chats.transfer(chatId, a.to);
    case 'privacy':
      return api.chats.setPrivacy(chatId, a.private);
    case 'close':
      return api.chats.close(chatId, a.sendClosingMessage);
  }
}

export interface ConversationHeaderProps {
  chat: ChatDetail;
  contactPanelOpen: boolean;
  onToggleContactPanel: () => void;
  onOpenChat: (chatId: string) => void;
}

export function ConversationHeader({ chat, contactPanelOpen, onToggleContactPanel, onOpenChat }: ConversationHeaderProps) {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list }).data ?? [];
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list }).data ?? [];
  const [dialog, setDialog] = useState<'transfer' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = chat.state === 'open';
  const ownerOrAdmin = me.role === 'admin' || chat.ownerId === me.id;
  const lockedByPrivacy = chat.private && !ownerOrAdmin; // §5.3: private → only owner/admin transfer or close
  const sectorName = sectors.find((s) => s.id === chat.sectorId)?.name ?? '—';
  const ownerName = chat.ownerId ? (users.find((u) => u.id === chat.ownerId)?.name ?? 'Atendente') : 'Sem dono';

  async function act(a: Action) {
    setBusy(true);
    setError(null);
    try {
      const detail = await runAction(chat.id, a);
      setDialog(null);
      // reopen may answer with another chat already open for this contact (§5.3)
      if (detail.id !== chat.id) onOpenChat(detail.id);
      else qc.setQueryData(qk.chat(chat.id), detail);
    } catch (e) {
      if (isConflict(e)) {
        setDialog(null);
        setError('A conversa foi alterada por outra pessoa e foi recarregada.');
      } else {
        setError(errorMessage(e));
      }
      void qc.invalidateQueries({ queryKey: qk.chat(chat.id), exact: true });
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    setDialog(null);
    setError(null);
  }

  const pill = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50';

  return (
    <>
      <header className="flex items-center gap-1 border-b border-border bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-fg">{chat.contact.name ?? formatPhone(chat.contact.phone)}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded bg-panel px-1.5 text-fg">{sectorName}</span>
            <span>{ownerName}</span>
            {chat.private && (
              <span className="flex items-center gap-0.5 text-amber-400">
                <LockSimple size={12} /> Privada
              </span>
            )}
            {!open && <span>Finalizada</span>}
          </div>
        </div>

        {open && !chat.ownerId && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'assume' })} className={`${pill} bg-primary text-white hover:bg-primary-hover`}>
            <UserPlus size={16} /> Assumir
          </button>
        )}
        {!open && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'reopen' })} className={`${pill} bg-panel text-fg hover:bg-sidebar-hover`}>
            <ArrowCounterClockwise size={16} /> Reabrir
          </button>
        )}

        <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
          <User size={20} />
        </HeaderButton>
        {open && (
          <>
            <HeaderButton label="Transferir" disabled={busy || lockedByPrivacy} onClick={() => setDialog('transfer')}>
              <ArrowBendUpRight size={20} />
            </HeaderButton>
            <HeaderButton
              label={chat.private ? 'Liberar conversa' : 'Privar conversa'}
              disabled={busy || !ownerOrAdmin}
              onClick={() => void act({ kind: 'privacy', private: !chat.private })}
            >
              {chat.private ? <LockSimpleOpen size={20} /> : <LockSimple size={20} />}
            </HeaderButton>
            <HeaderButton label="Finalizar" disabled={busy || lockedByPrivacy} onClick={() => setDialog('close')}>
              <Check size={20} />
            </HeaderButton>
          </>
        )}
      </header>

      {error && !dialog && (
        <p role="alert" className="border-b border-border bg-danger/15 px-4 py-1.5 text-sm text-danger">
          {error}
        </p>
      )}
      {dialog === 'transfer' && (
        <TransferDialog
          chat={chat}
          sectors={sectors}
          users={users}
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(to) => void act({ kind: 'transfer', to })}
        />
      )}
      {dialog === 'close' && (
        <CloseDialog
          busy={busy}
          error={error}
          onCancel={closeDialog}
          onConfirm={(sendClosingMessage) => void act({ kind: 'close', sendClosingMessage })}
        />
      )}
    </>
  );
}
