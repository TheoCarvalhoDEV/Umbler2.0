import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BotRunningBehavior, SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { fieldArea, fieldSelect } from '../../components/ui';
import { Loading, PageHeader, SaveBar, SettingRow, SettingsSection, send, useSend } from '../../components/settings/common';

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
  const textId = useId();
  const behaviorId = useId();
  const save = useSend(qk.settings);
  const dirty = text.trim() !== settings.closingMessage.trim() || behavior !== settings.botRunningBehavior;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim(), botRunningBehavior: behavior }));
  }

  function discard() {
    setText(settings.closingMessage);
    setBehavior(settings.botRunningBehavior);
    save.reset();
  }

  return (
    <>
      <PageHeader title="Conversas" description="Como uma conversa termina e o que acontece quando o atendente escreve com um chatbot rodando." />
      <form onSubmit={submit}>
        <SettingsSection title="Encerramento">
          <SettingRow
            wide
            label="Mensagem de encerramento"
            htmlFor={textId}
            description="Enviada ao contato quando o atendente finaliza a conversa com a opção “Enviar mensagem de encerramento” marcada. Deixe em branco para não usar."
            control={<textarea id={textId} rows={4} value={text} onChange={(e) => setText(e.target.value)} className={fieldArea} />}
          />
        </SettingsSection>
        <SettingsSection title="Chatbots">
          <SettingRow
            label="Quando o atendente enviar mensagem com chatbot em execução"
            htmlFor={behaviorId}
            description="Perguntar mostra um aviso antes de enviar. Parar o bot encerra o chatbot e envia. Manter rodando envia e deixa o chatbot continuar. A mesma regra vale para transferências feitas pelo atendente."
            control={
              <div className="w-56 max-w-full">
                <select id={behaviorId} value={behavior} onChange={(e) => setBehavior(e.target.value as BotRunningBehavior)} className={fieldSelect}>
                  {BEHAVIORS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
            }
          />
        </SettingsSection>
        <SaveBar dirty={dirty} saving={save.isPending} onDiscard={discard} error={save.error} saved={save.isSuccess} />
      </form>
    </>
  );
}
