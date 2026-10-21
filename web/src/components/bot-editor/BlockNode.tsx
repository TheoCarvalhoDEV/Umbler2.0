import { createContext, useContext, useEffect, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { TrashIcon } from '@phosphor-icons/react';
import { catalogEntry, outputsOf, type BotDto, type BotPatch } from '@talk/shared';
import { field, fieldLabel } from '../ui';
import { BlockConfigCard } from './cards';
import { canBeTarget, type BlockFlowNode } from './editor-state';
import { CATEGORY_TONE, blockIcon } from './icons';
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

export function BlockNode({ id, data, selected }: NodeProps<BlockFlowNode>) {
  const actions = useContext(NodeActionsContext);
  const updateNodeInternals = useUpdateNodeInternals();
  const { problems } = data;
  // Local copy updated in the same event as the edit: data.node only catches up after BotEditor's setNodes reaches
  // React Flow, and a controlled field that briefly gets its old value back jumps the caret to the end.
  const [seen, setSeen] = useState(data.node);
  const [node, setNode] = useState(data.node);
  if (seen !== data.node) {
    setSeen(data.node);
    setNode(data.node);
  }
  const entry = catalogEntry(node.type);
  const outputs = outputsOf(node.type, node.config);
  const handleKey = outputs.map((o) => o.id).join('|');
  // React Flow caches handle positions; tell it when a config change adds or removes outputs.
  useEffect(() => updateNodeInternals(id), [id, handleKey, updateNodeInternals]);
  if (!actions) throw new Error('BlockNode usado fora do BotEditor');
  const Icon = blockIcon(entry.icon);
  const ring = problems.length > 0 ? 'ring-2 ring-danger' : selected ? 'ring-2 ring-primary' : '';

  return (
    <div
      data-testid={`block-${node.id}`}
      data-invalid={problems.length > 0 ? 'true' : undefined}
      className={`w-[280px] rounded-block bg-surface text-fg shadow-float ${ring}`}
    >
      {canBeTarget(node.type) && <Handle type="target" position={Position.Left} />}
      <header className="flex items-center gap-2 border-b border-border py-2 pr-1.5 pl-3">
        <span className={`grid size-7 shrink-0 place-items-center rounded-full ${CATEGORY_TONE[entry.category]}`}>
          <Icon size={16} aria-hidden />
        </span>
        <span className="flex-1 truncate text-sm font-bold">{entry.label}</span>
        {!actions.readOnly && (
          <button
            type="button"
            aria-label={`Excluir bloco ${entry.label}`}
            title="Excluir bloco"
            onClick={() => actions.remove(id)}
            className="nodrag grid size-8 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-danger-soft hover:text-danger"
          >
            <TrashIcon size={16} />
          </button>
        )}
      </header>
      <fieldset disabled={actions.readOnly} className="nodrag nowheel min-w-0 cursor-default space-y-3 p-3">
        {node.type !== 'sticky_note' && (
          <label className="block">
            <span className={fieldLabel}>Nome (variável)</span>
            <input
              value={node.name ?? ''}
              maxLength={40}
              onChange={(e) => {
                setNode({ ...node, name: e.target.value });
                actions.rename(id, e.target.value);
              }}
              className={field}
            />
          </label>
        )}
        {actions.catalog ? (
          <BlockConfigCard
            node={node}
            catalog={actions.catalog}
            bot={actions.bot}
            problems={problems}
            onChange={(config) => {
              setNode({ ...node, config });
              actions.changeConfig(id, config);
            }}
            onBotChange={actions.changeBot}
          />
        ) : (
          <p className="text-xs text-muted">Carregando…</p>
        )}
        {problems.length > 0 && (
          <ul className="space-y-0.5 text-xs font-semibold text-danger">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </fieldset>
      {outputs.length > 0 && (
        <ul className="border-t border-border py-1.5">
          {outputs.map((o) => (
            <li key={o.id} className="relative py-1.5 pr-4 text-right text-xs font-semibold text-fg-2">
              {o.label}
              <Handle type="source" position={Position.Right} id={o.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
