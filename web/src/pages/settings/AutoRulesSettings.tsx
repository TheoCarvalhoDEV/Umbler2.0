import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CLOSE_INACTIVE_HOURS, RETURN_TO_QUEUE_MINUTES, type AutoRulesDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { field } from '../../components/ui';
import { Loading, PageHeader, SaveBar, SettingRow, SettingsSection, Switch, useSend } from '../../components/settings/common';

export function AutoRulesSettings() {
  const rules = useQuery({ queryKey: qk.autoRules, queryFn: api.settings.autoRules.get });
  if (!rules.data) return <Loading error={rules.error} />;
  return <AutoRulesForm rules={rules.data} />;
}

/** Spec 2026-10-20 agendamentos §4: both rules, off until an admin turns them on; the server checks the limits too. */
function AutoRulesForm({ rules }: { rules: AutoRulesDto }) {
  const [form, setForm] = useState(rules);
  const minutesId = useId();
  const hoursId = useId();
  const save = useSend(qk.autoRules);
  const dirty = JSON.stringify(form) !== JSON.stringify(rules);
  const setReturn = (patch: Partial<AutoRulesDto['returnToQueue']>) =>
    setForm((f) => ({ ...f, returnToQueue: { ...f.returnToQueue, ...patch } }));
  const setClose = (patch: Partial<AutoRulesDto['closeInactive']>) =>
    setForm((f) => ({ ...f, closeInactive: { ...f.closeInactive, ...patch } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => api.settings.autoRules.put(form));
  }

  function discard() {
    setForm(rules);
    save.reset();
  }

  return (
    <>
      <PageHeader title="Regras automáticas" description="O sistema mexe nas conversas sozinho quando ninguém responde. As duas regras começam desligadas." />
      <form onSubmit={submit}>
        <SettingsSection title="Fila">
          <SettingRow
            label="Devolver à fila conversas paradas"
            description="Quando o contato espera resposta há mais tempo que o limite, a conversa perde o atendente e volta para “Sem atendente” no mesmo setor. Quem assume a conversa ganha o prazo inteiro. Não vale para conversas privadas, em triagem ou com chatbot em execução."
            control={<Switch label="Devolver à fila conversas paradas" checked={form.returnToQueue.enabled} onChange={(enabled) => setReturn({ enabled })} />}
          />
          <SettingRow
            label="Minutos sem resposta"
            htmlFor={minutesId}
            control={
              <div className="w-40 max-w-full">
                <input
                  id={minutesId}
                  type="number"
                  required
                  step={1}
                  min={RETURN_TO_QUEUE_MINUTES.min}
                  max={RETURN_TO_QUEUE_MINUTES.max}
                  value={form.returnToQueue.minutes}
                  onChange={(e) => setReturn({ minutes: Number(e.target.value) })}
                  className={field}
                />
              </div>
            }
          />
        </SettingsSection>
        <SettingsSection title="Encerramento">
          <SettingRow
            label="Finalizar por inatividade"
            description="Quando o escritório falou por último e ninguém escreveu dentro do limite, a conversa é finalizada. Não vale para conversas em triagem, com chatbot em execução ou com mensagem agendada pendente."
            control={<Switch label="Finalizar por inatividade" checked={form.closeInactive.enabled} onChange={(enabled) => setClose({ enabled })} />}
          />
          <SettingRow
            label="Horas sem mensagens"
            htmlFor={hoursId}
            control={
              <div className="w-40 max-w-full">
                <input
                  id={hoursId}
                  type="number"
                  required
                  step={1}
                  min={CLOSE_INACTIVE_HOURS.min}
                  max={CLOSE_INACTIVE_HOURS.max}
                  value={form.closeInactive.hours}
                  onChange={(e) => setClose({ hours: Number(e.target.value) })}
                  className={field}
                />
              </div>
            }
          />
          <SettingRow
            label="Enviar a mensagem de encerramento"
            description="Usa a mensagem de Ajustes → Conversas."
            control={
              <Switch
                label="Enviar a mensagem de encerramento"
                checked={form.closeInactive.sendClosingMessage}
                onChange={(sendClosingMessage) => setClose({ sendClosingMessage })}
              />
            }
          />
        </SettingsSection>
        <SaveBar dirty={dirty} saving={save.isPending} onDiscard={discard} error={save.error} saved={save.isSuccess} />
      </form>
    </>
  );
}
