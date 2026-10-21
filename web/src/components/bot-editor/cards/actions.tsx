import { useRef, useState } from 'react';
import type {
  AskChoiceConfig,
  AskInputConfig,
  BotDto,
  CallFlowConfig,
  CloseChatConfig,
  EditTagsConfig,
  InputValidator,
  MediaType,
  NoteConfig,
  NotifyAgentConfig,
  PrivacyConfig,
  SendMessageConfig,
  SetContactFieldConfig,
  TransferAgentConfig,
  TransferSectorConfig,
} from '@talk/shared';
import { api } from '../../../lib/api';
import { fieldHint, fieldLabel } from '../../ui';
import {
  Check,
  CheckList,
  Field,
  NumberInput,
  RemoveButton,
  Select,
  VarText,
  addBtn,
  control,
  entries,
  fieldItems,
  sectorItems,
  tagItems,
  userItems,
  type FormProps,
} from './fields';

export function SendMessageForm({ config, onChange, catalog }: FormProps<SendMessageConfig>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the upload is async: merge into the config current when it finishes, not the one when it started
  const latest = useRef(config);
  latest.current = config;

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const attachment = await api.bots.uploadMedia(file, file.name);
      onChange({ ...latest.current, attachment });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível enviar o arquivo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Field label="Arquivo (opcional)" hint="Com arquivo, o texto vai como legenda. O chatbot não usa assinatura.">
        {config.attachment ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{config.attachment.name}</span>
            <RemoveButton label="Remover arquivo" onClick={() => onChange({ ...config, attachment: null })} />
          </div>
        ) : (
          <input
            type="file"
            aria-label="Arquivo"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
            className="block w-full text-xs text-muted file:mr-3 file:h-8 file:rounded-full file:border-0 file:bg-panel file:px-3 file:text-xs file:font-bold file:text-fg hover:file:bg-border"
          />
        )}
        {busy && <p className="mt-1.5 text-xs text-muted">Enviando…</p>}
        {error && (
          <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">
            {error}
          </p>
        )}
      </Field>
    </div>
  );
}

export function NoteForm({ config, onChange, catalog }: FormProps<NoteConfig>) {
  return (
    <VarText
      label="Nota"
      hint="Aparece na conversa só para a equipe."
      value={config.text}
      onChange={(text) => onChange({ ...config, text })}
      catalog={catalog}
    />
  );
}

type AskShared = { invalidText?: string; invalidRetries: number; timeoutHours?: number | null };

/** Fields shared by ask_choice and ask_input: invalid text, extra attempts and the optional timeout. */
function AskCommon<C extends AskShared>({ config, onChange, catalog, invalidPlaceholder }: FormProps<C> & { invalidPlaceholder: string }) {
  const hasTimeout = (config.timeoutHours ?? 0) > 0;
  return (
    <>
      <VarText
        label="Mensagem se a resposta for inválida"
        rows={2}
        value={config.invalidText ?? ''}
        placeholder={invalidPlaceholder}
        onChange={(invalidText) => onChange({ ...config, invalidText })}
        catalog={catalog}
      />
      <Select
        label="Tentativas extras"
        hint="Depois delas, segue pela saída “Resposta inválida”."
        value={String(config.invalidRetries)}
        options={[
          ['0', 'Não repetir'],
          ['1', '1 vez'],
          ['2', '2 vezes'],
          ['3', '3 vezes'],
        ]}
        onChange={(v) => onChange({ ...config, invalidRetries: Number(v) })}
      />
      <Check
        label="Limitar tempo de espera"
        checked={hasTimeout}
        onChange={(on) => onChange({ ...config, timeoutHours: on ? 24 : null })}
      />
      {hasTimeout && (
        <NumberInput
          label="Horas sem resposta"
          value={config.timeoutHours ?? 24}
          min={1}
          max={720}
          onChange={(timeoutHours) => onChange({ ...config, timeoutHours })}
        />
      )}
    </>
  );
}

