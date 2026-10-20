import { DotsThreeVertical, LockSimple, PushPin } from '@phosphor-icons/react';
import type { ChatListItem as ChatItem } from '@talk/shared';
import { contactLabel, listTime } from '../../lib/format';
import { Avatar } from '../Avatar';

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
    <li className={`flex items-stretch rounded-xl ${active ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 gap-3 rounded-xl py-3 pl-3 text-left"
      >
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-10 shrink-0 text-sm bg-panel" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`truncate ${unread || active ? 'font-semibold' : 'font-medium'}`}>{title}</span>
            {chat.private && <LockSimple aria-label="Conversa privada" className="shrink-0 text-private" />}
            {chat.pinned && <PushPin aria-label="Fixada" weight="fill" className="shrink-0 text-muted" />}
            <span className={`ml-auto shrink-0 font-mono text-[11px] ${unread ? 'font-semibold text-link' : 'text-muted'}`}>
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`truncate text-sm ${unread ? 'text-fg' : 'text-muted'}`}>{chat.lastMessagePreview ?? ''}</span>
            {unread && (
              <span
                aria-label={`Não lidas: ${chat.unread}`}
                className="ml-auto min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-[11px] font-bold text-white"
              >
                {chat.unread}
              </span>
            )}
          </span>
          <span className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px]">
            {channelName && <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-muted">{channelName}</span>}
            {sectorName && <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-muted">{sectorName}</span>}
            {owner ? (
              <span
                title={owner.name}
                role="img"
                aria-label={`Responsável: ${owner.name}`}
                className="flex min-w-0 items-center gap-1 rounded-full border border-border py-px pr-2 pl-px text-muted"
              >
                <Avatar name={owner.name} src={owner.avatarUrl} className="size-4 shrink-0 text-[8px] bg-primary text-white" />
                <span aria-hidden className="truncate">{owner.name.split(' ')[0]}</span>
              </span>
            ) : (
              chat.state === 'open' && <span className="rounded-full bg-brass-soft px-2 py-0.5 font-semibold text-brass">Sem atendente</span>
            )}
          </span>
        </span>
      </button>
      <details className="relative">
        <summary aria-label="Opções da conversa" className="cursor-pointer list-none rounded-lg px-1.5 py-3 text-muted hover:text-fg">
          <DotsThreeVertical size={18} />
        </summary>
        <div className="absolute right-1 z-10 mt-1 rounded-lg border border-border bg-surface py-1 shadow-lg">
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
                  className={`block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-sidebar-hover ${item.danger ? 'text-danger' : ''}`}
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
