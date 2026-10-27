import type { GraphEdgeInput, ResolvedGraphEdge } from "./types";

/**
 * Keep every narrative edge in the source of truth, but collapse parallel
 * edges in the visual projection so a pair of nodes does not paint several
 * identical strokes and labels on top of one another.
 */
export function collapseParallelEdges<EdgeMetadata = Record<string, unknown>>(
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>,
): GraphEdgeInput<EdgeMetadata>[] {
  const groups = new Map<string, GraphEdgeInput<EdgeMetadata> & { labels: string[] }>();
  for (const edge of edges) {
    const pair = edge.source <= edge.target
      ? `${edge.source}\u0000${edge.target}`
      : `${edge.target}\u0000${edge.source}`;
    // Self loops are not currently rendered as curves, so keep them separate.
    const key = edge.source === edge.target ? `${edge.id}\u0000${pair}` : pair;
    const current = groups.get(key);
    if (current) {
      if (edge.label && !current.labels.includes(edge.label)) current.labels.push(edge.label);
      continue;
    }
    groups.set(key, { ...edge, labels: edge.label ? [edge.label] : [] });
  }
  return [...groups.values()].map(({ labels, ...edge }) => {
    const result: GraphEdgeInput<EdgeMetadata> = { ...edge };
    if (labels.length > 1) {
      result.label = `${labels[0]} +${labels.length - 1}`;
      result.metadata = {
        ...(edge.metadata ?? {}),
        parallelLabels: labels,
      } as EdgeMetadata;
    } else if (labels.length === 1) {
      result.label = labels[0]!;
    } else {
      delete result.label;
    }
    return result;
  });
}

export interface EdgeLabelPlacement {
  x: number;
  y: number;
  label: string;
  fullLabel: string;
  visible: boolean;
}

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface LabelCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  fullLabel: string;
  active: boolean;
  length: number;
}

const LABEL_FONT_SIZE = 10;
const LABEL_HEIGHT = 16;
const MAX_LABEL_CHARS = 20;

function displayLabel(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if ([...normalized].length <= MAX_LABEL_CHARS) return normalized;
  return `${[...normalized].slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

function estimateLabelWidth(value: string) {
  // Conservative by design: a false positive collision is less distracting
  // than two relationship labels painted on top of one another.
  return Math.min(224, Math.max(24, [...value].length * LABEL_FONT_SIZE * 0.82 + 10));
}

function boxFor(candidate: Pick<LabelCandidate, "x" | "y" | "width" | "height">): LabelBox {
  return {
    left: candidate.x - candidate.width / 2,
    right: candidate.x + candidate.width / 2,
    top: candidate.y - candidate.height / 2,
    bottom: candidate.y + candidate.height / 2,
  };
}

function overlap(a: LabelBox, b: LabelBox, padding = 5) {
  return a.left < b.right + padding && a.right + padding > b.left && a.top < b.bottom + padding && a.bottom + padding > b.top;
}

function edgeLength<NodeMetadata, EdgeMetadata>(edge: ResolvedGraphEdge<NodeMetadata, EdgeMetadata>) {
  return Math.hypot(edge.target.x - edge.source.x, edge.target.y - edge.source.y);
}

/** Place labels along different lanes while keeping them horizontal. */
export function layoutEdgeLabels<NodeMetadata, EdgeMetadata>(
  edges: ReadonlyArray<ResolvedGraphEdge<NodeMetadata, EdgeMetadata>>,
  selectedNodeId?: string | null,
): Map<string, EdgeLabelPlacement> {
  const candidates = edges
    .filter((edge) => Boolean(edge.label?.trim()))
    .map((edge): LabelCandidate | null => {
      const fullLabel = edge.label!.replace(/\s+/g, " ").trim();
      const label = displayLabel(fullLabel);
      const length = edgeLength(edge);
      if (length < 44 && edge.source.id !== selectedNodeId && edge.target.id !== selectedNodeId) return null;
      return {
        id: edge.id,
        x: (edge.source.x + edge.target.x) / 2,
        y: (edge.source.y + edge.target.y) / 2,
        width: estimateLabelWidth(label),
        height: LABEL_HEIGHT,
        label,
        fullLabel,
        active: !selectedNodeId || edge.source.id === selectedNodeId || edge.target.id === selectedNodeId,
        length,
      };
    })
    .filter((candidate): candidate is LabelCandidate => candidate !== null)
    .sort((left, right) => Number(right.active) - Number(left.active) || right.length - left.length || left.id.localeCompare(right.id));

  const occupied: LabelBox[] = [];
  const result = new Map<string, EdgeLabelPlacement>();
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const laneOffsets = [0, 14, -14, 28, -28, 44, -44, 62, -62, 82, -82];
  const fractions = [0.58, 0.68, 0.48, 0.78, 0.38];

  for (const candidate of candidates) {
    const edge = edgeById.get(candidate.id);
    if (!edge) continue;
    const dx = edge.target.x - edge.source.x;
    const dy = edge.target.y - edge.source.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normalX = -dy / length;
    const normalY = dx / length;
    let best: { box: LabelBox; score: number } | undefined;
    for (const fraction of fractions) {
      for (const offset of laneOffsets) {
        const pointX = edge.source.x + dx * fraction + normalX * offset;
        const pointY = edge.source.y + dy * fraction + normalY * offset;
        const trial = { ...candidate, x: pointX, y: pointY };
        const box = boxFor(trial);
        const collisions = occupied.reduce((count, item) => count + (overlap(box, item) ? 1 : 0), 0);
        const distanceFromCenter = Math.abs(fraction - 0.58) * 10 + Math.abs(offset) * 0.04;
        const score = collisions * 1_000 + distanceFromCenter;
        if (!best || score < best.score) best = { box, score };
        if (collisions === 0) break;
      }
      if (best?.score !== undefined && best.score < 1_000) break;
    }
    if (!best) continue;
    // Never knowingly paint an overlapping label. When the available lanes
    // are exhausted the lower-priority label is omitted until the user
    // narrows the view or selects a connected node.
    const visible = best.score < 1_000;
    const x = (best.box.left + best.box.right) / 2;
    const y = (best.box.top + best.box.bottom) / 2;
    if (visible) occupied.push(best.box);
    result.set(candidate.id, { x, y, label: candidate.label, fullLabel: candidate.fullLabel, visible });
  }
  return result;
}
