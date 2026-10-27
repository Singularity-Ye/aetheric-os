export const INSPIRATION_REFINEMENT_FIELDS = [
  "status",
  "refinement_status",
  "agent_status",
  "derived_note_path",
  "value_score",
  "value_reason",
  "freshness",
  "next_action",
  "refinement_protocol",
  "refinement_job_id",
  "refinement_request_id",
  "refinement_submitted_at",
  "refinement_error",
  "refinement_error_code",
  "refinement_error_layer",
  "refinement_retryable",
  "refinement_finished_at",
  "refined_at",
  "agent_updated_at",
  "updated_at",
] as const;

export interface InspirationRefinementProjection {
  effectiveFrontmatter: Record<string, unknown>;
  syncFields: Record<string, unknown> | null;
  conflict: boolean;
}

export function isCompletedInspirationRefinement(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.derived_note_path === "string"
    && frontmatter.derived_note_path.trim().length > 0;
}

export type InspirationRefinementTerminalStatus = "refined" | "failed" | "blocked" | "interrupted";

export function inspirationRefinementTerminalStatus(
  frontmatter: Record<string, unknown>,
): InspirationRefinementTerminalStatus | null {
  if (isCompletedInspirationRefinement(frontmatter)) return "refined";
  const status = typeof frontmatter.refinement_status === "string"
    ? frontmatter.refinement_status.trim().toLowerCase()
    : "";
  return ["failed", "blocked", "interrupted"].includes(status)
    ? status as InspirationRefinementTerminalStatus
    : null;
}

export function isTerminalInspirationRefinement(frontmatter: Record<string, unknown>): boolean {
  return inspirationRefinementTerminalStatus(frontmatter) !== null;
}

export function pickInspirationRefinementFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of INSPIRATION_REFINEMENT_FIELDS) {
    if (frontmatter[key] !== undefined) picked[key] = frontmatter[key];
  }
  if (isCompletedInspirationRefinement(frontmatter) && picked.refinement_status === undefined) {
    picked.refinement_status = "refined";
  }
  return picked;
}

export function copyInspirationRefinementFields(
  frontmatter: Record<string, unknown>,
  fields: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(fields)) frontmatter[key] = value;
}

/**
 * Project a source note's terminal refinement state onto a separate index card.
 *
 * A concrete derived note proves success; an explicit failed/blocked/
 * interrupted refinement status proves an unsuccessful terminal attempt. A
 * card that already points at a completed result is never regressed by failure,
 * and conflicting completed paths are never overwritten implicitly.
 */
export function buildInspirationRefinementProjection(
  cardFrontmatter: Record<string, unknown>,
  sourceFrontmatter: Record<string, unknown>,
): InspirationRefinementProjection {
  const sourceTerminalStatus = inspirationRefinementTerminalStatus(sourceFrontmatter);
  if (!sourceTerminalStatus) {
    return { effectiveFrontmatter: cardFrontmatter, syncFields: null, conflict: false };
  }

  const sourceFields = pickInspirationRefinementFields(sourceFrontmatter);
  const cardDerivedPath = typeof cardFrontmatter.derived_note_path === "string"
    ? cardFrontmatter.derived_note_path.trim()
    : "";
  const sourceDerivedPath = typeof sourceFields.derived_note_path === "string"
    ? sourceFields.derived_note_path.trim()
    : "";
  if (isCompletedInspirationRefinement(cardFrontmatter)
    && sourceTerminalStatus !== "refined") {
    return { effectiveFrontmatter: cardFrontmatter, syncFields: null, conflict: true };
  }
  if (isCompletedInspirationRefinement(cardFrontmatter)
    && cardDerivedPath
    && cardDerivedPath !== sourceDerivedPath) {
    return { effectiveFrontmatter: cardFrontmatter, syncFields: null, conflict: true };
  }

  const differs = Object.entries(sourceFields).some(([key, value]) => cardFrontmatter[key] !== value);
  return {
    effectiveFrontmatter: differs ? { ...cardFrontmatter, ...sourceFields } : cardFrontmatter,
    syncFields: differs ? sourceFields : null,
    conflict: false,
  };
}
