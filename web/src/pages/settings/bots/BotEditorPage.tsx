import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';
import { api, qk } from '../../../lib/api';
import { useCurrentUser } from '../../../lib/auth';
import { Loading } from '../../../components/settings/common';
import { BotEditor } from '../../../components/bot-editor/BotEditor';

/** `/configuracoes/chatbots/:id`, full screen outside AppLayout. Admin only (the API answers 403 anyway). */
export function BotEditorPage() {
  const { id = '' } = useParams();
  return <EditorLoader key={id} id={id} />; // a different bot id remounts with fresh state
}

function EditorLoader({ id }: { id: string }) {
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const bot = useQuery({ queryKey: qk.bot(id), queryFn: () => api.bots.get(id), enabled: isAdmin });
  // Freeze the version number seen on first load: saving bumps latestVersionNumber, and a new
  // query key would drop version.data for a moment and unmount the editor with its undo history.
  const [n, setN] = useState<number | null>(null);
  if (n === null && bot.data) setN(bot.data.latestVersionNumber);
  const version = useQuery({
    queryKey: qk.botVersion(id, n ?? 0),
    queryFn: () => api.bots.version(id, n ?? 0),
    enabled: isAdmin && n !== null,
    staleTime: Infinity, // versions are immutable
  });

  if (!isAdmin) return <Navigate to="/configuracoes/perfil" replace />;
  if (!bot.data || !version.data) {
    return (
      <div className="grid h-dvh place-items-center bg-surface p-6">
        <Loading error={bot.error ?? version.error} />
      </div>
    );
  }
  return <BotEditor bot={bot.data} initial={version.data} />;
}
