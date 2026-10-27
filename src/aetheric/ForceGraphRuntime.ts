import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ForceGraphSvg, type GraphEdgeLabelMode, type GraphMapRegion, type GraphPerformanceSample } from "../force-graph/force-graph-svg";
import type {
  GraphColorMap,
  GraphEdgeInput,
  GraphNodeInput,
  GraphNodeState,
  GraphTuning,
} from "../force-graph/types";
import type {
  InboxTemplateGraphData,
  InboxTemplateGraphNode,
} from "./InboxGraphAdapter";
import { buildStaticGraphLayout } from "./GraphStaticLayout";
import { compactGraphNodeLabel } from "./GraphLabel";

type GraphNode = GraphNodeInput<InboxTemplateGraphNode>;
type GraphEdge = GraphEdgeInput<{ relationType: string }>;

export interface ForceGraphRuntimeOptions {
  /** `map` is the stable semantic atlas; `force` keeps the exploratory view. */
  mode?: "force" | "map";
  onActivate?: (node: InboxTemplateGraphNode) => void;
  onSelect?: (node: InboxTemplateGraphNode | null) => void;
  onHover?: (node: InboxTemplateGraphNode | null) => void;
  onNodeDragMove?: (node: InboxTemplateGraphNode, event: PointerEvent) => void;
  onNodeDrop?: (node: InboxTemplateGraphNode, event: PointerEvent) => boolean | void;
  onPerformanceSample?: (sample: GraphPerformanceSample) => void;
  edgeLabelMode?: GraphEdgeLabelMode;
  /** Relationship-only projections opt into real force-link edges. */
  relationshipLayout?: "context" | "force";
  /** Keep the current camera when a mounted relationship lens receives data. */
  preserveViewportOnUpdate?: boolean;
}

export type ForceGraphPerformanceSample = GraphPerformanceSample;
export type ForceGraphEdgeLabelMode = GraphEdgeLabelMode;

const GRAPH_COLORS: GraphColorMap = {
  // Semantic shapes use a quiet four-color hierarchy: warm root, teal
  // directory, indigo subdirectory, ochre note. The palette remains legible
  // on the cream shell without making every node look like the same pill.
  area: "#b6533d",
  platform: "#287a70",
  cluster: "#7167a8",
  note: "#c18a35",
};

const GRAPH_TYPE_LABELS: Readonly<Record<string, string>> = {
  area: "工作域",
  platform: "目录入口",
  cluster: "子目录",
  note: "笔记",
};

const RELATION_LABELS: Readonly<Record<string, string>> = {
  classified_as_area: "归入工作域",
  captured_from_platform: "来自目录",
  topic_cluster: "目录包含",
  contains_note: "包含笔记",
  related_notes: "交叉关联",
};

const GRAPH_TUNING: Partial<GraphTuning> = Object.freeze({
  // Directory maps need breathing room more than a compact layout.
  // Context edges (cross-directory evidence) are excluded from the
  // force-link list; these settings only settle the structural tree.
  repelForce: 2.2,
  manyBodyTheta: 1.15,
  manyBodyDistanceMax: 1400,
  linkDistance: 290,
  linkStrength: 0.08,
  centerForce: 0.018,
  collisionPadding: 30,
  collisionIterations: 2,
  velocityDecay: 0.42,
  alphaDecay: 0.06,
});

function graphRadius(node: InboxTemplateGraphNode): number {
  if (node.kind === "area") return 48;
  if (node.kind === "platform") return 42;
  if (node.kind === "cluster") return 38;
  return 34;
}

function toGraphInput(
  data: InboxTemplateGraphData,
  relationshipLayout: "context" | "force" = "context",
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: data.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      displayLabel: compactGraphNodeLabel(node.label, node.path ?? node.note?.path ?? node.memberPaths?.[0] ?? ""),
      type: node.kind,
      radius: graphRadius(node),
      color: GRAPH_COLORS[node.kind],
      weight: Math.max(1, node.count),
      metadata: node,
    })),
    edges: data.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.relationType,
      label: RELATION_LABELS[edge.relationType] ?? edge.relationType,
      layout: edge.relationType === "related_notes" ? relationshipLayout : "force",
      weight: Math.max(1, edge.weight),
      metadata: { relationType: edge.relationType },
    })),
  };
}

