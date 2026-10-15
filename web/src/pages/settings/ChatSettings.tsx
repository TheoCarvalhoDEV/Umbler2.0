import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { ErrorText, Loading, Section, btnPrimary, field, send, useSend } from '../../components/settings/common';

export function ChatSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  if (!settings.data) return <Loading error={settings.error} />;
  return <ClosingMessageForm settings={settings.data} />;
}

function ClosingMessageForm({ settings }: { settings: SettingsDto }) {
  const [text, setText] = useState(settings.closingMessage);
  const save = useSend(qk.settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim() }));
  }

  return (
    <Section title="Conversas">
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm font-medium">
          Mensagem de encerramento
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={field} />
          <span className="mt-1 block text-xs font-normal text-muted">
            Enviada ao contato quando o atendente finaliza a conversa com a opção “Enviar mensagem de encerramento” marcada.
            Deixe em branco para não usar.
          </span>
        </label>
        <ErrorText error={save.error} />
        {save.isSuccess && <p className="text-sm text-success">Mensagem salva.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
