export interface WeightedGraphAdjacency {
  get(source: string): ReadonlyMap<string, number> | undefined;
}

export interface IndexedGraphEdge {
  source: string;
  target: string;
  weight: number;
}

/**
 * Resolve only the edges owned by the candidate nodes already admitted to the
 * current graph lens.  The previous implementation walked every resolved link
 * in the Vault even when the canvas budget was only 48 nodes.
 */
export function collectCandidateGraphEdges(
  candidatePaths: ReadonlySet<string>,
  adjacency: WeightedGraphAdjacency,
  limit = 320,
): IndexedGraphEdge[] {
  const edges: IndexedGraphEdge[] = [];
  if (limit <= 0 || candidatePaths.size === 0) return edges;

  for (const source of candidatePaths) {
    const targets = adjacency.get(source);
    if (!targets) continue;
    for (const [target, weight] of targets) {
      if (!candidatePaths.has(target)) continue;
      edges.push({ source, target, weight });
      if (edges.length >= limit) return edges;
    }
  }
  return edges;
}
