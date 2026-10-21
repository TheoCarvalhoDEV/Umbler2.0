import '@xyflow/react/dist/style.css';
import './flow.css';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker, useNavigate } from 'react-router';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type AriaLabelConfig,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnDelete,
  type OnNodeDrag,
} from '@xyflow/react';
import {
  BLOCK_TYPES,
  catalogEntry,
  type BlockType,
  type BotDto,
  type BotGraph,
  type BotPatch,
  type BotVersionDto,
  type GraphProblem,
} from '@talk/shared';
import { api, graphProblems, qk, readBotExport } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { btn } from '../settings/common';
import { errorMessage } from '../conversation/model';
import { BlockNode, NodeActionsContext, type NodeActions } from './BlockNode';
import {
  addNode,
  canBeTarget,
  connect,
  moveNodes,
  removeElements,
  renameNode,
  shortcutFor,
  toFlowEdges,
  toFlowNodes,
  updateNodeConfig,
  useGraphHistory,
  type BlockFlowNode,
} from './editor-state';
import { NODE_WIDTH, autoLayout, type NodeSizes } from './layout';
import { PALETTE_DRAG_TYPE, Palette } from './Palette';
import { ProblemsList } from './ProblemsList';
import { Toolbar } from './Toolbar';
import { VersionsPanel } from './VersionsPanel';
import { useEditorCatalog } from './useEditorCatalog';

const nodeTypes = { block: BlockNode };

const ARIA_PT: Partial<AriaLabelConfig> = {
  'node.a11yDescription.default': 'Pressione Enter ou espaço para selecionar o bloco. Pressione Delete para excluí-lo e Esc para cancelar.',
  'node.a11yDescription.keyboardDisabled':
    'Pressione Enter ou espaço para selecionar o bloco. Use as setas para movê-lo, Delete para excluí-lo e Esc para cancelar.',
  'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => `Bloco movido para ${direction}. Nova posição: x ${x}, y ${y}`,
  'edge.a11yDescription.default': 'Pressione Enter ou espaço para selecionar a ligação. Depois pressione Delete para excluí-la ou Esc para cancelar.',
  'controls.ariaLabel': 'Controles',
  'controls.zoomIn.ariaLabel': 'Aproximar',
  'controls.zoomOut.ariaLabel': 'Afastar',
  'controls.fitView.ariaLabel': 'Ajustar à tela',
  'minimap.ariaLabel': 'Minimapa',
  'handle.ariaLabel': 'Conector',
};

const LEAVE_PROMPT = 'Há alterações não salvas. Sair mesmo assim?';

export interface BotEditorProps {
  bot: BotDto;
  initial: BotVersionDto;
}

/** Full-screen flow editor. `initial` is read once: refetches of the version do not reset the canvas or the undo history. */
export function BotEditor(props: BotEditorProps) {
  return (
    <ReactFlowProvider>
      <EditorCanvas {...props} />
    </ReactFlowProvider>
  );
}

type Message = { kind: 'error' | 'notice'; text: string };

