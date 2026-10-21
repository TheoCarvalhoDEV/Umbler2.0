import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { STICKER_MAX_BYTES } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { blockTitle, fieldError, menu, menuItem } from '../ui';

const STICKER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export interface StickerPanelProps {
  onPick: (messageId: string) => void;
  onPickFile: (file: File) => void;
  onClose: () => void;
}

/** Composer popover (spec §6): the 40 recent stickers, plus "Enviar imagem como figurinha" (PNG/JPEG/WebP up to 1 MB). */
export function StickerPanel({ onPick, onPickFile, onClose }: StickerPanelProps) {
  const recent = useQuery({ queryKey: qk.recentStickers, queryFn: api.stickers.recent });
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      role="dialog"
      aria-label="Figurinhas"
      className={`${menu} absolute bottom-full left-0 z-10 mb-2 w-80 text-sm`}
    >
      <p className={`${blockTitle} px-2 pt-1.5 pb-2`}>Figurinhas recentes</p>
      {recent.isPending && <p className="px-2 pb-1 text-muted">Carregando…</p>}
      {recent.isError && <p className="px-2 pb-1 text-danger">Não foi possível carregar as figurinhas.</p>}
      {recent.data?.length === 0 && <p className="px-2 pb-1 text-muted">Nenhuma figurinha ainda.</p>}
      <div className="grid max-h-64 grid-cols-5 gap-1 overflow-y-auto">
        {recent.data?.map((s) => (
          <button
            key={s.messageId}
            type="button"
            aria-label="Enviar figurinha"
            onClick={() => {
              onPick(s.messageId);
              onClose();
            }}
            className="grid place-items-center rounded-block p-1 transition-colors hover:bg-sidebar-hover"
          >
            <img src={s.url} alt="" loading="lazy" className="size-12 object-contain" />
          </button>
        ))}
      </div>
      <button type="button" onClick={() => fileRef.current?.click()} className={`${menuItem} mt-1`}>
        Enviar imagem como figurinha
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={STICKER_TYPES.join(',')}
        aria-label="Imagem para figurinha"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // picking the same file again still fires onChange
          if (!file) return;
          if (!STICKER_TYPES.includes(file.type) || file.size > STICKER_MAX_BYTES) {
            setError('Envie uma imagem PNG, JPEG ou WebP de até 1 MB');
            return;
          }
          onPickFile(file);
          onClose();
        }}
      />
      {error && (
        <p role="alert" className={`${fieldError} px-2 pb-1`}>
          {error}
        </p>
      )}
    </div>
  );
}
