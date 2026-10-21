import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CLOSE_INACTIVE_HOURS, RETURN_TO_QUEUE_MINUTES, type AutoRulesDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { checkbox, field, fieldLabel } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnPrimary, hint, okText, useSend } from '../../components/settings/common';

// under a checkbox's text: the 18px box plus the 12px gap. Outside the <label>, so the label stays the rule's name.
const checkHint = `${hint} pl-[30px]`;
const numberField = `${field} max-w-40`;

export function AutoRulesSettings() {
  const rules = useQuery({ queryKey: qk.autoRules, queryFn: api.settings.autoRules.get });
  if (!rules.data) return <Loading error={rules.error} />;
  return <AutoRulesForm rules={rules.data} />;
}

/** Spec 2026-10-20 agendamentos §4: both rules, off until an admin turns them on; the server checks the limits too. */
function AutoRulesForm({ rules }: { rules: AutoRulesDto }) {
  const [form, setForm] = useState(rules);
  const save = useSend(qk.autoRules);
  const setReturn = (patch: Partial<AutoRulesDto['returnToQueue']>) =>
    setForm((f) => ({ ...f, returnToQueue: { ...f.returnToQueue, ...patch } }));
  const setClose = (patch: Partial<AutoRulesDto['closeInactive']>) =>
    setForm((f) => ({ ...f, closeInactive: { ...f.closeInactive, ...patch } }));

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(() => api.settings.autoRules.put(form));
  }

  return (
    <Section title="Regras automáticas">
      <form onSubmit={submit} className="space-y-5">
        <fieldset className={`${block} space-y-4`}>
          <div>
            <label className="flex cursor-pointer items-center gap-3 text-sm font-bold">
              <input
                type="checkbox"
                checked={form.returnToQueue.enabled}
                onChange={(e) => setReturn({ enabled: e.target.checked })}
                className={checkbox}
              />
              Devolver à fila conversas paradas
            </label>
            <p className={checkHint}>
              Quando o contato espera resposta há mais tempo que o limite, a conversa perde o atendente e volta para “Sem
              atendente” no mesmo setor. Quem assume a conversa ganha o prazo inteiro. Não vale para conversas privadas, em
              triagem ou com chatbot em execução.
            </p>
          </div>
          <label className="block">
            <span className={fieldLabel}>Minutos sem resposta</span>
            <input
              type="number"
              required
              step={1}
              min={RETURN_TO_QUEUE_MINUTES.min}
              max={RETURN_TO_QUEUE_MINUTES.max}
              value={form.returnToQueue.minutes}
              onChange={(e) => setReturn({ minutes: Number(e.target.value) })}
              className={numberField}
            />
          </label>
        </fieldset>

        <fieldset className={`${block} space-y-4`}>
          <div>
            <label className="flex cursor-pointer items-center gap-3 text-sm font-bold">
              <input
                type="checkbox"
                checked={form.closeInactive.enabled}
                onChange={(e) => setClose({ enabled: e.target.checked })}
                className={checkbox}
              />
              Finalizar por inatividade
            </label>
            <p className={checkHint}>
              Quando o escritório falou por último e ninguém escreveu dentro do limite, a conversa é finalizada. Não vale para
              conversas em triagem, com chatbot em execução ou com mensagem agendada pendente.
            </p>
          </div>
          <label className="block">
            <span className={fieldLabel}>Horas sem mensagens</span>
            <input
              type="number"
              required
              step={1}
              min={CLOSE_INACTIVE_HOURS.min}
              max={CLOSE_INACTIVE_HOURS.max}
              value={form.closeInactive.hours}
              onChange={(e) => setClose({ hours: Number(e.target.value) })}
              className={numberField}
            />
          </label>
          <div>
            <label className="flex cursor-pointer items-center gap-3 text-sm font-semibold">
              <input
                type="checkbox"
                checked={form.closeInactive.sendClosingMessage}
                onChange={(e) => setClose({ sendClosingMessage: e.target.checked })}
                className={checkbox}
              />
              Enviar a mensagem de encerramento
            </label>
            <p className={checkHint}>Usa a mensagem de Configurações → Conversas.</p>
          </div>
        </fieldset>

        <ErrorText error={save.error} />
        {save.isSuccess && <p className={okText}>Regras salvas.</p>}
        <button type="submit" disabled={save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
