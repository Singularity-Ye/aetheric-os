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

type IndexListener = () => void;

export class VaultIndexService {
  private filesByPath = new Map<string, IndexedFile>();
  private foldersByPath = new Map<string, TFolder>();
  private outgoingBySource = new Map<string, string[]>();
  private backlinksByTarget = new Map<string, Set<string>>();
  private unresolvedCounts = new Map<string, number>();
  private listeners = new Set<IndexListener>();
  private ready = false;
  private emitFrame: number | null = null;

  constructor(private app: App, private plugin: Plugin) {}

  start(): void {
    this.plugin.registerEvent(this.app.vault.on("create", file => this.handleCreate(file)));
    this.plugin.registerEvent(this.app.vault.on("modify", file => this.handleModify(file)));
    this.plugin.registerEvent(this.app.vault.on("delete", file => this.handleDelete(file)));
    this.plugin.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.plugin.registerEvent(this.app.metadataCache.on("changed", file => {
      this.indexFile(file);
      this.scheduleEmit();
    }));
    this.plugin.registerEvent(this.app.metadataCache.on("resolved", () => {
      this.rebuildRelationIndex();
      this.scheduleEmit();
    }));
  }

  async build(): Promise<void> {
    this.filesByPath.clear();
    this.foldersByPath.clear();
    for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
      if (abstractFile instanceof TFolder) this.foldersByPath.set(abstractFile.path, abstractFile);
      if (abstractFile instanceof TFile) this.indexFile(abstractFile);
    }
    this.rebuildRelationIndex();
    this.ready = true;
    this.emit();
  }

  isReady(): boolean {
    return this.ready;
  }

  subscribe(listener: IndexListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getFilteredFiles(workspace: AethericWorkspace | null): IndexedFile[] {
    if (!workspace || !workspace.rootPaths || workspace.rootPaths.length === 0) {
      return [...this.filesByPath.values()];
    }
    const roots = workspace.rootPaths.map(r => normalizePath(r));
    return [...this.filesByPath.values()].filter(file =>
      roots.some(root => this.isWithin(file.path, root))
    );
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
    return [...this.foldersByPath.values()]
      .filter(folder => folder.parent?.path === parent)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  listFiles(folderPath: string): KnowledgeNodeViewModel[] {
    const folder = normalizePath(folderPath);
    return [...this.filesByPath.values()]
      .filter(file => this.isWithin(file.path, folder))
      .map(file => this.toKnowledgeNode(file))
      .sort((a, b) => b.mtime - a.mtime);
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
    const files = [...this.filesByPath.values()].filter(file => {
      if (scope === "current-folder" && !this.isWithin(file.path, folder)) return false;
      if (scope === "current-workspace" && workspace && !workspace.rootPaths.some(root => this.isWithin(file.path, normalizePath(root)))) return false;
      const haystack = `${file.basename} ${file.path} ${file.tags.join(" ")}`.toLocaleLowerCase("zh-CN");
      return haystack.includes(needle);
    });
    return files.map(file => this.toKnowledgeNode(file)).sort((a, b) => b.mtime - a.mtime);
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

  getGraphData(
    seedPath: string | null,
    scope: GraphScope,
    workspace: AethericWorkspace | null,
    folderPath: string,
    limit = 64,
  ): GraphData {
    const normalizedSeed = seedPath ? normalizePath(seedPath) : null;
    const candidates = new Map<string, { file: IndexedFile; depth: number }>();

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
      const pool = [...this.filesByPath.values()].filter(file => {
        if (scope === "current-folder") return this.isWithin(file.path, normalizePath(folderPath));
        if (scope === "current-workspace" && workspace) return workspace.rootPaths.some(root => this.isWithin(file.path, normalizePath(root)));
        if (scope === "current-tag") return !!seedTag && file.tags.includes(seedTag);
        return true;
      }).sort((a, b) => b.mtime - a.mtime);
      if (seed) candidates.set(seed.path, { file: seed, depth: 0 });
      for (const file of pool) {
        if (candidates.size >= limit) break;
        if (!candidates.has(file.path)) candidates.set(file.path, { file, depth: 1 });
      }
    }

    const pathSet = new Set(candidates.keys());
    const edges = [] as GraphData["edges"];
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!pathSet.has(source)) continue;
      for (const [target, weight] of Object.entries(targets)) {
        if (pathSet.has(target)) edges.push({ source, target, weight });
        if (edges.length >= 320) break;
      }
      if (edges.length >= 320) break;
    }
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

  private rebuildRelationIndex(): void {
    const outgoingBySource = new Map<string, string[]>();
    const backlinksByTarget = new Map<string, Set<string>>();
    const unresolvedCounts = new Map<string, number>();

    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      const normalizedSource = normalizePath(source);
      const targetPaths = Object.keys(targets).map(target => normalizePath(target));
      outgoingBySource.set(normalizedSource, targetPaths);
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
      unresolvedCounts.set(normalizePath(source), Object.keys(targets).length);
    }

    this.outgoingBySource = outgoingBySource;
    this.backlinksByTarget = backlinksByTarget;
    this.unresolvedCounts = unresolvedCounts;
  }

  private indexFile(file: TFile): void {
    if (file.path.startsWith("08_密室/")) {
      const allowed = [
        "08_密室/todo.md",
        "08_密室/林下工作台.md",
        "08_密室/待办池.md",
        "08_密室/灵感池.md"
      ];
      const isAllowed = allowed.includes(file.path) || file.path.startsWith("08_密室/生活计划/");
      if (!isAllowed) return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const tags = cache ? (getAllTags(cache) ?? []) : [];
    this.filesByPath.set(file.path, {
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
    });
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
    if (file instanceof TFolder) this.foldersByPath.set(file.path, file);
    if (file instanceof TFile) this.indexFile(file);
    this.scheduleEmit();
  }

  private handleModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    this.indexFile(file);
    this.scheduleEmit();
  }

  private handleDelete(file: TAbstractFile): void {
    if (file instanceof TFolder) {
      this.foldersByPath.delete(file.path);
      for (const path of [...this.filesByPath.keys()]) if (this.isWithin(path, file.path)) this.filesByPath.delete(path);
    }
    if (file instanceof TFile) this.filesByPath.delete(file.path);
    this.scheduleEmit();
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    const normalizedOld = normalizePath(oldPath);
    if (file instanceof TFile) {
      this.filesByPath.delete(normalizedOld);
      this.indexFile(file);
    }
    if (file instanceof TFolder) {
      for (const path of [...this.foldersByPath.keys()]) if (this.isWithin(path, normalizedOld)) this.foldersByPath.delete(path);
      for (const path of [...this.filesByPath.keys()]) if (this.isWithin(path, normalizedOld)) this.filesByPath.delete(path);
      for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
        if (abstractFile instanceof TFolder && this.isWithin(abstractFile.path, file.path)) this.foldersByPath.set(abstractFile.path, abstractFile);
        if (abstractFile instanceof TFile && this.isWithin(abstractFile.path, file.path)) this.indexFile(abstractFile);
      }
    }
    this.scheduleEmit();
  }

  private isWithin(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private scheduleEmit(): void {
    if (this.emitFrame !== null) return;
    this.emitFrame = window.requestAnimationFrame(() => {
      this.emitFrame = null;
      this.emit();
    });
  }
}
