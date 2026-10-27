import type { WorkspaceGraphDepth } from "./InboxGraphAdapter";
import type { GraphScope } from "./types";

export type KnowledgeGraphLens = "inbox" | "native" | "relation";
export type KnowledgeGraphDetail = "overview" | "focus";

export const DEFAULT_RELATION_NODE_BUDGET = 48;
export const RELATION_NODE_BUDGET_STEP = 32;
export const MAX_RELATION_NODE_BUDGET = 160;

export interface GraphModuleState {
  scope: GraphScope;
  lens: KnowledgeGraphLens;
  folderPath?: string;
  semanticFolderPath?: string;
  depth: WorkspaceGraphDepth;
  focus?: string;
  detail: KnowledgeGraphDetail;
  relationNodeBudget: number;
}

export interface GraphModuleContext {
  selectedFilePath: string | null;
  selectedFolderPath: string;
  selectedNoteFolderPath?: string;
  /** Parent folder of the latest Markdown document actually opened in Obsidian. */
  activeDocumentFolderPath?: string;
  workspaceRootPaths: readonly string[];
  folderExists: (path: string) => boolean;
}

export interface RelationshipEntryResult {
  state: GraphModuleState;
  blocked: boolean;
  reason?: "missing-folder" | "workspace-root";
}

export function normalizeGraphPath(value?: string | null): string {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function isGraphWorkspaceRoot(path: string, roots: readonly string[]): boolean {
  const normalized = normalizeGraphPath(path);
  return Boolean(normalized) && roots.some(root => normalizeGraphPath(root) === normalized);
}

export function isGraphPathWithinWorkspace(path: string, roots: readonly string[]): boolean {
  const normalized = normalizeGraphPath(path);
  return Boolean(normalized) && roots.some(rootValue => {
    const root = normalizeGraphPath(rootValue);
    return Boolean(root) && (normalized === root || normalized.startsWith(`${root}/`));
  });
}

export function normalizeRelationNodeBudget(value?: number | null): number {
  const numeric = Number.isFinite(value) ? Math.floor(Number(value)) : DEFAULT_RELATION_NODE_BUDGET;
  return Math.max(DEFAULT_RELATION_NODE_BUDGET, Math.min(MAX_RELATION_NODE_BUDGET, numeric));
}

export function expandRelationNodeBudget(value: number): number {
  return normalizeRelationNodeBudget(value + RELATION_NODE_BUDGET_STEP);
}

function firstExistingFolder(context: GraphModuleContext, candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const normalized = normalizeGraphPath(candidate);
    if (normalized && context.folderExists(normalized)) return normalized;
  }
  return "";
}

/**
 * Enter the graph module through a predictable directory-map state. Previous
 * force-graph lenses are deliberately not replayed across module boundaries.
 */
export function prepareGraphModuleEntry(context: GraphModuleContext): GraphModuleState {
  const folderPath = firstExistingFolder(context, [
    context.activeDocumentFolderPath,
    context.selectedNoteFolderPath,
    context.selectedFolderPath,
    ...context.workspaceRootPaths,
  ]);
  return {
    scope: folderPath ? "current-folder" : "current-workspace",
    lens: "native",
    folderPath: folderPath || undefined,
    semanticFolderPath: folderPath || undefined,
    depth: 1,
    focus: undefined,
    detail: "overview",
    relationNodeBudget: DEFAULT_RELATION_NODE_BUDGET,
  };
}

/**
 * Normalize stale history/index state before a renderer mounts. The function
 * never broadens an implicit relationship request to a workspace or Vault.
 */
export function normalizeGraphModuleState(
  current: GraphModuleState,
  context: GraphModuleContext,
): GraphModuleState {
  const next: GraphModuleState = {
    ...current,
    folderPath: normalizeGraphPath(current.folderPath) || undefined,
    semanticFolderPath: normalizeGraphPath(current.semanticFolderPath) || undefined,
    relationNodeBudget: normalizeRelationNodeBudget(current.relationNodeBudget),
  };

  if (next.lens !== "inbox" && next.scope === "current-file" && !context.selectedFilePath) {
    const fallback = firstExistingFolder(context, [context.activeDocumentFolderPath, next.folderPath, context.selectedFolderPath]);
    next.lens = "native";
    next.scope = fallback ? "current-folder" : "current-workspace";
    next.folderPath = fallback || undefined;
    next.semanticFolderPath = fallback || undefined;
  }

  if (next.lens === "relation" && next.scope === "current-folder") {
    const folder = firstExistingFolder(context, [next.folderPath, context.activeDocumentFolderPath, context.selectedFolderPath]);
    if (!folder || isGraphWorkspaceRoot(folder, context.workspaceRootPaths)) {
      next.lens = "native";
      next.folderPath = folder || next.folderPath;
      next.semanticFolderPath = folder || next.semanticFolderPath;
    }
  }
  return next;
}

/** Resolve a relationship request to a real child folder or return a blocked
 * directory-map state. A selected note may safely refine a workspace root to
 * its own parent folder. */
export function enterGraphRelationship(
  current: GraphModuleState,
  requestedFolderPath: string | undefined,
  context: GraphModuleContext,
): RelationshipEntryResult {
  let candidate = normalizeGraphPath(
    requestedFolderPath
      || current.semanticFolderPath
      || current.folderPath
      || context.activeDocumentFolderPath
      || context.selectedFolderPath,
  );
  const selectedNoteFolder = normalizeGraphPath(context.selectedNoteFolderPath);
  if (
    isGraphWorkspaceRoot(candidate, context.workspaceRootPaths)
    && selectedNoteFolder
    && !isGraphWorkspaceRoot(selectedNoteFolder, context.workspaceRootPaths)
    && context.folderExists(selectedNoteFolder)
  ) {
    candidate = selectedNoteFolder;
  }
  const folder = firstExistingFolder(context, [candidate, context.activeDocumentFolderPath, context.selectedFolderPath]);
  const base: GraphModuleState = {
    ...current,
    scope: "current-folder",
    folderPath: folder || undefined,
    semanticFolderPath: folder || current.semanticFolderPath,
    focus: undefined,
    detail: "overview",
    relationNodeBudget: DEFAULT_RELATION_NODE_BUDGET,
  };
  if (!folder) return { state: { ...base, lens: "native" }, blocked: true, reason: "missing-folder" };
  if (isGraphWorkspaceRoot(folder, context.workspaceRootPaths)) {
    return { state: { ...base, lens: "native" }, blocked: true, reason: "workspace-root" };
  }
  return { state: { ...base, lens: "relation" }, blocked: false };
}
