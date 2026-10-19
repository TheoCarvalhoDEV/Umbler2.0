import dagre from '@dagrejs/dagre';
import type { BotGraph } from '@talk/shared';

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 160;
export type NodeSizes = Record<string, { width: number; height: number }>;

/**
 * Left-to-right dagre layout (nodesep 40, ranksep 80). `sizes` are the measured card sizes;
 * a node without one counts as 280×160. Sticky notes keep their position.
 */
export function autoLayout(graph: BotGraph, sizes: NodeSizes = {}): BotGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = (id: string) => sizes[id] ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  for (const n of graph.nodes) {
    if (n.type !== 'sticky_note') g.setNode(n.id, { ...size(n.id) }); // copy: dagre writes x/y into the label
  }
  for (const e of graph.edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (!g.hasNode(n.id)) return n;
      const { x, y } = g.node(n.id) as { x: number; y: number };
      const { width, height } = size(n.id);
      return { ...n, position: { x: Math.round(x - width / 2), y: Math.round(y - height / 2) } }; // dagre gives centers
    }),
  };
}
