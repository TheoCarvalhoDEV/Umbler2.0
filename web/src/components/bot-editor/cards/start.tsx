import { useState } from 'react';
import type { BotDto, BotPatch, StickyColor, StickyNoteConfig } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';
import { Check, CheckList, Field, Select, TextInput, channelItems, controlArea, entries, type FormProps } from './fields';

interface BotFormProps {
  bot: BotDto;
  catalog: EditorCatalog;
  onBotChange(patch: BotPatch): void;
}

/** Shows the bot with this card's edits and reports the cumulative patch, so merging or replacing it upstream gives the same result. */
function useBotDraft(bot: BotDto, onBotChange: (patch: BotPatch) => void) {
  const [patch, setPatch] = useState<BotPatch>({});
  return {
    current: { ...bot, ...patch },
    change(p: BotPatch) {
      const next = { ...patch, ...p };
      setPatch(next);
      onBotChange(next);
    },
  };
}

export function StartChannelForm({ bot, catalog, onBotChange }: BotFormProps) {
  const { current, change } = useBotDraft(bot, onBotChange);
  return (
    <div className="space-y-3">
      <CheckList
        label="Canais"
        hint="Começa quando um contato abre uma conversa nova neste canal. Conversas que já estão abertas não são afetadas; para elas, use o bloco “Iniciar manualmente”. Se dois chatbots ativos usam o mesmo canal, inicia o mais antigo. A triagem simples não roda nesses canais."
        items={channelItems(catalog)}
        selected={current.startChannelIds}
        onChange={(startChannelIds) => change({ startChannelIds })}
      />
      {current.startChannelIds.length === 0 && (
        <p role="alert" className="text-xs font-semibold text-danger">
          Nenhum canal marcado: este chatbot não vai iniciar sozinho.
        </p>
      )}
    </div>
  );
}

export function StartManualForm({ bot, onBotChange }: BotFormProps) {
  const { current, change } = useBotDraft(bot, onBotChange);
  return (
    <div className="space-y-3">
      <Check
        label="Permitir que atendentes iniciem pela conversa"
        checked={current.manualStart}
        onChange={(manualStart) => change({ manualStart })}
      />
      <TextInput
        label="Título no painel"
        hint="Em branco, usa o nome do chatbot."
        value={current.manualTitle}
        placeholder={bot.name}
        maxLength={80}
        onChange={(manualTitle) => change({ manualTitle })}
      />
      <Check
        label="Não mostrar no painel (só outro fluxo aciona)"
        checked={current.manualUnlisted}
        onChange={(manualUnlisted) => change({ manualUnlisted })}
      />
    </div>
  );
}

const STICKY_COLORS: Record<StickyColor, string> = { yellow: 'Amarelo', blue: 'Azul', green: 'Verde', pink: 'Rosa', gray: 'Cinza' };

export function StickyNoteForm({ config, onChange }: FormProps<StickyNoteConfig>) {
  return (
    <div className="space-y-3">
      <Field label="Texto da anotação">
        <textarea
          aria-label="Texto da anotação"
          rows={4}
          value={config.text}
          onChange={(e) => onChange({ ...config, text: e.target.value })}
          className={controlArea}
        />
      </Field>
      <Select label="Cor" value={config.color} options={entries(STICKY_COLORS)} onChange={(color) => color && onChange({ ...config, color })} />
    </div>
  );
}
