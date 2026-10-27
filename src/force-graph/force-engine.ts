import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
} from "d3-force";
import {
  DEFAULT_GRAPH_TUNING,
  type GraphEdgeInput,
  type GraphNodeInput,
  type GraphNodeState,
  type GraphTuning,
  type ResolvedGraphEdge,
} from "./types";

type InternalNode<NodeMetadata> = GraphNodeState<NodeMetadata>;
type InternalLink<NodeMetadata, EdgeMetadata> = SimulationLinkDatum<InternalNode<NodeMetadata>> & {
  id: string;
  source: string | InternalNode<NodeMetadata>;
  target: string | InternalNode<NodeMetadata>;
  label?: string;
  type?: string;
  layout?: "force" | "context";
  weight: number;
  metadata?: EdgeMetadata;
};

export interface ForceGraphEngineOptions<NodeMetadata, EdgeMetadata> {
  nodes: ReadonlyArray<GraphNodeInput<NodeMetadata>>;
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>;
  width: number;
  height: number;
  tuning?: Partial<GraphTuning>;
}

function validateGraph<NodeMetadata, EdgeMetadata>(
  nodes: ReadonlyArray<GraphNodeInput<NodeMetadata>>,
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>,
) {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id) throw new Error("Graph node id must not be empty");
    if (ids.has(node.id)) throw new Error(`Duplicate graph node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`Graph edge ${edge.id} references an unknown node`);
    }
  }
}

export class ForceGraphEngine<NodeMetadata = Record<string, unknown>, EdgeMetadata = Record<string, unknown>> {
  private readonly width: number;
  private readonly height: number;
  private readonly nodes: Array<InternalNode<NodeMetadata>>;
  private readonly edges: Array<InternalLink<NodeMetadata, EdgeMetadata>>;
  private readonly simulationEdges: Array<InternalLink<NodeMetadata, EdgeMetadata>>;
  private readonly nodeById: Map<string, InternalNode<NodeMetadata>>;
  private readonly simulation: Simulation<InternalNode<NodeMetadata>, InternalLink<NodeMetadata, EdgeMetadata>>;
  private readonly listeners = new Set<() => void>();
  private readonly settledListeners = new Set<() => void>();
  private tuning: GraphTuning;
  private disposed = false;

  constructor(options: ForceGraphEngineOptions<NodeMetadata, EdgeMetadata>) {
    validateGraph(options.nodes, options.edges);
    this.width = options.width;
    this.height = options.height;
    this.tuning = { ...DEFAULT_GRAPH_TUNING, ...options.tuning };
    const orbit = Math.min(options.width, options.height) * 0.28;
    this.nodes = options.nodes.map((node, index) => {
      const angle = index * 2.399963229728653;
      const x = node.x ?? options.width / 2 + Math.cos(angle) * orbit;
      const y = node.y ?? options.height / 2 + Math.sin(angle) * orbit;
      return {
        ...node,
        radius: node.radius ?? 28,
        weight: node.weight ?? 1,
        x,
        y,
        vx: 0,
        vy: 0,
        ...(node.pinned ? { fx: x, fy: y } : {}),
      };
    });
    this.nodeById = new Map(this.nodes.map((node) => [node.id, node]));
    this.edges = options.edges.map((edge) => ({ ...edge, weight: edge.weight ?? 1 }));
    this.simulationEdges = this.edges.filter((edge) => edge.layout !== "context");
    this.simulation = forceSimulation<InternalNode<NodeMetadata>>(this.nodes).stop();
    this.installForces();
    this.simulation.on("tick", () => this.emit());
    this.simulation.on("end", () => this.emitSettled());
  }

  private installForces() {
    const manyBodyDistanceMax = this.tuning.manyBodyDistanceMax > 0
      ? this.tuning.manyBodyDistanceMax
      : Math.hypot(this.width, this.height) * 1.35;
    const collisionIterations = this.nodes.length >= 600
      ? 1
      : this.nodes.length >= 240
        ? Math.min(2, this.tuning.collisionIterations)
        : this.tuning.collisionIterations;
    const link = forceLink<InternalNode<NodeMetadata>, InternalLink<NodeMetadata, EdgeMetadata>>(this.simulationEdges)
      .id((node) => node.id)
      .distance((edge) => this.tuning.linkDistance / Math.max(0.45, Math.sqrt(edge.weight)))
      .strength((edge) => Math.min(1, this.tuning.linkStrength * edge.weight));
    this.simulation
      .force(
        "charge",
        forceManyBody<InternalNode<NodeMetadata>>()
          .strength(-100 * this.tuning.repelForce)
          .theta(this.tuning.manyBodyTheta)
          .distanceMax(manyBodyDistanceMax),
      )
      .force("center", forceCenter<InternalNode<NodeMetadata>>(this.width / 2, this.height / 2).strength(this.tuning.centerForce))
      .force("link", link)
      .force(
        "collide",
        forceCollide<InternalNode<NodeMetadata>>()
          .radius((node) => node.radius + this.tuning.collisionPadding)
          .iterations(collisionIterations),
      )
      .velocityDecay(this.tuning.velocityDecay)
      .alphaDecay(this.tuning.alphaDecay);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private emitSettled() {
    for (const listener of this.settledListeners) listener();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSettled(listener: () => void) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  getNodes(): ReadonlyArray<GraphNodeState<NodeMetadata>> {
    return this.nodes;
  }

  getEdges(): ReadonlyArray<ResolvedGraphEdge<NodeMetadata, EdgeMetadata>> {
    return this.edges.map((edge) => ({
      ...edge,
      source: typeof edge.source === "string" ? this.nodeById.get(edge.source)! : edge.source,
      target: typeof edge.target === "string" ? this.nodeById.get(edge.target)! : edge.target,
    }));
  }

  setTuning(next: Partial<GraphTuning>) {
    const changed = (Object.keys(next) as Array<keyof GraphTuning>)
      .some(key => next[key] !== undefined && next[key] !== this.tuning[key]);
    // React may deliver the same tuning values through a fresh object on a
    // normal render. Re-installing forces and restarting alpha in that case
    // creates the visible “twitch” loop users experience after the graph has
    // already settled.
    if (!changed) return;
    this.tuning = { ...this.tuning, ...next };
    this.installForces();
    this.simulation.alpha(0.45).restart();
  }

  restart(alpha = 1) {
    if (this.disposed) return;
    this.simulation.alpha(alpha).restart();
  }

  stop() {
    this.simulation.stop();
  }

  /** Current d3-force activity, exposed for the shell's performance pointer. */
  getAlpha() {
    return this.simulation.alpha();
  }

  tick(iterations = 1) {
    this.simulation.tick(iterations);
    this.emit();
  }

  beginDrag(nodeId: string) {
    const node = this.nodeById.get(nodeId);
    if (!node) return false;
    node.fx = node.x;
    node.fy = node.y;
    this.simulation.alphaTarget(this.tuning.dragAlpha).restart();
    return true;
  }

  dragTo(nodeId: string, x: number, y: number) {
    const node = this.nodeById.get(nodeId);
    if (!node) return false;
    node.fx = x;
    node.fy = y;
    return true;
  }

  endDrag(nodeId: string) {
    const node = this.nodeById.get(nodeId);
    if (!node) return false;
    node.fx = null;
    node.fy = null;
    this.simulation.alphaTarget(0);
    return true;
  }

  dispose() {
    this.disposed = true;
    this.simulation.stop();
    this.simulation.on("tick", null);
    this.simulation.on("end", null);
    this.listeners.clear();
    this.settledListeners.clear();
  }
}
