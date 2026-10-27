import type { GraphMapRegion } from "../force-graph/force-graph-svg";
import type { GraphEdgeInput, GraphNodeInput } from "../force-graph/types";
import type { InboxTemplateGraphData, InboxTemplateGraphNode } from "./InboxGraphAdapter";
import { compactGraphNodeLabel } from "./GraphLabel";

export type StaticGraphNode = GraphNodeInput<InboxTemplateGraphNode>;
export type StaticGraphEdge = GraphEdgeInput<{ relationType: string }>;

export interface StaticGraphLayout {
  nodes: StaticGraphNode[];
  edges: StaticGraphEdge[];
  regions: GraphMapRegion[];
  width: number;
  height: number;
  hiddenTileCount: number;
}

interface StaticMapRect { x: number; y: number; width: number; height: number; }
interface StaticMapItem { node: InboxTemplateGraphNode; weight: number; }

const TILE_BUDGET_BY_DEPTH = [1, 12, 16, 24] as const;

function staticMapWeight(node: InboxTemplateGraphNode): number {
  // The aggregate is a doorway to the long tail, not the dominant content
  // block. Keep it readable without letting its summed note count swallow the
  // high-value named directories that remain directly visible.
  if (node.presentation === "overflow") return 1.15;
  return Math.max(1, Math.log2(Math.max(1, node.count) + 1));
}

function staticMapColumns(count: number, noteLayer: boolean): number {
  if (count <= 1) return 1;
  const target = Math.ceil(Math.sqrt(count * (noteLayer ? 1.25 : 1)));
  return Math.min(noteLayer ? 6 : 4, Math.max(2, target));
}

function weightedTileWidths(items: StaticMapItem[], availableWidth: number, minimumWidth: number): number[] {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const widths = items.map(item => availableWidth * item.weight / Math.max(1, totalWeight));
  const fixed = new Set<number>();
  for (let pass = 0; pass < items.length; pass += 1) {
    const under = widths.findIndex((width, index) => width < minimumWidth && !fixed.has(index));
    if (under < 0) break;
    widths[under] = minimumWidth;
    fixed.add(under);
    const frozenWidth = widths.reduce((sum, width, index) => fixed.has(index) ? sum + width : sum, 0);
    const remaining = Math.max(0, availableWidth - frozenWidth);
    const flexibleWeight = items.reduce((sum, item, index) => fixed.has(index) ? sum : sum + item.weight, 0);
    if (flexibleWeight <= 0) break;
    items.forEach((item, index) => {
      if (!fixed.has(index)) widths[index] = remaining * item.weight / flexibleWeight;
    });
  }
  const correction = availableWidth - widths.reduce((sum, width) => sum + width, 0);
  const lastFlexible = items.map((_, index) => index).reverse().find(index => !fixed.has(index));
  if (lastFlexible !== undefined) widths[lastFlexible] = Math.max(minimumWidth, widths[lastFlexible]! + correction);
  return widths;
}

function layoutWeightedMapItems(
  items: StaticMapItem[],
  rect: StaticMapRect,
  output: Map<string, StaticMapRect>,
  columns: number,
  minimumWidth: number,
  minimumHeight: number,
): void {
  if (items.length === 0) return;
  const sorted = items.slice().sort((left, right) => right.weight - left.weight || left.node.label.localeCompare(right.node.label, "zh-CN"));
  const gap = 14;
  const rows = Math.ceil(sorted.length / columns);
  const rowHeight = Math.max(minimumHeight, (rect.height - gap * (rows - 1)) / rows);
  for (let row = 0; row < rows; row += 1) {
    const rowItems = sorted.slice(row * columns, (row + 1) * columns);
    const widths = weightedTileWidths(rowItems, rect.width - gap * (rowItems.length - 1), minimumWidth);
    let x = rect.x;
    for (let index = 0; index < rowItems.length; index += 1) {
      const width = widths[index] ?? minimumWidth;
      output.set(rowItems[index]!.node.id, {
        x: x + 4,
        y: rect.y + row * (rowHeight + gap) + 4,
        width: Math.max(minimumWidth - 8, width - 8),
        height: Math.max(minimumHeight - 8, rowHeight - 8),
      });
      x += width + gap;
    }
  }
}

