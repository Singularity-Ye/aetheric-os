const KNOWLEDGE_INDEX_EXTENSIONS = new Set(["md"]);
const MACHINE_DIRECTORY_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  "venv",
  "target",
  "out",
]);

/**
 * The workbench index represents knowledge documents, not every file that
 * happens to live inside the Vault. Binary assets, source code, logs and
 * machine output keep their own feature-specific access paths and must not
 * inflate navigation/search/relationship state.
 */
export function isKnowledgeIndexableExtension(extension: string): boolean {
  return KNOWLEDGE_INDEX_EXTENSIONS.has(extension.trim().toLowerCase());
}

export function isKnowledgeIndexableFolderPath(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .every(segment => !segment.startsWith(".") && !MACHINE_DIRECTORY_SEGMENTS.has(segment.toLowerCase()));
}

export function isKnowledgeIndexablePath(path: string, extension: string): boolean {
  return isKnowledgeIndexableExtension(extension) && isKnowledgeIndexableFolderPath(path);
}
