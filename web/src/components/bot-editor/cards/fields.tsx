import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TrashIcon } from '@phosphor-icons/react';
import { NATIVE_CONTACT_FIELDS, RULE_OPERATOR_LABELS, type Logic, type Operand, type Rule, type RuleOperator } from '@talk/shared';
import { FIXED_VARIABLES, insertAtCursor } from '../../settings/QuickAnswerForm';
import type { EditorCatalog } from '../useEditorCatalog';

/** Props of every config form. `config` is already merged over defaultConfig(type). */
export interface FormProps<C> {
  config: C;
  onChange(next: C): void;
  catalog: EditorCatalog;
}
export interface Item {
  id: string;
  label: string;
}

export const control = 'w-full rounded border border-border bg-surface px-2 py-1 text-sm';
export const addBtn = 'rounded border border-border px-2 py-1 text-xs hover:bg-sidebar-hover disabled:opacity-50';

export const entries = <V extends string>(r: Record<V, string>) => Object.entries(r) as Array<[V, string]>;
export const sectorItems = (c: EditorCatalog): Item[] => c.sectors.map((s) => ({ id: s.id, label: s.name }));
export const userItems = (c: EditorCatalog): Item[] => c.users.filter((u) => u.active).map((u) => ({ id: u.id, label: u.name }));
export const tagItems = (c: EditorCatalog): Item[] => c.tags.map((t) => ({ id: t.id, label: t.emoji ? `${t.emoji} ${t.name}` : t.name }));
export const channelItems = (c: EditorCatalog): Item[] => c.channels.map((ch) => ({ id: ch.id, label: ch.name }));
/** Native contact fields first, then the custom ones; ids are what configs store (NativeFieldId or custom field id). */
export const fieldItems = (c: EditorCatalog): Item[] => [
  ...NATIVE_CONTACT_FIELDS.map((f) => ({ id: f.id as string, label: f.label })),
  ...c.customFields.map((f) => ({ id: f.id, label: f.name })),
];
const pairs = (items: Item[]) => items.map((i) => [i.id, i.label] as const);

/** Whole number clamped to [min, max]; empty or junk input becomes `min`. */
export function clampInt(raw: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.trunc(Number(raw));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="block text-xs font-medium text-muted">{label}</span>
      <div className="mt-0.5">{children}</div>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Select<V extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  placeholder,
  allowEmpty = false,
}: {
  label: string;
  hint?: string;
  value: V | '';
  options: ReadonlyArray<readonly [V, string]>;
  onChange(v: V | ''): void;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as V | '')} className={control}>
        {placeholder !== undefined && (
          <option value="" disabled={!allowEmpty}>
            {placeholder}
          </option>
        )}
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function TextInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      <input aria-label={label} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} className={control} />
    </Field>
  );
}

export function NumberInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max?: number; onChange(v: number): void }) {
  return (
    <Field label={label}>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(clampInt(e.target.value, min, max))}
        className={control}
      />
    </Field>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function RemoveButton({ label, onClick, disabled = false }: { label: string; onClick(): void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Remover"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded p-1 text-muted hover:bg-danger/15 hover:text-danger disabled:opacity-30"
    >
      <TrashIcon size={14} />
    </button>
  );
}

/** Checkbox list of ids. The result keeps the catalog order; ids missing from the catalog are dropped on the next check. */
export function CheckList({
  label,
  items,
  selected,
  onChange,
  hint,
}: {
  label: string;
  items: Item[];
  selected: string[];
  onChange(next: string[]): void;
  hint?: string;
}) {
  function toggle(id: string, on: boolean) {
    onChange(on ? items.filter((it) => it.id === id || selected.includes(it.id)).map((it) => it.id) : selected.filter((x) => x !== id));
  }
  return (
    <fieldset>
      <legend className="text-xs font-medium text-muted">{label}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-muted">Nada cadastrado ainda.</p>
      ) : (
        <div className="mt-0.5 max-h-40 space-y-0.5 overflow-y-auto">
          {items.map((it) => (
            // w-fit: only the checkbox and its text toggle, not a click anywhere across the node card
            <label key={it.id} className="flex w-fit items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.includes(it.id)} onChange={(e) => toggle(it.id, e.target.checked)} />
              {it.label}
            </label>
          ))}
        </div>
      )}
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </fieldset>
  );
}

