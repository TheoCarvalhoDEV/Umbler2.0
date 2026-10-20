import { Check, Checks, Clock, DotsThreeVertical, LockSimple, PushPin, WarningCircle } from '@phosphor-icons/react';
import type { ChatListItem as ChatItem } from '@talk/shared';
import { contactLabel, listTime } from '../../lib/format';
import { Avatar } from '../Avatar';
import { badge, badgeTone, menu as menuBox, menuItem, unreadBadge } from '../ui';

interface Props {
  chat: ChatItem;
  sectorName: string | null;
  /** History spec §7: set only when there is more than one channel. */
  channelName?: string | null;
  owner: { name: string; avatarUrl: string | null } | null;
  active: boolean;
  onOpen(): void;
  onTogglePin(): void;
  onMarkUnread(): void;
  /** Opens the chat with ConversationHeader's own dialog (?acao=…), so its rules apply. */
  onOpenWith(acao: 'transferir' | 'finalizar'): void;
  /** Admins only; undefined hides the item. */
  onDelete?: () => void;
}

/** Like WhatsApp: the last message was the office's, with its ticks. */
function OutTick({ status }: { status: NonNullable<ChatItem['lastOutStatus']> }) {
  const cls = 'shrink-0';
  switch (status) {
    case 'pending':
      return <Clock size={14} aria-label="Você · enviando" className={cls} />;
    case 'sent':
      return <Check size={14} aria-label="Você · enviada" className={cls} />;
    case 'delivered':
      return <Checks size={14} aria-label="Você · entregue" className={cls} />;
    case 'read':
      return <Checks size={14} weight="bold" aria-label="Você · lida" className={`${cls} text-read`} />;
    case 'failed':
      return <WarningCircle size={14} weight="fill" aria-label="Você · falhou" className={`${cls} text-danger`} />;
  }
}

export function ChatListItem({
  chat, sectorName, channelName = null, owner, active, onOpen, onTogglePin, onMarkUnread, onOpenWith, onDelete,
}: Props) {
  const title = contactLabel(chat.contact);
  const unread = chat.unread > 0;
  const workable = chat.state === 'open' && !chat.history;
  const menu: Array<{ label: string; run: () => void; danger?: boolean } | false> = [
    { label: chat.pinned ? 'Desafixar' : 'Fixar', run: onTogglePin },
    !unread && { label: 'Marcar como não lida', run: onMarkUnread },
    workable && { label: 'Transferir', run: () => onOpenWith('transferir') },
    workable && { label: 'Finalizar', run: () => onOpenWith('finalizar') },
    !!onDelete && { label: 'Excluir conversa', run: onDelete, danger: true },
  ];
  return (
    <li className={`flex items-start rounded-item transition-colors ${active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-item py-2.5 pr-1 pl-2.5 text-left"
      >
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-[46px] text-sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-bold tabular-nums">{title}</span>
            {chat.private && <LockSimple size={14} weight="bold" aria-label="Conversa privada" className="shrink-0 text-private" />}
            {chat.pinned && <PushPin size={14} aria-label="Fixada" weight="fill" className="shrink-0 text-muted" />}
            <span className="ml-auto shrink-0 pl-1 text-xs text-muted tabular-nums">
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`flex min-w-0 flex-1 items-center gap-1 text-[13px] leading-[18px] ${unread ? 'font-semibold text-fg' : 'text-muted'}`}>
              {chat.lastOutStatus && <OutTick status={chat.lastOutStatus} />}
              <span className="truncate">{chat.lastMessagePreview ?? ''}</span>
            </span>
            {unread && (
              <span aria-label={`Não lidas: ${chat.unread}`} className={`${unreadBadge} shrink-0`}>
                {chat.unread}
              </span>
            )}
          </span>
          <span className="flex min-h-[22px] min-w-0 items-center gap-1.5 text-xs leading-4 text-muted">
            {channelName && <span className="truncate">{channelName}</span>}
            {channelName && sectorName && <span aria-hidden>·</span>}
            {sectorName && <span className="truncate">{sectorName}</span>}
            {chat.history && <span className={`${badge} ${badgeTone.neutral}`}>Histórico do WhatsApp</span>}
            {/* board: "Previdenciário · Juliana" */}
            {(channelName || sectorName) && !chat.history && (owner || chat.state === 'open') && <span aria-hidden>·</span>}
            {owner ? (
              <span
                title={owner.name}
                role="img"
                aria-label={`Responsável: ${owner.name}`}
                className="flex min-w-0 items-center gap-1"
              >
                <Avatar name={owner.name} src={owner.avatarUrl} className="size-[18px] text-[8px]" />
                <span aria-hidden className="truncate">{owner.name.split(' ')[0]}</span>
              </span>
            ) : (
              chat.state === 'open' && <span className={`${badge} ${badgeTone.warning}`}>Sem atendente</span>
            )}
          </span>
        </span>
      </button>
      <details className="group relative shrink-0 pt-1 pr-1.5">
        <summary
          aria-label="Opções da conversa"
          className="grid size-8 cursor-pointer list-none place-items-center rounded-full text-muted transition-colors group-open:bg-panel group-open:text-fg hover:bg-panel hover:text-fg [&::-webkit-details-marker]:hidden"
        >
          <DotsThreeVertical size={18} weight="bold" />
        </summary>
        <div className={`${menuBox} absolute right-1.5 z-10 mt-1 min-w-44`}>
          {menu.map(
            (item) =>
              item && (
                <button
                  key={item.label}
                  type="button"
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    item.run();
                  }}
                  className={`${menuItem} whitespace-nowrap ${item.danger ? 'text-danger' : ''}`}
                >
                  {item.label}
                </button>
              ),
          )}
        </div>
      </details>
    </li>
  );
}
