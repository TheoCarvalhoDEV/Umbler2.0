import { createContext, useContext, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { TrashIcon } from '@phosphor-icons/react';
import { catalogEntry, outputsOf, type BlockCategory, type BotDto, type BotPatch } from '@talk/shared';
import { field } from '../settings/common';
import { BlockConfigCard } from './cards';
import { canBeTarget, type BlockFlowNode } from './editor-state';
import { blockIcon } from './icons';
import type { EditorCatalog } from './useEditorCatalog';

/** What a node needs from the editor. Kept out of node.data so the data stays a plain BotNode. */
export interface NodeActions {
  catalog: EditorCatalog | null;
  bot: BotDto; // with the pending BotPatch applied
  readOnly: boolean; // viewing an old version
  changeConfig(nodeId: string, config: Record<string, unknown>): void;
  rename(nodeId: string, name: string): void;
  changeBot(patch: BotPatch): void;
  remove(nodeId: string): void;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);

export const CATEGORY_BORDER: Record<BlockCategory, string> = {
  start: 'border-success',
  condition: 'border-amber-500',
  action: 'border-primary',
  finish: 'border-danger',
  utility: 'border-border',
};

export function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const actions = useContext(NodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const { node, problems } = data;
  const entry = catalogEntry(node.type);
  const outputs = outputsOf(node.type, node.config);
  const handleKey = outputs.map((o) => o.id).join('|');
  // React Flow caches handle positions; tell it when a config change adds or removes outputs.
  useEffect(() => updateNodeInternals(id), [id, handleKey, updateNodeInternals]);
  if (!actions) throw new Error('BlockNode usado fora do BotEditor');
  const Icon = blockIcon(entry.icon);
  const ring = problems.length > 0 ? 'ring-2 ring-danger' : selected ? 'ring-2 ring-primary/50' : '';

  return (
    <div
      data-testid={`block-${node.id}`}
      data-invalid={problems.length > 0 ? 'true' : undefined}
      className={`w-[280px] rounded-lg border-2 bg-panel text-fg shadow-lg ${CATEGORY_BORDER[entry.category]} ${ring}`}
    >
      {canBeTarget(node.type) && <Handle type="target" position={Position.Left} />}
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon size={16} aria-hidden />
        <span className="flex-1 truncate text-sm font-medium">{entry.label}</span>
        {!actions.readOnly && (
          <button
            type="button"
            aria-label={`Excluir bloco ${entry.label}`}
            title="Excluir bloco"
            onClick={() => actions.remove(id)}
            className="nodrag rounded p-0.5 text-muted hover:text-danger"
          >
            <TrashIcon size={14} />
          </button>
        )}
      </header>
      <fieldset disabled={actions.readOnly} className="nodrag nowheel min-w-0 cursor-default space-y-2 px-3 py-2">
        {node.type !== 'sticky_note' && (
          <label className="block text-xs text-muted">
            Nome (variável)
            <input
              value={node.name ?? ''}
              maxLength={40}
              onChange={(e) => actions.rename(id, e.target.value)}
              className={`${field} bg-surface text-fg`}
            />
          </label>
        )}
        {actions.catalog ? (
          <BlockConfigCard
            node={node}
            catalog={actions.catalog}
            bot={actions.bot}
            problems={problems}
            onChange={(config) => actions.changeConfig(id, config)}
            onBotChange={actions.changeBot}
          />
        ) : (
          <p className="text-xs text-muted">Carregando…</p>
        )}
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs text-danger">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </fieldset>
      {outputs.length > 0 && (
        <ul className="border-t border-border py-1">
          {outputs.map((o) => (
            <li key={o.id} className="relative py-1 pr-4 text-right text-xs text-muted">
              {o.label}
              <Handle type="source" position={Position.Right} id={o.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
