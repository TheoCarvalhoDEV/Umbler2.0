import { DotsThreeVertical, LockSimple, PushPin } from '@phosphor-icons/react';
import type { ChatListItem as ChatItem } from '@talk/shared';
import { contactLabel, listTime } from '../../lib/format';
import { Avatar } from '../Avatar';

interface Props {
  chat: ChatItem;
  sectorName: string | null;
  owner: { name: string; avatarUrl: string | null } | null;
  active: boolean;
  onOpen(): void;
  onTogglePin(): void;
}

export function ChatListItem({ chat, sectorName, owner, active, onOpen, onTogglePin }: Props) {
  const title = contactLabel(chat.contact);
  const unread = chat.unread > 0;
  return (
    <li className={`flex items-stretch border-b border-border ${active ? 'bg-sidebar-active' : 'hover:bg-panel'}`}>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 gap-3 px-3 py-2 text-left"
      >
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-10 text-sm bg-sidebar-active" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span className={`truncate ${unread ? 'font-bold' : 'font-medium'}`}>{title}</span>
            {chat.private && <LockSimple aria-label="Conversa privada" className="shrink-0 text-muted" />}
            {chat.pinned && <PushPin aria-label="Fixada" weight="fill" className="shrink-0 text-muted" />}
            <span className={`ml-auto shrink-0 text-xs ${unread ? 'font-semibold text-link' : 'text-muted'}`}>
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`truncate text-sm ${unread ? 'text-fg' : 'text-muted'}`}>{chat.lastMessagePreview ?? ''}</span>
            {unread && (
              <span
                aria-label={`Não lidas: ${chat.unread}`}
                className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-xs font-semibold text-white"
              >
                {chat.unread}
              </span>
            )}
          </span>
          <span className="mt-1 flex items-center gap-1">
            {sectorName && <span className="rounded bg-panel px-1.5 text-xs text-muted">{sectorName}</span>}
            {owner && (
              <span title={owner.name} role="img" aria-label={`Responsável: ${owner.name}`}>
                <Avatar name={owner.name} src={owner.avatarUrl} className="size-5 text-[10px] bg-primary text-white" />
              </span>
            )}
          </span>
        </span>
      </button>
      <details className="relative">
        <summary aria-label="Opções da conversa" className="cursor-pointer list-none px-1 py-3 text-muted hover:text-fg">
          <DotsThreeVertical size={18} />
        </summary>
        <div className="absolute right-1 z-10 mt-1 rounded border border-border bg-panel py-1 shadow-lg">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.closest('details')?.removeAttribute('open');
              onTogglePin();
            }}
            className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-sm hover:bg-sidebar-hover"
          >
            {chat.pinned ? 'Desafixar' : 'Fixar'}
          </button>
        </div>
      </details>
    </li>
  );
}
