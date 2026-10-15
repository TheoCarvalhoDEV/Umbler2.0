import { useId, useState, type FormEvent } from 'react';
import { TAG_COLORS, tagColorHex, type TagDto } from '@talk/shared';

export interface TagInput {
  name: string;
  emoji: string | null;
  color: string;
}

export const TAG_NAME_MAX = 30;

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
    <form onSubmit={submit} className="mb-6 space-y-4 rounded border border-border p-4">
      <div className="flex gap-3">
        <div className="w-20">
          <label htmlFor={`${id}-emoji`} className="block text-sm font-medium">
            Emoji
          </label>
          {/* ponytail: native input, the OS emoji picker (Win + . / Ctrl+Cmd+Space) fills it; no picker library */}
          <input
            id={`${id}-emoji`}
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="⭐"
            className="mt-1 w-full rounded border border-border px-2 py-1.5 text-center"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${id}-name`} className="block text-sm font-medium">
            Nome
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={TAG_NAME_MAX}
            onChange={(e) => setName(e.target.value.slice(0, TAG_NAME_MAX))}
            className="mt-1 w-full rounded border border-border px-2 py-1.5 text-sm"
          />
          <p className="mt-1 text-right text-xs text-muted">{`${name.length}/${TAG_NAME_MAX}`}</p>
        </div>
      </div>

      <div>
        <span id={`${id}-colors`} className="block text-sm font-medium">
          Cor de fundo
        </span>
        <div role="radiogroup" aria-labelledby={`${id}-colors`} className="mt-2 grid w-fit grid-cols-10 gap-2">
          {TAG_COLORS.map((c) => (
            <button
              key={c.name}
              type="button"
              role="radio"
              aria-checked={color === c.hex}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.hex)}
              className={`h-7 w-7 rounded-full ${color === c.hex ? 'ring-2 ring-fg ring-offset-2 ring-offset-panel' : ''}`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium">Pré-visualização</span>
        <span
          data-testid="tag-preview"
          className="mt-2 inline-block rounded-full px-3 py-1 text-sm font-medium text-white"
          style={{ backgroundColor: color }}
        >
          {`${cleanEmoji ? `${cleanEmoji} ` : ''}${cleanName || 'Nome da etiqueta'}`}
        </span>
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border border-border px-3 py-1.5 text-sm hover:bg-sidebar-hover">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={!cleanName || pending}
          className="rounded bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
        >
          Salvar
        </button>
      </div>
    </form>
  );
}
