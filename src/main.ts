import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AethericShellView, AETHERIC_SHELL_VIEW } from "./aetheric/AethericShellView";
import { AethericStore } from "./aetheric/AethericStore";
import { LogBus } from "./aetheric/LogBus";
import { NativeUiService } from "./aetheric/NativeUiService";
import { VaultIndexService } from "./aetheric/VaultIndexService";
import { HamasxiangAdapter } from "./aetheric/HamasxiangAdapter";
import { CompatAdapter } from "./aetheric/CompatAdapter";
import { AethericShellState } from "./aetheric/types";
import { ScriptoriumSettings, DEFAULT_SETTINGS, ScriptoriumSettingTab, mergeSettings } from "./settings";
import { ScriptoriumDashboardView, SCRIPTORIUM_DASHBOARD_VIEW } from "./views/ScriptoriumDashboardView";
import { ChildProcess, spawn, execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { ProcessRegistry } from "./aetheric/operations/ProcessRegistry";
import { WorkerControlAdapter } from "./aetheric/operations/WorkerControlAdapter";
import { AnalyticsService } from "./aetheric/operations/AnalyticsService";
import { HamasxiangOperationsService } from "./aetheric/operations/HamasxiangOperationsService";

const HAMASXIANG_VIEW = "hamasxiang-console-view";

export interface DaemonProbe {
  online: boolean;
  service?: string;
  version?: string;
  activeJobs: number;
  pid?: number;
  instance_id?: string;
  error?: string;
}

export type DaemonOwnership = "offline" | "managed" | "external";

export default class ScriptoriumPlugin extends Plugin {
  settings: ScriptoriumSettings = structuredClone(DEFAULT_SETTINGS);
  store!: AethericStore;
  logBus = new LogBus();
  nativeUi = new NativeUiService();
  indexService!: VaultIndexService;
  hamasxiangAdapter!: HamasxiangAdapter;
  daemonProcess: ChildProcess | null = null;
  daemonOwnership: DaemonOwnership = "offline";
  daemonState: "idle" | "starting" | "stopping" = "idle";
  currentInstanceId: string | null = null;

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return "";
  }

  processRegistry!: ProcessRegistry;
  workerControl!: WorkerControlAdapter;
  analyticsService!: AnalyticsService;
  hamasxiangOperations!: HamasxiangOperationsService;

  private saveTimer: number | null = null;
  private pollTimeout: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new AethericStore(this.settings.shellState, state => {
      this.settings.shellState = state;
      this.scheduleSave();
    });
    this.indexService = new VaultIndexService(this.app, this);
    this.indexService.start();

    this.processRegistry = new ProcessRegistry();
    this.workerControl = new WorkerControlAdapter(this);
    this.analyticsService = new AnalyticsService(this);
    this.analyticsService.start();
    this.hamasxiangOperations = new HamasxiangOperationsService(this, this.processRegistry);
    this.hamasxiangAdapter = new HamasxiangAdapter(
      this.logBus,
      "http://127.0.0.1:8765",
      this.settings.hamasxiangDaemonToken,
    );

    void this.cleanupExpiredTempFiles();
    void this.startDaemon();

    let currentInterval = 15000;
    const poll = async () => {
      try {
        const snapshot = await this.hamasxiangAdapter.refresh(false);
        if (snapshot.online) {
          currentInterval = 15000;
        } else {
          currentInterval = Math.min(currentInterval * 1.5, 120000);
        }
      } catch (e) {
        currentInterval = Math.min(currentInterval * 1.5, 120000);
      }
      this.pollTimeout = window.setTimeout(() => void poll(), currentInterval);
    };
    void poll();

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
    this.addCommand({
      id: "reload-obsidian-app",
      name: "重新加载 Obsidian 窗口 (Reload Window)",
      callback: () => {
        CompatAdapter.reloadObsidianWindow(this.app);
      },
    });
    this.addCommand({
      id: "copy-selected-node-relative-path",
      name: "复制当前节点的 Vault 相对路径",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "C" }],
      checkCallback: checking => {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && (
          activeElement.matches("input, textarea, [contenteditable='true']")
          || activeElement.closest(".aos-claudian-embed")
        )) return false;

        const view = this.app.workspace.getLeavesOfType(AETHERIC_SHELL_VIEW)
          .map(leaf => leaf.view)
          .find(candidate => candidate instanceof AethericShellView) as AethericShellView | undefined;
        const path = view?.getSelectedNodePath();
        if (!path) return false;
        if (!checking) void this.copySelectedNodePath(path);
        return true;
      },
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
            mask.style.pointerEvents = "none";
            window.setTimeout(() => mask.remove(), 250);
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
              mask.style.pointerEvents = "none";
              window.setTimeout(() => mask.remove(), 250);
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
    if (this.pollTimeout !== null) window.clearTimeout(this.pollTimeout);
    this.nativeUi.restore();
    if (this.analyticsService) {
      this.analyticsService.destroy();
    }
    if (this.processRegistry) {
      // Stop only temporary preview developer servers when unloading the plugin
      void this.processRegistry.kill("preview");
    }
    if (this.settings.stopDaemonOnUnload) {
      void this.stopDaemon();
    }
  }

  async probeDaemonHealth(timeoutMs = 2000): Promise<DaemonProbe> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const token = this.settings.hamasxiangDaemonToken;
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    try {
      const response = await fetch("http://127.0.0.1:8765/health", {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (!response.ok) {
        return { online: false, activeJobs: 0, error: `HTTP ${response.status}` };
      }
      const data = await response.json() as any;
      if (data && data.ok === true && data.service === "hamaxiang-daemon") {
        return {
          online: true,
          service: data.service,
          version: data.version,
          activeJobs: typeof data.active_jobs === "number" ? data.active_jobs : 0,
          pid: typeof data.pid === "number" ? data.pid : undefined,
          instance_id: typeof data.instance_id === "string" ? data.instance_id : undefined,
        };
      }
      return { online: false, activeJobs: 0, error: "未知服务类型" };
    } catch (e) {
      window.clearTimeout(timer);
      return { online: false, activeJobs: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async startDaemon(): Promise<boolean> {
    if (this.daemonState !== "idle") {
      new Notice("正在处理其他进程状态，请稍后...");
      return false;
    }
    this.daemonState = "starting";
    try {
      let savedJson: { pid?: number; instance_id?: string; started_at?: number } | null = null;
      try {
        const vaultPath = this.getVaultPath();
        const pPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-scriptorium", ".managed-daemon.pid");
        if (fs.existsSync(pPath)) {
          savedJson = JSON.parse(fs.readFileSync(pPath, "utf-8").trim());
        }
      } catch (e) {}

      const probe = await this.probeDaemonHealth(2000);
      if (probe.online) {
        if (savedJson && probe.pid === savedJson.pid && probe.instance_id === savedJson.instance_id) {
          this.daemonOwnership = "managed";
          this.currentInstanceId = savedJson.instance_id || null;
          this.daemonState = "idle";
          this.logBus.append("success", "hamaxiang.lifecycle", `接管已在后台运行的天工台托管 Daemon 进程 (PID: ${probe.pid}, 实例: ${probe.instance_id})`);
          return true;
        } else {
          this.daemonOwnership = "external";
          this.daemonState = "idle";
          this.logBus.append("success", "hamaxiang.lifecycle", `发现活动中的外部 Daemon (PID: ${probe.pid})，直接复用连接`);
          return true;
        }
      }
      if (this.settings.daemonMode === "external") {
        this.daemonOwnership = "offline";
        this.daemonState = "idle";
        this.logBus.append("info", "hamaxiang.lifecycle", "当前设为外部常驻模式且服务离线，跳过自动拉起");
        return false;
      }
      if (this.daemonProcess) {
        this.daemonOwnership = "managed";
        this.daemonState = "idle";
        return true;
      }
      const systemPath = this.settings.hamasxiangSystemPath;
      if (!fs.existsSync(systemPath)) {
        throw new Error(`配置的系统目录不存在: ${systemPath}`);
      }
      const scriptPath = path.join(systemPath, "hamaxiang_daemon.py");
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`启动脚本未找到: ${scriptPath}`);
      }

      // Generate a random instance ID for this launch
      const randomInstanceId = Math.random().toString(36).substring(2) + Date.now().toString(36);
      this.currentInstanceId = randomInstanceId;

      const env = { ...process.env, HAMAXIANG_INSTANCE_ID: randomInstanceId };
      this.daemonProcess = spawn("python", [scriptPath], {
        cwd: systemPath,
        detached: false,
        stdio: "ignore",
        env,
      });

      // Wait for it to become online and verify instance identity
      let spawnedOnline = false;
      let spawnedPid: number | undefined;
      for (let i = 0; i < 15; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const checkProbe = await this.probeDaemonHealth(600);
        if (checkProbe.online && checkProbe.pid && checkProbe.instance_id === randomInstanceId) {
          spawnedOnline = true;
          spawnedPid = checkProbe.pid;
          // Write lock metadata atomically
          try {
            const vaultPath = this.getVaultPath();
            const pPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-scriptorium", ".managed-daemon.pid");
            fs.writeFileSync(pPath, JSON.stringify({
              pid: checkProbe.pid,
              instance_id: randomInstanceId,
              started_at: Date.now()
            }, null, 2));
          } catch (e) {}
          break;
        }
      }

      if (!spawnedOnline) {
        if (this.daemonProcess) {
          try {
            this.daemonProcess.kill("SIGKILL");
          } catch (e) {}
          this.daemonProcess = null;
        }
        throw new Error("启动 Daemon 后无法在限时内连通服务或实例身份不吻合。");
      }

      this.processRegistry.register("daemon", this.daemonProcess, "python", [scriptPath], systemPath);
      this.daemonProcess.on("close", (code) => {
        console.log(`[Hamasxiang Daemon] Process exited with code ${code}`);
        this.daemonProcess = null;
        this.daemonOwnership = "offline";
        this.currentInstanceId = null;
        try {
          const vaultPath = this.getVaultPath();
          const pPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-scriptorium", ".managed-daemon.pid");
          if (fs.existsSync(pPath)) fs.unlinkSync(pPath);
        } catch (e) {}
        this.hamasxiangAdapter.refresh(true);
      });
      this.daemonOwnership = "managed";
      this.daemonState = "idle";
      this.logBus.append("success", "hamaxiang.lifecycle", `天工台托管：本地 Daemon 成功拉起并绑定受控 (PID: ${spawnedPid}, 实例: ${randomInstanceId})`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logBus.append("error", "hamaxiang.lifecycle", `启动 Daemon 失败：${msg}`);
      new Notice(`启动 Daemon 失败: ${msg}`);
      this.daemonProcess = null;
      this.currentInstanceId = null;
      this.daemonOwnership = "offline";
      this.daemonState = "idle";
      return false;
    }
  }

  async stopDaemon(): Promise<boolean> {
    if (this.daemonState !== "idle") {
      new Notice("正在处理其他进程状态，请稍后...");
      return false;
    }
    this.daemonState = "stopping";
    if (this.daemonOwnership !== "managed") {
      this.daemonState = "idle";
      return true;
    }

    let savedJson: { pid?: number; instance_id?: string; started_at?: number } | null = null;
    try {
      const vaultPath = this.getVaultPath();
      const pPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-scriptorium", ".managed-daemon.pid");
      if (fs.existsSync(pPath)) {
        savedJson = JSON.parse(fs.readFileSync(pPath, "utf-8").trim());
      }
    } catch (e) {}

    const probe = await this.probeDaemonHealth(1000);
    // Double check instance identity before stop
    if (!probe.online || !savedJson || probe.pid !== savedJson.pid || probe.instance_id !== savedJson.instance_id) {
      this.daemonState = "idle";
      this.logBus.append("error", "hamaxiang.lifecycle", "停止 Daemon 校验失败：活动服务 PID / 实例 ID 与托管记录不符，拒绝终止");
      new Notice("停止 Daemon 失败：当前服务所有权校验不符");
      return false;
    }

    const procEntry = this.processRegistry.get("daemon");
    const pid = probe.pid;

    this.daemonProcess = null;
    this.logBus.append("warn", "hamaxiang.lifecycle", `正在尝试停止天工台托管进程 (PID: ${pid}, 实例: ${probe.instance_id})...`);
    try {
      if (procEntry) {
        await this.processRegistry.kill("daemon");
      } else if (pid) {
        // Adopted process: kill it manually
        if (process.platform === "win32") {
          await new Promise<void>((resolve) => {
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (err) => {
              if (err) console.error("[taskkill] error:", err);
              resolve();
            });
          });
        } else {
          try {
            process.kill(pid, "SIGKILL");
          } catch (e) {}
        }
      }

      let exited = false;
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const probeCheck = await this.probeDaemonHealth(800);
        if (!probeCheck.online) {
          exited = true;
          break;
        }
      }
      if (!exited && pid) {
        this.logBus.append("warn", "hamaxiang.lifecycle", `托管进程 (PID: ${pid}) 未按时退出，执行强制进程树清理...`);
        if (process.platform === "win32") {
          await new Promise<void>((resolve) => {
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (err) => {
              if (err) console.error("[taskkill] error:", err);
              resolve();
            });
          });
        } else {
          try {
            process.kill(pid, "SIGKILL");
          } catch (e) {}
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      const finalProbe = await this.probeDaemonHealth(1000);
      if (finalProbe.online) {
        this.logBus.append("error", "hamaxiang.lifecycle", "端口 8765 依然被占用，停止操作判定失败");
        new Notice("停止 Daemon 失败，端口依然被占用");
        this.daemonOwnership = "external";
        this.daemonState = "idle";
        return false;
      }

      // Cleanup saved PID file
      try {
        const vaultPath = this.getVaultPath();
        const pPath = path.join(vaultPath, ".obsidian", "plugins", "obsidian-scriptorium", ".managed-daemon.pid");
        if (fs.existsSync(pPath)) fs.unlinkSync(pPath);
      } catch (e) {}

      this.daemonOwnership = "offline";
      this.currentInstanceId = null;
      this.daemonState = "idle";
      this.logBus.append("success", "hamaxiang.lifecycle", "已成功终止本地 Daemon 进程及子进程树");
      this.hamasxiangAdapter.refresh(true);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logBus.append("error", "hamaxiang.lifecycle", `停止 Daemon 异常: ${msg}`);
      this.daemonState = "idle";
      return false;
    }
  }

  async cleanupExpiredTempFiles(): Promise<void> {
    const systemPath = this.settings.hamasxiangSystemPath;
    try {
      if (!fs.existsSync(systemPath)) return;
      const files = await fs.promises.readdir(systemPath);
      const prefix = ".env.tmp-";
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith(prefix)) {
          const filePath = path.join(systemPath, file);
          const stat = await fs.promises.stat(filePath);
          if (now - stat.mtimeMs > 24 * 3600 * 1000) {
            await fs.promises.unlink(filePath).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn("Failed to cleanup expired temp files", e);
    }
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

  private async copySelectedNodePath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.logBus.append("success", "navigation.clipboard", `已复制 Vault 相对路径：${path}`);
      new Notice(`已复制相对路径：${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logBus.append("error", "navigation.clipboard", `复制失败：${message}`);
      new Notice(`复制路径失败：${message}`);
    }
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
