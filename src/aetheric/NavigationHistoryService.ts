import { App, EventRef, Notice, TFile, WorkspaceLeaf } from "obsidian";

/**
 * A small, surface-agnostic history contract.
 *
 * Obsidian's native history and the Aetheric Shell used to be two separate
 * stacks.  The service deliberately stores only navigation targets (shell
 * state or a Vault-relative note path), never note contents or editor state.
 */
export interface AethericShellHistorySnapshot {
  activeModule: string;
  selectedWorkspaceId: string;
  selectedFolderPath: string;
  selectedFilePath: string | null;
  contextTab: string;
  /** Optional graph lens state; older snapshots remain valid. */
  graphScope?: string;
  graphDepth?: number;
  graphFocus?: string;
  graphFolderPath?: string;
  graphDetail?: string;
  knowledgeLens?: string;
  graphRelationBudget?: number;
}

export interface AethericShellHistoryHost {
  getNavigationLeaf(): WorkspaceLeaf | null;
  getNavigationSnapshot(): AethericShellHistorySnapshot;
  restoreNavigationSnapshot(snapshot: AethericShellHistorySnapshot): void;
}

type HistoryEntry =
  | { kind: "shell"; host: AethericShellHistoryHost; snapshot: AethericShellHistorySnapshot }
  | { kind: "file"; path: string; leaf: WorkspaceLeaf | null };

const SHELL_VIEW_TYPE = "aetheric-os-shell-view";

export class NavigationHistoryService {
  private entries: HistoryEntry[] = [];
  private index = -1;
  private shellHosts = new Set<AethericShellHistoryHost>();
  private activeLeafRef: EventRef | null = null;
  private fileOpenRef: EventRef | null = null;
  private started = false;
  private applying = false;

  private readonly onPointerDown = (event: MouseEvent): void => {
    const direction = event.button === 3 ? -1 : event.button === 4 ? 1 : 0;
    if (!direction || !this.isEligibleSurface()) return;
    if (event.target instanceof Element && event.target.closest(".aos-claudian-embed")) return;

    // X1/X2 are the standard Windows mouse back/forward buttons. Capture the
    // event before Obsidian/Electron turns it into an unrelated browser action.
    event.preventDefault();
    event.stopPropagation();
    void this.navigate(direction);
  };

