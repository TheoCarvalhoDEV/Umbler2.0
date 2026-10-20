import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotRunningBehavior, SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { fieldArea, fieldLabel, fieldSelect } from '../../components/ui';
import { ErrorText, Loading, Section, btnPrimary, hint, okText, send, useSend } from '../../components/settings/common';

const BEHAVIORS: Array<{ value: BotRunningBehavior; label: string }> = [
  { value: 'ask', label: 'Perguntar' },
  { value: 'stop', label: 'Parar o bot' },
  { value: 'keep', label: 'Manter rodando' },
];

export function ChatSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  if (!settings.data) return <Loading error={settings.error} />;
  return <ChatSettingsForm settings={settings.data} />;
}

function ChatSettingsForm({ settings }: { settings: SettingsDto }) {
  const [text, setText] = useState(settings.closingMessage);
  const [behavior, setBehavior] = useState<BotRunningBehavior>(settings.botRunningBehavior);
  const behaviorId = useId();
  const save = useSend(qk.settings);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim(), botRunningBehavior: behavior }));
  }

  return (
    <Section title="Conversas">
      <form onSubmit={submit} className="space-y-5">
        <label className="block">
          <span className={fieldLabel}>Mensagem de encerramento</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={fieldArea} />
          <span className={hint}>
            Enviada ao contato quando o atendente finaliza a conversa com a opção “Enviar mensagem de encerramento” marcada.
            Deixe em branco para não usar.
          </span>
        </label>
        <div>
          <label htmlFor={behaviorId} className={fieldLabel}>
            Quando o atendente enviar mensagem com chatbot em execução
          </label>
          <select
            id={behaviorId}
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as BotRunningBehavior)}
            className={fieldSelect}
          >
            {BEHAVIORS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
          <span className={hint}>
            Perguntar mostra um aviso antes de enviar. Parar o bot encerra o chatbot e envia. Manter rodando envia e deixa o
            chatbot continuar. A mesma regra vale para transferências feitas pelo atendente.
          </span>
        </div>
        <ErrorText error={save.error} />
        {save.isSuccess && <p className={okText}>Configurações salvas.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
