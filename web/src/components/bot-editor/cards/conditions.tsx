import { useState } from 'react';
import {
  RULE_OPERATOR_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  type ChatAgentConfig,
  type ChatChannelConfig,
  type ChatSectorConfig,
  type ConditionConfig,
  type ContactFieldConfig,
  type DistributeConfig,
  type HoursConfig,
  type HoursInterval,
  type MessageContainsConfig,
  type MultiConditionConfig,
  type TagsConfig,
  type TimeUnit,
  type ValueConfig,
  type WaitIntervalConfig,
  type Weekday,
  type WeekdaysConfig,
} from '@talk/shared';
import {
  Check,
  CheckList,
  Field,
  NumberInput,
  RemoveButton,
  RuleRow,
  RulesEditor,
  Select,
  TextInput,
  TimezoneInput,
  VarText,
  addBtn,
  channelItems,
  clampInt,
  control,
  entries,
  fieldItems,
  needsRight,
  newRule,
  sectorItems,
  tagItems,
  userItems,
  type FormProps,
} from './fields';

const WORKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const UNIT_LABELS: Record<TimeUnit, string> = { seconds: 'segundos', minutes: 'minutos', hours: 'horas', days: 'dias' };

export function WeekdaysForm({ config, onChange }: FormProps<WeekdaysConfig>) {
  return <TimezoneInput value={config.timezone} onChange={(timezone) => onChange({ ...config, timezone })} />;
}

