import { useId, useState, type FormEvent } from 'react';
import { TAG_COLORS, tagColorHex, type TagDto } from '@talk/shared';
import { button, field, fieldError, fieldLabel } from '../ui';
import { btnPrimary } from './common';

export interface TagInput {
  name: string;
  emoji: string | null;
  color: string;
}

export const TAG_NAME_MAX = 30;

/** A tag as a neutral pill with a dot of its color: readable in both themes whatever the color. */
export const tagChip = 'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-panel px-3 text-xs font-bold text-fg-2';

export function TagForm({
  initial,
  onSubmit,
  onCancel,
  pending = false,
  error = null,
}: {
  initial?: TagDto;
  onSubmit(value: TagInput): void;
  onCancel(): void;
  pending?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji ?? '');
  const [color, setColor] = useState<string>(initial ? tagColorHex(initial.color) : TAG_COLORS[0].hex);
  const cleanName = name.trim();
  const cleanEmoji = emoji.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (cleanName) onSubmit({ name: cleanName, emoji: cleanEmoji || null, color });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex gap-3">
        <div className="w-20">
          <label htmlFor={`${id}-emoji`} className={fieldLabel}>
            Emoji
          </label>
          {/* ponytail: native input, the OS emoji picker (Win + . / Ctrl+Cmd+Space) fills it; no picker library */}
          <input
            id={`${id}-emoji`}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="⭐"
            className={`${field} text-center`}
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${id}-name`} className={fieldLabel}>
            Nome
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={TAG_NAME_MAX}
            onChange={(e) => setName(e.target.value.slice(0, TAG_NAME_MAX))}
            className={field}
          />
          <p className="mt-1.5 text-right text-xs text-muted tabular-nums">{`${name.length}/${TAG_NAME_MAX}`}</p>
        </div>
      </div>

      <div>
        <span id={`${id}-colors`} className={fieldLabel}>
          Cor de fundo
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-colors`} className="grid w-fit grid-cols-10 gap-2.5">
          {TAG_COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.hex)}
              className={`size-7 rounded-full ${color === c.hex ? 'ring-2 ring-fg ring-offset-2 ring-offset-surface' : ''}`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </div>

      <div>
        <span className={fieldLabel}>Pré-visualização</span>
        <span data-testid="tag-preview" className={tagChip}>
          <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
          {`${cleanEmoji ? `${cleanEmoji} ` : ''}${cleanName || 'Nome da etiqueta'}`}
        </span>
      </div>

      {error && (
        <p role="alert" className={fieldError}>
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={button('ghost')}>
          Cancelar
        </button>
        <button type="submit" disabled={!cleanName || pending} className={btnPrimary}>
          Salvar
        </button>
      </div>
    </form>
  );
}