/**
 * Obsidian-side host for the packaged Aetheric SVG force-graph renderer.
 *
 * The renderer is intentionally mounted as-is instead of being copied into a
 * second vanilla implementation.  Only the shell adapter changes directory
 * nodes into the renderer's generic node/edge contract.  Capture listeners
 * bridge the renderer's pointer drag to the existing depth/drop rails without
 * modifying the package's interaction model.
 */
export class ForceGraphRuntime {
  private readonly parent: HTMLElement;
  private options: ForceGraphRuntimeOptions;
  private readonly root: Root;
  private nodes = new Map<string, InboxTemplateGraphNode>();
  private graphNodes: GraphNode[] = [];
  private graphEdges: GraphEdge[] = [];
  private staticLayout = false;
  private mapRegions: GraphMapRegion[] = [];
  private graphWidth = 1800;
  private graphHeight = 960;
  private readonly layoutPositions = new Map<string, { x: number; y: number }>();
  private readonly pointerDownCapture: (event: PointerEvent) => void;
  private readonly pointerMoveCapture: (event: PointerEvent) => void;
  private readonly pointerUpCapture: (event: PointerEvent) => void;
  private draggedNodeId: string | null = null;
  private pointerStart = { x: 0, y: 0 };
  private resetToken = 0;
  private edgeLabelMode: GraphEdgeLabelMode;
  private selectedNodeId: string | null = null;
  private destroyed = false;