function EditorCanvas({ bot, initial }: BotEditorProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const rf = useReactFlow<BlockFlowNode, Edge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const { graph, canUndo, canRedo, set, undo, redo } = useGraphHistory(initial.graph);
  const [saved, setSaved] = useState<BotGraph>(initial.graph);
  const [patch, setPatch] = useState<BotPatch>({});
  const [problems, setProblems] = useState<GraphProblem[]>(initial.problems);
  const [preview, setPreview] = useState<BotVersionDto | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const catalog = useEditorCatalog();

  const readOnly = preview !== null;
  const shown = preview ? preview.graph : graph;
  const shownProblems = preview ? preview.problems : problems;
  const dirty = graph !== saved || Object.keys(patch).length > 0;
  const editedBot = useMemo<BotDto>(() => ({ ...bot, ...patch }), [bot, patch]);

  // React Flow owns selection, drag positions and measured sizes; the graph (history) owns everything else.
  const [nodes, setNodes] = useState(() => toFlowNodes(shown, shownProblems));
  const [edges, setEdges] = useState(() => toFlowEdges(shown));
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return toFlowNodes(shown, shownProblems).map((n) => {
        const o = old.get(n.id);
        return o ? { ...n, selected: o.selected, measured: o.measured } : n;
      });
    });
    setEdges((prev) => {
      const selected = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return toFlowEdges(shown).map((e) => (selected.has(e.id) ? { ...e, selected: true } : e));
    });
  }, [shown, shownProblems]);

  const actions = useMemo<NodeActions>(
    () => ({
      catalog,
      bot: editedBot,
      readOnly,
      changeConfig: (id, config) => set((g) => updateNodeConfig(g, id, config), `config:${id}`),
      rename: (id, name) => set((g) => renameNode(g, id, name), `name:${id}`),
      changeBot: (p) => setPatch((prev) => ({ ...prev, ...p })),
      remove: (id) => set((g) => removeElements(g, [id], [])),
    }),
    [catalog, editedBot, readOnly, set],
  );

  // Keyboard: Tab toggles the palette, Ctrl/Cmd+Z and Ctrl+Shift+Z / Ctrl+Y undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const shortcut = shortcutFor(e);
      if (!shortcut) return;
      e.preventDefault();
      if (shortcut === 'palette') setPaletteOpen((o) => !o);
      else if (preview) return;
      else if (shortcut === 'undo') undo();
      else redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, undo, redo]);

  // Unsaved-changes guard: in-app navigation asks, and closing or reloading the tab gets the browser prompt.
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirmDialog({ title: LEAVE_PROMPT, confirmLabel: 'Sair sem salvar', cancelLabel: 'Continuar editando' }).then((ok) =>
      ok ? blocker.proceed() : blocker.reset(),
    );
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function onNodesChange(changes: NodeChange<BlockFlowNode>[]) {
    // removals go through onDelete so they land in the undo history
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), ns));
  }
  function onEdgesChange(changes: EdgeChange[]) {
    setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== 'remove'), es));
  }
  const onDelete: OnDelete<BlockFlowNode, Edge> = ({ nodes: gone, edges: cut }) =>
    set((g) => removeElements(g, gone.map((n) => n.id), cut.map((e) => e.id)));
  const onNodeDragStop: OnNodeDrag<BlockFlowNode> = (_event, _node, dragged) =>
    set((g) => moveNodes(g, Object.fromEntries(dragged.map((n) => [n.id, n.position]))));
  function onConnect(c: Connection) {
    const sourceHandle = c.sourceHandle;
    if (sourceHandle) set((g) => connect(g, { source: c.source, sourceHandle, target: c.target }));
  }
  const isValidConnection: IsValidConnection<Edge> = (c) => {
    const target = shown.nodes.find((n) => n.id === c.target);
    return target !== undefined && canBeTarget(target.type);
  };

  function insert(type: BlockType, at?: { x: number; y: number }) {
    const entry = catalogEntry(type);
    if (entry.category === 'start' && graph.nodes.some((n) => n.type === type)) {
      setMessage({ kind: 'error', text: `O fluxo já tem o bloco "${entry.label}".` });
      return;
    }
    const box = wrapper.current?.getBoundingClientRect();
    const center = rf.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + (box?.height ?? 0) / 2 });
    const position = at ?? { x: Math.round(center.x - NODE_WIDTH / 2), y: Math.round(center.y - 40) };
    set((g) => addNode(g, type, position).graph);
    setMessage(null);
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes(PALETTE_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }
  function onDrop(e: DragEvent) {
    const type = e.dataTransfer.getData(PALETTE_DRAG_TYPE);
    if (!(BLOCK_TYPES as readonly string[]).includes(type)) return;
    e.preventDefault();
    insert(type as BlockType, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  function layout() {
    const sizes: NodeSizes = {};
    for (const n of rf.getNodes()) {
      if (n.measured?.width && n.measured.height) sizes[n.id] = { width: n.measured.width, height: n.measured.height };
    }
    set((g) => autoLayout(g, sizes));
    requestAnimationFrame(() => void rf.fitView({ duration: 300 }));
  }

  function focusNode(id: string) {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    void rf.fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.2 });
  }
  function labelOf(id: string): string {
    const n = shown.nodes.find((x) => x.id === id);
    return n ? (n.name ?? catalogEntry(n.type).label) : 'Bloco removido';
  }

  function restore(g: BotGraph, n: number) {
    set(g); // undoable; saving it creates the new draft version
    setPreview(null);
    setProblems([]);
    setMessage({ kind: 'notice', text: `Versão ${n} restaurada. Salve para criar um novo rascunho.` });
  }

  async function save(publish: boolean) {
    const snapshot = graph;
    const pending = patch;
    setBusy(true);
    setMessage(null);
    try {
      if (Object.keys(pending).length > 0) {
        qc.setQueryData(qk.bot(bot.id), await api.bots.update(bot.id, pending));
        setPatch((p) => (p === pending ? {} : p));
      }
      const v = await api.bots.saveVersion(bot.id, { graph: snapshot, publish });
      setSaved(snapshot);
      setProblems(v.problems);
      const text = publish
        ? `Versão ${v.number} publicada.`
        : v.valid
          ? `Rascunho salvo (versão ${v.number}).`
          : `Rascunho salvo (versão ${v.number}) com ${v.problems.length} problema(s).`;
      setMessage({ kind: 'notice', text });
    } catch (e) {
      const found = graphProblems(e);
      if (found) {
        setSaved(snapshot); // the server stores the draft even when publishing is refused
        setProblems(found);
        setMessage({ kind: 'error', text: 'O fluxo tem problemas e não foi publicado. O rascunho foi salvo.' });
      } else {
        setMessage({ kind: 'error', text: errorMessage(e) });
      }
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: qk.bots });
    }
  }

  /** Creates a new draft bot from the file and opens it; this flow is left as it is (unsaved changes still ask before leaving). */
  async function importFile(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.bots.importBot(await readBotExport(file));
      void qc.invalidateQueries({ queryKey: qk.bots });
      setMessage({ kind: 'notice', text: `Chatbot importado como "${created.name}".` }); // seen if the user stays here
      navigate(`/configuracoes/chatbots/${created.id}`);
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setBusy(true);
    setMessage(null);
    try {
      qc.setQueryData(qk.bot(bot.id), await api.bots.setStatus(bot.id, bot.status === 'active' ? 'paused' : 'active'));
      void qc.invalidateQueries({ queryKey: qk.bots });
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <NodeActionsContext.Provider value={actions}>
      <div className="flex h-dvh flex-col gap-3 bg-ground p-3 text-fg">
        <Toolbar
          name={editedBot.name}
          onRename={(name) => setPatch((p) => ({ ...p, name }))}
          status={bot.status}
          publishedVersionNumber={bot.publishedVersionNumber}
          onToggleStatus={() => void toggleStatus()}
          canUndo={canUndo && !readOnly}
          canRedo={canRedo && !readOnly}
          onUndo={undo}
          onRedo={redo}
          onLayout={layout}
          onSave={(publish) => void save(publish)}
          busy={busy}
          dirty={dirty}
          readOnly={readOnly}
          exportUrl={api.bots.exportUrl(bot.id)}
          onImport={(file) => void importFile(file)}
          paletteOpen={paletteOpen}
          onTogglePalette={() => setPaletteOpen((o) => !o)}
          versionsOpen={versionsOpen}
          onToggleVersions={() => setVersionsOpen((o) => !o)}
        />
        {message && (
          <p
            role={message.kind === 'error' ? 'alert' : 'status'}
            className={`rounded-card px-4 py-2.5 text-sm font-semibold ${message.kind === 'error' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}
          >
            {message.text}
          </p>
        )}
        {preview && (
          <div className="flex flex-wrap items-center gap-2 rounded-card bg-primary-soft px-4 py-2 text-sm">
            <span className="flex-1 font-semibold text-accent-ink">Visualizando a versão {preview.number} (somente leitura).</span>
            <button type="button" className={btn} onClick={() => restore(preview.graph, preview.number)}>
              Restaurar como rascunho
            </button>
            <button type="button" className={btn} onClick={() => setPreview(null)}>
              Voltar à edição
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 gap-3">
          <Palette open={paletteOpen && !readOnly} onInsert={(type) => insert(type)} />
          <div ref={wrapper} className="relative min-w-0 flex-1 overflow-hidden rounded-card bg-sunken" onDragOver={onDragOver} onDrop={onDrop}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDelete={onDelete}
              onNodeDragStop={onNodeDragStop}
              isValidConnection={isValidConnection}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
              colorMode="dark"
              ariaLabelConfig={ARIA_PT}
              minZoom={0.2}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={20} />
              <MiniMap pannable zoomable />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          {(versionsOpen || shownProblems.length > 0) && (
            <aside aria-label="Painel lateral" className="w-80 shrink-0 overflow-y-auto rounded-card bg-surface">
              <ProblemsList problems={shownProblems} onFocus={focusNode} labelOf={labelOf} />
              {versionsOpen && <VersionsPanel botId={bot.id} onRestore={restore} onView={setPreview} />}
            </aside>
          )}
        </div>
      </div>
    </NodeActionsContext.Provider>
  );
}
