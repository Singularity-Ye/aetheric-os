/**
 * Visibility policy for the semantic graph lenses.
 *
 * This is deliberately a presentation policy, not a vault deletion rule.
 * Physical navigation and search keep these files reachable; graph lenses
 * simply avoid treating machine output and binary assets as knowledge nodes.
 */
const NOISE_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".codex",
  ".agents",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".staging",
  ".tmp",
  "tmp",
  "output",
  "outputs",
  "cache",
  "conversation-images-webp",
]);

const NOISE_NAME_PATTERN = /^(?:codex-clipboard|conversation[-_ ]?image|screenshot[-_]|buffer[-_])/iu;

export function normalizeGraphPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

/** Return false only when a path is machine/binary noise for graph lenses. */
export function isGraphVisiblePath(value: string): boolean {
  const path = normalizeGraphPath(value);
  if (!/\.(?:md|markdown)$/iu.test(path)) return false;
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => NOISE_DIRECTORIES.has(segment))) return false;
  if (segments.some(segment => NOISE_NAME_PATTERN.test(segment))) return false;
  return true;
}

export function graphVisibilityReason(value: string): "binary" | "machine-directory" | "machine-name" | null {
  const path = normalizeGraphPath(value);
  if (!/\.(?:md|markdown)$/iu.test(path)) return "binary";
  const segments = path.split("/").filter(Boolean);
  if (segments.some(segment => NOISE_DIRECTORIES.has(segment))) return "machine-directory";
  if (segments.some(segment => NOISE_NAME_PATTERN.test(segment))) return "machine-name";
  return null;
}
