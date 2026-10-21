import { DotsThreeVertical, LockSimple, PushPin, WarningCircle } from '@phosphor-icons/react';
import { BULK_MAX, tagColorHex, type ChatListItem as ChatItem, type TagDto } from '@talk/shared';
import { contactLabel, listTime } from '../../lib/format';
import { Avatar } from '../Avatar';
import { badge, badgeTone, menu as menuBox, menuItem, unreadBadge } from '../ui';
import { initials } from '../../lib/format';

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

/** The office's messages start with the WhatsApp signature ("*Setor - Nome:*" then a line break; the Umbler era used
 * the same shape). The card shows what was said, so the signature line goes. Only for the office's own messages. */
export function withoutSignature(preview: string): string {
  return preview.replace(/^\*[^*\n]{1,80}:\*\s*/, '');
}

const NO_TAGS: ReadonlyMap<string, TagDto> = new Map();
// The card's third line has room for the sector, two tags and the owner; the rest becomes "+N".
const MAX_CHIPS = 2;
type Chip = { tag: TagDto; kind: 'chat' | 'contact' };
const chipBase = 'inline-flex h-[22px] max-w-32 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold';

/** A tag in its own color, as a soft filled pill (the tag color is user data, so it is mixed, never raw). */
function TagChip({ tag, kind }: Chip) {
  const color = tagColorHex(tag.color);
  const what = kind === 'chat' ? 'Etiqueta da conversa' : 'Etiqueta do contato';
  return (
    <span
      title={`${what}: ${tag.name}`}
      className={chipBase}
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)`,
        color: `color-mix(in srgb, ${color} 65%, var(--color-fg))`,
      }}
    >
      <span className="sr-only">{what}: </span>
      <span className="truncate">
        {tag.emoji ? `${tag.emoji} ` : ''}
        {tag.name}
      </span>
    </span>
  );
}

/** The owner: their photo, or the initial on the rail's dark green, and the first name. */
function OwnerChip({ owner }: { owner: { name: string; avatarUrl: string | null } }) {
  return (
    <span title={owner.name} role="img" aria-label={`Responsável: ${owner.name}`} className="flex min-w-0 items-center gap-1.5">
      {owner.avatarUrl ? (
        <img src={owner.avatarUrl} alt="" aria-hidden="true" className="size-5 shrink-0 rounded-full object-cover" />
      ) : (
        <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-rail text-[10px] font-bold text-white">
          {initials(owner.name).slice(0, 1)}
        </span>
      )}
      <span aria-hidden="true" className="truncate text-xs font-semibold text-fg">
        {owner.name.split(' ')[0]}
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
    <li className={`group/row relative flex items-start rounded-item transition-colors ${highlighted ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}>
      {selection && (
        <label
          title={selection.disabled ? `Até ${BULK_MAX} conversas por vez` : undefined}
          className="flex shrink-0 cursor-pointer items-center self-stretch pl-3"
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
        className="flex min-w-0 flex-1 items-center gap-3 rounded-item py-2.5 pr-3 pl-2.5 text-left"
      >
        <Avatar name={chat.contact.name} src={chat.contact.avatarUrl} className="size-[46px] text-sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-bold tabular-nums">{title}</span>
            {chat.private && <LockSimple size={14} weight="bold" aria-label="Conversa privada" className="shrink-0 text-private" />}
            {chat.pinned && <PushPin size={14} aria-label="Fixada" weight="fill" className="shrink-0 text-muted" />}
            <span className={`ml-auto shrink-0 pl-1 text-xs tabular-nums ${unread ? 'font-bold text-primary' : 'text-muted'}`}>
              {chat.lastMessageAt ? listTime(chat.lastMessageAt) : ''}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <span className={`flex min-w-0 flex-1 items-center gap-1 text-[13px] leading-[18px] ${unread ? 'font-semibold text-fg' : 'text-muted'}`}>
              {chat.lastOutStatus === 'failed' && (
                <WarningCircle size={14} weight="fill" aria-label="Falhou" className="shrink-0 text-danger" />
              )}
              <span className="truncate">
                {/* like WhatsApp: the office spoke last */}
                {chat.lastOutStatus && <span className="font-semibold text-fg-2">Você: </span>}
                {chat.lastOutStatus ? withoutSignature(chat.lastMessagePreview ?? '') : (chat.lastMessagePreview ?? '')}
              </span>
            </span>
            {unread && (
              <span aria-label={`Não lidas: ${chat.unread}`} className={`${unreadBadge} shrink-0`}>
                {chat.unread}
              </span>
            )}
          </span>
          <span className="mt-1 flex min-h-[22px] min-w-0 flex-wrap items-center gap-1.5">
            {channelName && <span className="truncate text-xs text-muted">{channelName}</span>}
            {sectorName && (
              <span title={`Setor: ${sectorName}`} className={`${chipBase} border border-primary/30 bg-primary-soft/40 text-accent-ink`}>
                <span className="sr-only">Setor: </span>
                <span className="truncate">{sectorName}</span>
              </span>
            )}
            {chat.history && <span className={`${badge} ${badgeTone.neutral}`}>Histórico do WhatsApp</span>}
            {chips.slice(0, MAX_CHIPS).map((c) => (
              <TagChip key={`${c.kind}:${c.tag.id}`} {...c} />
            ))}
            {chips.length > MAX_CHIPS && <span className="text-xs font-semibold text-muted">+{chips.length - MAX_CHIPS}</span>}
            {owner ? (
              <OwnerChip owner={owner} />
            ) : (
              chat.state === 'open' && (
                <span className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                  <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full border border-dashed border-warning leading-none">
                    –
                  </span>
                  Sem atendente
                </span>
              )
            )}
          </span>
        </span>
      </button>
      {!selection && (
        <details className="group/menu absolute right-1.5 bottom-1.5 z-10">
          <summary
            aria-label="Opções da conversa"
            className="grid size-8 cursor-pointer list-none place-items-center rounded-full text-muted opacity-0 transition group-hover/row:opacity-100 group-open/menu:bg-panel group-open/menu:text-fg group-open/menu:opacity-100 hover:bg-panel hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100 [&::-webkit-details-marker]:hidden"
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
      )}
    </li>
  );
}