function tileColor(node: InboxTemplateGraphNode): { fill: string; text: string; accent: string } {
  if (node.presentation === "overflow") return { fill: "#f3efe8", text: "#5d554b", accent: "#8e8274" };
  if (node.kind === "note") return { fill: "#fffaf0", text: "#493629", accent: "#c58b3a" };
  if (node.kind === "cluster") return { fill: "#f0ecfb", text: "#4f456e", accent: "#8875bd" };
  if (node.kind === "platform") return { fill: "#e9f3ef", text: "#245f58", accent: "#4f9a8b" };
  return { fill: "#f8eee2", text: "#704335", accent: "#c77a5b" };
}

function tileSubtitle(node: InboxTemplateGraphNode): string {
  if (node.presentation === "overflow") return "完整内容保留在右侧列表与搜索中";
  if (node.kind === "note") return `${node.note?.status ?? "captured"} · ${node.note?.period ?? ""}`.trim();
  return `${node.count} 篇笔记`;
}

function overflowNode(nodes: InboxTemplateGraphNode[], depth: number): InboxTemplateGraphNode {
  const kind = depth >= 3 ? "note" : depth === 2 ? "cluster" : "platform";
  return {
    id: `workspace:overflow:${depth}`,
    label: `其余 ${nodes.length} 项`,
    kind,
    count: nodes.reduce((sum, node) => sum + Math.max(1, node.count), 0),
    memberPaths: [...new Set(nodes.flatMap(node => node.path ? [node.path] : node.memberPaths ?? []))],
    presentation: "overflow",
  };
}

export function buildStaticGraphLayout(
  data: InboxTemplateGraphData,
  relationEdges: StaticGraphEdge[],
): StaticGraphLayout {
  const depth = data.depth ?? 1;
  const candidates = depth === 0
    ? data.nodes.filter(node => node.kind === "area")
    : depth === 1
      ? data.nodes.filter(node => node.kind === "platform")
      : depth === 2
        ? data.nodes.filter(node => node.kind === "cluster")
        : data.nodes.filter(node => node.kind === "note");
  const sortedCandidates = candidates.slice().sort((left, right) => staticMapWeight(right) - staticMapWeight(left) || left.label.localeCompare(right.label, "zh-CN"));
  const budget = TILE_BUDGET_BY_DEPTH[depth] ?? TILE_BUDGET_BY_DEPTH[1];
  const hidden = sortedCandidates.slice(budget);
  const tileNodes = sortedCandidates.length
    ? [...sortedCandidates.slice(0, budget), ...(hidden.length ? [overflowNode(hidden, depth)] : [])]
    : data.nodes.filter(node => node.kind !== "area").slice(0, 1);
  const items = tileNodes.map(node => ({ node, weight: staticMapWeight(node) }));
  const noteLayer = depth >= 3;
  const columns = staticMapColumns(tileNodes.length, noteLayer);
  const minimumWidth = noteLayer ? 190 : 240;
  const minimumHeight = noteLayer ? 126 : 164;
  const gap = 14;
  const paddingX = 18;
  const paddingTop = 18;
  const paddingBottom = 18;
  const width = Math.max(1180, paddingX * 2 + columns * minimumWidth + (columns - 1) * gap);
  const rows = Math.max(1, Math.ceil(tileNodes.length / columns));
  const height = Math.max(640, paddingTop + paddingBottom + rows * minimumHeight + (rows - 1) * gap);
  const rootRect: StaticMapRect = { x: paddingX, y: paddingTop, width: width - paddingX * 2, height: height - paddingTop - paddingBottom };
  const rects = new Map<string, StaticMapRect>();
  layoutWeightedMapItems(items, rootRect, rects, columns, minimumWidth, minimumHeight);
  const nodes = tileNodes.map((node): StaticGraphNode => {
    const rect = rects.get(node.id) ?? { x: rootRect.x + 8, y: rootRect.y + 40, width: 160, height: 100 };
    const colors = tileColor(node);
    return {
      id: node.id,
      label: node.label,
      displayLabel: compactGraphNodeLabel(node.label, node.path ?? node.note?.path ?? node.memberPaths?.[0] ?? ""),
      type: node.kind,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      radius: Math.max(rect.width, rect.height) / 2,
      width: rect.width,
      height: rect.height,
      subtitle: tileSubtitle(node),
      metric: node.presentation === "overflow" ? "聚合入口" : node.kind === "note" ? (node.note?.folder.split("/").pop() ?? "笔记") : node.kind === "platform" ? "目录入口" : "子目录",
      color: colors.fill,
      textColor: colors.text,
      accentColor: colors.accent,
      weight: Math.max(1, node.count),
      metadata: node,
    };
  });
  const visibleIds = new Set(nodes.map(node => node.id));
  const edges = relationEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  return { nodes, edges, regions: [], width, height, hiddenTileCount: hidden.length };
}