/** Text with variables: a textarea plus "Inserir variável" chips that insert {{…}} at the cursor. */
export function VarText({
  label,
  value,
  onChange,
  catalog,
  rows = 3,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  catalog: EditorCatalog;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  // after an insert, put the caret right after the variable so typing continues there
  useLayoutEffect(() => {
    const el = ref.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });

  const variables: Array<readonly [string, string]> = [
    ...FIXED_VARIABLES,
    ...catalog.customFields.map((f) => [`campo.${f.name}`, `Campo: ${f.name}`] as const),
  ];

  function insert(variable: string) {
    const el = ref.current;
    if (!el) return;
    const result = insertAtCursor(el.value, el.selectionStart, el.selectionEnd, `{{${variable}}}`);
    caret.current = result.caret;
    onChange(result.text);
  }

  return (
    <Field label={label} hint={hint}>
      <textarea
        ref={ref}
        aria-label={label}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={control}
      />
      <button
        type="button"
        aria-label={`Inserir variável em ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-primary hover:underline"
      >
        Inserir variável
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap gap-1">
          {variables.map(([variable, text]) => (
            <button
              key={variable}
              type="button"
              title={`{{${variable}}}`}
              // keep the textarea focused so its selection is not lost
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(variable)}
              className="rounded-full border border-border px-2 py-0.5 text-xs hover:bg-sidebar-hover"
            >
              {text}
            </button>
          ))}
          <p className="w-full text-xs text-muted">
            Resposta de um bloco: {'{{contexto.nome_do_bloco}}'}; texto original: {'{{contexto.nome_do_bloco:raw}}'}.
          </p>
        </div>
      )}
    </Field>
  );
}

const TIME_ZONES = Intl.supportedValuesOf('timeZone');

export function TimezoneInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  const listId = useId();
  return (
    <Field label="Fuso horário" hint="Padrão: America/Cuiaba (Mato Grosso).">
      <input aria-label="Fuso horário" list={listId} value={value} onChange={(e) => onChange(e.target.value.trim())} className={control} />
      <datalist id={listId}>
        {TIME_ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
    </Field>
  );
}

// ---------- rules ----------
export const newRule = (): Rule => ({ left: { kind: 'var', value: '' }, operator: 'eq', right: { kind: 'literal', value: '' } });
export const needsRight = (op: RuleOperator) => op !== 'empty' && op !== 'not_empty';
const OPERAND_KINDS: Record<Operand['kind'], string> = { var: 'Resposta de bloco', field: 'Campo do contato', literal: 'Texto' };

function OperandInput({ label, operand, onChange, catalog }: { label: string; operand: Operand; onChange(o: Operand): void; catalog: EditorCatalog }) {
  return (
    <div className="flex gap-1">
      <select
        aria-label={`${label}: tipo`}
        value={operand.kind}
        onChange={(e) => onChange({ kind: e.target.value as Operand['kind'], value: '' })}
        className={`${control} w-32 shrink-0`}
      >
        {entries(OPERAND_KINDS).map(([k, text]) => (
          <option key={k} value={k}>
            {text}
          </option>
        ))}
      </select>
      {operand.kind === 'field' ? (
        <select aria-label={`${label}: valor`} value={operand.value} onChange={(e) => onChange({ kind: 'field', value: e.target.value })} className={control}>
          <option value="" disabled>
            Escolha o campo…
          </option>
          {pairs(fieldItems(catalog)).map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={`${label}: valor`}
          value={operand.value}
          placeholder={operand.kind === 'var' ? 'nome do bloco (ex.: menu)' : 'texto ou {{variável}}'}
          onChange={(e) => onChange({ kind: operand.kind, value: e.target.value })}
          className={control}
        />
      )}
    </div>
  );
}

export function RuleRow({ label, rule, onChange, catalog }: { label: string; rule: Rule; onChange(r: Rule): void; catalog: EditorCatalog }) {
  function setOperator(operator: RuleOperator) {
    const { right, ...rest } = rule;
    onChange(needsRight(operator) ? { ...rest, operator, right: right ?? { kind: 'literal', value: '' } } : { ...rest, operator });
  }
  return (
    <div className="space-y-1">
      <OperandInput label={`${label}: esquerda`} operand={rule.left} onChange={(left) => onChange({ ...rule, left })} catalog={catalog} />
      <select aria-label={`${label}: operador`} value={rule.operator} onChange={(e) => setOperator(e.target.value as RuleOperator)} className={control}>
        {entries(RULE_OPERATOR_LABELS).map(([op, text]) => (
          <option key={op} value={op}>
            {text}
          </option>
        ))}
      </select>
      {needsRight(rule.operator) && (
        <OperandInput
          label={`${label}: direita`}
          operand={rule.right ?? { kind: 'literal', value: '' }}
          onChange={(right) => onChange({ ...rule, right })}
          catalog={catalog}
        />
      )}
    </div>
  );
}

/** At least one rule; the and/or select appears once there are two or more. `prefix` makes labels unique ("Caso 1 · "). */
export function RulesEditor({
  prefix,
  logic,
  rules,
  onChange,
  catalog,
}: {
  prefix: string;
  logic: Logic;
  rules: Rule[];
  onChange(next: { logic: Logic; rules: Rule[] }): void;
  catalog: EditorCatalog;
}) {
  const list = rules ?? []; // an imported graph may lack the array
  const setRule = (i: number, r: Rule) => onChange({ logic, rules: list.map((x, j) => (j === i ? r : x)) });
  return (
    <div className="space-y-2">
      {list.length > 1 && (
        <select
          aria-label={`${prefix}Combinar regras`}
          value={logic}
          onChange={(e) => onChange({ logic: e.target.value as Logic, rules: list })}
          className={control}
        >
          <option value="and">Todas as regras valem (E)</option>
          <option value="or">Qualquer regra vale (OU)</option>
        </select>
      )}
      {list.map((r, i) => (
        <div key={i} className="rounded border border-border p-2">
          <div className="mb-1 flex items-center justify-between text-xs text-muted">
            <span>Regra {i + 1}</span>
            <RemoveButton
              label={`${prefix}Remover regra ${i + 1}`}
              disabled={list.length === 1}
              onClick={() => onChange({ logic, rules: list.filter((_, j) => j !== i) })}
            />
          </div>
          <RuleRow label={`${prefix}Regra ${i + 1}`} rule={r} onChange={(next) => setRule(i, next)} catalog={catalog} />
        </div>
      ))}
      <button type="button" aria-label={`${prefix}Adicionar regra`} className={addBtn} onClick={() => onChange({ logic, rules: [...list, newRule()] })}>
        Adicionar regra
      </button>
    </div>
  );
}
