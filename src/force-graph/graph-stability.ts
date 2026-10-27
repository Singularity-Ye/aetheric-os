import type { GraphEdgeInput, GraphNodeInput } from "./types";

/**
 * Creates a render-data signature without serialising arbitrary metadata.
 *
 * Both React renderers receive arrays assembled by their business layer. A
 * fresh array is not necessarily a new graph. Keeping this signature narrow
 * lets a renderer ignore identity-only changes while still rebuilding when a
 * visible graph attribute actually changes.
 */
export function graphInputSignature<NodeMetadata, EdgeMetadata>(
  nodes: ReadonlyArray<GraphNodeInput<NodeMetadata>>,
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>,
): string {
  return JSON.stringify({
    nodes: nodes.map((node) => [
      node.id,
      node.label,
      node.displayLabel ?? null,
      node.type,
      node.x ?? null,
      node.y ?? null,
      node.radius ?? null,
      node.width ?? null,
      node.height ?? null,
      node.subtitle ?? null,
      node.metric ?? null,
      node.textColor ?? null,
      node.color ?? null,
      node.imageUrl ?? null,
      node.weight ?? null,
      node.pinned ?? false,
    ]),
    edges: edges.map((edge) => [
      edge.id,
      edge.source,
      edge.target,
      edge.label ?? null,
      edge.type ?? null,
      edge.weight ?? null,
    ]),
  });
}

/** Topology-only key for callers that update labels/metadata separately. */
export function graphTopologySignature<NodeMetadata, EdgeMetadata>(
  nodes: ReadonlyArray<GraphNodeInput<NodeMetadata>>,
  edges: ReadonlyArray<GraphEdgeInput<EdgeMetadata>>,
): string {
  return JSON.stringify({
    nodes: nodes.map((node) => node.id),
    edges: edges.map((edge) => [edge.id, edge.source, edge.target]),
  });
}
