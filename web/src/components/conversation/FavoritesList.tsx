import { useQuery } from '@tanstack/react-query';
import { api, qk } from '../../lib/api';
import { previewText, shortDateTime } from './model';

/** Spec 2026-10-19 §5: the chat's starred messages, newest star first; a click jumps to the message. */
export function FavoritesList({ chatId, onJump }: { chatId: string; onJump: (messageId: string) => void }) {
  const favorites = useQuery({ queryKey: qk.chatFavorites(chatId), queryFn: () => api.chats.favorites(chatId) });
  if (favorites.isPending) return <p className="text-sm text-muted">Carregando…</p>;
  if (favorites.isError) return <p className="text-sm text-danger">Não foi possível carregar as favoritas.</p>;
  if (favorites.data.length === 0) return <p className="text-sm text-muted">Nenhuma mensagem favorita.</p>;
  return (
    <ul className="divide-y divide-border">
      {favorites.data.map((m) => (
        <li key={m.id}>
          <button type="button" onClick={() => onJump(m.id)} className="block w-full rounded px-1 py-2 text-left hover:bg-sidebar-hover">
            <span className="line-clamp-2 text-sm text-fg">{previewText(m.body, m.kind)}</span>
            <span className="mt-0.5 block text-xs text-muted">
              {shortDateTime(m.sentAt)}
              {m.favorite?.byName ? ` · por ${m.favorite.byName}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