  constructor(private readonly app: App) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.activeLeafRef = this.app.workspace.on("active-leaf-change", leaf => this.captureLeaf(leaf));
    this.fileOpenRef = this.app.workspace.on("file-open", file => this.captureFileOpen(file));
    window.addEventListener("mousedown", this.onPointerDown, true);
    this.captureLeaf(this.app.workspace.activeLeaf);
  }

  destroy(): void {
    if (!this.started) return;
    this.started = false;
    if (this.activeLeafRef) this.app.workspace.offref(this.activeLeafRef);
    if (this.fileOpenRef) this.app.workspace.offref(this.fileOpenRef);
    this.activeLeafRef = null;
    this.fileOpenRef = null;
    window.removeEventListener("mousedown", this.onPointerDown, true);
    this.entries = [];
    this.index = -1;
    this.shellHosts.clear();
  }

  registerShell(host: AethericShellHistoryHost): void {
    this.shellHosts.add(host);
    if (this.app.workspace.activeLeaf === host.getNavigationLeaf()) {
      this.recordShellState(host, host.getNavigationSnapshot());
    }
  }

  unregisterShell(host: AethericShellHistoryHost): void {
    this.shellHosts.delete(host);
    // A closed view must not keep the service alive through a history entry.
    this.entries = this.entries.filter(entry => entry.kind !== "shell" || entry.host !== host);
    this.index = Math.min(this.index, this.entries.length - 1);
  }

  recordShellState(host: AethericShellHistoryHost, snapshot: AethericShellHistorySnapshot): void {
    if (this.applying) return;
    this.shellHosts.add(host);
    this.push({ kind: "shell", host, snapshot: { ...snapshot } });
  }

  canNavigate(direction: -1 | 1): boolean {
    const next = this.index + direction;
    return next >= 0 && next < this.entries.length;
  }

  async navigate(direction: -1 | 1): Promise<void> {
    const nextIndex = this.index + direction;
    const entry = this.entries[nextIndex];
    if (!entry) {
      new Notice(direction === -1 ? "已是历史最前页" : "已是历史最后页");
      return;
    }

    this.applying = true;
    try {
      await this.apply(entry);
      this.index = nextIndex;
      new Notice(entry.kind === "file" ? `历史导航：${entry.path.split("/").pop() ?? entry.path}` : "历史导航：工作台");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`历史导航失败：${message}`);
    } finally {
      this.applying = false;
    }
  }

  private captureLeaf(leaf: WorkspaceLeaf | null): void {
    if (this.applying || !leaf) return;
    const viewType = leaf.view?.getViewType?.();
    if (viewType === SHELL_VIEW_TYPE) {
      const host = [...this.shellHosts].find(candidate => candidate.getNavigationLeaf() === leaf);
      if (host) this.recordShellState(host, host.getNavigationSnapshot());
      return;
    }
    if (viewType === "markdown") {
      const file = (leaf.view as any)?.file;
      if (file?.path) this.push({ kind: "file", path: String(file.path), leaf });
    }
  }

  private captureFileOpen(file: TFile | null): void {
    if (this.applying || !file) return;
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.view?.getViewType?.() === "markdown") {
      this.push({ kind: "file", path: file.path, leaf });
    }
  }

  isNavigationSurfaceActive(): boolean {
    const viewType = this.app.workspace.activeLeaf?.view?.getViewType?.();
    return viewType === SHELL_VIEW_TYPE || viewType === "markdown" || viewType === "empty";
  }

  private isEligibleSurface(): boolean {
    return this.isNavigationSurfaceActive();
  }

  private push(entry: HistoryEntry): void {
    const current = this.entries[this.index];
    if (current && this.same(current, entry)) return;
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(entry);
    this.index = this.entries.length - 1;
  }

  private same(left: HistoryEntry, right: HistoryEntry): boolean {
    if (left.kind !== right.kind) return false;
    if (left.kind === "file" && right.kind === "file") return left.path === right.path;
    if (left.kind !== "shell" || right.kind !== "shell") return false;
    return left.host === right.host
      && left.snapshot.activeModule === right.snapshot.activeModule
      && left.snapshot.selectedWorkspaceId === right.snapshot.selectedWorkspaceId
      && left.snapshot.selectedFolderPath === right.snapshot.selectedFolderPath
      && left.snapshot.selectedFilePath === right.snapshot.selectedFilePath
      && left.snapshot.contextTab === right.snapshot.contextTab
      && left.snapshot.graphScope === right.snapshot.graphScope
      && left.snapshot.graphDepth === right.snapshot.graphDepth
      && left.snapshot.graphFocus === right.snapshot.graphFocus
      && left.snapshot.graphFolderPath === right.snapshot.graphFolderPath
      && left.snapshot.graphDetail === right.snapshot.graphDetail
      && left.snapshot.knowledgeLens === right.snapshot.knowledgeLens
      && left.snapshot.graphRelationBudget === right.snapshot.graphRelationBudget;
  }

  private async apply(entry: HistoryEntry): Promise<void> {
    if (entry.kind === "shell") {
      const leaf = entry.host.getNavigationLeaf();
      if (!leaf) throw new Error("工作台标签页已关闭");
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      entry.host.restoreNavigationSnapshot(entry.snapshot);
      return;
    }

    const abstract = this.app.vault.getAbstractFileByPath(entry.path);
    if (!(abstract instanceof TFile)) throw new Error(`笔记不存在：${entry.path}`);
    let leaf = entry.leaf;
    if (!leaf) {
      this.app.workspace.iterateAllLeaves(candidate => {
        const candidateFile = (candidate.view as any)?.file;
        if (!leaf && candidateFile?.path === entry.path) leaf = candidate;
      });
    }
    leaf ??= this.app.workspace.getLeaf("tab");
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    await leaf.openFile(abstract);
  }
}
