import {
  App,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  getAllTags,
  normalizePath,
} from "obsidian";
import {
  AethericWorkspace,
  GraphData,
  GraphScope,
  IndexedFile,
  KnowledgeNodeKind,
  KnowledgeNodeViewModel,
} from "./types";
import { isGraphVisiblePath } from "./GraphVisibilityPolicy";
import { collectCandidateGraphEdges } from "./GraphQuery";
import { isKnowledgeIndexableFolderPath, isKnowledgeIndexablePath } from "./KnowledgeIndexPolicy";

export interface VaultIndexChange {
  version: number;
  structureChanged: boolean;
  contentChanged: boolean;
  relationsChanged: boolean;
}

export interface VaultIndexBuildMetrics {
  totalMs: number;
  scanMs: number;
  folderLookupMs: number;
  relationsMs: number;
  emitMs: number;
  loadedEntries: number;
  indexedFiles: number;
  indexedFolders: number;
}

type VaultIndexChangeFlags = Omit<VaultIndexChange, "version">;
type IndexListener = (change: VaultIndexChange) => void;

const INDEX_EMIT_DEBOUNCE_MS = 72;
const RELATION_REBUILD_IDLE_TIMEOUT_MS = 900;

const EMPTY_INDEX_CHANGE: VaultIndexChangeFlags = {
  structureChanged: false,
  contentChanged: false,
  relationsChanged: false,
};

export class VaultIndexService {
  private filesByPath = new Map<string, IndexedFile>();
  private foldersByPath = new Map<string, TFolder>();
  private childFoldersByParent = new Map<string, TFolder[]>();
  private outgoingBySource = new Map<string, string[]>();
  private outgoingWeightsBySource = new Map<string, Map<string, number>>();
  private backlinksByTarget = new Map<string, Set<string>>();
  private unresolvedCounts = new Map<string, number>();
  private graphFilesByMtime: IndexedFile[] | null = null;
  private filteredFilesCache = new Map<string, IndexedFile[]>();
  private fileListCache = new Map<string, KnowledgeNodeViewModel[]>();
  private searchCache = new Map<string, KnowledgeNodeViewModel[]>();
  private listeners = new Set<IndexListener>();
  private ready = false;
  private version = 0;
  private emitTimer: number | null = null;
  private relationRebuildHandle: number | null = null;
  private relationRebuildUsesIdleCallback = false;
  private pendingChange: VaultIndexChangeFlags = { ...EMPTY_INDEX_CHANGE };

  constructor(private app: App, private plugin: Plugin) {}

  start(): void {
    this.plugin.registerEvent(this.app.vault.on("create", file => this.handleCreate(file)));
    this.plugin.registerEvent(this.app.vault.on("modify", file => this.handleModify(file)));
    this.plugin.registerEvent(this.app.vault.on("delete", file => this.handleDelete(file)));
    this.plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.plugin.registerEvent(this.app.metadataCache.on("changed", file => {
      if (this.indexFile(file)) this.scheduleEmit({ contentChanged: true });
    }));
    this.plugin.registerEvent(this.app.metadataCache.on("resolved", () => {
      this.scheduleRelationRebuild();
    }));
    this.plugin.register(() => this.disposePendingWork());
  }

