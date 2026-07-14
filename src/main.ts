import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AethericShellView, AETHERIC_SHELL_VIEW } from "./aetheric/AethericShellView";
import { AethericStore } from "./aetheric/AethericStore";
import { LogBus } from "./aetheric/LogBus";
import { NativeUiService } from "./aetheric/NativeUiService";
import { VaultIndexService } from "./aetheric/VaultIndexService";
import { HamasxiangAdapter } from "./aetheric/HamasxiangAdapter";
import { AethericShellState } from "./aetheric/types";
import { ScriptoriumSettings, DEFAULT_SETTINGS, ScriptoriumSettingTab, mergeSettings } from "./settings";
import { ScriptoriumDashboardView, SCRIPTORIUM_DASHBOARD_VIEW } from "./views/ScriptoriumDashboardView";

const HAMASXIANG_VIEW = "hamasxiang-console-view";

export default class ScriptoriumPlugin extends Plugin {
  settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  store!: AethericStore;
  logBus = new LogBus();
  nativeUi = new NativeUiService();
  indexService!: VaultIndexService;
  hamasxiangAdapter!: HamasxiangAdapter;
  private saveTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new AethericStore(this.settings.shellState, state => {
      this.settings.shellState = state;
      this.scheduleSave();
    });
    this.indexService = new VaultIndexService(this.app, this);
    this.indexService.start();
    this.hamasxiangAdapter = new HamasxiangAdapter(this.logBus);
    this.registerInterval(window.setInterval(() => void this.hamasxiangAdapter.refresh(false), 15000));

    this.addSettingTab(new ScriptoriumSettingTab(this.app, this));
    this.registerView(AETHERIC_SHELL_VIEW, leaf => new AethericShellView(leaf, this));
    this.registerView(SCRIPTORIUM_DASHBOARD_VIEW, leaf => new ScriptoriumDashboardView(leaf, this));

    this.addRibbonIcon("sparkles", "松果天工台 · Aetheric OS", () => void this.activateView());

    this.addCommand({
      id: "open-aetheric-os",
      name: "打开松果天工台 · Aetheric OS",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "open-legacy-scriptorium-dashboard",
      name: "打开松果阁旧工具",
      callback: () => void this.openLegacyView(),
    });
    this.addCommand({
      id: "restore-native-obsidian-ui",
      name: "安全恢复 Obsidian 原生界面",
      callback: () => void this.restoreNativeUi(),
    });
    this.addCommand({
      id: "enable-aetheric-shell-ui",
      name: "重新启用 Aetheric OS 统一外壳",
      callback: () => void this.enableAethericUi(),
    });