export function AskChoiceForm({ config, onChange, catalog }: FormProps<AskChoiceConfig>) {
  const options = config.options ?? [];
  const set = (i: number, patch: Partial<AskChoiceConfig['options'][number]>) =>
    onChange({ ...config, options: options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  function add() {
    const next = Math.max(0, ...options.map((o) => Number.parseInt(o.key, 10) || 0)) + 1;
    onChange({ ...config, options: [...options, { key: String(next), label: '' }] });
  }

  return (
    <div className="space-y-3">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <fieldset>
        <legend className={fieldLabel}>Opções</legend>
        {options.map((o, i) => (
          <div key={i} className="mt-2 flex items-center gap-2">
            <input
              aria-label={`Opção ${i + 1}: número`}
              value={o.key}
              maxLength={10}
              onChange={(e) => set(i, { key: e.target.value.trim() })}
              className={`${control} basis-14 shrink-0`}
            />
            <input aria-label={`Opção ${i + 1}: texto`} value={o.label} maxLength={60} onChange={(e) => set(i, { label: e.target.value })} className={control} />
            <RemoveButton
              label={`Remover opção ${i + 1}`}
              disabled={options.length === 1}
              onClick={() => onChange({ ...config, options: options.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <p className={fieldHint}>O contato pode digitar o número ou o texto. Mudar o número desconecta a saída da opção.</p>
      </fieldset>
      <button type="button" className={addBtn} disabled={options.length >= 20} onClick={add}>
        Adicionar opção
      </button>
      <AskCommon config={config} onChange={onChange} catalog={catalog} invalidPlaceholder="Opção inválida." />
    </div>
  );
}

const VALIDATOR_LABELS: Record<InputValidator, string> = {
  any: 'Qualquer resposta',
  email: 'E-mail',
  phone: 'Telefone (Brasil)',
  cpf: 'CPF',
  cnpj: 'CNPJ',
  media: 'Arquivo ou mídia',
  regex: 'Formato próprio (expressão regular)',
};
const MEDIA_LABELS: Record<MediaType, string> = { pdf: 'PDF', audio: 'Áudio', image: 'Imagem', video: 'Vídeo' };

/** Same rule as the server's compileUserRegex: flag 'u', at most 200 chars. */
function regexProblem(pattern: string): string | null {
  if (pattern.length > 200) return 'Use no máximo 200 caracteres';
  try {
    new RegExp(pattern, 'u');
    return null;
  } catch {
    return 'Expressão inválida';
  }
}

export function AskInputForm({ config, onChange, catalog }: FormProps<AskInputConfig>) {
  function setValidator(validator: InputValidator) {
    const { mediaTypes, regex, ...rest } = config;
    onChange({
      ...rest,
      validator,
      ...(validator === 'media' ? { mediaTypes: mediaTypes ?? [] } : {}),
      ...(validator === 'regex' ? { regex: regex ?? '' } : {}),
    });
  }
  const problem = config.validator === 'regex' && config.regex ? regexProblem(config.regex) : null;

  return (
    <div className="space-y-3">
      <VarText label="Mensagem" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Select label="Tipo de resposta" value={config.validator} options={entries(VALIDATOR_LABELS)} onChange={(v) => v && setValidator(v)} />
      {config.validator === 'media' && (
        <CheckList
          label="Tipos aceitos"
          hint="Nenhum marcado aceita qualquer mídia."
          items={entries(MEDIA_LABELS).map(([id, label]) => ({ id, label }))}
          selected={config.mediaTypes ?? []}
          onChange={(ids) => onChange({ ...config, mediaTypes: ids as MediaType[] })}
        />
      )}
      {config.validator === 'regex' && (
        <Field label="Expressão regular" hint="Exemplo para CEP: ^\d{5}-?\d{3}$">
          <input
            aria-label="Expressão regular"
            value={config.regex ?? ''}
            maxLength={200}
            onChange={(e) => onChange({ ...config, regex: e.target.value })}
            className={control}
          />
          {problem && <p className="mt-1.5 text-xs font-semibold text-danger">{problem}</p>}
        </Field>
      )}
      <Check
        label="Aproveitar a última mensagem do contato, se for válida"
        checked={config.useLastMessage}
        onChange={(useLastMessage) => onChange({ ...config, useLastMessage })}
      />
      <Select
        label="Salvar no campo"
        value={config.saveToField ?? ''}
        placeholder="Não salvar"
        allowEmpty
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(v) => onChange({ ...config, saveToField: v || null })}
      />
      <AskCommon config={config} onChange={onChange} catalog={catalog} invalidPlaceholder="Resposta inválida. Tente de novo." />
    </div>
  );
}

export function SetContactFieldForm({ config, onChange, catalog }: FormProps<SetContactFieldConfig>) {
  return (
    <div className="space-y-3">
      <Select
        label="Campo"
        value={config.fieldId}
        placeholder="Escolha o campo…"
        options={fieldItems(catalog).map((f) => [f.id, f.label] as const)}
        onChange={(fieldId) => onChange({ ...config, fieldId })}
      />
      <VarText label="Valor" rows={1} value={config.value} onChange={(value) => onChange({ ...config, value })} catalog={catalog} />
    </div>
  );
}

export function EditTagsForm({ config, onChange, catalog }: FormProps<EditTagsConfig>) {
  return (
    <div className="space-y-3">
      <CheckList label="Adicionar ao contato" items={tagItems(catalog)} selected={config.add} onChange={(add) => onChange({ ...config, add })} />
      <CheckList label="Remover do contato" items={tagItems(catalog)} selected={config.remove} onChange={(remove) => onChange({ ...config, remove })} />
    </div>
  );
}

export function TransferSectorForm({ config, onChange, catalog }: FormProps<TransferSectorConfig>) {
  return (
    <div className="space-y-3">
      <Select
        label="Setor"
        value={config.sectorId}
        placeholder="Escolha o setor…"
        options={sectorItems(catalog).map((s) => [s.id, s.label] as const)}
        onChange={(sectorId) => onChange({ ...config, sectorId })}
      />
      <Check
        label="Manter o atendente só se ele pertencer ao setor de destino"
        checked={config.onlyIfAgentAllowed}
        onChange={(onlyIfAgentAllowed) => onChange({ ...config, onlyIfAgentAllowed })}
      />
    </div>
  );
}

const AGENT_RULES: Record<TransferAgentConfig['rule'], string> = {
  specific: 'O primeiro ativo desta lista',
  least_busy: 'Quem tiver menos conversas abertas',
};

export function TransferAgentForm({ config, onChange, catalog }: FormProps<TransferAgentConfig>) {
  return (
    <div className="space-y-3">
      <Select label="Como escolher o atendente" value={config.rule} options={entries(AGENT_RULES)} onChange={(rule) => rule && onChange({ ...config, rule })} />
      {config.rule === 'specific' ? (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      ) : (
        <CheckList label="Nos setores" items={sectorItems(catalog)} selected={config.sectorIds} onChange={(sectorIds) => onChange({ ...config, sectorIds })} />
      )}
    </div>
  );
}

export function PrivacyForm({ config, onChange }: FormProps<PrivacyConfig>) {
  return (
    <Select
      label="Tornar a conversa"
      value={config.mode}
      options={[
        ['private', 'Privada (só o atendente e admins veem)'],
        ['public', 'Pública para o setor'],
      ]}
      onChange={(mode) => mode && onChange({ ...config, mode })}
    />
  );
}

export function NotifyAgentForm({ config, onChange, catalog }: FormProps<NotifyAgentConfig>) {
  return (
    <div className="space-y-3">
      <VarText label="Título" rows={1} value={config.title} onChange={(title) => onChange({ ...config, title })} catalog={catalog} />
      <VarText label="Texto" value={config.text} onChange={(text) => onChange({ ...config, text })} catalog={catalog} />
      <Select
        label="Quem recebe"
        value={config.target}
        options={[
          ['owner', 'O atendente da conversa'],
          ['users', 'Atendentes escolhidos'],
        ]}
        onChange={(target) => target && onChange({ ...config, target })}
      />
      {config.target === 'users' && (
        <CheckList label="Atendentes" items={userItems(catalog)} selected={config.userIds} onChange={(userIds) => onChange({ ...config, userIds })} />
      )}
    </div>
  );
}

export function CallFlowForm({ config, onChange, catalog, bot }: FormProps<CallFlowConfig> & { bot: BotDto }) {
  const others = catalog.bots
    .filter((b) => b.id !== bot.id)
    .map((b) => [b.id, b.status === 'active' && b.publishedVersionId ? b.name : `${b.name} (inativo)`] as const);
  return (
    <div className="space-y-3">
      <Select
        label="Fluxo"
        hint="O fluxo escolhido precisa estar ativo e publicado."
        value={config.botId}
        placeholder="Escolha o fluxo…"
        options={others}
        onChange={(botId) => onChange({ ...config, botId })}
      />
      <Check
        label="Voltar para este fluxo quando o outro terminar"
        checked={config.continueAfter}
        onChange={(continueAfter) => onChange({ ...config, continueAfter })}
      />
    </div>
  );
}

export function CloseChatForm({ config, onChange, catalog }: FormProps<CloseChatConfig>) {
  return (
    <div className="space-y-3">
      <Check
        label="Enviar mensagem de finalização"
        checked={config.sendClosingMessage}
        onChange={(sendClosingMessage) => onChange({ ...config, sendClosingMessage })}
      />
      {config.sendClosingMessage && (
        <VarText
          label="Mensagem de finalização"
          hint="Em branco, usa a mensagem de Ajustes › Conversas."
          value={config.closingText ?? ''}
          onChange={(closingText) => onChange({ ...config, closingText })}
          catalog={catalog}
        />
      )}
    </div>
  );
}