  async build(): Promise<VaultIndexBuildMetrics> {
    const startedAt = performance.now();
    this.filesByPath.clear();
    this.foldersByPath.clear();
    const loadedFiles = this.app.vault.getAllLoadedFiles();
    for (const abstractFile of loadedFiles) {
      if (abstractFile instanceof TFolder && isKnowledgeIndexableFolderPath(abstractFile.path)) {
        this.foldersByPath.set(abstractFile.path, abstractFile);
      }
      if (abstractFile instanceof TFile) this.indexFile(abstractFile);
    }
    const scanFinishedAt = performance.now();
    this.rebuildFolderLookup();
    const folderLookupFinishedAt = performance.now();
    this.rebuildRelationIndex();
    const relationsFinishedAt = performance.now();
    this.ready = true;
    this.emit({ structureChanged: true, contentChanged: true, relationsChanged: true });
    const finishedAt = performance.now();
    return {
      totalMs: finishedAt - startedAt,
      scanMs: scanFinishedAt - startedAt,
      folderLookupMs: folderLookupFinishedAt - scanFinishedAt,
      relationsMs: relationsFinishedAt - folderLookupFinishedAt,
      emitMs: finishedAt - relationsFinishedAt,
      loadedEntries: loadedFiles.length,
      indexedFiles: this.filesByPath.size,
      indexedFolders: this.foldersByPath.size,
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  subscribe(listener: IndexListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getFilteredFiles(workspace: AethericWorkspace | null): IndexedFile[] {
    const roots = workspace?.rootPaths?.map(root => normalizePath(root)).sort() ?? [];
    const cacheKey = roots.length ? roots.join("\u0000") : "__vault__";
    const cached = this.filteredFilesCache.get(cacheKey);
    if (cached) return cached;
    const files = roots.length === 0
      ? [...this.filesByPath.values()]
      : [...this.filesByPath.values()].filter(file => roots.some(root => this.isWithin(file.path, root)));
    this.filteredFilesCache.set(cacheKey, files);
    return files;
  }

  getFileCount(workspace: AethericWorkspace | null = null): number {
    return this.getFilteredFiles(workspace).length;
  }

  getTotalSize(workspace: AethericWorkspace | null = null): number {
    let total = 0;
    const files = this.getFilteredFiles(workspace);
    for (const file of files) total += file.size;
    return total;
  }

  getIndexedFile(path: string): IndexedFile | undefined {
    return this.filesByPath.get(normalizePath(path));
  }

  getFolder(path: string): TFolder | undefined {
    return this.foldersByPath.get(normalizePath(path));
  }

  getChildFolders(parentPath: string): TFolder[] {
    const parent = normalizePath(parentPath);
    return this.childFoldersByParent.get(parent) ?? [];
  }

  listFiles(folderPath: string): KnowledgeNodeViewModel[] {
    const folder = normalizePath(folderPath);
    const cached = this.fileListCache.get(folder);
    if (cached) return cached;
    const nodes = [...this.filesByPath.values()]
      .filter(file => this.isWithin(file.path, folder))
      .map(file => this.toKnowledgeNode(file))
      .sort((a, b) => b.mtime - a.mtime);
    this.fileListCache.set(folder, nodes);
    return nodes;
  }

  listFilesRecursive(rootPaths: string[]): IndexedFile[] {
    const roots = rootPaths.map(value => normalizePath(value));
    return [...this.filesByPath.values()].filter(file => roots.some(root => this.isWithin(file.path, root)));
  }

  search(
    query: string,
    workspace: AethericWorkspace | null,
    folderPath: string,
    scope: "current-folder" | "current-workspace" | "vault",
  ): KnowledgeNodeViewModel[] {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    if (!needle) return this.listFiles(folderPath);
    const folder = normalizePath(folderPath);
    const workspaceRoots = workspace?.rootPaths?.map(root => normalizePath(root)).sort().join("\u0000") ?? "";
    const cacheKey = `${scope}\u0001${folder}\u0001${workspaceRoots}\u0001${needle}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;
    const files = [...this.filesByPath.values()].filter(file => {
      if (scope === "current-folder" && !this.isWithin(file.path, folder)) return false;
      if (scope === "current-workspace" && workspace && !workspace.rootPaths.some(root => this.isWithin(file.path, normalizePath(root)))) return false;
      const haystack = `${file.basename} ${file.path} ${file.tags.join(" ")}`.toLocaleLowerCase("zh-CN");
      return haystack.includes(needle);
    });
    const nodes = files.map(file => this.toKnowledgeNode(file)).sort((a, b) => b.mtime - a.mtime);
    // Search input is naturally high-cardinality. Keep only a small working set
    // so backspace/repeated queries are instant without turning the cache into a
    // second copy of the Vault index.
    if (this.searchCache.size >= 32) this.searchCache.delete(this.searchCache.keys().next().value as string);
    this.searchCache.set(cacheKey, nodes);
    return nodes;
  }

  countModifiedSince(timestamp: number, workspace: AethericWorkspace | null = null): number {
    let count = 0;
    const files = this.getFilteredFiles(workspace);
    for (const file of files) if (file.mtime >= timestamp) count += 1;
    return count;
  }

  getActivityByDay(days: number, workspace: AethericWorkspace | null = null): Map<string, number> {
    const map = new Map<string, number>();
    const start = Date.now() - days * 86400000;
    const files = this.getFilteredFiles(workspace);
    for (const file of files) {
      if (file.mtime < start) continue;
      const date = new Date(file.mtime);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      const key = `${y}-${m}-${d}`;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }

  getCategoryDistribution(limit = 6, workspace: AethericWorkspace | null = null): Array<{ label: string; count: number }> {
    const counts = new Map<string, number>();
    const files = this.getFilteredFiles(workspace);
    for (const file of files) {
      let label = "根目录";
      if (workspace && workspace.rootPaths && workspace.rootPaths.length > 0) {
        const matchingRoot = workspace.rootPaths.find(p => file.path.startsWith(p));
        if (matchingRoot) {
          const relative = file.path.substring(matchingRoot.length);
          const parts = relative.split("/").filter(p => p);
          label = parts.length > 1 ? parts[0] : (workspace.name || "工作域");
        } else {
          const parts = file.path.split("/");
          label = parts.length > 1 ? parts[0] : "根目录";
        }
      } else {
        const parts = file.path.split("/");
        label = parts.length > 1 ? parts[0] : "根目录";
      }
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  getRelationCounts(path: string): { outgoing: number; backlinks: number; unresolved: number } {
    const normalized = normalizePath(path);
    return {
      outgoing: this.outgoingBySource.get(normalized)?.length ?? 0,
      backlinks: this.backlinksByTarget.get(normalized)?.size ?? 0,
      unresolved: this.unresolvedCounts.get(normalized) ?? 0,
    };
  }

  getOutgoingPaths(path: string): readonly string[] {
    return this.outgoingBySource.get(normalizePath(path)) ?? [];
  }

  getBacklinkPaths(path: string): readonly string[] {
    return [...(this.backlinksByTarget.get(normalizePath(path)) ?? [])];
  }

  getGraphData(
    seedPath: string | null,
    scope: GraphScope,
    workspace: AethericWorkspace | null,
    folderPath: string,
    limit = 64,
  ): GraphData {
    const normalizedSeed = seedPath ? normalizePath(seedPath) : null;
    const candidates = new Map<string, { file: IndexedFile; depth: number }>();

    // Graph lenses share one presentation policy across every workspace. This
    // does not affect list/search/navigation; it only keeps machine output and
    // binary assets out of relationship-map candidate pools.
    if (normalizedSeed && !isGraphVisiblePath(normalizedSeed)) {
      return { nodes: [], edges: [], truncated: false };
    }

    // A missing/stale current-file seed is an empty local graph, never permission
    // to fall through to the broad candidate pool. This is especially important
    // while the initial Vault index is still being built.
    if (scope === "current-file" && (!normalizedSeed || !this.filesByPath.has(normalizedSeed))) {
      return { nodes: [], edges: [], truncated: false };
    }

    if (scope === "current-file" && normalizedSeed) {
      const queue: Array<{ path: string; depth: number }> = [{ path: normalizedSeed, depth: 0 }];
      while (queue.length && candidates.size < limit) {
        const current = queue.shift()!;
        if (candidates.has(current.path) || current.depth > 1) continue;
        if (!isGraphVisiblePath(current.path)) continue;
        const file = this.filesByPath.get(current.path);
        if (!file) continue;
        candidates.set(current.path, { file, depth: current.depth });
        for (const related of this.getRelatedPaths(current.path)) {
          if (!candidates.has(related)) queue.push({ path: related, depth: current.depth + 1 });
        }
      }
    } else {
      const seed = normalizedSeed ? this.filesByPath.get(normalizedSeed) : undefined;
      const seedTag = seed?.tags[0];
      const matchesScope = (file: IndexedFile): boolean => {
        if (!isGraphVisiblePath(file.path)) return false;
        if (scope === "current-folder") return this.isWithin(file.path, normalizePath(folderPath));
        if (scope === "current-workspace") return Boolean(workspace?.rootPaths.some(root => this.isWithin(file.path, normalizePath(root))));
        if (scope === "current-tag") return !!seedTag && file.tags.includes(seedTag);
        return true;
      };
      const pool = this.getGraphFilesByMtime();
      // The selected shell note may belong to a different tab/workspace. It is
      // a seed only when it satisfies the same scope predicate as every other
      // candidate; otherwise a supposedly local graph leaks an outside node.
      if (seed && matchesScope(seed)) candidates.set(seed.path, { file: seed, depth: 0 });
      for (const file of pool) {
        if (candidates.size >= limit) break;
        if (!candidates.has(file.path)) candidates.set(file.path, { file, depth: 1 });
      }
    }

    const pathSet = new Set(candidates.keys());
    const edges = collectCandidateGraphEdges(pathSet, this.outgoingWeightsBySource, 320);
    return {
      nodes: [...candidates.values()].map(({ file, depth }) => {
        const node = this.toKnowledgeNode(file);
        return { path: file.path, title: node.title, kind: node.kind, depth };
      }),
      edges,
      truncated: candidates.size >= limit || edges.length >= 320,
    };
  }

  private getRelatedPaths(path: string): string[] {
    const normalized = normalizePath(path);
    const related = new Set(this.outgoingBySource.get(normalized) ?? []);
    for (const source of this.backlinksByTarget.get(normalized) ?? []) related.add(source);
    return [...related];
  }

  private getGraphFilesByMtime(): IndexedFile[] {
    if (!this.graphFilesByMtime) {
      this.graphFilesByMtime = [...this.filesByPath.values()]
        .filter(file => isGraphVisiblePath(file.path))
        .sort((left, right) => right.mtime - left.mtime);
    }
    return this.graphFilesByMtime;
  }

  private rebuildRelationIndex(): void {
    const outgoingBySource = new Map<string, string[]>();
    const outgoingWeightsBySource = new Map<string, Map<string, number>>();
    const backlinksByTarget = new Map<string, Set<string>>();
    const unresolvedCounts = new Map<string, number>();

    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      const normalizedSource = normalizePath(source);
      if (!this.filesByPath.has(normalizedSource)) continue;
      const targetWeights = new Map<string, number>();
      for (const [target, weight] of Object.entries(targets)) {
        const normalizedTarget = normalizePath(target);
        if (!this.filesByPath.has(normalizedTarget)) continue;
        targetWeights.set(normalizedTarget, weight);
      }
      const targetPaths = [...targetWeights.keys()];
      outgoingBySource.set(normalizedSource, targetPaths);
      outgoingWeightsBySource.set(normalizedSource, targetWeights);
      for (const target of targetPaths) {
        let backlinks = backlinksByTarget.get(target);
        if (!backlinks) {
          backlinks = new Set<string>();
          backlinksByTarget.set(target, backlinks);
        }
        backlinks.add(normalizedSource);
      }
    }

    for (const [source, targets] of Object.entries(this.app.metadataCache.unresolvedLinks)) {
      const normalizedSource = normalizePath(source);
      if (this.filesByPath.has(normalizedSource)) unresolvedCounts.set(normalizedSource, Object.keys(targets).length);
    }

    this.outgoingBySource = outgoingBySource;
    this.outgoingWeightsBySource = outgoingWeightsBySource;
    this.backlinksByTarget = backlinksByTarget;
    this.unresolvedCounts = unresolvedCounts;
    this.fileListCache.clear();
    this.searchCache.clear();
  }

  private indexFile(file: TFile): boolean {
    if (!isKnowledgeIndexablePath(file.path, file.extension)) {
      const removed = this.filesByPath.delete(file.path);
      if (removed) this.invalidateFileCaches();
      return removed;
    }

    if (file.path.startsWith("08_密室/")) {
      const allowed = [
        "08_密室/todo.md",
        "08_密室/林下工作台.md",
        "08_密室/待办池.md",
        "08_密室/灵感池.md"
      ];
      const isAllowed = allowed.includes(file.path) || file.path.startsWith("08_密室/生活计划/");
      if (!isAllowed) return false;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    const indexed: IndexedFile = {
      path: file.path,
      name: file.name,
      basename: file.basename,
      extension: file.extension,
      parentPath: file.parent?.path ?? "",
      mtime: file.stat.mtime,
      ctime: file.stat.ctime,
      size: file.stat.size,
      tags,
      frontmatter: cache?.frontmatter ? { ...cache.frontmatter } : {},
    };
    const previous = this.filesByPath.get(file.path);
    if (previous && this.sameIndexedFile(previous, indexed)) return false;
    this.filesByPath.set(file.path, indexed);
    this.invalidateFileCaches();
    return true;
  }

  private toKnowledgeNode(file: IndexedFile): KnowledgeNodeViewModel {
    const frontmatter = file.frontmatter;
    const relations = this.getRelationCounts(file.path);
    const agent = typeof frontmatter.last_agent === "string" ? frontmatter.last_agent : undefined;
    const action = typeof frontmatter.last_agent_action === "string" ? frontmatter.last_agent_action : undefined;
    return {
      ...file,
      title: typeof frontmatter.title === "string" ? frontmatter.title : file.basename,
      kind: this.inferKind(file),
      lifecycleStatus: typeof frontmatter.status === "string" ? frontmatter.status : undefined,
      relationCount: relations.outgoing + relations.backlinks,
      lastAgent: agent && action ? { agent, action } : undefined,
    };
  }

  private inferKind(file: IndexedFile): KnowledgeNodeKind {
    const type = typeof file.frontmatter.type === "string" ? file.frontmatter.type.toLowerCase() : "";
    if (type.includes("project")) return "project";
    if (type.includes("report") || /报告|审计/.test(file.basename)) return "report";
    if (["csv", "json", "xlsx", "xls"].includes(file.extension)) return "dataset";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"].includes(file.extension)) return "asset";
    if (file.extension === "md") return "note";
    return "other";
  }

  private handleCreate(file: TAbstractFile): void {
    let structureChanged = false;
    let contentChanged = false;
    if (file instanceof TFolder && isKnowledgeIndexableFolderPath(file.path)) {
      this.foldersByPath.set(file.path, file);
      this.rebuildFolderLookup();
      structureChanged = true;
    }
    if (file instanceof TFile) contentChanged = this.indexFile(file);
    if (structureChanged || contentChanged) this.scheduleEmit({ structureChanged, contentChanged });
  }

  private handleModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (this.indexFile(file)) this.scheduleEmit({ contentChanged: true });
  }

  private handleDelete(file: TAbstractFile): void {
    let fileIndexChanged = false;
    if (file instanceof TFolder) {
      this.foldersByPath.delete(file.path);
      for (const path of [...this.foldersByPath.keys()]) {
        if (this.isWithin(path, file.path)) this.foldersByPath.delete(path);
      }
      for (const path of [...this.filesByPath.keys()]) {
        if (!this.isWithin(path, file.path)) continue;
        this.filesByPath.delete(path);
        fileIndexChanged = true;
      }
      this.rebuildFolderLookup();
    }
    if (file instanceof TFile) fileIndexChanged = this.filesByPath.delete(file.path) || fileIndexChanged;
    if (fileIndexChanged) this.invalidateFileCaches();
    const structureChanged = file instanceof TFolder;
    if (structureChanged || fileIndexChanged) {
      this.scheduleEmit({ structureChanged, contentChanged: fileIndexChanged });
    }
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    const normalizedOld = normalizePath(oldPath);
    let structureChanged = false;
    let contentChanged = false;
    if (file instanceof TFile) {
      contentChanged = this.filesByPath.delete(normalizedOld);
      contentChanged = this.indexFile(file) || contentChanged;
    }
    if (file instanceof TFolder) {
      structureChanged = true;
      contentChanged = true;
      for (const path of [...this.foldersByPath.keys()]) if (this.isWithin(path, normalizedOld)) this.foldersByPath.delete(path);
      for (const path of [...this.filesByPath.keys()]) if (this.isWithin(path, normalizedOld)) this.filesByPath.delete(path);
      for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
        if (abstractFile instanceof TFolder
          && this.isWithin(abstractFile.path, file.path)
          && isKnowledgeIndexableFolderPath(abstractFile.path)) {
          this.foldersByPath.set(abstractFile.path, abstractFile);
        }
        if (abstractFile instanceof TFile && this.isWithin(abstractFile.path, file.path)) this.indexFile(abstractFile);
      }
      this.rebuildFolderLookup();
    }
    if (contentChanged) this.invalidateFileCaches();
    if (structureChanged || contentChanged) this.scheduleEmit({ structureChanged, contentChanged });
  }

  private isWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
  }

  private rebuildFolderLookup(): void {
    const lookup = new Map<string, TFolder[]>();
    for (const folder of this.foldersByPath.values()) {
      const parentPath = folder.parent?.path ?? "";
      const siblings = lookup.get(parentPath) ?? [];
      siblings.push(folder);
      lookup.set(parentPath, siblings);
    }
    for (const siblings of lookup.values()) siblings.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    this.childFoldersByParent = lookup;
  }

  private sameIndexedFile(left: IndexedFile, right: IndexedFile): boolean {
    if (
      left.name !== right.name
      || left.basename !== right.basename
      || left.extension !== right.extension
      || left.parentPath !== right.parentPath
      || left.mtime !== right.mtime
      || left.ctime !== right.ctime
      || left.size !== right.size
      || left.tags.length !== right.tags.length
    ) return false;
    for (let index = 0; index < left.tags.length; index += 1) {
      if (left.tags[index] !== right.tags[index]) return false;
    }
    return JSON.stringify(left.frontmatter) === JSON.stringify(right.frontmatter);
  }

  private invalidateFileCaches(): void {
    this.graphFilesByMtime = null;
    this.filteredFilesCache.clear();
    this.fileListCache.clear();
    this.searchCache.clear();
  }

  private scheduleRelationRebuild(): void {
    if (this.relationRebuildHandle !== null) return;
    const run = (): void => {
      this.relationRebuildHandle = null;
      this.relationRebuildUsesIdleCallback = false;
      this.rebuildRelationIndex();
      this.scheduleEmit({ relationsChanged: true });
    };
    if (typeof window.requestIdleCallback === "function") {
      this.relationRebuildUsesIdleCallback = true;
      this.relationRebuildHandle = window.requestIdleCallback(run, { timeout: RELATION_REBUILD_IDLE_TIMEOUT_MS });
      return;
    }
    this.relationRebuildHandle = window.setTimeout(run, INDEX_EMIT_DEBOUNCE_MS * 2);
  }

  private emit(change: VaultIndexChangeFlags): void {
    const payload: VaultIndexChange = { ...change, version: ++this.version };
    for (const listener of this.listeners) listener(payload);
  }

  private scheduleEmit(change: Partial<VaultIndexChangeFlags> = {}): void {
    this.pendingChange.structureChanged ||= change.structureChanged === true;
    this.pendingChange.contentChanged ||= change.contentChanged === true;
    this.pendingChange.relationsChanged ||= change.relationsChanged === true;
    if (this.emitTimer !== null) return;
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = null;
      const pending = this.pendingChange;
      this.pendingChange = { ...EMPTY_INDEX_CHANGE };
      this.emit(pending);
    }, INDEX_EMIT_DEBOUNCE_MS);
  }

  private disposePendingWork(): void {
    if (this.emitTimer !== null) window.clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (this.relationRebuildHandle !== null) {
      if (this.relationRebuildUsesIdleCallback && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(this.relationRebuildHandle);
      } else {
        window.clearTimeout(this.relationRebuildHandle);
      }
    }
    this.relationRebuildHandle = null;
    this.relationRebuildUsesIdleCallback = false;
  }
}
