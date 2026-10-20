import { ChatCircleText, Check, Checks, Clock, DotsThreeVertical, LockSimple, PushPin, WarningCircle } from '@phosphor-icons/react';
import { BULK_MAX, tagColorHex, type ChatListItem as ChatItem, type TagDto } from '@talk/shared';
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
  /** The tag catalog by id, for the chips. An unknown id (a tag just deleted) is skipped. */
  tagById?: ReadonlyMap<string, TagDto>;
  /** Spec 2026-10-20 §4 "Selecionar": a checkbox; the row toggles it instead of opening the chat; no menu. */
  selection?: { selected: boolean; disabled: boolean; onToggle(): void };
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

const NO_TAGS: ReadonlyMap<string, TagDto> = new Map();
const MAX_CHIPS = 4;
type Chip = { tag: TagDto; kind: 'chat' | 'contact' };

/** Spec 2026-10-20 §5: a conversation tag is filled and carries a speech bubble; a contact tag is only outlined. */
function TagChip({ tag, kind }: Chip) {
  const color = tagColorHex(tag.color);
  const what = kind === 'chat' ? 'Etiqueta da conversa' : 'Etiqueta do contato';
  return (
    <span
      title={`${what}: ${tag.name}`}
      className={`flex max-w-28 items-center gap-0.5 rounded-full border px-1.5 py-px ${kind === 'chat' ? 'text-white' : ''}`}
      style={kind === 'chat' ? { backgroundColor: color, borderColor: color } : { borderColor: color, color }}
    >
      {kind === 'chat' && <ChatCircleText size={10} weight="fill" aria-hidden className="shrink-0" />}
      <span className="sr-only">{what}: </span>
      <span className="truncate">
        {tag.emoji ? `${tag.emoji} ` : ''}
        {tag.name}
      </span>
    </span>
  );
}

export function ChatListItem({
  chat, sectorName, channelName = null, owner, active, onOpen, onTogglePin, onMarkUnread, onOpenWith, onDelete,
  tagById = NO_TAGS, selection,
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
  const chipsOf = (ids: string[], kind: Chip['kind']): Chip[] =>
    ids.flatMap((id) => {
      const tag = tagById.get(id);
      return tag ? [{ tag, kind }] : [];
    });
  const chips = [...chipsOf(chat.chatTagIds ?? [], 'chat'), ...chipsOf(chat.tagIds, 'contact')];
  const highlighted = active || !!selection?.selected;
  return (
    <li className={`flex items-stretch rounded-xl ${highlighted ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}>
      {selection && (
        <label
          title={selection.disabled ? `Até ${BULK_MAX} conversas por vez` : undefined}
          className="flex shrink-0 cursor-pointer items-center pl-3"
        >
          <input
            type="checkbox"
            aria-label={`Selecionar ${title}`}
            checked={selection.selected}
            disabled={selection.disabled}
            onChange={selection.onToggle}
            className="size-4 accent-primary"
          />
        </label>
      )}
      <button
        type="button"
        onClick={
          selection
            ? () => {
                if (!selection.disabled) selection.onToggle();
              }
            : onOpen
        }
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
            <span className={`flex min-w-0 items-center gap-1 text-sm ${unread ? 'text-fg' : 'text-muted'}`}>
              {chat.lastOutStatus && <OutTick status={chat.lastOutStatus} />}
              <span className="truncate">{chat.lastMessagePreview ?? ''}</span>
            </span>
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
            {chat.history && <span className="rounded-md bg-panel px-2 py-0.5 font-medium text-muted">Histórico do WhatsApp</span>}
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
          {chips.length > 0 && (
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] font-medium">
              {chips.slice(0, MAX_CHIPS).map((c) => (
                <TagChip key={`${c.kind}:${c.tag.id}`} {...c} />
              ))}
              {chips.length > MAX_CHIPS && <span className="text-muted">+{chips.length - MAX_CHIPS}</span>}
            </span>
          )}
        </span>
      </button>
      {!selection && (
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
      )}
    </li>
  );
}