export function HoursForm({ config, onChange }: FormProps<HoursConfig>) {
  const intervals = config.intervals ?? [];
  const setIntervals = (next: HoursInterval[]) => onChange({ ...config, intervals: next });
  const set = (i: number, patch: Partial<HoursInterval>) => setIntervals(intervals.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  function toggleDay(i: number, day: Weekday) {
    const { days, ...rest } = intervals[i]!;
    const current = days ?? WEEKDAYS;
    const next = WEEKDAYS.filter((d) => (d === day ? !current.includes(d) : current.includes(d)));
    if (next.length === 0) return; // an interval with no day would never match
    // every day = no `days` key (HoursInterval: absent = every day)
    setIntervals(intervals.map((it, j) => (j !== i ? it : next.length === WEEKDAYS.length ? rest : { ...rest, days: next })));
  }

  return (
    <div className="space-y-2">
      <TimezoneInput value={config.timezone} onChange={(timezone) => onChange({ ...config, timezone })} />
      {intervals.map((it, i) => (
        <div key={i} className="rounded border border-border p-2">
          <div className="flex items-center gap-1">
            <input type="time" aria-label={`Intervalo ${i + 1}: início`} value={it.from} onChange={(e) => set(i, { from: e.target.value })} className={control} />
            <span className="text-xs text-muted">até</span>
            <input type="time" aria-label={`Intervalo ${i + 1}: fim`} value={it.to} onChange={(e) => set(i, { to: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover intervalo ${i + 1}`}
              disabled={intervals.length === 1}
              onClick={() => setIntervals(intervals.filter((_, j) => j !== i))}
            />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            {WEEKDAYS.map((d) => (
              <label key={d} className="flex items-center gap-0.5 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Intervalo ${i + 1}: ${WEEKDAY_LABELS[d]}`}
                  checked={(it.days ?? WEEKDAYS).includes(d)}
                  onChange={() => toggleDay(i, d)}
                />
                {WEEKDAY_LABELS[d].slice(0, 3)}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        onClick={() => setIntervals([...intervals, { from: '08:00', to: '18:00', days: [...WORKDAYS] }])}
      >
        Adicionar intervalo
      </button>
      <p className="text-xs text-muted">O horário final não entra: 08:00 até 12:00 vale até 11:59.</p>
    </div>
  );
}

export function WaitIntervalForm({ config, onChange, catalog }: FormProps<WaitIntervalConfig>) {
  function setMode(mode: WaitIntervalConfig['mode']) {
    const { variable, ...rest } = config;
    onChange(mode === 'variable' ? { ...rest, mode, variable: variable ?? '' } : { ...rest, mode });
  }
  return (
    <div className="space-y-2">
      <Select
        label="Esperar"
        value={config.mode}
        options={[
          ['fixed', 'Um tempo fixo'],
          ['variable', 'O número de uma variável'],
        ]}
        onChange={(v) => v && setMode(v)}
      />
      {config.mode === 'fixed' ? (
        <NumberInput label="Quantidade" value={config.amount} min={1} onChange={(amount) => onChange({ ...config, amount })} />
      ) : (
        <VarText
          label="Variável com o número"
          rows={1}
          value={config.variable ?? ''}
          placeholder="{{contexto.prazo}}"
          onChange={(variable) => onChange({ ...config, variable })}
          catalog={catalog}
        />
      )}
      <Select label="Unidade" value={config.unit} options={entries(UNIT_LABELS)} onChange={(unit) => unit && onChange({ ...config, unit })} />
      <Check
        label="Continuar antes se o contato responder"
        checked={config.resumeOnReply}
        onChange={(resumeOnReply) => onChange({ ...config, resumeOnReply })}
      />
    </div>
  );
}

export function ConditionForm({ config, onChange, catalog }: FormProps<ConditionConfig>) {
  return <RulesEditor prefix="" logic={config.logic} rules={config.rules} catalog={catalog} onChange={(next) => onChange({ ...config, ...next })} />;
}

export function MultiConditionForm({ config, onChange, catalog }: FormProps<MultiConditionConfig>) {
  const cases = config.cases ?? [];
  const setCase = (i: number, patch: Partial<MultiConditionConfig['cases'][number]>) =>
    onChange({ ...config, cases: cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div className="space-y-2">
      {cases.map((c, i) => (
        <div key={i} className="space-y-1 rounded border border-border p-2">
          <div className="flex items-center gap-1">
            <input aria-label={`Caso ${i + 1}: nome`} value={c.label} maxLength={40} onChange={(e) => setCase(i, { label: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover caso ${i + 1}`}
              disabled={cases.length === 1}
              onClick={() => onChange({ ...config, cases: cases.filter((_, j) => j !== i) })}
            />
          </div>
          <RulesEditor prefix={`Caso ${i + 1} · `} logic={c.logic} rules={c.rules} catalog={catalog} onChange={(next) => setCase(i, next)} />
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        disabled={cases.length >= 20}
        onClick={() => onChange({ ...config, cases: [...cases, { label: `Caso ${cases.length + 1}`, logic: 'and', rules: [newRule()] }] })}
      >
        Adicionar caso
      </button>
      <p className="text-xs text-muted">Segue o primeiro caso verdadeiro; se nenhum for, sai por “Senão”.</p>
    </div>
  );
}

export function ValueForm({ config, onChange, catalog }: FormProps<ValueConfig>) {
  return <RuleRow label="Regra" rule={config} onChange={onChange} catalog={catalog} />;
}

export function DistributeForm({ config, onChange }: FormProps<DistributeConfig>) {
  const branches = config.branches ?? [];
  const total = branches.reduce((sum, b) => sum + b.weight, 0) || 1;
  const set = (i: number, patch: Partial<DistributeConfig['branches'][number]>) =>
    onChange({ ...config, branches: branches.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  return (
    <div className="space-y-1">
      {branches.map((b, i) => (
        <div key={i} className="flex items-center gap-1">
          <input aria-label={`Caminho ${i + 1}: nome`} value={b.label} maxLength={40} onChange={(e) => set(i, { label: e.target.value })} className={control} />
          <input
            type="number"
            aria-label={`Caminho ${i + 1}: peso`}
            min={1}
            step={1}
            value={b.weight}
            onChange={(e) => set(i, { weight: clampInt(e.target.value, 1) })}
            className={`${control} w-16 shrink-0`}
          />
          <span className="w-10 shrink-0 text-right text-xs text-muted">{Math.round((b.weight / total) * 100)}%</span>
          <RemoveButton
            label={`Remover caminho ${i + 1}`}
            disabled={branches.length <= 2}
            onClick={() => onChange({ ...config, branches: branches.filter((_, j) => j !== i) })}
          />
        </div>
      ))}
      <button
        type="button"
        className={addBtn}
        disabled={branches.length >= 10}
        onClick={() => onChange({ ...config, branches: [...branches, { label: String.fromCharCode(65 + branches.length), weight: 1 }] })}
      >
        Adicionar caminho
      </button>
    </div>
  );
}

export function ContactFieldForm({ config, onChange, catalog }: FormProps<ContactFieldConfig>) {
  return (
    <div className="space-y-2">
      <Select
        label="Campo"
        value={config.fieldId}
        placeholder="Escolha o campo…"
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(fieldId) => onChange({ ...config, fieldId })}
      />
      <Select
        label="Condição"
        value={config.operator}
        options={entries(RULE_OPERATOR_LABELS)}
        onChange={(operator) => operator && onChange({ ...config, operator })}
      />
      {needsRight(config.operator) && <TextInput label="Valor" value={config.value} onChange={(value) => onChange({ ...config, value })} />}
    </div>
  );
}

const TAG_MODES: Record<TagsConfig['mode'], string> = {
  any: 'Tem alguma destas etiquetas',
  all: 'Tem todas estas etiquetas',
  none: 'Não tem nenhuma destas etiquetas',
};

export function TagsForm({ config, onChange, catalog }: FormProps<TagsConfig>) {
  return (
    <div className="space-y-2">
      <Select label="Regra" value={config.mode} options={entries(TAG_MODES)} onChange={(mode) => mode && onChange({ ...config, mode })} />
      <CheckList label="Etiquetas" items={tagItems(catalog)} selected={config.tagIds} onChange={(tagIds) => onChange({ ...config, tagIds })} />
    </div>
  );
}

export function ChatSectorForm({ config, onChange, catalog }: FormProps<ChatSectorConfig>) {
  return <CheckList label="Setores" items={sectorItems(catalog)} selected={config.sectorIds} onChange={(sectorIds) => onChange({ ...config, sectorIds })} />;
}

export function ChatChannelForm({ config, onChange, catalog }: FormProps<ChatChannelConfig>) {
  return (
    <CheckList label="Canais" items={channelItems(catalog)} selected={config.channelIds} onChange={(channelIds) => onChange({ ...config, channelIds })} />
  );
}

const AGENT_MODES: Record<ChatAgentConfig['mode'], string> = {
  none: 'Sem atendente',
  any: 'Com qualquer atendente',
  specific: 'Com um destes atendentes',
};

export function ChatAgentForm({ config, onChange, catalog }: FormProps<ChatAgentConfig>) {
  return (
    <div className="space-y-2">
      <Select label="A conversa está" value={config.mode} options={entries(AGENT_MODES)} onChange={(mode) => mode && onChange({ ...config, mode })} />
      {config.mode === 'specific' && (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      )}
    </div>
  );
}

export function MessageContainsForm({ config, onChange }: FormProps<MessageContainsConfig>) {
  // keep the text as typed (blank lines included) so Enter works; store only the non-empty trimmed lines
  const [text, setText] = useState(() => (config.keywords ?? []).join('\n'));
  return (
    <div className="space-y-2">
      <Field label="Palavras ou frases" hint="Uma por linha. Maiúsculas e acentos não importam.">
        <textarea
          aria-label="Palavras ou frases"
          rows={3}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange({ ...config, keywords: e.target.value.split('\n').map((k) => k.trim()).filter(Boolean) });
          }}
          className={control}
        />
      </Field>
      <Select
        label="A mensagem precisa ter"
        value={config.match}
        options={[
          ['any', 'Qualquer uma delas'],
          ['all', 'Todas elas'],
        ]}
        onChange={(match) => match && onChange({ ...config, match })}
      />
    </div>
  );
}