    this.registerEvent(this.app.workspace.on("file-open", file => this.recordRecentFile(file)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (!leaf || !this.store) return;
      const type = leaf.view.getViewType();
      if (type === AETHERIC_SHELL_VIEW) {
        const workspaceContainer = this.app.workspace.containerEl;
        if (!workspaceContainer.querySelector(".aos-page-transition-mask")) {
          const mask = workspaceContainer.createDiv({ cls: "aos-page-transition-mask" });
          mask.createDiv({ cls: "aos-spinner" });

          if (this.settings.nativeUiHidden) {
            this.app.workspace.leftSplit.collapse();
            this.app.workspace.rightSplit.collapse();
          }
          this.nativeUi.apply(this.settings.nativeUiHidden);

          window.setTimeout(() => {
            mask.style.opacity = "0";
            mask.addEventListener("transitionend", () => mask.remove());
          }, 180);
        } else {
          if (this.settings.nativeUiHidden) {
            this.app.workspace.leftSplit.collapse();
            this.app.workspace.rightSplit.collapse();
          }
          this.nativeUi.apply(this.settings.nativeUiHidden);
        }
      } else if (type === "markdown") {
        const isRightCollapsed = (this.app.workspace.rightSplit as any).collapsed;
        const workspaceContainer = this.app.workspace.containerEl;

        if (isRightCollapsed) {
          if (!workspaceContainer.querySelector(".aos-page-transition-mask")) {
            const mask = workspaceContainer.createDiv({ cls: "aos-page-transition-mask" });
            mask.createDiv({ cls: "aos-spinner" });

            this.nativeUi.apply(false);
            this.app.workspace.rightSplit.expand();

            window.setTimeout(() => {
              mask.style.opacity = "0";
              mask.addEventListener("transitionend", () => mask.remove());
            }, 180);
          } else {
            this.nativeUi.apply(false);
            this.app.workspace.rightSplit.expand();
          }
        } else {
          this.nativeUi.apply(false);
        }
      } else {
        this.nativeUi.apply(false);
      }
    }));

    this.app.workspace.onLayoutReady(() => {
      void this.initializeShell();
    });

    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile && file.path === ".agents/chat/dialog.md") {
        const leaves = this.app.workspace.getLeavesOfType(AETHERIC_SHELL_VIEW);
        for (const leaf of leaves) {
          if (leaf.view instanceof AethericShellView) {
            leaf.view.renderContext();
          }
        }
      }
    }));
  }

  onunload(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.nativeUi.restore();
  }

  async loadSettings(): Promise<void> {
    this.settings = mergeSettings(await this.loadData() as Partial<ScriptoriumSettings> | null);
  }

  async saveSettings(): Promise<void> {
    if (this.store) this.settings.shellState = structuredClone(this.store.getSnapshot()) as AethericShellState;
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(AETHERIC_SHELL_VIEW);
    let leaf: WorkspaceLeaf;
    if (leaves.length) leaf = leaves[0];
    else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: AETHERIC_SHELL_VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async openFolderInAetheric(folderPath: string): Promise<void> {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(AETHERIC_SHELL_VIEW)[0];
    if (leaf?.view instanceof AethericShellView) leaf.view.selectFolder(folderPath);
  }

  async openLegacyView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(SCRIPTORIUM_DASHBOARD_VIEW);
    let leaf: WorkspaceLeaf;
    if (leaves.length) leaf = leaves[0];
    else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: SCRIPTORIUM_DASHBOARD_VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async openHamasxiangConsole(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(HAMASXIANG_VIEW);
    let leaf: WorkspaceLeaf;
    if (leaves.length) leaf = leaves[0];
    else {
      leaf = this.app.workspace.getLeaf("tab");
      try {
        await leaf.setViewState({ type: HAMASXIANG_VIEW, active: true });
      } catch {
        new Notice("蛤蟆祥控制台未启用或未安装");
        return;
      }
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async restoreNativeUi(): Promise<void> {
    this.settings.nativeUiHidden = false;
    this.nativeUi.restore();
    await this.saveSettings();
    this.logBus.append("warn", "shell.native-ui", "已安全恢复 Obsidian 原生界面");
    new Notice("已恢复 Obsidian 原生界面");
  }

  async enableAethericUi(): Promise<void> {
    this.settings.nativeUiHidden = true;
    this.nativeUi.apply(true);
    await this.saveSettings();
    this.logBus.append("success", "shell.native-ui", "已重新启用 Aetheric OS 统一外壳");
  }

  async toggleNativeUi(): Promise<boolean> {
    if (this.nativeUi.isApplied()) await this.restoreNativeUi();
    else await this.enableAethericUi();
    return this.nativeUi.isApplied();
  }

  private async initializeShell(): Promise<void> {
    try {
      const startedAt = performance.now();
      await this.indexService.build();
      this.logBus.append("success", "vault.index", `Vault 轻量索引完成：${this.indexService.getFileCount()} 个节点`, Math.round(performance.now() - startedAt));
      this.nativeUi.apply(this.settings.nativeUiHidden);
      void this.hamasxiangAdapter.refresh(false);
      if (this.settings.autoOpenShell) await this.activateView();
    } catch (error) {
      this.nativeUi.restore();
      console.error("Aetheric OS 初始化失败", error);
      new Notice("Aetheric OS 初始化失败，已恢复原生界面");
    }
  }

  private recordRecentFile(file: TFile | null): void {
    if (!file || !this.store) return;
    const state = this.store.getSnapshot();
    const recentFilePaths = [file.path, ...state.recentFilePaths.filter(path => path !== file.path)]
      .filter(path => this.app.vault.getAbstractFileByPath(path) instanceof TFile)
      .slice(0, 80);
    this.store.patch({ recentFilePaths });
    for (const leaf of this.app.workspace.getLeavesOfType(AETHERIC_SHELL_VIEW)) {
      if (leaf.view instanceof AethericShellView) leaf.view.refreshRecent();
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveSettings();
    }, 250);
  }
}
