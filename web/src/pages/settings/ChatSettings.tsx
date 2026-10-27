import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RETURNING_CONTACT_DAYS, type BotRunningBehavior, type ReturningContactDto, type SettingsDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { field, fieldArea, fieldSelect } from '../../components/ui';
import { Loading, PageHeader, SaveBar, SettingRow, SettingsSection, Switch, send, useSend } from '../../components/settings/common';

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
  const [returning, setReturning] = useState<ReturningContactDto>(settings.returningContact);
  const textId = useId();
  const behaviorId = useId();
  const daysId = useId();
  const save = useSend(qk.settings);
  const dirty =
    text.trim() !== settings.closingMessage.trim() ||
    behavior !== settings.botRunningBehavior ||
    returning.enabled !== settings.returningContact.enabled ||
    returning.days !== settings.returningContact.days;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() =>
      send('/api/settings', 'PUT', { ...settings, closingMessage: text.trim(), botRunningBehavior: behavior, returningContact: returning }),
    );
  }

  function discard() {
    setText(settings.closingMessage);
    setBehavior(settings.botRunningBehavior);
    setReturning(settings.returningContact);
    save.reset();
  }

  return (
    <>
      <PageHeader
        title="Conversas"
        description="Para onde vai o cliente que volta, como uma conversa termina e o que acontece quando o atendente escreve com um chatbot rodando."
      />
      <form onSubmit={submit}>
        <SettingsSection title="Cliente que volta">
          <SettingRow
            label="Cliente que volta vai direto para o último atendimento"
            description="Quando um cliente escreve de novo depois de a conversa ser finalizada, a conversa nova abre no mesmo setor e com o mesmo atendente da última, sem chatbot e sem triagem. Se o atendente estiver inativo, ela fica no setor, sem atendente. Conversas que ficaram no setor padrão sem atendente não contam."
            control={
              <Switch
                label="Cliente que volta vai direto para o último atendimento"
                checked={returning.enabled}
                onChange={(enabled) => setReturning((r) => ({ ...r, enabled }))}
              />
            }
          />
          <SettingRow
            label="Até quantos dias depois de finalizada"
            htmlFor={daysId}
            description="Depois desse prazo, o cliente passa pelo chatbot ou pela triagem como um cliente novo."
            control={
              <div className="w-40 max-w-full">
                <input
                  id={daysId}
                  type="number"
                  required
                  step={1}
                  min={RETURNING_CONTACT_DAYS.min}
                  max={RETURNING_CONTACT_DAYS.max}
                  disabled={!returning.enabled}
                  value={returning.days}
                  onChange={(e) => setReturning((r) => ({ ...r, days: Number(e.target.value) }))}
                  className={field}
                />
              </div>
            }
          />
        </SettingsSection>
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
