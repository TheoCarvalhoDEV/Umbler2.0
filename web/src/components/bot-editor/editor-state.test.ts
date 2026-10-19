// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EDITOR_HISTORY_LIMIT, defaultConfig, type BotGraph } from '@talk/shared';
import {
  addNode,
  canBeTarget,
  connect,
  historyInit,
  historyPush,
  historyRedo,
  historyUndo,
  moveNodes,
  removeElements,
  renameNode,
  shortcutFor,
  toFlowEdges,
  toFlowNodes,
  updateNodeConfig,
} from './editor-state';
import { autoLayout } from './layout';

const graph: BotGraph = {
  nodes: [
    { id: 'n1', type: 'start_channel', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
    {
      id: 'n2',
      type: 'ask_choice',
      position: { x: 300, y: 0 },
      name: 'menu',
      config: { text: 'Escolha', options: [{ key: '1', label: 'Atendimento' }, { key: '2', label: 'Financeiro' }], invalidRetries: 1, timeoutHours: null },
    },
    { id: 'n3', type: 'send_message', position: { x: 600, y: 0 }, name: 'mensagem', config: { text: 'Olá', attachment: null, signature: false } },
    { id: 'n4', type: 'sticky_note', position: { x: 50, y: 400 }, config: { text: 'lembrete', color: 'yellow' } },
    { id: 'n5', type: 'note', position: { x: 900, y: 0 }, name: 'nota', config: { text: 'Cliente atendido pelo bot' } },
  ],
  edges: [
    { id: 'e1', source: 'n1', sourceHandle: 'next', target: 'n2' },
    { id: 'e2', source: 'n2', sourceHandle: 'opt:2', target: 'n3' },
    { id: 'e3', source: 'n3', sourceHandle: 'next', target: 'n5' },
  ],
};

describe('graph ↔ flow mapping', () => {
  it('maps every node to a block node carrying only its own problems', () => {
    const nodes = toFlowNodes(graph, [
      { nodeId: 'n3', message: 'Texto obrigatório' },
      { nodeId: null, message: 'O fluxo precisa de um bloco de início' },
    ]);
    expect(nodes).toHaveLength(5);
    expect(nodes[2]).toMatchObject({ id: 'n3', type: 'block', position: { x: 600, y: 0 }, data: { node: graph.nodes[2], problems: ['Texto obrigatório'] } });
    expect(nodes[0]!.data.problems).toEqual([]);
  });

  it('maps edges with their source handle', () => {
    expect(toFlowEdges(graph)[1]).toEqual({ id: 'e2', source: 'n2', sourceHandle: 'opt:2', target: 'n3' });
  });
});

describe('graph operations', () => {
  it('adds a node with a unique contexto name and the default config, without touching the input', () => {
    const a = addNode(graph, 'condition', { x: 10, y: 20 });
    const b = addNode(a.graph, 'condition', { x: 0, y: 0 });
    expect(a.graph.nodes.find((n) => n.id === a.nodeId)).toMatchObject({
      type: 'condition',
      name: 'condition',
      position: { x: 10, y: 20 },
      config: defaultConfig('condition'),
    });
    expect(b.graph.nodes.find((n) => n.id === b.nodeId)!.name).toBe('condition_2');
    expect(a.nodeId).not.toBe(b.nodeId);
    expect(graph.nodes).toHaveLength(5);
    const sticky = addNode(graph, 'sticky_note', { x: 0, y: 0 });
    expect(sticky.graph.nodes.at(-1)!.name).toBeUndefined();
  });

  it('keeps one edge per source handle by replacing the old one', () => {
    const g2 = connect(graph, { source: 'n2', sourceHandle: 'opt:2', target: 'n5' });
    expect(g2.edges.filter((e) => e.source === 'n2' && e.sourceHandle === 'opt:2')).toEqual([expect.objectContaining({ target: 'n5' })]);
    expect(g2.edges).toHaveLength(3);
    expect(connect(g2, { source: 'n2', sourceHandle: 'opt:1', target: 'n3' }).edges).toHaveLength(4);
  });

  it('ignores connections to start or sticky blocks, unknown handles and repeats', () => {
    expect(canBeTarget('start_manual')).toBe(false);
    expect(canBeTarget('send_message')).toBe(true);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:1', target: 'n1' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:1', target: 'n4' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:9', target: 'n3' })).toBe(graph);
    expect(connect(graph, { source: 'n2', sourceHandle: 'opt:2', target: 'n3' })).toBe(graph);
  });

  it('removes nodes with their edges, and single edges', () => {
    const g2 = removeElements(graph, ['n2'], []);
    expect(g2.nodes.map((n) => n.id)).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(g2.edges.map((e) => e.id)).toEqual(['e3']);
    expect(removeElements(graph, [], ['e3']).edges.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('drops the edges of outputs that a config change removed', () => {
    const menu = graph.nodes[1]!;
    const g2 = updateNodeConfig(graph, 'n2', { ...menu.config, options: [{ key: '1', label: 'Atendimento' }] });
    expect(g2.nodes[1]!.config.options).toEqual([{ key: '1', label: 'Atendimento' }]);
    expect(g2.edges.map((e) => e.id)).toEqual(['e1', 'e3']);
  });

  it('renames and moves nodes, and a move to the same spot changes nothing', () => {
    expect(renameNode(graph, 'n3', 'boas_vindas').nodes[2]!.name).toBe('boas_vindas');
    expect(moveNodes(graph, { n3: { x: 1, y: 2 } }).nodes[2]!.position).toEqual({ x: 1, y: 2 });
    expect(moveNodes(graph, { n3: { x: 600, y: 0 } })).toBe(graph);
  });
});

describe('history', () => {
  it('undoes and redoes, and a new edit clears the redo stack', () => {
    const g1 = renameNode(graph, 'n3', 'a');
    const g2 = renameNode(g1, 'n3', 'b');
    let h = historyPush(historyPush(historyInit(graph), g1), g2);
    h = historyUndo(h);
    expect(h.present).toBe(g1);
    h = historyUndo(h);
    expect(h.present).toBe(graph);
    expect(historyUndo(h)).toBe(h);
    h = historyRedo(h);
    expect(h.present).toBe(g1);
    h = historyPush(h, renameNode(g1, 'n3', 'c'));
    expect(h.future).toEqual([]);
    expect(historyRedo(h)).toBe(h);
  });

  it(`keeps at most ${EDITOR_HISTORY_LIMIT} undo steps`, () => {
    let h = historyInit(graph);
    for (let i = 0; i < EDITOR_HISTORY_LIMIT + 10; i++) h = historyPush(h, renameNode(graph, 'n3', `v${i}`));
    expect(h.past).toHaveLength(EDITOR_HISTORY_LIMIT);
    for (let i = 0; i < EDITOR_HISTORY_LIMIT; i++) h = historyUndo(h);
    expect(h.past).toHaveLength(0);
    expect(h.present.nodes[2]!.name).toBe('v9');
  });

  it('merges consecutive edits with the same key into one step and ignores no-ops', () => {
    let h = historyInit(graph);
    h = historyPush(h, renameNode(graph, 'n3', 'b'), 'name:n3');
    h = historyPush(h, renameNode(graph, 'n3', 'bo'), 'name:n3');
    expect(h.past).toHaveLength(1);
    expect(h.present.nodes[2]!.name).toBe('bo');
    h = historyPush(h, moveNodes(h.present, { n3: { x: 5, y: 5 } }));
    expect(h.past).toHaveLength(2);
    expect(historyPush(h, h.present)).toBe(h);
  });
});

describe('shortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  const key = (k: string, target: EventTarget | null, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
    key: k,
    target,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it('toggles the palette with Tab only from the page or the canvas, never while typing', () => {
    const canvas = document.createElement('div');
    canvas.className = 'react-flow';
    const inside = document.createElement('div');
    canvas.append(inside);
    const input = document.createElement('input');
    const toolbarButton = document.createElement('button');
    document.body.append(canvas, input, toolbarButton);
    expect(shortcutFor(key('Tab', document.body))).toBe('palette');
    expect(shortcutFor(key('Tab', inside))).toBe('palette');
    expect(shortcutFor(key('Tab', input))).toBeNull();
    expect(shortcutFor(key('Tab', toolbarButton))).toBeNull();
    expect(shortcutFor(key('Tab', document.body, { shiftKey: true }))).toBeNull();
  });

  it('maps Ctrl/Cmd+Z, Ctrl+Shift+Z and Ctrl+Y outside inputs', () => {
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    expect(shortcutFor(key('z', document.body, { ctrlKey: true }))).toBe('undo');
    expect(shortcutFor(key('Z', document.body, { metaKey: true, shiftKey: true }))).toBe('redo');
    expect(shortcutFor(key('y', document.body, { ctrlKey: true }))).toBe('redo');
    expect(shortcutFor(key('z', textarea, { ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key('z', document.body))).toBeNull();
  });
});

describe('autoLayout', () => {
  it('lays the flow out left to right and leaves sticky notes and edges alone', () => {
    const out = autoLayout(graph);
    const x = (id: string) => out.nodes.find((n) => n.id === id)!.position.x;
    expect(x('n2') - x('n1')).toBeGreaterThanOrEqual(360); // 280 wide + ranksep 80
    expect(x('n3')).toBeGreaterThan(x('n2'));
    expect(x('n5')).toBeGreaterThan(x('n3'));
    expect(out.nodes.find((n) => n.id === 'n4')!.position).toEqual({ x: 50, y: 400 });
    expect(out.edges).toBe(graph.edges);
  });

  it('uses measured sizes so tall siblings do not overlap, without mutating them', () => {
    const fan: BotGraph = {
      nodes: [
        { id: 's', type: 'start_channel', position: { x: 0, y: 0 }, config: {}, name: 'inicio' },
        { id: 'a', type: 'ask_choice', position: { x: 0, y: 0 }, name: 'menu', config: { text: 'x', options: [{ key: '1', label: 'A' }, { key: '2', label: 'B' }], invalidRetries: 1 } },
        { id: 'b', type: 'send_message', position: { x: 0, y: 0 }, name: 'b', config: { text: 'b', signature: false } },
        { id: 'c', type: 'send_message', position: { x: 0, y: 0 }, name: 'c', config: { text: 'c', signature: false } },
      ],
      edges: [
        { id: 'e1', source: 's', sourceHandle: 'next', target: 'a' },
        { id: 'e2', source: 'a', sourceHandle: 'opt:1', target: 'b' },
        { id: 'e3', source: 'a', sourceHandle: 'opt:2', target: 'c' },
      ],
    };
    const sizes = { b: { width: 280, height: 400 }, c: { width: 280, height: 400 } };
    const out = autoLayout(fan, sizes);
    const pos = (id: string) => out.nodes.find((n) => n.id === id)!.position;
    expect(pos('b').x).toBe(pos('c').x);
    expect(Math.abs(pos('b').y - pos('c').y)).toBeGreaterThanOrEqual(400);
    expect(sizes.b).toEqual({ width: 280, height: 400 });
  });
});