  constructor(parent: HTMLElement, data: InboxTemplateGraphData, options: ForceGraphRuntimeOptions = {}) {
    this.parent = parent;
    this.options = options;
    this.edgeLabelMode = options.edgeLabelMode ?? "explore";
    this.applyData(data);

    parent.empty();
    parent.classList.add("aos-force-graph-host");
    this.root = createRoot(parent);

    this.pointerDownCapture = (event) => {
      const target = event.target instanceof Element
        ? event.target.closest<SVGGElement>("[data-node-id]")
        : null;
      const nodeId = target?.getAttribute("data-node-id") ?? null;
      if (!nodeId || !this.nodes.has(nodeId)) return;
      this.draggedNodeId = nodeId;
      this.pointerStart = { x: event.clientX, y: event.clientY };
    };
    this.pointerMoveCapture = (event) => {
      const nodeId = this.draggedNodeId;
      const node = nodeId ? this.nodes.get(nodeId) : undefined;
      if (!node) return;
      if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) <= 3) return;
      this.options.onNodeDragMove?.(node, event);
    };
    this.pointerUpCapture = (event) => {
      const nodeId = this.draggedNodeId;
      const node = nodeId ? this.nodes.get(nodeId) : undefined;
      this.draggedNodeId = null;
      if (!node) return;
      this.options.onNodeDrop?.(node, event);
    };
    parent.addEventListener("pointerdown", this.pointerDownCapture, true);
    parent.addEventListener("pointermove", this.pointerMoveCapture, true);
    parent.addEventListener("pointerup", this.pointerUpCapture, true);
    parent.addEventListener("pointercancel", this.pointerUpCapture, true);
    this.render();
  }

  /** Replace graph data without replacing the host element or React root. */
  updateData(data: InboxTemplateGraphData, options: Partial<ForceGraphRuntimeOptions> = {}): void {
    if (this.destroyed) return;
    this.options = { ...this.options, ...options };
    if (options.edgeLabelMode) this.edgeLabelMode = options.edgeLabelMode;
    this.applyData(data);
    this.render();
    const selected = this.selectedNodeId ? this.nodes.get(this.selectedNodeId) ?? null : null;
    this.options.onSelect?.(selected);
  }

  resetViewport(): void {
    if (this.destroyed) return;
    this.resetToken += 1;
    this.render();
  }

  /** Reset the camera without restarting a semantic-map layout. */
  fitToView(): void {
    this.resetViewport();
  }

  setEdgeLabelMode(mode: GraphEdgeLabelMode): void {
    if (this.destroyed || this.edgeLabelMode === mode) return;
    this.edgeLabelMode = mode;
    this.render();
  }

  onResize(): void {
    // The SVG viewBox scales with its host. The renderer owns its simulation
    // viewport; a resize does not require replacing the graph or flashing the
    // surrounding page.
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.parent.removeEventListener("pointerdown", this.pointerDownCapture, true);
    this.parent.removeEventListener("pointermove", this.pointerMoveCapture, true);
    this.parent.removeEventListener("pointerup", this.pointerUpCapture, true);
    this.parent.removeEventListener("pointercancel", this.pointerUpCapture, true);
    this.root.unmount();
    this.options.onHover?.(null);
    this.parent.classList.remove("aos-force-graph-host");
    this.parent.empty();
  }

  private render(): void {
    this.root.render(React.createElement(ForceGraphSvg, {
      ariaLabel: "松果天工台关系图谱 · 工作台目录地图",
      className: "aos-force-graph-svg",
      colors: GRAPH_COLORS,
      edges: this.graphEdges,
      edgeLabelMode: this.edgeLabelMode,
      fitOnDataChange: !this.options.preserveViewportOnUpdate,
      height: this.graphHeight,
      initialAlpha: this.staticLayout ? 1 : 0.55,
      nodes: this.graphNodes,
      onNodeSelect: (nodeId: string) => {
        const node = this.nodes.get(nodeId) ?? null;
        this.selectedNodeId = node?.presentation === "overflow" ? null : nodeId;
        this.options.onSelect?.(node);
        if (node) this.options.onActivate?.(node);
        if (!this.destroyed) this.render();
      },
      onNodeHover: (nodeId: string | null) => {
        this.options.onHover?.(nodeId ? this.nodes.get(nodeId) ?? null : null);
      },
      resetToken: this.resetToken,
      selectedNodeId: this.selectedNodeId,
      staticLayout: this.staticLayout,
      theme: "light",
      typeLabels: GRAPH_TYPE_LABELS,
      tuning: GRAPH_TUNING,
      width: this.graphWidth,
      mapRegions: this.mapRegions,
      onPerformanceSample: this.options.onPerformanceSample,
      onLayoutFrame: (nodes: ReadonlyArray<GraphNodeState<unknown>>) => this.captureLayoutPositions(nodes),
      onLayoutSnapshot: (nodes: ReadonlyArray<GraphNodeState<unknown>>) => this.captureLayoutPositions(nodes),
    }));
  }

  private captureLayoutPositions(nodes: ReadonlyArray<GraphNodeState<unknown>>): void {
    for (const node of nodes) this.layoutPositions.set(node.id, { x: node.x, y: node.y });
  }

  private applyData(data: InboxTemplateGraphData): void {
    this.staticLayout = this.options.mode === "map";
    const relationInput = toGraphInput(data, this.options.relationshipLayout ?? "context");
    if (!this.staticLayout && this.layoutPositions.size > 0) {
      relationInput.nodes = relationInput.nodes.map(node => {
        const position = this.layoutPositions.get(node.id);
        return position ? { ...node, x: position.x, y: position.y } : node;
      });
    }
    const staticInput = this.staticLayout ? buildStaticGraphLayout(data, relationInput.edges) : null;
    const input = staticInput ?? relationInput;
    this.graphNodes = input.nodes;
    this.graphEdges = input.edges;
    this.mapRegions = staticInput?.regions ?? [];
    this.graphWidth = staticInput?.width ?? 1800;
    this.graphHeight = staticInput?.height ?? 960;
    this.nodes = new Map(input.nodes.map(node => [node.id, node.metadata!]));
    if (this.selectedNodeId && !this.nodes.has(this.selectedNodeId)) this.selectedNodeId = null;
  }
}
