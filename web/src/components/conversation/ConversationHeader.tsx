import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowCounterClockwise, ArrowsLeftRight, Check, LockSimple, LockSimpleOpen, MagnifyingGlass, User, UserPlus,
} from '@phosphor-icons/react';
import type { BotAction, BotRunningErrorBody, ChatDetail } from '@talk/shared';
import { api, botRunningRuns, qk } from '../../lib/api';
import { useCurrentUser } from '../../lib/auth';
import { contactLabel } from '../../lib/format';
import { Avatar } from '../Avatar';
import { badge, badgeTone, button, iconButton, iconButtonOn, sectionTitle } from '../ui';
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
      className={props.pressed ? iconButtonOn : iconButton}
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
  /** Spec 2026-10-19 §4: the search bar under the header. */
  searchOpen?: boolean;
  onToggleSearch?: () => void;
}

export function ConversationHeader({
  chat, contactPanelOpen, onToggleContactPanel, onOpenChat, searchOpen = false, onToggleSearch,
}: ConversationHeaderProps) {
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

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 bg-surface px-[18px] py-3.5">
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-11 text-sm" />
        <div className="min-w-[180px] flex-1">
          <h2 className={`${sectionTitle} truncate text-fg`}>{contactLabel(chat.contact)}</h2>
          {/* the board's subline: owner · sector in muted text; only states (Sem atendente, Privada…) are badges */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-[18px] text-muted">
            {/* nobody owns it: drawn as the "Sem atendente" state badge */}
            <span className={chat.ownerId ? undefined : `${badge} ${badgeTone.warning}`}>{ownerName}</span>
            <span aria-hidden>·</span>
            <span>{sectorName}</span>
            {chat.private && (
              <span className={`${badge} ${badgeTone.brass}`}>
                <LockSimple size={12} weight="bold" /> Privada
              </span>
            )}
            {!open && <span className={`${badge} ${badgeTone.neutral}`}>{chat.history ? 'Histórico do WhatsApp' : 'Finalizada'}</span>}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <HeaderButton label="Buscar na conversa" pressed={searchOpen} onClick={() => onToggleSearch?.()}>
            <MagnifyingGlass size={18} />
          </HeaderButton>
          <HeaderButton label="Contato" pressed={contactPanelOpen} onClick={onToggleContactPanel}>
            <User size={18} />
          </HeaderButton>
          {open && (
            <HeaderButton
              label={chat.private ? 'Tornar pública' : 'Tornar privada'}
              disabled={busy || !ownerOrAdmin}
              onClick={() => void act({ kind: 'privacy', private: !chat.private })}
            >
              {chat.private ? <LockSimpleOpen size={18} /> : <LockSimple size={18} />}
            </HeaderButton>
          )}

          {open && !chat.ownerId && (
            <button type="button" disabled={busy} onClick={() => void act({ kind: 'assume' })} className={button('primary')}>
              <UserPlus size={16} /> Assumir
            </button>
          )}
          {!open && !chat.history && (
            <button type="button" disabled={busy} onClick={() => void act({ kind: 'reopen' })} className={button('secondary')}>
              <ArrowCounterClockwise size={16} /> Reabrir
            </button>
          )}
          {open && (
            <>
              {/* the two workflow actions carry text: an icon-only ✓ read as "message sent" */}
              <button
                type="button"
                disabled={busy || lockedByPrivacy}
                onClick={() => setDialog('transfer')}
                className={button('secondary')}
              >
                <ArrowsLeftRight size={16} /> Transferir
              </button>
              <button
                type="button"
                disabled={busy || lockedByPrivacy}
                onClick={() => setDialog('close')}
                // one primary action at a time: Assumir while nobody owns the chat, then Finalizar
                className={button(chat.ownerId ? 'primary' : 'secondary')}
              >
                <Check size={16} /> Finalizar
              </button>
            </>
          )}
        </div>
      </header>

      {error && !dialog && (
        <p role="alert" className="bg-danger-soft px-[18px] py-2.5 text-[13px] leading-[18px] font-semibold text-danger">
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
