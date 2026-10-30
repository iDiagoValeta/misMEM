import type { LinkObject, NodeObject } from "react-force-graph-2d";
import type { GraphLink, GraphNode } from "../../api";
import { tokensNow } from "../../lib/graph-tokens";

export type Node = NodeObject<GraphNode>;
export type Link = LinkObject<GraphNode, GraphLink>;

type End = string | number | NodeObject<GraphNode> | undefined;

/** force-graph swaps ids for nodes as soon as it computes: both are accepted here. */
const endId = (end: End): string | undefined => {
  if (end === undefined || end === null) return undefined;
  return typeof end === "object" ? (end.id === undefined ? undefined : String(end.id)) : String(end);
};

/**
 * The simulation sizes a node from this and the canvas draws its radius from the same number,
 * so the circle and the force field cannot disagree.
 */
export const nodeWeight = (node: Node): number =>
  node.layer === "trait" ? 5 : 1 + 2.5 * (node.salience ?? 0.5);

/** The radius grows with salience and the chosen size; traits have their own base. */
const radiusOf = (node: Node, size: number): number => Math.sqrt(nodeWeight(node) * size) * 2.2;

export function colorOfNode(node: Node, palette: Map<string, string>, colorByScope: boolean): string {
  if (node.layer === "trait") return tokensNow().brand;
  const scopeColor = colorByScope ? palette.get(node.scope) : undefined;
  return scopeColor ?? tokensNow().inkMuted;
}

interface NodePaint {
  nodeSize: number;
  textThreshold: number;
  selectedId?: string;
  active: string | null;
  isLit: (id: string) => boolean;
  color: (node: Node) => string;
  positions: Map<string, { x: number; y: number }>;
}

/** Draws one node; every piece of state it needs arrives in `paint`, never through a closure. */
export function paintNode(node: Node, ctx: CanvasRenderingContext2D, scale: number, paint: NodePaint): void {
  if (node.x == null || node.y == null) return;
  const tokens = tokensNow();
  const id = String(node.id);
  const saved = paint.positions.get(id);
  if (saved?.x !== node.x || saved.y !== node.y) paint.positions.set(id, { x: node.x, y: node.y });
  const lit = paint.isLit(id);
  const radius = radiusOf(node, paint.nodeSize);

  // Outside the active node and its neighbours the graph dims: focus reads at a glance.
  ctx.globalAlpha = lit ? 1 : 0.15;
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
  ctx.fillStyle = paint.color(node);
  ctx.fill();

  if (id === paint.selectedId) {
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = tokens.ink;
    ctx.stroke();
  }

  const focused = paint.active !== null && lit;
  if (scale > paint.textThreshold || focused) {
    const fontSize = 11 / scale;
    const text = node.label.length > 48 ? `${node.label.slice(0, 47)}…` : node.label;
    // On hover a neighbour's label reads regardless of the zoom.
    ctx.globalAlpha *= Math.min(1, scale - paint.textThreshold + (focused ? 1 : 0.4));
    ctx.font = `${fontSize}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = tokens.inkSoft;
    ctx.fillText(text, node.x, node.y + radius + 2 / scale);
  }

  ctx.globalAlpha = 1;
}

export function colorOfLink(link: Link, active: string | null): string {
  const tokens = tokensNow();
  if (active === null) return tokens.edge;
  const touching = endId(link.source) === active || endId(link.target) === active;
  return touching ? tokens.brand : tokens.edge;
}

export function widthOfLink(link: Link, active: string | null): number {
  const touching = active !== null && (endId(link.source) === active || endId(link.target) === active);
  if (touching) return 1.6;
  return link.kind === "related" ? 0.7 : 0.6;
}
