import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowBendUpRight, ArrowCounterClockwise, CheckCircle, LockSimple, LockSimpleOpen, User, UserPlus } from '@phosphor-icons/react';
import type { BotAction, BotRunningErrorBody, ChatDetail } from '@talk/shared';
import { api, botRunningRuns, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { contactLabel } from '../../lib/format';
import { Avatar } from '../Avatar';
import { BotRunningDialog, CloseDialog, TransferDialog } from './ChatDialogs';
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
      className={`flex size-10 items-center justify-center rounded-lg hover:bg-sidebar-hover disabled:cursor-not-allowed disabled:opacity-40 ${
        props.pressed ? 'bg-primary-soft text-link' : 'text-muted'
      }`}
    >
      {props.children}
    </button>
  );
}

type Action =
  | { kind: 'assume' }
  | { kind: 'reopen' }
  | { kind: 'transfer'; to: { sectorId: string; ownerId: string | null }; botAction?: BotAction }
  | { kind: 'privacy'; private: boolean }
  | { kind: 'close'; sendClosingMessage: boolean };

function runAction(chatId: string, a: Action): Promise<ChatDetail> {
  switch (a.kind) {
    case 'assume':
      return api.chats.assume(chatId);
    case 'reopen':
      return api.chats.reopen(chatId);
    case 'transfer':
      return api.chats.transfer(chatId, { ...a.to, botAction: a.botAction });
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
  const [botAsk, setBotAsk] = useState<{
    runs: BotRunningErrorBody['runs'];
    transfer: Extract<Action, { kind: 'transfer' }>;
  } | null>(null);

  const open = chat.state === 'open';
  const ownerOrAdmin = me.role === 'admin' || chat.ownerId === me.id;
  const lockedByPrivacy = chat.private && !ownerOrAdmin; // §5.3: private → only owner/admin transfer or close
  // The chat list menu opens a chat with ?acao=transferir|finalizar: the same dialog as the buttons below, only when
  // that button is enabled; the param goes away (replace) so a reload does not reopen it.
  const [params, setParams] = useSearchParams();
  const acao = params.get('acao');
  useEffect(() => {
    if (!acao) return;
    if (open && !lockedByPrivacy) setDialog(acao === 'transferir' ? 'transfer' : acao === 'finalizar' ? 'close' : null);
    setParams(
      (p) => {
        p.delete('acao');
        return p;
      },
      { replace: true },
    );
  }, [acao, open, lockedByPrivacy, setParams]);

  const sectorName = sectors.find((s) => s.id === chat.sectorId)?.name ?? '—';
  const ownerName = chat.ownerId ? (users.find((u) => u.id === chat.ownerId)?.name ?? 'Atendente') : 'Sem atendente';

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
      const runs = botRunningRuns(e);
      if (runs && a.kind === 'transfer') {
        // spec §5.5 "ask": confirm first, then the same transfer goes again with botAction
        setDialog(null);
        setBotAsk({ runs, transfer: a });
        return;
      }
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

  const pill = 'flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-semibold disabled:opacity-50';
  const secondary = `${pill} border border-border bg-surface text-fg hover:bg-sidebar-hover`;

  return (
    <>
      <header className="flex items-center gap-1 border-b border-border bg-surface py-3 pr-4 pl-6">
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="mr-2 size-11 shrink-0 text-sm bg-panel" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-fg">{contactLabel(chat.contact)}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-fg">{sectorName}</span>
            <span>{ownerName}</span>
            {chat.private && (
              <span className="flex items-center gap-0.5 text-private">
                <LockSimple size={12} /> Privada
              </span>
            )}
            {!open && <span>{chat.history ? 'Histórico do WhatsApp' : 'Finalizada'}</span>}
          </div>
        </div>

        {open && !chat.ownerId && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'assume' })} className={`${pill} bg-primary text-white hover:bg-primary-hover`}>
            <UserPlus size={16} /> Assumir
          </button>
        )}
        {!open && !chat.history && (
          <button type="button" disabled={busy} onClick={() => void act({ kind: 'reopen' })} className={secondary}>
            <ArrowCounterClockwise size={16} /> Reabrir
          </button>
        )}

        <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
          <User size={20} />
        </HeaderButton>
        {open && (
          <>
            <HeaderButton
              label={chat.private ? 'Tornar pública' : 'Tornar privada'}
              disabled={busy || !ownerOrAdmin}
              onClick={() => void act({ kind: 'privacy', private: !chat.private })}
            >
              {chat.private ? <LockSimpleOpen size={20} /> : <LockSimple size={20} />}
            </HeaderButton>
            {/* the two workflow actions carry text: an icon-only ✓ read as "message sent" */}
            <button
              type="button"
              disabled={busy || lockedByPrivacy}
              onClick={() => setDialog('transfer')}
              className={`${secondary} ml-2 disabled:cursor-not-allowed`}
            >
              <ArrowBendUpRight size={16} /> Transferir
            </button>
            <button
              type="button"
              disabled={busy || lockedByPrivacy}
              onClick={() => setDialog('close')}
              // one primary action at a time: Assumir while nobody owns the chat, then Finalizar
              className={`${chat.ownerId ? `${pill} bg-primary text-white hover:bg-primary-hover` : secondary} ml-1 disabled:cursor-not-allowed`}
            >
              <CheckCircle size={16} /> Finalizar
            </button>
          </>
        )}
      </header>

      {error && !dialog && (
        <p role="alert" className="border-b border-border bg-danger-soft px-6 py-2 text-sm text-danger">
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
      {botAsk && (
        <BotRunningDialog
          runs={botAsk.runs}
          action="transfer"
          onChoose={(botAction) => {
            const retry = botAsk.transfer;
            setBotAsk(null);
            if (botAction) void act({ ...retry, botAction });
          }}
        />
      )}
    </>
  );
}
