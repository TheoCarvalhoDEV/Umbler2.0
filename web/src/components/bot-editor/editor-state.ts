import { useCallback, useReducer } from 'react';
import type { Edge, Node } from '@xyflow/react';
import {
  EDITOR_HISTORY_LIMIT,
  catalogEntry,
  defaultConfig,
  nodeNameFor,
  outputsOf,
  type BlockType,
  type BotGraph,
  type BotNode,
  type GraphProblem,
} from '@talk/shared';

/** A type alias, not an interface: React Flow's Node<T> requires T extends Record<string, unknown>. */
export type BlockNodeData = { node: BotNode; problems: string[] };
export type BlockFlowNode = Node<BlockNodeData, 'block'>;

// ---------- graph ↔ React Flow ----------

export function toFlowNodes(graph: BotGraph, problems: GraphProblem[]): BlockFlowNode[] {
  const byNode = new Map<string, string[]>();
  for (const p of problems) {
    if (p.nodeId) byNode.set(p.nodeId, [...(byNode.get(p.nodeId) ?? []), p.message]);
  }
  return graph.nodes.map((node) => ({
    id: node.id,
    type: 'block' as const,
    position: node.position,
    data: { node, problems: byNode.get(node.id) ?? [] },
  }));
}

export function toFlowEdges(graph: BotGraph): Edge[] {
  return graph.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target }));
}

// ---------- graph operations (pure; every one returns a new graph or the same reference when nothing changed) ----------

/** Start blocks have no input and sticky notes never connect. */
export function canBeTarget(type: BlockType): boolean {
  return catalogEntry(type).category !== 'start' && type !== 'sticky_note';
}

export function addNode(graph: BotGraph, type: BlockType, position: { x: number; y: number }): { graph: BotGraph; nodeId: string } {
  const id = crypto.randomUUID();
  const config = defaultConfig(type) as unknown as Record<string, unknown>; // a fresh object per call
  const node: BotNode = { id, type, position: { x: position.x, y: position.y }, config };
  if (type !== 'sticky_note') node.name = nodeNameFor(type, graph.nodes.flatMap((n) => (n.name ? [n.name] : [])));
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, nodeId: id };
}

/** One edge per (source, sourceHandle): a new connection replaces the old one. */
export function connect(graph: BotGraph, c: { source: string; sourceHandle: string; target: string }): BotGraph {
  const source = graph.nodes.find((n) => n.id === c.source);
  const target = graph.nodes.find((n) => n.id === c.target);
  if (!source || !target || source.type === 'sticky_note' || !canBeTarget(target.type)) return graph;
  if (!outputsOf(source.type, source.config).some((o) => o.id === c.sourceHandle)) return graph;
  const existing = graph.edges.find((e) => e.source === c.source && e.sourceHandle === c.sourceHandle);
  if (existing?.target === c.target) return graph;
  const edges = graph.edges.filter((e) => e !== existing);
  return { ...graph, edges: [...edges, { id: crypto.randomUUID(), source: c.source, sourceHandle: c.sourceHandle, target: c.target }] };
}

export function removeElements(graph: BotGraph, nodeIds: string[], edgeIds: string[]): BotGraph {
  const nodes = new Set(nodeIds);
  const edges = new Set(edgeIds);
  return {
    nodes: graph.nodes.filter((n) => !nodes.has(n.id)),
    edges: graph.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target)),
  };
}

/** Replaces the config, then drops the edges whose handle is no longer in outputsOf (e.g. a removed option). */
export function updateNodeConfig(graph: BotGraph, nodeId: string, config: Record<string, unknown>): BotGraph {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return graph;
  const handles = new Set(outputsOf(node.type, config).map((o) => o.id));
  return {
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, config } : n)),
    edges: graph.edges.filter((e) => e.source !== nodeId || handles.has(e.sourceHandle)),
  };
}

export function renameNode(graph: BotGraph, nodeId: string, name: string): BotGraph {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, name } : n)) };
}

export function moveNodes(graph: BotGraph, positions: Record<string, { x: number; y: number }>): BotGraph {
  let changed = false;
  const nodes = graph.nodes.map((n) => {
    const p = positions[n.id];
    if (!p || (p.x === n.position.x && p.y === n.position.y)) return n;
    changed = true;
    return { ...n, position: { x: p.x, y: p.y } };
  });
  return changed ? { ...graph, nodes } : graph;
}

// ---------- undo / redo ----------

export interface History { graph: BotGraph; canUndo: boolean; canRedo: boolean }
export interface HistoryState { past: BotGraph[]; present: BotGraph; future: BotGraph[]; mergeKey: string | null }

export function historyInit(graph: BotGraph): HistoryState {
  return { past: [], present: graph, future: [], mergeKey: null };
}

/** Same mergeKey as the previous push → replace the present instead of adding a step (typing in a card). */
export function historyPush(h: HistoryState, graph: BotGraph, mergeKey?: string): HistoryState {
  if (graph === h.present) return h;
  if (mergeKey !== undefined && mergeKey === h.mergeKey) return { ...h, present: graph, future: [] };
  return { past: [...h.past, h.present].slice(-EDITOR_HISTORY_LIMIT), present: graph, future: [], mergeKey: mergeKey ?? null };
}

export function historyUndo(h: HistoryState): HistoryState {
  const previous = h.past.at(-1);
  if (!previous) return h;
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future], mergeKey: null };
}

export function historyRedo(h: HistoryState): HistoryState {
  const [next, ...rest] = h.future;
  if (!next) return h;
  return { past: [...h.past, h.present].slice(-EDITOR_HISTORY_LIMIT), present: next, future: rest, mergeKey: null };
}

export type GraphUpdate = BotGraph | ((g: BotGraph) => BotGraph);
type HistoryAction =
  | { type: 'set'; next: GraphUpdate; mergeKey?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; graph: BotGraph };

function historyReducer(h: HistoryState, a: HistoryAction): HistoryState {
  switch (a.type) {
    case 'set':
      return historyPush(h, typeof a.next === 'function' ? a.next(h.present) : a.next, a.mergeKey);
    case 'undo':
      return historyUndo(h);
    case 'redo':
      return historyRedo(h);
    case 'reset':
      return historyInit(a.graph);
  }
}

/** `set` takes a graph or an updater (so callbacks never close over a stale graph); all callbacks are stable. */
export function useGraphHistory(initial: BotGraph): History & {
  set(next: GraphUpdate, mergeKey?: string): void;
  undo(): void;
  redo(): void;
  reset(g: BotGraph): void;
} {
  const [h, dispatch] = useReducer(historyReducer, initial, historyInit);
  const set = useCallback((next: GraphUpdate, mergeKey?: string) => dispatch({ type: 'set', next, mergeKey }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const reset = useCallback((graph: BotGraph) => dispatch({ type: 'reset', graph }), []);
  return { graph: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0, set, undo, redo, reset };
}

// ---------- keyboard ----------

export type EditorShortcut = 'palette' | 'undo' | 'redo';

/** Inputs keep their own keys (Tab moves focus, Ctrl+Z undoes text). Tab toggles the palette only from the page or the canvas. */
export function shortcutFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'target'>): EditorShortcut | null {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('input, textarea, select, [contenteditable="true"]')) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab') {
    if (mod || e.altKey || e.shiftKey) return null;
    return !el || el === document.body || el.closest('.react-flow') ? 'palette' : null;
  }
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y') return 'redo';
  return null;
}
