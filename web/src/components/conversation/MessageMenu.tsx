import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import {
  QUICK_REACTIONS, deleteBlock, editBlock, forwardBlock, isSingleEmoji, reactBlock, replyBlock, type ActionBlock, type MessageDto,
} from '@talk/shared';

export type MenuAction = 'react' | 'reply' | 'forward' | 'copy' | 'edit' | 'delete';
/** hint set = the action applies but its time is over: shown disabled with the hint. */
export interface MenuItem { action: MenuAction; label: string; hint: string | null }

/**
 * Spec §9: Reagir · Responder · Encaminhar · Copiar · Editar · Apagar para todos. An action that does not apply to
 * this message is left out; one whose time is over stays, disabled, with its hint. A closed chat only offers Copiar.
 */
export function menuItems(m: MessageDto, meId: string | null, chatOpen: boolean, now: number): MenuItem[] {
  const items: MenuItem[] = [];
  const add = (action: MenuAction, label: string, block: ActionBlock | null) => {
    if (!block) items.push({ action, label, hint: null });
    else if (block.expired) items.push({ action, label, hint: block.reason });
  };
  if (chatOpen) {
    add('react', 'Reagir', reactBlock(m));
    add('reply', 'Responder', replyBlock(m));
    add('forward', 'Encaminhar', forwardBlock(m));
  }
  if (m.body) items.push({ action: 'copy', label: 'Copiar', hint: null });
  if (chatOpen) {
    add('edit', 'Editar', editBlock(m, meId, now));
    add('delete', 'Apagar para todos', deleteBlock(m, now));
  }
  return items;
}

const firstGrapheme = (s: string) => [...new Intl.Segmenter('pt-BR', { granularity: 'grapheme' }).segment(s.trim())][0]?.segment ?? '';

/** Visible box the menu must fit in: the nearest scrolling ancestor (the timeline), else the viewport. */
function clipBox(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) return p.getBoundingClientRect();
  }
  return { top: 0, bottom: window.innerHeight };
}

export interface MessageMenuProps {
  items: MenuItem[];
  officeReaction: string | null;
  /** Bubble on the right (sent): the menu opens toward the left. */
  alignRight: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (action: Exclude<MenuAction, 'react'>) => void;
  onReact: (emoji: string) => void;
}

/**
 * Hover (or a long press, through the bubble's contextmenu) shows the trigger. "Reagir" swaps the list for the quick
 * reactions plus a box where the system emoji picker (Win + . / Ctrl + Cmd + Space) or the phone keyboard types one.
 */
export function MessageMenu(props: MessageMenuProps) {
  const [reacting, setReacting] = useState(false);
  const [other, setOther] = useState('');
  const [otherError, setOtherError] = useState(false);
  // Near the bottom of the timeline the menu would be clipped: open it upward instead.
  const [up, setUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!props.open || !triggerRef.current || !menuRef.current) return;
    const btn = triggerRef.current.getBoundingClientRect();
    const h = menuRef.current.offsetHeight + 4;
    const box = clipBox(triggerRef.current);
    const below = box.bottom - btn.bottom;
    setUp(below < h && btn.top - box.top > below);
  }, [props.open, reacting]);
  if (props.items.length === 0) return null;

  function close() {
    setReacting(false);
    setOther('');
    setOtherError(false);
    props.onOpenChange(false);
  }

  function pick(action: MenuAction) {
    if (action === 'react') {
      setReacting(true);
      return;
    }
    close();
    props.onAction(action);
  }

  function react(emoji: string) {
    close();
    props.onReact(emoji);
  }

  function onOtherKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const emoji = firstGrapheme(other);
    if (isSingleEmoji(emoji)) react(emoji);
    else setOtherError(true);
  }

  return (
    <div
      className="relative self-center"
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label="Ações da mensagem"
        title="Ações da mensagem"
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={() => (props.open ? close() : props.onOpenChange(true))}
        className="p-1 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
      >
        <CaretDown size={16} />
      </button>
      {props.open && (
        <>
          <div className="fixed inset-0 z-10" aria-hidden onClick={close} />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Ações da mensagem"
            className={`absolute z-20 w-60 rounded-md border border-border bg-panel py-1 text-sm text-fg shadow-lg ${
              up ? 'bottom-full mb-1' : 'top-full mt-1'
            } ${props.alignRight ? 'right-0' : 'left-0'}`}
          >
            {reacting ? (
              <div className="px-2 py-1">
                <div className="flex gap-1">
                  {QUICK_REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      aria-label={`Reagir com ${e}`}
                      aria-pressed={props.officeReaction === e}
                      onClick={() => react(e)}
                      className="rounded px-1 text-lg hover:bg-surface aria-pressed:bg-primary/25"
                    >
                      {e}
                    </button>
                  ))}
                </div>
                <input
                  aria-label="Outro emoji"
                  autoFocus
                  value={other}
                  placeholder="Mais: Win + . ou cole um emoji e Enter"
                  onChange={(e) => {
                    setOther(e.target.value);
                    setOtherError(false);
                  }}
                  onKeyDown={onOtherKey}
                  className="mt-2 w-full rounded border border-field bg-surface px-2 py-1 text-sm"
                />
                {otherError && (
                  <p role="alert" className="mt-1 text-xs text-danger">
                    Escolha um emoji
                  </p>
                )}
              </div>
            ) : (
              props.items.map((it) => (
                <button
                  key={it.action}
                  type="button"
                  role="menuitem"
                  disabled={it.hint !== null}
                  onClick={() => pick(it.action)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span>{it.label}</span>
                  {it.hint && <span className="block text-xs text-muted">{it.hint}</span>}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
