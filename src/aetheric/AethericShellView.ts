import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  setIcon,
} from "obsidian";
import ScriptoriumPlugin from "../main";
import { CompatAdapter } from "./CompatAdapter";
import { LogDock } from "./LogDock";
import { VirtualFileList } from "./VirtualFileList";
import {
  AethericModule,
  AethericWorkspace,
  GraphScope,
  IndexedFile,
  IntelligenceItem,
  KnowledgeNodeViewModel,
  OperationArtifact,
  OperationTask,
  WorkspaceCapability,
} from "./types";

export const AETHERIC_SHELL_VIEW = "aetheric-os-shell-view";

const MODULES: Array<{ id: AethericModule; label: string; icon: string }> = [
  { id: "overview", label: "总览", icon: "layout-dashboard" },
  { id: "navigation", label: "导航", icon: "compass" },
  { id: "collection", label: "采集", icon: "radio-tower" },
  { id: "tasks", label: "任务", icon: "clipboard-list" },
  { id: "intelligence", label: "情报", icon: "chart-no-axes-combined" },
  { id: "knowledge", label: "知识库", icon: "book-open" },
  { id: "logs", label: "日志", icon: "file-terminal" },
];

type ContextTab = "overview" | "relations" | "agent" | "preview";

export class AethericShellView extends ItemView {
  private root!: HTMLDivElement;
  private modeRail!: HTMLDivElement;
  private navigator!: HTMLDivElement;
  private mainPane!: HTMLDivElement;
  private contextPane!: HTMLDivElement;
  private indexStatus!: HTMLSpanElement;
  private commandInput!: HTMLInputElement;
  private workspaceSelect!: HTMLSelectElement;
  private virtualList: VirtualFileList | null = null;
  private logDock: LogDock | null = null;
  private unsubscribeIndex: (() => void) | null = null;
  private unsubscribeHamasxiang: (() => void) | null = null;
  private contextTab: ContextTab = "overview";
  private selectedNode: KnowledgeNodeViewModel | null = null;
  private commandResults!: HTMLDivElement;
  private commandMatches: KnowledgeNodeViewModel[] = [];
  private graphScope: GraphScope = "current-file";
  private globalHistoryStack: Array<{
    activeModule: AethericModule;
    selectedWorkspaceId: string;
    selectedFolderPath: string;
    selectedFilePath: string | null;
    contextTab: ContextTab;
  }> = [];
  private globalHistoryIndex = -1;
  private isNavigatingHistory = false;
  private nativeGraphView: any = null;
  private nativeGraphLeaf: any = null;
  private currentRenderId = 0;
  private agentRenderTx = 0;
  private borrowedClaudianEl: HTMLElement | null = null;
  private borrowedClaudianLeaf: any | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ScriptoriumPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return AETHERIC_SHELL_VIEW;
  }

  getDisplayText(): string {
    return "松果天工台 · Aetheric OS";
  }

  getIcon(): string {
    return "sparkles";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("aos-view-content");
    this.root = this.contentEl.createDiv({ cls: "aos-shell" });
    this.root.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".aos-claudian-embed")) return;
      if (e.button === 3) {
        e.preventDefault();
        this.navigateHistory(-1);
      } else if (e.button === 4) {
        e.preventDefault();
        this.navigateHistory(1);
      }
    });
    this.renderTopBar();

    const workArea = this.root.createDiv({ cls: "aos-work-area" });
    this.modeRail = workArea.createDiv({ cls: "aos-mode-rail" });
    this.navigator = workArea.createDiv({ cls: "aos-navigator" });
    this.mainPane = workArea.createDiv({ cls: "aos-main-pane" });
    this.contextPane = workArea.createDiv({ cls: "aos-context-pane" });

    const startState = this.plugin.store.getSnapshot();
    if (startState.selectedFilePath) {
      this.selectedNode = this.toNode(startState.selectedFilePath);
    }

    this.applyPanelWidths();
    this.renderModeRail();
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
    this.recordHistoryState(true);

    this.logDock = new LogDock(this.root, this.plugin.logBus, {
      getState: () => this.plugin.store.getSnapshot(),
      onStateChange: patch => {
        const state = this.plugin.store.getSnapshot();
        this.plugin.store.patch({ logDock: { ...state.logDock, ...patch } });
      },
    });

    this.unsubscribeIndex = this.plugin.indexService.subscribe(() => {
      const state = this.plugin.store.getSnapshot();
      if (!this.selectedNode && state.selectedFilePath) {
        this.selectedNode = this.toNode(state.selectedFilePath);
      }
      this.updateIndexStatus();
      this.renderNavigator();
      if (state.activeModule === "overview") this.renderOverview();
      if (state.activeModule === "navigation") this.refreshVirtualList();
      if (state.activeModule === "knowledge") this.renderKnowledgeGraph();
      this.renderContext();
    });
    this.unsubscribeHamasxiang = this.plugin.hamasxiangAdapter.subscribe(() => {
      const module = this.plugin.store.getSnapshot().activeModule;
      if (["overview", "collection", "tasks", "intelligence", "logs"].includes(module)) this.renderMain();
    });

    this.updateIndexStatus();
    this.plugin.logBus.append("success", "shell.lifecycle", "Aetheric OS Shell 已就绪");
  }

  async onClose(): Promise<void> {
    this.agentRenderTx++;
    this.restoreBorrowedClaudian();
    this.currentRenderId += 1;
    this.disposeNativeGraphView();
    this.virtualList?.destroy();
    this.virtualList = null;
    this.logDock?.destroy();
    this.logDock = null;
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.unsubscribeHamasxiang?.();
    this.unsubscribeHamasxiang = null;
    this.contentEl.removeClass("aos-view-content");
  }

  onResize(): void {
    super.onResize();
    if (this.nativeGraphView && typeof this.nativeGraphView.onResize === "function") {
      this.nativeGraphView.onResize();
    }
  }

  getSelectedNodePath(): string | null {
    return this.selectedNode?.path ?? this.plugin.store.getSnapshot().selectedFilePath;
  }

  selectFolder(folderPath: string, pushHistory = true): void {
    const normalized = normalizePath(folderPath);
    if (!this.plugin.indexService.getFolder(normalized)) {
      new Notice(`目录不存在：${normalized}`);
      return;
    }
    const state = this.plugin.store.getSnapshot();
    const expanded = this.getPathChain(normalized);
    this.plugin.store.patch({
      activeModule: "navigation",
      selectedFolderPath: normalized,
      selectedFilePath: null,
      expandedFolderPaths: expanded,
      folderTreeVisible: true,
      searchQuery: "",
      workspaceHistory: {
        ...state.workspaceHistory,
        [state.selectedWorkspaceId]: { folderPath: normalized, selectedFilePath: null },
      },
    });
    this.selectedNode = null;
    this.commandInput.value = "";
    this.renderModeRail();
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
    if (pushHistory) this.recordHistoryState(true);
    this.plugin.logBus.append("info", "navigation.folder", `已进入目录：${normalized}`);
  }

  refreshRecent(): void {
    this.renderNavigator();
    if (this.plugin.store.getSnapshot().activeModule === "overview") this.renderOverview();
  }

  private renderTopBar(): void {
    const topbar = this.root.createDiv({ cls: "aos-topbar" });
    const brand = topbar.createDiv({ cls: "aos-brand" });
    brand.createSpan({ cls: "aos-brand-mark", text: "♜" });
    const brandText = brand.createDiv();
    brandText.createDiv({ cls: "aos-brand-title", text: "松果天工台 · Aetheric OS" });
    brandText.createDiv({ cls: "aos-brand-subtitle", text: "Agent Operations & Knowledge System" });

    this.workspaceSelect = topbar.createEl("select", { cls: "aos-workspace-select" });
    for (const workspace of this.plugin.settings.workspaces) {
      this.workspaceSelect.createEl("option", { value: workspace.id, text: `${workspace.icon ?? "◇"} ${workspace.name}` });
    }
    this.workspaceSelect.value = this.plugin.store.getSnapshot().selectedWorkspaceId;
    this.workspaceSelect.addEventListener("change", () => this.selectWorkspace(this.workspaceSelect.value));

    const command = topbar.createDiv({ cls: "aos-command-center" });
    command.createSpan({ cls: "aos-command-icon", text: "⌕" });
    this.commandInput = command.createEl("input", {
      cls: "aos-command-input",
      attr: { placeholder: "搜索 / > 命令 / @ Agent / / Skill / # 范围" },
    });
    this.commandInput.addEventListener("input", () => this.handleCommandInput());
    this.commandInput.addEventListener("keydown", event => {
      if (event.key === "Escape") this.hideCommandResults();
      if (event.key === "Enter") {
        const value = this.commandInput.value.trim();
        if (this.commandMatches.length && value && !/^[>@/#]/.test(value)) this.chooseCommandNode(this.commandMatches[0]);
        else this.executeCommandCenter(value);
      }
    });
    const syntax = command.createDiv({ cls: "aos-command-syntax" });
    for (const token of [">命令", "@Agent", "/Skill", "#范围"]) syntax.createSpan({ text: token });
    this.commandResults = command.createDiv({ cls: "aos-command-results is-hidden" });
    this.registerDomEvent(document, "pointerdown", event => {
      if (!command.contains(event.target as Node)) this.hideCommandResults();
    });

    const status = topbar.createDiv({ cls: "aos-system-status" });
    status.createSpan({ cls: "aos-status-dot" });
    status.createSpan({ text: "在线" });
    this.indexStatus = status.createSpan({ cls: "aos-index-status" });

    const nativeButton = topbar.createEl("button", {
      cls: "aos-topbar-button",
      text: this.plugin.nativeUi.isApplied() ? "恢复原生界面" : "隐藏原生界面",
    });
    nativeButton.addEventListener("click", () => void this.plugin.toggleNativeUi().then(applied => {
      nativeButton.textContent = applied ? "恢复原生界面" : "隐藏原生界面";
    }));
  }

  private renderModeRail(): void {
    this.modeRail.empty();
    const active = this.plugin.store.getSnapshot().activeModule;
    for (const module of MODULES) {
      const button = this.modeRail.createEl("button", { cls: "aos-mode-button" });
      button.classList.toggle("is-active", module.id === active);
      button.setAttribute("aria-label", module.label);
      button.setAttribute("title", module.label);
      const icon = button.createSpan({ cls: "aos-mode-icon" });
      setIcon(icon, module.icon);
      button.createSpan({ cls: "aos-mode-label", text: module.label });
      button.addEventListener("click", () => this.switchModule(module.id));
    }
    const spacer = this.modeRail.createDiv({ cls: "aos-mode-spacer" });
    spacer.setAttribute("aria-hidden", "true");
    const settings = this.modeRail.createEl("button", { cls: "aos-mode-button" });
    const icon = settings.createSpan({ cls: "aos-mode-icon" });
    setIcon(icon, "settings");
    settings.createSpan({ cls: "aos-mode-label", text: "设置" });
    settings.addEventListener("click", () => {
      new Notice("请在 Obsidian 设置 → 社区插件 → 松果天工台中配置");
    });
  }

  private renderNavigator(): void {
    const state = this.plugin.store.getSnapshot();
    const workspace = this.getWorkspace();
    this.navigator.empty();
    this.navigator.classList.toggle("is-collapsed", state.navigatorMode === "collapsed");

    const header = this.navigator.createDiv({ cls: "aos-navigator-header" });
    header.createSpan({ text: "Workspace" });
    const collapse = header.createEl("button", { cls: "aos-icon-button", text: state.navigatorMode === "collapsed" ? "»" : "«" });
    collapse.addEventListener("click", () => {
      const next = state.navigatorMode === "collapsed" ? "full" : "collapsed";
      this.plugin.store.patch({ navigatorMode: next });
      this.applyPanelWidths();
      this.renderNavigator();
    });

    if (!workspace) return;
    const workspaceCard = this.navigator.createDiv({ cls: "aos-workspace-card" });
    workspaceCard.createSpan({ cls: "aos-workspace-icon", text: workspace.icon ?? "◇" });
    const text = workspaceCard.createDiv();
    text.createDiv({ cls: "aos-workspace-name", text: workspace.name });
    text.createDiv({ cls: "aos-workspace-desc", text: "工作域 · 项目 · 能力 · 知识节点" });

    if (state.navigatorMode === "collapsed") {
      for (const item of this.plugin.settings.workspaces) {
        const button = this.navigator.createEl("button", { cls: "aos-collapsed-workspace", text: item.icon ?? "◇" });
        button.setAttribute("title", item.name);
        button.classList.toggle("is-active", item.id === workspace.id);
        button.addEventListener("click", () => this.selectWorkspace(item.id));
      }
      return;
    }

    this.renderNavigatorSection("Projects", workspace.projects.map(project => ({
      title: project.name,
      meta: project.status ?? "项目",
      action: () => this.selectProject(project.id, project.rootPath),
      active: state.selectedProjectId === project.id,
    })));

    this.renderNavigatorSection("Capabilities", workspace.capabilities.map(capability => ({
      title: capability.name,
      meta: capability.description ?? "长期能力",
      action: () => this.activateCapability(capability),
    })));

    const quick = this.navigator.createDiv({ cls: "aos-nav-section" });
    const quickHeader = quick.createDiv({ cls: "aos-quick-header" });
    quickHeader.createDiv({ cls: "aos-nav-section-title", text: "Quick Access" });
    const addFolderBtn = quickHeader.createEl("button", {
      cls: "aos-quick-add-btn",
      text: "+",
      attr: { title: "添加快捷目录" },
    });
    addFolderBtn.addEventListener("click", () => this.promptAddFolder());
    this.renderQuickButton(quick, "最近访问", `${state.recentFilePaths.length}`, "history", () => this.showRecentFiles());
    this.renderQuickButton(quick, "收藏节点", `${state.favoritePaths.length}`, "star", () => this.showFavoriteFiles());
    if (state.favoriteFolderPaths && state.favoriteFolderPaths.length > 0) {
      for (const folderPath of state.favoriteFolderPaths) {
        const folderName = folderPath.split("/").pop() || folderPath;
        const btn = this.renderQuickButton(quick, folderName, "", "folder", () => this.selectFolder(folderPath));
        btn.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          menu.addItem(item => {
            item.setTitle("★ 从快捷访问移除")
              .setIcon("star-off")
              .onClick(() => this.toggleFavoriteFolder(folderPath));
          });
          menu.showAtPosition({ x: event.clientX, y: event.clientY });
        });
      }
    }
    if (workspace.inboxPath) this.renderQuickButton(quick, "收件箱", "", "inbox", () => this.selectFolder(workspace.inboxPath!));
    this.renderQuickButton(quick, state.folderTreeVisible ? "收起物理目录" : "浏览物理目录", "", "folder-tree", () => {
      this.plugin.store.patch({ folderTreeVisible: !state.folderTreeVisible });
      this.renderNavigator();
    });

    if (state.activeModule === "navigation" && state.folderTreeVisible) this.renderFolderTree(workspace);
  }

  private renderNavigatorSection(
    label: string,
    items: Array<{ title: string; meta: string; action: () => void; active?: boolean }>,
  ): void {
    if (!items.length) return;
    const section = this.navigator.createDiv({ cls: "aos-nav-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: label });
    for (const item of items) {
      const button = section.createDiv({ cls: "aos-nav-card" });
      button.classList.toggle("is-active", item.active === true);
      button.createSpan({ cls: "aos-nav-card-title", text: item.title });
      button.createSpan({ cls: "aos-nav-card-meta", text: item.meta });
      button.addEventListener("click", item.action);
    }
  }

  private renderQuickButton(parent: HTMLElement, label: string, count: string, iconName: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "aos-quick-button" });
    const icon = button.createSpan({ cls: "aos-quick-icon" });
    setIcon(icon, iconName);
    button.createSpan({ text: label });
    if (count) button.createSpan({ cls: "aos-quick-count", text: count });
    button.addEventListener("click", action);
    return button;
  }

  private renderFolderTree(workspace: AethericWorkspace): void {
    const section = this.navigator.createDiv({ cls: "aos-folder-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: "Physical folders · 按需展开" });
    for (const rootPath of workspace.rootPaths) {
      const folder = this.plugin.indexService.getFolder(rootPath);
      if (folder) this.renderFolderBranch(section, folder, 0, new Set(this.plugin.store.getSnapshot().expandedFolderPaths));
    }
  }

  private renderFolderBranch(parent: HTMLElement, folder: TFolder, depth: number, expanded: Set<string>): void {
    const state = this.plugin.store.getSnapshot();
    const children = this.plugin.indexService.getChildFolders(folder.path);
    const row = parent.createDiv({ cls: "aos-folder-row" });
    row.style.setProperty("--aos-folder-depth", `${depth}`);
    const toggle = row.createEl("button", { cls: "aos-folder-toggle", text: children.length ? (expanded.has(folder.path) ? "⌄" : "›") : "·" });
    toggle.disabled = children.length === 0;
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      const next = new Set(this.plugin.store.getSnapshot().expandedFolderPaths);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      this.plugin.store.patch({ expandedFolderPaths: [...next] });
      this.renderNavigator();
    });
    const label = row.createEl("button", { cls: "aos-folder-label", text: folder.name || "Vault" });
    label.classList.toggle("is-selected", state.selectedFolderPath === folder.path);
    label.addEventListener("click", () => this.selectFolder(folder.path));

    const favoriteFolderPaths = state.favoriteFolderPaths || [];
    const isFav = favoriteFolderPaths.includes(folder.path);
    const favBtn = row.createEl("button", {
      cls: "aos-folder-fav-btn",
      text: isFav ? "★" : "☆",
      attr: { title: isFav ? "取消收藏" : "收藏" }
    });
    favBtn.classList.toggle("is-active", isFav);
    row.addEventListener("click", () => this.selectFolder(folder.path));
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem(item => {
        item.setTitle(isFav ? "★ 从快捷访问移除" : "☆ 添加至快捷访问")
          .setIcon("star")
          .onClick(() => this.toggleFavoriteFolder(folder.path));
      });
      if (children.length > 0) {
        menu.addItem(item => {
          item.setTitle(expanded.has(folder.path) ? "收起子目录" : "展开子目录")
            .setIcon("folder")
            .onClick(() => {
              const next = new Set(this.plugin.store.getSnapshot().expandedFolderPaths);
              if (next.has(folder.path)) next.delete(folder.path);
              else next.add(folder.path);
              this.plugin.store.patch({ expandedFolderPaths: [...next] });
              this.renderNavigator();
            });
        });
      }
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });

    if (expanded.has(folder.path)) {
      for (const child of children) this.renderFolderBranch(parent, child, depth + 1, expanded);
    }
  }

  private renderMain(): void {
    this.currentRenderId += 1;
    this.virtualList?.destroy();
    this.virtualList = null;
    this.mainPane.empty();
    const module = this.plugin.store.getSnapshot().activeModule;
    if (module === "overview") this.renderOverview();
    else if (module === "navigation") this.renderNavigation();
    else if (module === "collection") this.renderCollection();
    else if (module === "tasks") this.renderTasks();
    else if (module === "intelligence") this.renderIntelligence();
    else if (module === "knowledge") this.renderKnowledgeGraph();
    else if (module === "logs") this.renderLogsPage();
    else this.renderPlannedModule(module);
  }

  private renderOverview(): void {
    this.mainPane.empty();
    const page = this.mainPane.createDiv({ cls: "aos-page aos-overview-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "总览 Overview" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "真实 Vault 活动、当前工作域与知识流状态" });

    this.renderLifeDashboard(page);

    const workspace = this.getWorkspace();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    const adapterTasks = this.plugin.hamasxiangAdapter.getTasks();
    const runningTasks = adapterTasks.filter(task => task.status === "running" || task.status === "queued").length;
    const failedTasks = adapterTasks.filter(task => task.status === "failed" || task.status === "offline").length;
    this.metric(metrics, "索引节点", this.plugin.indexService.getFileCount(workspace).toLocaleString(), workspace ? `当前工作域: ${workspace.name}` : "Vault 当前已加载文件");
    this.metric(metrics, "索引体积", this.formatBytes(this.plugin.indexService.getTotalSize(workspace)), "工作域真实文件体积");
    this.metric(metrics, "今日修改", `${this.plugin.indexService.countModifiedSince(today.getTime(), workspace)}`, "按修改时间统计");
    this.metric(metrics, "运行任务", `${runningTasks}`, failedTasks ? `${failedTasks} 项需关注` : "Adapter 观测正常");
    this.metric(metrics, "最近访问", `${this.plugin.store.getSnapshot().recentFilePaths.length}`, "真实打开记录");

    const grid = page.createDiv({ cls: "aos-overview-grid" });
    const activity = grid.createDiv({ cls: "aos-panel aos-panel-wide" });
    activity.createDiv({ cls: "aos-panel-title", text: "知识活动热力图 · 近 8 周" });
    this.renderHeatmap(activity, workspace);

    const sources = grid.createDiv({ cls: "aos-panel" });
    sources.createDiv({ cls: "aos-panel-title", text: "知识库分类分布 · 真实索引" });
    this.renderDistribution(sources, workspace);

    const flow = grid.createDiv({ cls: "aos-panel aos-panel-wide" });
    flow.createDiv({ cls: "aos-panel-title", text: "当前知识流" });
    const flowRow = flow.createDiv({ cls: "aos-flow-row" });
    for (const [label, detail] of [["采集源", "由蛤蟆祥提供"], ["证据包", "EvidencePacket"], ["知识节点", "Vault 索引"], ["Agent 处理", "等待真实任务总线"], ["发布 / 归档", "松果屋出口"]]) {
      const item = flowRow.createDiv({ cls: "aos-flow-item" });
      item.createDiv({ cls: "aos-flow-label", text: label });
      item.createDiv({ cls: "aos-flow-detail", text: detail });
    }

    const recent = grid.createDiv({ cls: "aos-panel" });
    recent.createDiv({ cls: "aos-panel-title", text: "最近知识节点" });
    this.renderRecentNodeCards(recent, 6);

    const tasks = grid.createDiv({ cls: "aos-panel" });
    tasks.createDiv({ cls: "aos-panel-title", text: "当前任务快照" });
    this.renderTaskList(tasks, adapterTasks.slice(0, 4), true);

    const legacy = page.createDiv({ cls: "aos-panel aos-legacy-actions" });
    legacy.createDiv({ cls: "aos-panel-title", text: "现有控制台能力" });
    legacy.createDiv({ cls: "aos-panel-note", text: "Phase 1–2 保留旧工具入口，后台业务未迁移也未删除。" });
    const actions = legacy.createDiv({ cls: "aos-action-row" });
    this.actionButton(actions, "打开蛤蟆祥指挥中心", () => void this.plugin.openHamasxiangConsole());
    this.actionButton(actions, "打开松果阁旧工具", () => void this.plugin.openLegacyView());
  }

  private renderNavigation(): void {
    const page = this.mainPane.createDiv({ cls: "aos-page aos-navigation-page" });
    const toolbar = page.createDiv({ cls: "aos-file-toolbar" });
    const breadcrumbContainer = toolbar.createDiv({ cls: "aos-breadcrumb-container" });
    const breadcrumb = breadcrumbContainer.createDiv({ cls: "aos-breadcrumb" });
    const folderPath = this.plugin.store.getSnapshot().selectedFolderPath;
    const pathParts = folderPath.split("/").filter(Boolean);
    breadcrumb.createSpan({ text: "导航工作区" });
    for (const part of pathParts.slice(-4)) breadcrumb.createSpan({ text: `› ${part}` });

    if (folderPath) {
      const favoriteFolderPaths = this.plugin.store.getSnapshot().favoriteFolderPaths || [];
      const isFav = favoriteFolderPaths.includes(folderPath);
      const favBtn = breadcrumbContainer.createEl("button", {
        cls: "aos-folder-header-fav-btn",
        text: isFav ? "★" : "☆",
        attr: { title: isFav ? "取消收藏此目录" : "收藏此目录" }
      });
      favBtn.addEventListener("click", () => this.toggleFavoriteFolder(folderPath));
    }

    const search = toolbar.createEl("input", { cls: "aos-file-search", attr: { placeholder: "搜索文件名、路径或标签…" } });
    search.value = this.plugin.store.getSnapshot().searchQuery;
    search.addEventListener("input", () => {
      this.plugin.store.patch({ searchQuery: search.value }, false);
      this.commandInput.value = search.value;
      this.refreshVirtualList();
    });
    const scope = toolbar.createEl("select", { cls: "aos-scope-select" });
    for (const [value, text] of [["current-folder", "当前目录"], ["current-workspace", "当前工作域"], ["vault", "全库"]]) scope.createEl("option", { value, text });
    scope.value = this.plugin.store.getSnapshot().searchScope;
    scope.addEventListener("change", () => {
      this.plugin.store.patch({ searchScope: scope.value as "current-folder" | "current-workspace" | "vault" });
      this.refreshVirtualList();
    });

    const listHeader = page.createDiv({ cls: "aos-list-header" });
    listHeader.createSpan({ text: "知识节点" });
    listHeader.createSpan({ text: "单击查看上下文 · 双击在原生编辑器打开" });
    this.virtualList = new VirtualFileList(page, this.app, {
      view: this,
      onSelect: node => this.selectNode(node),
      onOpen: node => void this.openNode(node),
      isFavorite: path => this.plugin.store.getSnapshot().favoritePaths.includes(path),
      onToggleFavorite: path => this.toggleFavorite(path),
    });
    this.refreshVirtualList();
  }

  private restoreBorrowedClaudian(): void {
    if (this.borrowedClaudianEl && this.borrowedClaudianLeaf && this.borrowedClaudianLeaf.view) {
      try {
        const view = this.borrowedClaudianLeaf.view;
        (view as any).containerEl?.appendChild(this.borrowedClaudianEl);
      } catch (e) {
        console.warn("Failed to restore borrowed claudian view", e);
      }
    }
    this.borrowedClaudianEl = null;
    this.borrowedClaudianLeaf = null;
  }

  public renderContext(): void {
    this.agentRenderTx++;
    this.restoreBorrowedClaudian();
    this.contextPane.empty();
    const header = this.contextPane.createDiv({ cls: "aos-context-header" });
    header.createDiv({ cls: "aos-context-title", text: this.selectedNode?.title ?? "节点上下文" });
    if (this.selectedNode) header.createDiv({ cls: "aos-context-path", text: this.selectedNode.path });
    else header.createDiv({ cls: "aos-context-path", text: "选择知识节点后显示真实上下文" });

    const tabs = this.contextPane.createDiv({ cls: "aos-context-tabs" });
    const tabItems: Array<[ContextTab, string]> = [["overview", "概览"], ["relations", "关联"], ["agent", "Agent"], ["preview", "预览"]];
    for (const [id, label] of tabItems) {
      const button = tabs.createEl("button", { text: label });
      button.classList.toggle("is-active", this.contextTab === id);
      button.addEventListener("click", () => {
        this.contextTab = id;
        this.renderContext();
        this.recordHistoryState(true);
      });
    }

    const body = this.contextPane.createDiv({ cls: "aos-context-body" });
    if (!this.selectedNode) {
      body.createDiv({ cls: "aos-empty-state", text: "从导航、最近访问或搜索结果中选择一个节点。" });
      return;
    }
    if (this.contextTab === "overview") this.renderContextOverview(body, this.selectedNode);
    if (this.contextTab === "relations") this.renderContextRelations(body, this.selectedNode);
    if (this.contextTab === "agent") this.renderContextAgent(body, this.selectedNode);
    if (this.contextTab === "preview") void this.renderContextPreview(body, this.selectedNode);

    const actions = this.contextPane.createDiv({ cls: "aos-context-actions" });
    this.actionButton(actions, "打开笔记", () => void this.openNode(this.selectedNode!));
    this.actionButton(actions, this.plugin.store.getSnapshot().favoritePaths.includes(this.selectedNode.path) ? "取消收藏" : "收藏节点", () => this.toggleFavorite(this.selectedNode!.path));
  }

  private renderContextOverview(parent: HTMLElement, node: KnowledgeNodeViewModel): void {
    const card = parent.createDiv({ cls: "aos-context-card" });
    this.contextField(card, "类型", node.kind);
    this.contextField(card, "状态", node.lifecycleStatus ?? "未声明");
    this.contextField(card, "大小", this.formatBytes(node.size));
    this.contextField(card, "创建", new Date(node.ctime).toLocaleString("zh-CN"));
    this.contextField(card, "修改", new Date(node.mtime).toLocaleString("zh-CN"));
    if (node.tags.length) this.contextField(card, "标签", node.tags.join(" "));
  }

  private renderContextRelations(parent: HTMLElement, node: KnowledgeNodeViewModel): void {
    const normalized = normalizePath(node.path);
    const outgoingMap = this.app.metadataCache.resolvedLinks[normalized] ?? {};
    const unresolvedMap = this.app.metadataCache.unresolvedLinks[normalized] ?? {};
    const backlinks: string[] = [];
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (targets[normalized]) backlinks.push(source);
    }

    // 1. Overview counts card
    const countsCard = parent.createDiv({ cls: "aos-context-card" });
    this.contextField(countsCard, "出链数量", `${Object.keys(outgoingMap).length}`);
    this.contextField(countsCard, "反链数量", `${backlinks.length}`);
    this.contextField(countsCard, "未解析链接", `${Object.keys(unresolvedMap).length}`);

    const graphBtn = countsCard.createEl("button", { cls: "aos-action-button", text: "在动态图谱中聚焦" });
    graphBtn.setAttribute("style", "width: 100%; margin-top: 8px; font-size: 10px;");
    graphBtn.addEventListener("click", () => {
      this.graphScope = "current-file";
      this.switchModule("knowledge");
    });

    // 2. Outgoing Links list
    const outgoingSection = parent.createDiv({ cls: "aos-context-card" });
    outgoingSection.createDiv({ text: "🔗 出链节点列表", cls: "aos-relation-section-title" });
    const outgoingList = outgoingSection.createDiv({ cls: "aos-relation-list" });
    const outgoingPaths = Object.keys(outgoingMap);
    if (outgoingPaths.length > 0) {
      for (const targetPath of outgoingPaths) {
        const targetNode = this.toNode(targetPath);
        const name = targetNode ? targetNode.title : targetPath.split("/").pop() || targetPath;
        const item = outgoingList.createDiv({ cls: "aos-relation-item", text: name });
        item.setAttribute("title", targetPath);
        item.addEventListener("click", () => {
          if (targetNode) {
            this.switchModule("navigation");
            this.selectFolder(targetNode.parentPath);
            this.selectNode(targetNode);
            this.virtualList?.focusPath(targetNode.path);
          } else {
            new Notice(`无法在索引中找到节点：${targetPath}`);
          }
        });
      }
    } else {
      outgoingList.createDiv({ cls: "aos-empty-state", text: "该节点没有指向其它节点的出链。" });
    }

    // 3. Backlinks list
    const backlinksSection = parent.createDiv({ cls: "aos-context-card" });
    backlinksSection.createDiv({ text: "📥 反链来源列表", cls: "aos-relation-section-title" });
    const backlinksList = backlinksSection.createDiv({ cls: "aos-relation-list" });
    if (backlinks.length > 0) {
      for (const sourcePath of backlinks) {
        const sourceNode = this.toNode(sourcePath);
        const name = sourceNode ? sourceNode.title : sourcePath.split("/").pop() || sourcePath;
        const item = backlinksList.createDiv({ cls: "aos-relation-item", text: name });
        item.setAttribute("title", sourcePath);
        item.addEventListener("click", () => {
          if (sourceNode) {
            this.switchModule("navigation");
            this.selectFolder(sourceNode.parentPath);
            this.selectNode(sourceNode);
            this.virtualList?.focusPath(sourceNode.path);
          } else {
            new Notice(`无法在索引中找到节点：${sourcePath}`);
          }
        });
      }
    } else {
      backlinksList.createDiv({ cls: "aos-empty-state", text: "尚无其它节点引用此节点。" });
    }
  }

      private async renderContextAgent(parent: HTMLElement, node: KnowledgeNodeViewModel): Promise<void> {
    const card = parent.createDiv({ cls: "aos-context-card" });
    card.setAttribute("style", "padding: 12px; display: flex; flex-direction: column; gap: 12px;");
    
    // Check if Claudian plugin is enabled
    if (CompatAdapter.isClaudianAvailable(this.app)) {
      const chatSection = card.createDiv({ cls: "aos-agent-chat-mvp" });
      chatSection.setAttribute("style", "display: flex; flex-direction: column; flex-grow: 1;");
      
      const chatTitle = chatSection.createDiv({ text: "💬 Claudian 智能协同对讲机 (已融合)" });
      chatTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 8px; color: var(--aos-gold);");
      
      const embedContainer = chatSection.createDiv({ cls: "aos-claudian-embed" });
      embedContainer.setAttribute("style", "height: 520px; display: flex; flex-direction: column; border: 1px solid var(--aos-border); border-radius: var(--aos-radius); overflow: hidden; background: var(--aos-surface-muted); justify-content: center; align-items: center; position: relative;");
      
      // Spinner loader
      const loader = embedContainer.createDiv({ cls: "aos-spinner" });
      const statusText = embedContainer.createDiv({ text: "正在唤醒 Claudian 对讲机...", cls: "aos-loading-text" });
      statusText.setAttribute("style", "font-size: 10px; color: var(--aos-ink-muted); margin-top: 10px;");
      
      // Increment transaction counter and capture it locally
      this.agentRenderTx++;
      const tx = this.agentRenderTx;
      
      // Asynchronously instantiate and mount Claudian view to bypass race conditions
      setTimeout(async () => {
        try {
          if (tx !== this.agentRenderTx) return; // Stale transaction check
          
          let leaf: any = this.app.workspace.getLeavesOfType("claudian-view")[0] || null;
          if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            await leaf.setViewState({ type: "claudian-view", active: true });
          }
          
          if (tx !== this.agentRenderTx) return; // Double check after async leaf creation
          
          if (leaf && leaf.view) {
            if (leaf.view.getViewType() === "claudian-view" && !CompatAdapter.isClaudianViewInitialized(leaf)) {
              try {
                if (typeof (leaf.view as any).onOpen === "function") {
                  await (leaf.view as any).onOpen();
                }
              } catch (openErr) {
                console.warn("Manually triggering onOpen on ClaudianView failed", openErr);
              }
            }
            
            if (tx !== this.agentRenderTx) return; // Double check after async onOpen

            CompatAdapter.syncClaudianContext(this.app, node.path);

            this.restoreBorrowedClaudian();
            const contentEl = CompatAdapter.getClaudianContentEl(leaf);
            if (contentEl) {
              this.borrowedClaudianEl = contentEl;
              this.borrowedClaudianLeaf = leaf;
              
              embedContainer.empty();
              embedContainer.appendChild(contentEl);
              embedContainer.setAttribute("style", "height: 520px; display: flex; flex-direction: column; border: 1px solid var(--aos-border); border-radius: var(--aos-radius); overflow: hidden; background: var(--aos-surface-muted);");
              
              if (typeof (leaf.view as any).onResize === "function") {
                try { (leaf.view as any).onResize(); } catch(e) {}
              }
              return;
            }
          }
          throw new Error("Unable to retrieve Claudian content element");
        } catch (e) {
          if (tx === this.agentRenderTx) {
            console.warn("Failed to embed Claudian view", e);
            embedContainer.empty();
            embedContainer.createDiv({ cls: "aos-empty-state", text: "无法嵌入 Claudian 视图，请确保 Claudian 插件已启用且未损坏。" });
          }
        }
      }, 50);
      
      return;
    }

    // 1. Last Agent Run History (If any)
    const historySection = card.createDiv({ cls: "aos-agent-history-section" });
    const histTitle = historySection.createDiv({ text: "📋 节点执行历史" });
    histTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 6px; color: var(--aos-ink-muted);");
    if (node.lastAgent) {
      this.contextField(historySection, "Agent", node.lastAgent.agent);
      this.contextField(historySection, "动作", node.lastAgent.action);
    } else {
      historySection.createDiv({ cls: "aos-empty-state", text: "该节点尚无历史 Agent 动作记录。" });
    }

    // 2. Interactive Workspace Tools/Capabilities MVP
    const ws = this.getWorkspace();
    if (ws && ws.capabilities.length > 0) {
      const capSection = card.createDiv({ cls: "aos-agent-caps-mvp" });
      capSection.setAttribute("style", "border-top: 1px solid var(--aos-border); padding-top: 10px;");
      const capTitle = capSection.createDiv({ text: "🛠️ 节点专属工作域工具" });
      capTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 8px; color: var(--aos-gold);");
      for (const cap of ws.capabilities) {
        const btn = capSection.createEl("button", {
          cls: "aos-topbar-button",
          text: "运行: " + cap.name
        });
        btn.setAttribute("style", "width: 100%; margin-bottom: 6px; text-align: left; height: auto; padding: 6px 10px; font-size: 9px; display: block;");
        btn.addEventListener("click", () => {
          new Notice("正在调度 Agent 运行【" + cap.name + "】对当前节点【" + node.title + "】进行深度加工...");
          void this.appendAgentChatMessage("System", "调度运行能力: " + cap.name + " (" + cap.id + ") 对当前节点 《" + node.title + "》");
        });
      }
    }

    // 3. Interactive Agent Chat Sidebar/Bridge
    const chatSection = card.createDiv({ cls: "aos-agent-chat-mvp" });
    chatSection.setAttribute("style", "border-top: 1px solid var(--aos-border); padding-top: 10px;");
    const chatTitle = chatSection.createDiv({ text: "💬 协同 Agent 浮窗对讲机" });
    chatTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 8px; color: var(--aos-gold);");
    
    const chatLog = chatSection.createDiv();
    chatLog.setAttribute("style", "max-height: 240px; overflow-y: auto; background: rgba(0,0,0,0.03); border: 1px solid var(--aos-border); border-radius: 4px; padding: 8px; font-size: 10px; margin-bottom: 6px; text-align: left; display: flex; flex-direction: column; gap: 8px;");

    const chatFilePath = ".agents/chat/dialog.md";
    let chatContent = "";
    try {
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(chatFilePath);
      if (!exists) {
        await adapter.mkdir(".agents/chat").catch(() => {});
        chatContent = "**System** (" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "): 🤖 [天工台]: 你好！协作 Agent 对讲机已启动。本对话与本地 \`.agents/chat/dialog.md\` 实时绑定。我在下一次唤醒时将读取此处的历史上下文。";
        await adapter.write(chatFilePath, chatContent);
      } else {
        chatContent = await adapter.read(chatFilePath);
      }
    } catch (e) {
      console.warn("Failed to load chat dialog file", e);
      chatContent = "**System** (error): 无法加载对话文件: " + (e instanceof Error ? e.message : String(e));
    }

    const paragraphs = chatContent.split("\n\n").filter(Boolean);
    for (const para of paragraphs) {
      const match = para.match(/^\*\*([^*]+)\*\* \(([^)]+)\): ([\s\S]*)/);
      if (match) {
        const sender = match[1];
        const time = match[2];
        const text = match[3];
        const msgEl = chatLog.createDiv();
        const isUser = sender.trim().toLowerCase() === "user";
        const isSystem = sender.trim().toLowerCase() === "system";
        
        if (isUser) {
          msgEl.setAttribute("style", "align-self: flex-end; max-width: 85%; margin-bottom: 2px; text-align: right;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-user" });
          span.setAttribute("style", "background: rgba(169, 111, 23, 0.12); padding: 4px 8px; border-radius: 8px 8px 0px 8px; display: inline-block; word-break: break-word; border: 1px solid rgba(169, 111, 23, 0.2);");
          const textEl = span.createDiv({ text: text });
          textEl.style.fontWeight = "500";
          const timeEl = span.createDiv({ text: time });
          timeEl.setAttribute("style", "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;");
        } else {
          msgEl.setAttribute("style", "align-self: flex-start; max-width: 85%; margin-bottom: 2px; text-align: left;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-agent" });
          const isGold = !isSystem;
          span.setAttribute("style", "background: var(--aos-surface-muted); padding: 4px 8px; border-radius: 8px 8px 8px 0px; display: inline-block; word-break: break-word; border: 1px solid var(--aos-border); color: " + (isGold ? "var(--aos-gold)" : "var(--aos-ink-muted)") + ";");
          span.createDiv({ text: text });
          const timeEl = span.createDiv({ text: sender + " · " + time });
          timeEl.setAttribute("style", "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;");
        }
      } else {
        const msgEl = chatLog.createDiv({ text: para });
        msgEl.setAttribute("style", "color: var(--aos-ink-muted); font-style: italic; font-size: 9px;");
      }
    }
    
    setTimeout(() => {
      chatLog.scrollTop = chatLog.scrollHeight;
    }, 50);

    const inputRow = chatSection.createDiv();
    inputRow.setAttribute("style", "display: flex; gap: 6px;");
    const chatInput = inputRow.createEl("input", { placeholder: "向 Agent 提问..." });
    chatInput.setAttribute("style", "flex: 1; font-size: 10px; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--aos-border); background: var(--aos-surface); color: var(--aos-ink);");
    const sendBtn = inputRow.createEl("button", { cls: "aos-chat-send-btn", text: "发送" });
    sendBtn.setAttribute("style", "font-size: 10px; height: 26px; padding: 0 10px; font-weight: bold; border-radius: 6px; border: 1px solid var(--aos-border); background: var(--aos-surface); cursor: pointer;");
    
    const handleSend = async () => {
      const question = chatInput.value.trim();
      if (!question) return;
      chatInput.value = "";
      await this.appendAgentChatMessage("User", question);
    };

    sendBtn.addEventListener("click", handleSend);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSend();
    });
  }

  private async appendAgentChatMessage(sender: string, message: string): Promise<void> {
    const chatFilePath = ".agents/chat/dialog.md";
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const formatted = "\n\n**" + sender + "** (" + time + "): " + message;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(chatFilePath)) {
        await adapter.append(chatFilePath, formatted);
      } else {
        await adapter.write(chatFilePath, formatted);
      }
    } catch (e) {
      new Notice("写入对话失败: " + e);
    }
  }

private async renderContextPreview(parent: HTMLElement, node: KnowledgeNodeViewModel): Promise<void> {
    const card = parent.createDiv({ cls: "aos-context-card" });
    card.addClass("aos-markdown-preview");
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile) || file.extension !== "md") {
      card.createDiv({ cls: "aos-empty-state", text: "该节点不是 Markdown 文件，无法生成正文预览。" });
      return;
    }
    const loading = card.createDiv({ cls: "aos-empty-state", text: "正在渲染正文预览…" });
    try {
      const markdown = await this.app.vault.cachedRead(file);
      if (this.selectedNode?.path !== node.path || this.contextTab !== "preview") return;
      loading.remove();
      await MarkdownRenderer.render(this.app, markdown, card, file.path, this);
      this.registerDomEvent(card, "mouseover", (event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === "A" && target.hasClass("internal-link")) {
          const linktext = target.getAttribute("data-href") || target.getAttribute("href");
          if (linktext) {
            this.app.workspace.trigger("hover-link", {
              event,
              source: "aetheric-os",
              hoverParent: this,
              targetEl: target,
              linktext: linktext,
              sourcePath: node.path,
            });
          }
        }
      });
    } catch (error) {
      loading.setText(`预览失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private renderLogsPage(): void {
    const entries = this.plugin.logBus.getEntries();
    const daemonEntries = entries.filter(entry => entry.source.startsWith("hamaxiang."));
    const page = this.mainPane.createDiv({ cls: "aos-page" });
    page.createDiv({ cls: "aos-page-title", text: "日志 Logs" });
    page.createDiv({ cls: "aos-page-subtitle", text: "统一日志坞站已在底部运行；可拖动、筛选、暂停跟随和最大化。" });

    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    this.metric(metrics, "日志总数", `${entries.length}`, "当前内存窗口");
    this.metric(metrics, "Daemon 日志", `${daemonEntries.length}`, "GET /logs 增量同步");
    this.metric(metrics, "异常", `${entries.filter(entry => entry.level === "error").length}`, "error");
    this.metric(metrics, "警告", `${entries.filter(entry => entry.level === "warn").length}`, "warn");

    const card = page.createDiv({ cls: "aos-panel" });
    card.createDiv({ cls: "aos-panel-title", text: "当前接入来源" });
    card.createDiv({ cls: "aos-panel-note", text: "Shell 生命周期、导航、文件索引、松果阁旧工具，以及蛤蟆祥 Daemon 的任务与 X Watch 结构化事件。Daemon 日志按游标增量同步，不读取终端 DOM。" });

    const recent = page.createDiv({ cls: "aos-panel" });
    recent.createDiv({ cls: "aos-panel-title", text: "最近日志" });
    const recentEntries = entries.slice(-30).reverse();
    if (!recentEntries.length) {
      recent.createDiv({ cls: "aos-empty-state", text: "当前还没有日志。" });
    } else {
      const list = recent.createDiv({ cls: "aos-task-list" });
      for (const entry of recentEntries) {
        const row = list.createDiv({ cls: "aos-task-row" });
        const dot = row.createSpan({ cls: "aos-status-dot" });
        if (entry.level === "error") dot.addClass("is-error");
        else if (entry.level === "warn") dot.addClass("is-queued");
        const primary = row.createDiv({ cls: "aos-task-primary" });
        primary.createDiv({ cls: "aos-task-title", text: entry.message });
        primary.createDiv({ cls: "aos-task-detail", text: `${entry.source} · ${new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}` });
      }
    }
  }

  private renderCollection(): void {
    const snapshot = this.plugin.hamasxiangAdapter.getSnapshot();
    const page = this.mainPane.createDiv({ cls: "aos-page aos-hamasxiang-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "采集 · 蛤蟆祥系统" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "通过本地 Daemon 公共端点接入，不复制爬虫后端" });

    const hero = page.createDiv({ cls: "aos-hamasxiang-hero" });
    hero.createDiv({ cls: "aos-hamasxiang-mark", text: "🐸" });
    const intro = hero.createDiv();
    intro.createDiv({ cls: "aos-panel-title", text: "蛤蟆祥 · 采集与情报引擎" });
    intro.createDiv({ cls: "aos-panel-note", text: "它现在是松果天工台的采集子系统；原控制台仍作为高级管理页保留。" });
    const badge = hero.createSpan({ cls: `aos-service-badge ${snapshot.online ? "is-online" : "is-offline"}` });
    badge.createSpan({ cls: "aos-badge-dot" });
    badge.createSpan({ text: snapshot.online ? "本地炉火在线" : "本地炉火离线" });

    const metrics = page.createDiv({ cls: "aos-metric-grid aos-adapter-metrics" });
    this.metric(metrics, "Daemon", snapshot.online ? "在线" : "离线", snapshot.service);
    this.metric(metrics, "活跃任务", `${snapshot.activeJobs}`, "来自 GET /health");
    this.metric(metrics, "X Watch", this.xWatchLabel(snapshot.xWatch), "真实巡逻状态");
    this.metric(metrics, "上轮新增", `${snapshot.xWatch.last_new_count ?? 0}`, snapshot.xWatch.last_success_at ?? "暂无成功时间");
    this.metric(metrics, "下次巡逻", this.formatNextRun(snapshot.xWatch.next_run_at), "Daemon 调度");

    const panel = page.createDiv({ cls: "aos-panel" });
    panel.createDiv({ cls: "aos-panel-title", text: "采集操作" });
    panel.createDiv({ cls: "aos-panel-note", text: snapshot.error ? `最近连接错误：${snapshot.error}` : "数据来自 127.0.0.1:8765；仅在点击操作时触发任务。" });
    const actions = panel.createDiv({ cls: "aos-action-row" });
    this.actionButton(actions, "刷新炉火状态", () => void this.plugin.hamasxiangAdapter.refresh(true));
    this.actionButton(actions, "立即巡逻 X", () => void this.runXWatch());
    this.actionButton(actions, "打开完整蛤蟆祥控制台", () => void this.plugin.openHamasxiangConsole());

    const tasks = page.createDiv({ cls: "aos-panel" });
    tasks.createDiv({ cls: "aos-panel-title", text: "采集任务快照" });
    this.renderTaskList(tasks, this.plugin.hamasxiangAdapter.getTasks(), false);

    const artifacts = page.createDiv({ cls: "aos-panel" });
    artifacts.createDiv({ cls: "aos-panel-title", text: "最近产物" });
    this.renderArtifactList(artifacts, this.plugin.hamasxiangAdapter.getArtifacts().slice(0, 8));
  }

  private renderTasks(): void {
    const tasks = this.plugin.hamasxiangAdapter.getTasks();
    const page = this.mainPane.createDiv({ cls: "aos-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "任务 Tasks" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "统一 OperationTask 快照；只展示真实可观测任务" });

    const summary = page.createDiv({ cls: "aos-metric-grid aos-task-summary" });
    this.metric(summary, "任务总数", `${tasks.length}`, "来自已接入 adapter");
    this.metric(summary, "运行中", `${tasks.filter(task => task.status === "running" || task.status === "queued").length}`, "queued / running");
    this.metric(summary, "异常", `${tasks.filter(task => task.status === "failed" || task.status === "offline").length}`, "failed / offline");
    this.metric(summary, "可操作", `${tasks.filter(task => task.action).length}`, "支持直接触发");
    this.metric(summary, "接入源", "1", "Hamasxiang Daemon");

    const active = page.createDiv({ cls: "aos-panel aos-task-adapter" });
    active.createDiv({ cls: "aos-panel-title", text: "真实任务列表" });
    this.renderTaskList(active, tasks, false);

    const honest = page.createDiv({ cls: "aos-panel" });
    honest.createDiv({ cls: "aos-panel-title", text: "任务契约边界" });
    honest.createDiv({ cls: "aos-panel-note", text: "当前任务来自 Daemon 的真实 JOBS 与 X Watch 状态。审批与 Agent 步骤仍未由后端提供，因此界面不会虚构这些字段。" });

    const artifacts = page.createDiv({ cls: "aos-panel" });
    artifacts.createDiv({ cls: "aos-panel-title", text: "产物与结果" });
    this.renderArtifactList(artifacts, this.plugin.hamasxiangAdapter.getArtifacts());
  }

  private renderIntelligence(): void {
    const snapshot = this.plugin.hamasxiangAdapter.getSnapshot();
    const items = this.plugin.hamasxiangAdapter.getIntelligence();
    const page = this.mainPane.createDiv({ cls: "aos-page aos-intelligence-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "情报 Intelligence" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "读取 X Watch 与情报雷达的真实分类结果；不在 Shell 内重复运行爬虫" });

    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    this.metric(metrics, "情报条目", `${items.length}`, "GET /intelligence");
    this.metric(metrics, "高相关", `${items.filter(item => item.relevant).length}`, "classifier relevant");
    this.metric(metrics, "需通知", `${items.filter(item => item.shouldNotify).length}`, "should_notify");
    this.metric(metrics, "巡逻状态", this.xWatchLabel(snapshot.xWatch), snapshot.online ? "Daemon 在线" : "Daemon 离线");

    const actions = page.createDiv({ cls: "aos-action-row" });
    this.actionButton(actions, "刷新情报", () => void this.plugin.hamasxiangAdapter.refresh(true));
    this.actionButton(actions, "立即巡逻 X", () => void this.runXWatch());
    this.actionButton(actions, "打开蛤蟆祥指挥中心", () => void this.plugin.openHamasxiangConsole());

    const panel = page.createDiv({ cls: "aos-panel" });
    panel.createDiv({ cls: "aos-panel-title", text: "最近分类结果" });
    this.renderIntelligenceList(panel, items);
  }

  private renderKnowledgeGraph(): void {
    // Treat every scope/context update as a new render transaction so delayed
    // work from an older native graph cannot overwrite the current scope.
    this.currentRenderId += 1;
    const state = this.plugin.store.getSnapshot();
    const selectedFilePath = this.selectedNode?.path ?? state.selectedFilePath ?? null;
    const selectedTags = selectedFilePath
      ? (this.plugin.indexService.getIndexedFile(selectedFilePath)?.tags ?? [])
      : [];
    const hasCurrentTag = selectedTags.length > 0;

    if (!selectedFilePath && this.graphScope === "current-file") {
      this.graphScope = "current-workspace";
    }

    // ── 原地热更新 (In-place Hot Update) ──
    const existingPage = this.mainPane.querySelector(".aos-graph-page");
    if (existingPage) {
      // 1. Update scope buttons active status
      const buttons = existingPage.querySelectorAll(".aos-graph-scopes button");
      const scopes: GraphScope[] = ["current-file", "current-folder", "current-workspace", "current-tag", "vault"];
      buttons.forEach((el: Element, idx) => {
        const button = el as HTMLButtonElement;
        const scope = scopes[idx];
        if (scope) {
          button.classList.toggle("is-active", this.graphScope === scope);
          if (scope === "current-file") {
            button.disabled = !selectedFilePath;
            if (!selectedFilePath) {
              button.setAttribute("title", "请先在当前工作域中选择一个知识节点");
            } else {
              button.removeAttribute("title");
            }
          } else if (scope === "current-tag") {
            button.disabled = selectedTags.length === 0;
            if (selectedTags.length === 0) {
              button.setAttribute("title", "当前节点没有可用于筛选的标签");
            } else {
              button.removeAttribute("title");
            }
          }
        }
      });

      // 2. Fetch new graph data based on scope & workspace
      const data = this.graphScope === "current-tag" && !hasCurrentTag
        ? { nodes: [], edges: [], truncated: false }
        : this.plugin.indexService.getGraphData(
          selectedFilePath,
          this.graphScope,
          this.getWorkspace(),
          state.selectedFolderPath,
        );

      // 3. Update metadata counts
      const meta = existingPage.querySelector(".aos-graph-meta");
      if (meta) {
        meta.empty();
        meta.createSpan({ text: `${data.nodes.length} 个节点 (索引预估)` });
        meta.createSpan({ text: `${data.edges.length} 条关系 (索引预估)` });
        if (data.truncated) meta.createSpan({ text: "已为交互性能截断", cls: "is-warn" });
      }

      // 4. Update the WebGL graph canvas context
      const canvas = existingPage.querySelector(".aos-graph-canvas") as HTMLDivElement;
      if (canvas) {
        if (!this.plugin.indexService.isReady()) {
          this.disposeNativeGraphView();
          canvas.empty();
          canvas.createDiv({ cls: "aos-empty-state", text: "知识索引正在准备中，完成后将显示当前工作域图谱。" });
          return;
        }
        if (data.nodes.length === 0) {
          this.disposeNativeGraphView();
          canvas.empty();
          const message = this.graphScope === "current-file"
            ? "当前未选中任何节点。请先在工作域中选择节点以渲染局部图谱。"
            : this.graphScope === "current-tag"
              ? "当前节点没有标签，无法生成标签图谱。"
              : "当前作用域内暂无可渲染的知识节点。";
          canvas.createDiv({ cls: "aos-empty-state", text: message });
          return;
        }

        const graphSeedPath = selectedFilePath && data.nodes.some(node => node.path === selectedFilePath)
          ? selectedFilePath
          : data.nodes[0].path;

        void this.mountGraphCanvas(canvas, graphSeedPath, data, this.graphScope, selectedTags);
      }
      return;
    }

    // ── 首次加载 (Cold Boot) ──
    const page = this.mainPane.createDiv({ cls: "aos-page aos-graph-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "动态知识图谱 Graph" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "基于 MetadataCache 的真实链接关系，跟随当前上下文" });
    const controls = page.createDiv({ cls: "aos-graph-scopes" });
    const scopes: Array<[GraphScope, string]> = [
      ["current-file", "当前文件"], ["current-folder", "当前目录"], ["current-workspace", "当前工作域"],
      ["current-tag", "当前标签"], ["vault", "全库"],
    ];
    for (const [scope, label] of scopes) {
      const button = controls.createEl("button", { text: label });
      button.classList.toggle("is-active", this.graphScope === scope);
      if (scope === "current-file" && !selectedFilePath) {
        button.disabled = true;
        button.setAttribute("title", "请先在当前工作域中选择一个知识节点");
      } else if (scope === "current-tag" && selectedTags.length === 0) {
        button.disabled = true;
        button.setAttribute("title", "当前节点没有可用于筛选的标签");
      }
      button.addEventListener("click", () => {
        this.graphScope = scope;
        this.renderKnowledgeGraph();
      });
    }

    controls.createSpan({ cls: "aos-graph-separator" });

    const nativeGlobal = controls.createEl("button", { cls: "aos-graph-native-btn", text: "打开官方全局图谱大图 ↗" });
    nativeGlobal.addEventListener("click", () => {
      this.app.workspace.getLeaf("tab").setViewState({
        type: "graph",
        active: true
      });
      new Notice("正在新标签页中打开官方全局关系图谱...");
    });

    const data = this.graphScope === "current-tag" && !hasCurrentTag
      ? { nodes: [], edges: [], truncated: false }
      : this.plugin.indexService.getGraphData(
        selectedFilePath,
        this.graphScope,
        this.getWorkspace(),
        state.selectedFolderPath,
      );
    const meta = page.createDiv({ cls: "aos-graph-meta" });
    meta.createSpan({ text: `${data.nodes.length} 个节点 (索引预估)` });
    meta.createSpan({ text: `${data.edges.length} 条关系 (索引预估)` });
    if (data.truncated) meta.createSpan({ text: "已为交互性能截断", cls: "is-warn" });
    const canvas = page.createDiv({ cls: "aos-graph-canvas" });
    canvas.setAttribute("style", "height: 100%; min-height: 480px; display: flex; flex-direction: column;");
    if (!this.plugin.indexService.isReady()) {
      this.disposeNativeGraphView();
      canvas.createDiv({ cls: "aos-empty-state", text: "知识索引正在准备中，完成后将显示当前工作域图谱。" });
      return;
    }
    if (data.nodes.length === 0) {
      this.disposeNativeGraphView();
      const message = this.graphScope === "current-file"
        ? "当前未选中任何节点。请先在工作域中选择节点以渲染局部图谱。"
        : this.graphScope === "current-tag"
          ? "当前节点没有标签，无法生成标签图谱。"
          : "当前作用域内暂无可渲染的知识节点。";
      canvas.createDiv({ cls: "aos-empty-state", text: message });
      return;
    }

    // A native localgraph still needs a technical anchor even for folder/workspace
    // scopes. Prefer the selected shell node only when it belongs to the scoped
    // dataset; otherwise anchor to the first scoped node instead of an outside tab.
    const graphSeedPath = selectedFilePath && data.nodes.some(node => node.path === selectedFilePath)
      ? selectedFilePath
      : data.nodes[0].path;

    void this.mountGraphCanvas(canvas, graphSeedPath, data, this.graphScope, selectedTags);
  }

  private disposeNativeGraphView(): void {
    const graphView = this.nativeGraphView;
    this.nativeGraphView = null;
    this.nativeGraphLeaf = null;
    if (!graphView) return;
    try {
      if (typeof graphView.unload === "function") graphView.unload();
    } catch (error) {
      console.warn("Unloading native graph view error", error);
    }
  }

  private async mountGraphCanvas(
    canvas: HTMLDivElement,
    seedPath: string,
    data: any,
    scope: GraphScope,
    selectedTags: readonly string[],
  ): Promise<void> {
    await this.mountNativeGraph(canvas, seedPath, data, scope, selectedTags);
  }

  private async mountNativeGraph(
    canvas: HTMLDivElement,
    seedPath: string,
    data: any,
    scope: GraphScope,
    selectedTags: readonly string[],
  ): Promise<void> {
    const renderId = this.currentRenderId;
    let ownedGraphView: any = null;
    const disposeOwnedView = (): void => {
      if (!ownedGraphView) return;
      try {
        if (typeof ownedGraphView.unload === "function") ownedGraphView.unload();
      } catch (error) {
        console.warn("Failed to unload stale native graph view", error);
      }
      if (this.nativeGraphView === ownedGraphView) {
        this.nativeGraphView = null;
        this.nativeGraphLeaf = null;
      }
      ownedGraphView = null;
    };
    const abortIfStale = (): boolean => {
      if (this.currentRenderId === renderId) return false;
      disposeOwnedView();
      return true;
    };

    try {
      const viewType = scope === "current-file" ? "localgraph" : "graph";
      const viewCreator = (this.app as any).viewRegistry.getViewCreatorByType(viewType);
      if (!viewCreator) throw new Error(`No view creator for ${viewType}`);

      const nextGraphLeaf = {
        app: this.app,
        workspace: this.app.workspace,
        containerEl: canvas,
        view: null as any,
        getDisplayText: () => viewType === "localgraph" ? "Local Graph" : "Graph",
        getViewState: () => ({ type: viewType, state: {} }),
        setViewState: () => Promise.resolve(),
        getIcon: () => "graph",
        history: {
          backHistory: [],
          forwardHistory: [],
          back: () => {},
          forward: () => {},
          go: () => {},
          pushState: () => {},
          replaceState: () => {},
        },
        tabHeaderEl: document.createElement("div"),
        tabHeaderInnerIconEl: document.createElement("div"),
        tabHeaderTitleEl: document.createElement("div"),
        tabHeaderCloseEl: document.createElement("div"),
        parent: this.app.workspace.rootSplit,
        on: (name: string, callback: any, ctx?: any) => { return {}; },
        off: (name: string, callback: any) => {},
        trigger: (name: string, ...args: any[]) => {},
        onResize: () => {
          if (ownedGraphView && typeof ownedGraphView.onResize === "function") {
            ownedGraphView.onResize();
          }
        },
        updateHeader: () => {},
      } as any;

      let currentOptions: any = {};
      const folderPath = this.plugin.store.getSnapshot().selectedFolderPath;
      let searchQuery = "";

      const applyEmbeddedGraphSearch = (gv: any): void => {
        if (viewType !== "graph") return;
        CompatAdapter.safeApplyGraphSearch(gv, searchQuery, scope === "current-tag");
      };
      
      if (scope === "current-folder" && folderPath) {
        searchQuery = `path:"${normalizePath(folderPath)}"`;
      } else if (scope === "current-workspace") {
        const ws = this.getWorkspace();
        if (ws && ws.rootPaths && ws.rootPaths.length > 0) {
          searchQuery = ws.rootPaths.map(p => `path:"${normalizePath(p)}"`).join(" OR ");
        }
      } else if (scope === "current-tag") {
        if (selectedTags.length > 0) {
          searchQuery = selectedTags.map(t => {
            const name = t.startsWith("#") ? t : `#${t}`;
            return `tag:${name}`;
          }).join(" OR ");
        }
      }

      if (viewType === "graph") {
        delete currentOptions["localJumps"];
        delete currentOptions["localBacklinks"];
        delete currentOptions["localForelinks"];
      }

      let tFile = this.app.vault.getAbstractFileByPath(seedPath);
      if (viewType === "localgraph") {
        if (!(tFile instanceof TFile)) {
          throw new Error(`Graph seed is not a file: ${seedPath}`);
        }
      }

      // Check if we can reuse the existing view
      if (this.nativeGraphView) {
        const currentViewType = this.nativeGraphView.getViewType();
        if (currentViewType === viewType && this.nativeGraphLeaf && this.nativeGraphLeaf.containerEl === canvas) {
          const overlay = canvas.createDiv({ cls: "aos-graph-overlay" });
          const spinner = overlay.createDiv({ cls: "aos-spinner" });
          overlay.style.opacity = "0";
          void overlay.offsetHeight;
          overlay.style.opacity = "1";

          if (viewType === "localgraph" && tFile) {
            CompatAdapter.safeSetGraphFile(this.nativeGraphView, tFile);
          }
          const graphState = viewType === "localgraph" ? {
            file: tFile ? tFile.path : seedPath,
            options: {
              "collapse-filter": true,
              "localJumps": 1,
              "localBacklinks": true,
              "localForelinks": true,
              ...currentOptions,
              "showTags": false,
              "search": searchQuery
            }
          } : {
            "collapse-filter": true,
            ...currentOptions,
            "showTags": scope === "current-tag",
            "search": searchQuery,
            options: {
              "collapse-filter": true,
              ...currentOptions,
              "showTags": scope === "current-tag",
              "search": searchQuery
            }
          };
          
          if (viewType === "localgraph") {
            await CompatAdapter.safeSetGraphState(this.nativeGraphView, graphState);
            if (abortIfStale()) {
              overlay.remove();
              return;
            }
          }
          applyEmbeddedGraphSearch(this.nativeGraphView);
          await new Promise<void>(resolve => window.setTimeout(resolve, 240));
          if (abortIfStale()) {
            overlay.remove();
            return;
          }
          
          // Fade out helper with timeout safety fallback
          overlay.style.opacity = "0";
          let removed = false;
          const cleanup = () => {
            if (removed) return;
            removed = true;
            overlay.remove();
          };
          overlay.addEventListener("transitionend", cleanup);
          window.setTimeout(cleanup, 300);
          return;
        }

        const previousGraphView = this.nativeGraphView;
        const state = CompatAdapter.safeGetGraphState(previousGraphView);
        if (state && state.options) {
          currentOptions = state.options;
        }

        try {
          if (typeof previousGraphView.unload === "function") {
            previousGraphView.unload();
          }
        } catch (e) {
          console.warn("Failed to unload previous graph view", e);
        }
        if (this.nativeGraphView === previousGraphView) {
          this.nativeGraphView = null;
          this.nativeGraphLeaf = null;
        }
      }
      if (abortIfStale()) return;

      canvas.empty();
      const overlay = canvas.createDiv({ cls: "aos-graph-overlay" });
      const spinner = overlay.createDiv({ cls: "aos-spinner" });

      const graphView = viewCreator(nextGraphLeaf);
      ownedGraphView = graphView;
      nextGraphLeaf.view = graphView;
      this.nativeGraphLeaf = nextGraphLeaf;
      this.nativeGraphView = graphView;

      graphView.load();
      if (typeof graphView.onOpen === "function") {
        await graphView.onOpen();
        if (abortIfStale()) {
          overlay.remove();
          return;
        }
      }

      if (viewType === "localgraph" && tFile) {
        CompatAdapter.safeSetGraphFile(graphView, tFile);
      }

      const graphState = viewType === "localgraph" ? {
        file: tFile ? tFile.path : seedPath,
        options: {
          "collapse-filter": true,
          "localJumps": 1,
          "localBacklinks": true,
          "localForelinks": true,
          ...currentOptions,
          "showTags": false,
          "search": searchQuery
        }
      } : {
        "collapse-filter": true,
        ...currentOptions,
        "showTags": scope === "current-tag",
        "search": searchQuery,
        options: {
          "collapse-filter": true,
          ...currentOptions,
          "showTags": scope === "current-tag",
          "search": searchQuery
        }
      };

      await CompatAdapter.safeSetGraphState(graphView, graphState);
      if (abortIfStale()) {
        overlay.remove();
        return;
      }

      await new Promise<void>(resolve => window.setTimeout(resolve, 160));
      if (abortIfStale()) {
        overlay.remove();
        return;
      }
      if (graphView && typeof graphView.onResize === "function") {
        graphView.onResize();
      }
      await new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()));
      if (abortIfStale()) {
        overlay.remove();
        return;
      }
      const nativeCanvas = canvas.querySelector("canvas");
      const nativeBounds = nativeCanvas?.getBoundingClientRect();
      if (
        !nativeCanvas
        || !nativeBounds
        || nativeBounds.width < 2
        || nativeBounds.height < 2
        || nativeCanvas.width < 2
        || nativeCanvas.height < 2
      ) {
        throw new Error(`Native ${viewType} mounted without a renderable canvas`);
      }

      // Apply search query through the embedded engine's narrow search refresh.
      applyEmbeddedGraphSearch(graphView);

      // Fade out helper with timeout safety fallback
      overlay.style.opacity = "0";
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        overlay.remove();
      };
      overlay.addEventListener("transitionend", cleanup);
      window.setTimeout(cleanup, 300);

    } catch (err) {
      if (abortIfStale()) return;
      console.warn("Failed to load native localgraph, falling back to SVG force layout", err);
      this.plugin.logBus.append(
        "error",
        "graph.render",
        err instanceof Error ? err.message : String(err),
      );
      disposeOwnedView();
      canvas.empty();
      this.drawGraph(canvas, data.nodes, data.edges, seedPath);
    }
  }

  private drawGraph(
    parent: HTMLElement,
    nodes: Array<{ path: string; title: string; kind: string; depth: number }>,
    edges: Array<{ source: string; target: string; weight: number }>,
    seedPath: string | null,
  ): void {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 1000 590");
    svg.setAttribute("class", "aos-graph-svg");
    parent.appendChild(svg);
    const positions = new Map<string, { x: number; y: number }>();
    
    const width = 1000;
    const height = 590;
    const center = { x: width / 2, y: height / 2 };
    
    const nodeStates = nodes.map(node => {
      const isSeed = node.path === seedPath;
      return {
        path: node.path,
        title: node.title,
        kind: node.kind,
        depth: node.depth,
        x: isSeed ? center.x : center.x + (Math.random() - 0.5) * 240,
        y: isSeed ? center.y : center.y + (Math.random() - 0.5) * 240,
        vx: 0,
        vy: 0,
        fixed: isSeed
      };
    });

    const statesMap = new Map(nodeStates.map(n => [n.path, n]));
    const iterations = 160;
    const k = 0.07;
    const repulsion = 450;
    const gravity = 0.015;
    const damping = 0.82;

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < nodeStates.length; i++) {
        const n1 = nodeStates[i];
        for (let j = i + 1; j < nodeStates.length; j++) {
          const n2 = nodeStates[j];
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const distSq = dx * dx + dy * dy + 1;
          const dist = Math.sqrt(distSq);
          if (dist < 380) {
            const force = repulsion / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            if (!n1.fixed) { n1.vx -= fx; n1.vy -= fy; }
            if (!n2.fixed) { n2.vx += fx; n2.vy += fy; }
          }
        }
      }

      for (const edge of edges) {
        const n1 = statesMap.get(edge.source);
        const n2 = statesMap.get(edge.target);
        if (n1 && n2) {
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - 120) * k;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!n1.fixed) { n1.vx += fx; n1.vy += fy; }
          if (!n2.fixed) { n2.vx -= fx; n2.vy -= fy; }
        }
      }

      for (const n of nodeStates) {
        if (n.fixed) continue;
        const dx = center.x - n.x;
        const dy = center.y - n.y;
        n.vx += dx * gravity;
        n.vy += dy * gravity;
      }

      for (const n of nodeStates) {
        if (n.fixed) continue;
        n.x += n.vx;
        n.y += n.vy;
        n.vx *= damping;
        n.vy *= damping;
        n.x = Math.max(50, Math.min(width - 50, n.x));
        n.y = Math.max(50, Math.min(height - 50, n.y));
      }
    }

    nodeStates.forEach(n => {
      positions.set(n.path, { x: n.x, y: n.y });
    });

    const seedIndex = nodes.findIndex(node => node.path === seedPath);
    const ordered = seedIndex > 0 ? [nodes[seedIndex], ...nodes.slice(0, seedIndex), ...nodes.slice(seedIndex + 1)] : nodes;
    for (const edge of edges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) continue;
      const line = document.createElementNS(svg.namespaceURI, "line");
      line.setAttribute("x1", `${source.x}`); line.setAttribute("y1", `${source.y}`);
      line.setAttribute("x2", `${target.x}`); line.setAttribute("y2", `${target.y}`);
      line.setAttribute("class", "aos-graph-edge");
      line.setAttribute("stroke-width", `${Math.min(3, 1 + Math.log2(Math.max(1, edge.weight)))}`);
      svg.appendChild(line);
    }
    for (const node of ordered) {
      const position = positions.get(node.path)!;
      const group = document.createElementNS(svg.namespaceURI, "g");
      group.setAttribute("class", `aos-graph-node is-${node.kind}${node.path === seedPath ? " is-seed" : ""}`);
      group.setAttribute("transform", `translate(${position.x} ${position.y})`);
      const circle = document.createElementNS(svg.namespaceURI, "circle");
      circle.setAttribute("r", node.path === seedPath ? "24" : "13");
      const label = document.createElementNS(svg.namespaceURI, "text");
      label.setAttribute("y", node.path === seedPath ? "42" : "28");
      label.setAttribute("text-anchor", "middle");
      label.textContent = node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title;
      const title = document.createElementNS(svg.namespaceURI, "title");
      title.textContent = node.path;
      group.append(circle, label, title);
      group.addEventListener("click", () => {
        const selected = this.toNode(node.path);
        if (!selected) return;
        this.selectNode(selected);
        this.renderMain();
      });
      svg.appendChild(group);
    }
  }

  private async runXWatch(): Promise<void> {
    try {
      await this.plugin.hamasxiangAdapter.runXWatch();
      new Notice("已唤醒 X Watch");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.logBus.append("error", "hamaxiang.x-watch", message);
      new Notice(`X Watch 启动失败：${message}`);
    }
  }

  private xWatchLabel(xWatch: { enabled?: boolean; running?: boolean; status?: string }): string {
    if (xWatch.enabled === false) return "已禁用";
    if (xWatch.running || xWatch.status === "running") return "巡逻中";
    if (xWatch.status === "error") return "异常";
    return xWatch.status || "待命";
  }

  private formatNextRun(value?: string): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  private renderPlannedModule(module: AethericModule): void {
    const meta: Record<string, [string, string]> = {
      collection: ["采集 Collection", "通过 HamasxiangAdapter 消费本地 Daemon 状态与操作入口。"],
      tasks: ["任务 Tasks", "统一消费 Daemon 的真实任务快照；未提供的审批状态保持为空。"],
      intelligence: ["情报 Intelligence", "读取 X Watch 与情报雷达的真实分类结果。"],
      knowledge: ["知识库 Knowledge", "知识健康与五级动态图谱将在 Phase 5 接入。"],
      overview: ["总览", ""], navigation: ["导航", ""], logs: ["日志", ""],
    };
    const [title, detail] = meta[module];
    const page = this.mainPane.createDiv({ cls: "aos-page aos-planned-page" });
    page.createDiv({ cls: "aos-page-title", text: title });
    page.createDiv({ cls: "aos-empty-state", text: detail });
    const actions = page.createDiv({ cls: "aos-action-row" });
    this.actionButton(actions, "打开蛤蟆祥指挥中心", () => void this.plugin.openHamasxiangConsole());
  }

  private refreshVirtualList(): void {
    if (!this.virtualList) return;
    const state = this.plugin.store.getSnapshot();
    const workspace = this.getWorkspace();
    const items = this.plugin.indexService.search(state.searchQuery, workspace, state.selectedFolderPath, state.searchScope);
    this.virtualList.setItems(items, state.selectedFilePath);
  }

  private switchModule(module: AethericModule, pushHistory = true): void {
    this.plugin.store.patch({ activeModule: module });
    this.renderModeRail();
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
    this.plugin.logBus.append("info", "shell.route", `切换到 ${MODULES.find(item => item.id === module)?.label ?? module}`);
    if (pushHistory) this.recordHistoryState(true);
  }

  private selectWorkspace(workspaceId: string, pushHistory = true): void {
    const workspace = this.plugin.settings.workspaces.find(item => item.id === workspaceId);
    if (!workspace) return;
    const state = this.plugin.store.getSnapshot();
    const history = state.workspaceHistory[workspaceId];
    const folderPath = history?.folderPath && this.plugin.indexService.getFolder(history.folderPath)
      ? history.folderPath
      : workspace.rootPaths.find(path => this.plugin.indexService.getFolder(path)) ?? "";
    this.plugin.store.patch({
      selectedWorkspaceId: workspaceId,
      selectedProjectId: null,
      selectedFolderPath: folderPath,
      selectedFilePath: history?.selectedFilePath ?? null,
      expandedFolderPaths: folderPath ? this.getPathChain(folderPath) : [],
      searchQuery: "",
    });
    this.workspaceSelect.value = workspaceId;
    this.commandInput.value = "";
    this.selectedNode = history?.selectedFilePath ? this.toNode(history.selectedFilePath) : null;
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
    this.plugin.logBus.append("info", "workspace.switch", `工作域切换：${workspace.name}`);
    if (pushHistory) this.recordHistoryState(true);
  }

  private selectProject(projectId: string, rootPath?: string): void {
    this.plugin.store.patch({ selectedProjectId: projectId });
    if (rootPath && this.plugin.indexService.getFolder(rootPath)) this.selectFolder(rootPath);
    else {
      this.renderNavigator();
      new Notice("项目已选中；尚未配置独立根目录");
    }
  }

  private activateCapability(capability: WorkspaceCapability): void {
    this.plugin.logBus.append("info", "capability.select", `选择能力：${capability.name}`);
    if (capability.id === "x-watch") {
      this.switchModule("intelligence");
      return;
    }
    if (capability.id === "cloud-sync" || capability.id === "asr-repair") {
      void this.plugin.openHamasxiangConsole();
      return;
    }
    if (capability.id === "publish") {
      void this.plugin.openLegacyView();
      return;
    }
    if (capability.id === "knowledge-health") {
      this.switchModule("knowledge");
      return;
    }
    if (capability.id === "course-import") {
      this.switchModule("navigation");
      new Notice("课程导入已定位到当前工作域；导入执行器尚未接入。");
      return;
    }
    this.switchModule("navigation");
    new Notice(`${capability.name} 已进入对应工作域；Agent 执行器尚未接入，不会生成虚假结果。`);
  }

  private handleCommandInput(): void {
    const value = this.commandInput.value.trim();
    this.commandMatches = [];
    if (!value) {
      this.hideCommandResults();
      return;
    }
    if (value.startsWith(">")) {
      const needle = value.slice(1).trim();
      const commands = [
        ["总览", "切换到系统总览", () => this.switchModule("overview")],
        ["导航", "打开知识节点导航", () => this.switchModule("navigation")],
        ["图谱", "打开上下文动态图谱", () => this.switchModule("knowledge")],
        [this.plugin.nativeUi.isApplied() ? "恢复原生界面" : "隐藏原生界面", "切换 Obsidian 原生外观", () => void this.plugin.toggleNativeUi()],
      ] as Array<[string, string, () => void]>;
      this.showCommandItems(commands.filter(item => !needle || item[0].includes(needle)).map(([primary, secondary, action]) => ({ primary, secondary, action })));
      return;
    }
    if (value.startsWith("#")) {
      const needle = value.slice(1).trim().toLocaleLowerCase("zh-CN");
      this.showCommandItems(this.plugin.settings.workspaces
        .filter(workspace => !needle || workspace.name.toLocaleLowerCase("zh-CN").includes(needle))
        .map(workspace => ({ primary: `${workspace.icon ?? "◇"} ${workspace.name}`, secondary: "切换工作域", action: () => this.selectWorkspace(workspace.id) })));
      return;
    }
    if (value.startsWith("@")) {
      this.showCommandItems([{ primary: "Agent 路由尚未接入", secondary: "不会虚构 Agent 执行；当前可在蛤蟆祥控制台使用现有能力", action: () => void this.plugin.openHamasxiangConsole() }]);
      return;
    }
    if (value.startsWith("/")) {
      this.showCommandItems([{ primary: "Skill 路由尚未接入", secondary: "统一任务契约完成后在此列出真实 Skill", action: () => new Notice("当前没有已接入的 Aetheric Skill") }]);
      return;
    }
    this.commandMatches = this.plugin.indexService.search(value, null, "", "vault").slice(0, 8);
    this.showCommandItems(this.commandMatches.map(node => ({
      primary: node.title,
      secondary: `${node.parentPath || "Vault"}${node.tags.length ? ` · ${node.tags.slice(0, 2).join(" ")}` : ""}`,
      action: () => this.chooseCommandNode(node),
    })));
  }

  private showCommandItems(items: Array<{ primary: string; secondary: string; action: () => void }>): void {
    this.commandResults.empty();
    this.commandResults.classList.remove("is-hidden");
    if (!items.length) {
      this.commandResults.createDiv({ cls: "aos-command-empty", text: "没有匹配结果" });
      return;
    }
    for (const item of items) {
      const button = this.commandResults.createEl("button", { cls: "aos-command-result" });
      button.createSpan({ cls: "aos-command-result-title", text: item.primary });
      button.createSpan({ cls: "aos-command-result-meta", text: item.secondary });
      button.addEventListener("click", () => {
        this.hideCommandResults();
        item.action();
      });
    }
  }

  private hideCommandResults(): void {
    this.commandResults?.classList.add("is-hidden");
  }

  private chooseCommandNode(node: KnowledgeNodeViewModel): void {
    this.hideCommandResults();
    this.selectFolder(node.parentPath);
    this.selectNode(node);
    this.virtualList?.focusPath(node.path);
  }

  private executeCommandCenter(raw: string): void {
    const value = raw.trim();
    if (!value) return;
    if (value.startsWith(">")) {
      const command = value.slice(1).trim();
      if (command.includes("总览")) this.switchModule("overview");
      else if (command.includes("导航")) this.switchModule("navigation");
      else if (command.includes("图谱")) this.switchModule("knowledge");
      else if (command.includes("恢复") || command.includes("隐藏")) void this.plugin.toggleNativeUi();
      else new Notice(`未找到 Aetheric 命令：${command}`);
      return;
    }
    if (value.startsWith("#")) {
      const scope = value.slice(1).trim().toLocaleLowerCase("zh-CN");
      const workspace = this.plugin.settings.workspaces.find(item => item.name.toLocaleLowerCase("zh-CN").includes(scope));
      if (workspace) this.selectWorkspace(workspace.id);
      else new Notice(`未找到工作域：${scope}`);
      return;
    }
    if (value.startsWith("@")) {
      new Notice("Agent 路由将在 Agent 工作页接入；当前不会虚构执行任务");
      return;
    }
    if (value.startsWith("/")) {
      new Notice("Skill 路由将在 Agent 工作页接入");
      return;
    }
    this.switchModule("navigation");
    this.plugin.store.patch({ searchQuery: value }, false);
    this.refreshVirtualList();
    this.hideCommandResults();
  }

  private selectNode(node: KnowledgeNodeViewModel, pushHistory = true): void {
    const state = this.plugin.store.getSnapshot();
    this.selectedNode = node;
    this.plugin.store.patch({
      selectedFilePath: node.path,
      workspaceHistory: {
        ...state.workspaceHistory,
        [state.selectedWorkspaceId]: { folderPath: state.selectedFolderPath, selectedFilePath: node.path },
      },
    });
    this.renderContext();
    this.plugin.logBus.append("info", "navigation.node", `选择知识节点：${node.path}`);
    if (pushHistory) this.recordHistoryState(true);
  }

  private recordHistoryState(push = true): void {
    if (this.isNavigatingHistory) return;
    const state = this.plugin.store.getSnapshot();
    const snapshot = {
      activeModule: state.activeModule,
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedFolderPath: state.selectedFolderPath,
      selectedFilePath: state.selectedFilePath,
      contextTab: this.contextTab,
    };

    if (this.globalHistoryIndex >= 0) {
      const current = this.globalHistoryStack[this.globalHistoryIndex];
      if (
        current.activeModule === snapshot.activeModule &&
        current.selectedWorkspaceId === snapshot.selectedWorkspaceId &&
        current.selectedFolderPath === snapshot.selectedFolderPath &&
        current.selectedFilePath === snapshot.selectedFilePath &&
        current.contextTab === snapshot.contextTab
      ) {
        return;
      }
    }

    if (push) {
      this.globalHistoryStack = this.globalHistoryStack.slice(0, this.globalHistoryIndex + 1);
      this.globalHistoryStack.push(snapshot);
      this.globalHistoryIndex = this.globalHistoryStack.length - 1;
    }
  }

  private navigateHistory(direction: number): void {
    const nextIndex = this.globalHistoryIndex + direction;
    if (nextIndex >= 0 && nextIndex < this.globalHistoryStack.length) {
      this.globalHistoryIndex = nextIndex;
      const snapshot = this.globalHistoryStack[nextIndex];
      
      this.isNavigatingHistory = true;
      this.contextTab = snapshot.contextTab;
      
      if (snapshot.selectedWorkspaceId !== this.plugin.store.getSnapshot().selectedWorkspaceId) {
        this.selectWorkspace(snapshot.selectedWorkspaceId, false);
      }
      
      if (snapshot.selectedFolderPath !== this.plugin.store.getSnapshot().selectedFolderPath) {
        this.selectFolder(snapshot.selectedFolderPath, false);
      }
      
      if (snapshot.selectedFilePath) {
        const node = this.toNode(snapshot.selectedFilePath);
        if (node) {
          this.selectedNode = node;
          this.plugin.store.patch({ selectedFilePath: node.path });
          this.virtualList?.focusPath(node.path);
        }
      } else {
        this.selectedNode = null;
        this.plugin.store.patch({ selectedFilePath: null });
      }
      
      if (snapshot.activeModule !== this.plugin.store.getSnapshot().activeModule) {
        this.switchModule(snapshot.activeModule, false);
      } else {
        this.renderNavigator();
        this.renderMain();
        this.renderContext();
      }

      this.isNavigatingHistory = false;
      new Notice(`历史导航：${MODULES.find(m => m.id === snapshot.activeModule)?.label ?? snapshot.activeModule}`);
    } else {
      new Notice(direction === -1 ? "已是历史最前页" : "已是历史最后页");
    }
  }

  private async openNode(node: KnowledgeNodeViewModel): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) {
      new Notice(`文件不存在：${node.path}`);
      return;
    }

    const workspaceContainer = this.app.workspace.containerEl;
    const mask = workspaceContainer.createDiv({ cls: "aos-page-transition-mask" });
    mask.createDiv({ cls: "aos-spinner" });

    const finishTransition = () => {
      window.setTimeout(() => {
        mask.style.opacity = "0";
        mask.style.pointerEvents = "none";
        window.setTimeout(() => mask.remove(), 250);
      }, 180);
    };

    // 1. If the file is already open in any workspace tab, switch to it immediately
    let existingLeaf: any = null;
    this.app.workspace.iterateAllLeaves(l => {
      if (l.view && (l.view as any).file && (l.view as any).file.path === file.path) {
        existingLeaf = l;
      }
    });

    if (existingLeaf) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      this.app.workspace.rightSplit.expand();
      this.plugin.logBus.append("success", "workspace.open", `已切换 to 已有标签页：${node.path}`);
      finishTransition();
      return;
    }

    // 2. Spawn a new tab leaf
    const leaf = this.app.workspace.getLeaf("tab");

    // 3. Switch to the target tab first for instant visual feedback and UI restoration
    this.app.workspace.setActiveLeaf(leaf, { focus: true });

    // 4. Expand the outline sidebar panel concurrently while the file loads
    this.app.workspace.rightSplit.expand();

    // 5. Load the file content in the active tab
    await leaf.openFile(file);

    this.plugin.logBus.append("success", "workspace.open", `已在原生编辑器和右侧大纲栏打开：${node.path}`);
    finishTransition();
  }

  private toggleFavorite(path: string): void {
    const state = this.plugin.store.getSnapshot();
    const exists = state.favoritePaths.includes(path);
    const favoritePaths = exists ? state.favoritePaths.filter(item => item !== path) : [path, ...state.favoritePaths];
    this.plugin.store.patch({ favoritePaths });
    this.renderNavigator();
    this.renderContext();
    this.plugin.logBus.append("info", "navigation.favorite", `${exists ? "取消收藏" : "收藏节点"}：${path}`);
  }

  private showRecentFiles(): void {
    this.switchModule("navigation");
    const paths = new Set(this.plugin.store.getSnapshot().recentFilePaths);
    const items = [...paths].map(path => this.toNode(path)).filter((node): node is KnowledgeNodeViewModel => node !== null);
    this.virtualList?.setItems(items, this.plugin.store.getSnapshot().selectedFilePath);
  }

  private showFavoriteFiles(): void {
    this.switchModule("navigation");
    const items = this.plugin.store.getSnapshot().favoritePaths.map(path => this.toNode(path)).filter((node): node is KnowledgeNodeViewModel => node !== null);
    this.virtualList?.setItems(items, this.plugin.store.getSnapshot().selectedFilePath);
  }

  private toNode(path: string): KnowledgeNodeViewModel | null {
    const indexed = this.plugin.indexService.getIndexedFile(path);
    if (!indexed) return null;
    const relations = this.plugin.indexService.getRelationCounts(path);
    return {
      ...indexed,
      title: typeof indexed.frontmatter.title === "string" ? indexed.frontmatter.title : indexed.basename,
      kind: indexed.extension === "md" ? "note" : "other",
      lifecycleStatus: typeof indexed.frontmatter.status === "string" ? indexed.frontmatter.status : undefined,
      relationCount: relations.outgoing + relations.backlinks,
    };
  }

  private showIndexStatusText(): string {
    return this.plugin.indexService.isReady() ? `索引 ${this.plugin.indexService.getFileCount().toLocaleString()}` : "索引准备中";
  }

  private updateIndexStatus(): void {
    if (this.indexStatus) this.indexStatus.textContent = this.showIndexStatusText();
  }

  private getWorkspace(): AethericWorkspace | null {
    const id = this.plugin.store.getSnapshot().selectedWorkspaceId;
    return this.plugin.settings.workspaces.find(item => item.id === id) ?? null;
  }

  private getPathChain(path: string): string[] {
    const parts = normalizePath(path).split("/").filter(Boolean);
    const chain: string[] = [];
    for (let index = 1; index <= parts.length; index += 1) chain.push(parts.slice(0, index).join("/"));
    return chain;
  }

  private applyPanelWidths(): void {
    const state = this.plugin.store.getSnapshot();
    const navWidth = state.navigatorMode === "collapsed" ? 56 : state.navigatorWidth;
    this.root?.style.setProperty("--aos-navigator-width", `${navWidth}px`);
    this.root?.style.setProperty("--aos-context-width", `${state.contextPaneWidth}px`);
  }

  private toggleFavoriteFolder(path: string): void {
    const state = this.plugin.store.getSnapshot();
    const favoriteFolderPaths = state.favoriteFolderPaths || [];
    const exists = favoriteFolderPaths.includes(path);
    const nextPaths = exists
      ? favoriteFolderPaths.filter(item => item !== path)
      : [...favoriteFolderPaths, path];
    this.plugin.store.patch({ favoriteFolderPaths: nextPaths });
    this.renderNavigator();
    if (state.activeModule === "navigation") {
      this.renderMain();
    }
    this.plugin.logBus.append("info", "navigation.favorite-folder", `${exists ? "取消收藏目录" : "收藏目录"}：${path}`);
  }

  private renderArtifactList(parent: HTMLElement, artifacts: readonly OperationArtifact[]): void {
    if (!artifacts.length) {
      parent.createDiv({ cls: "aos-empty-state", text: "尚无可观测产物。" });
      return;
    }
    const list = parent.createDiv({ cls: "aos-task-list aos-artifact-list" });
    for (const artifact of artifacts) {
      const row = list.createDiv({ cls: "aos-task-row aos-artifact-row" });
      const dot = row.createSpan({ cls: "aos-status-dot" });
      if (artifact.status === "failed" || artifact.status === "delivery_failed") dot.addClass("is-error");
      const primary = row.createDiv({ cls: "aos-task-primary" });
      primary.createDiv({ cls: "aos-task-title", text: artifact.title });
      
      if (artifact.summary) {
        const summaryBlock = primary.createDiv({ cls: "aos-artifact-summary-block" });
        const cleanSummary = artifact.summary.trim();
        const cleanOriginal = artifact.originalText ? artifact.originalText.trim() : "";
        if (cleanOriginal && cleanOriginal !== cleanSummary) {
          summaryBlock.addClass("is-bilingual");
          summaryBlock.createDiv({ cls: "aos-summary-col-zh", text: cleanSummary });
          summaryBlock.createDiv({ cls: "aos-summary-col-en", text: cleanOriginal });
        } else {
          summaryBlock.setText(cleanSummary);
        }
      }
      
      const timeStr = new Date(artifact.createdAt).toLocaleString("zh-CN", { hour12: false });
      const metaStr = artifact.kind === "capture" ? `任务完成 · ${timeStr}` : timeStr;
      primary.createDiv({ cls: "aos-task-detail", text: metaStr });

      if (artifact.sourceUrl) {
        const actions = row.createDiv({ cls: "aos-task-actions" });
        const button = actions.createEl("button", { cls: "aos-task-action-btn", text: "打开来源" });
        button.addEventListener("click", () => window.open(artifact.sourceUrl, "_blank", "noopener"));
      }
    }
  }

  private renderIntelligenceList(parent: HTMLElement, items: readonly IntelligenceItem[]): void {
    if (!items.length) {
      parent.createDiv({ cls: "aos-empty-state", text: "尚无情报分类结果；Daemon 离线时保留最近一次成功快照。" });
      return;
    }
    const list = parent.createDiv({ cls: "aos-task-list aos-intelligence-list" });
    for (const item of items) {
      const row = list.createDiv({ cls: "aos-task-row aos-intelligence-row" });
      if (item.relevant) row.addClass("is-relevant");
      const dot = row.createSpan({ cls: "aos-status-dot" });
      if (!item.relevant) dot.addClass("is-idle");
      else if (item.shouldNotify) dot.addClass("is-running");
      
      const primary = row.createDiv({ cls: "aos-task-primary" });
      const titleRow = primary.createDiv({ cls: "aos-task-title-row" });
      titleRow.createSpan({ cls: "aos-task-title", text: item.title });
      
      if (item.relevant) {
        titleRow.createSpan({ cls: "aos-core-badge", text: "★ 核心信号" });
      }
      
      const detailContainer = primary.createDiv({ cls: "aos-task-detail-container" });
      const metadataParts = [
        item.author,
        `信号 ${item.signalLevel}`,
        item.confidence !== undefined ? `置信度 ${Math.round(item.confidence * 100)}%` : "",
        item.summary,
      ].filter(Boolean);
      
      detailContainer.createSpan({ cls: "aos-task-detail", text: metadataParts.join(" · ") });
      
      if (item.tags && item.tags.length > 0) {
        const tagContainer = detailContainer.createDiv({ cls: "aos-intel-tag-container" });
        item.tags.slice(0, 5).forEach(tag => {
          tagContainer.createSpan({ cls: "aos-intel-tag", text: `#${tag}` });
        });
      }
      
      if (item.url) {
        const actions = row.createDiv({ cls: "aos-task-actions" });
        const button = actions.createEl("button", { cls: "aos-task-action-btn", text: "查看原文 ↗" });
        button.addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
      }
    }
  }

  private renderTaskList(parent: HTMLElement, tasks: OperationTask[], mini: boolean): void {
    if (!tasks.length) {
      parent.createDiv({ cls: "aos-empty-state", text: "尚无任务记录。" });
      return;
    }
    const container = parent.createDiv({ cls: "aos-task-list" });
    for (const task of tasks) {
      const row = container.createDiv({ cls: "aos-task-row" });
      if (mini) row.addClass("is-mini");

      const dot = row.createSpan({ cls: "aos-status-dot" });
      if (task.status === "failed" || task.status === "offline") {
        dot.addClass("is-error");
      } else if (task.status === "running") {
        dot.addClass("is-running");
      } else if (task.status === "queued") {
        dot.addClass("is-queued");
      } else if (task.status === "idle" || task.status === "unknown") {
        dot.addClass("is-idle");
      }

      const primary = row.createDiv({ cls: "aos-task-primary" });
      primary.createDiv({ cls: "aos-task-title", text: task.title });
      if (task.detail && !mini) {
        primary.createDiv({ cls: "aos-task-detail", text: task.detail });
      }

      const meta = row.createDiv({ cls: "aos-task-meta" });
      if (task.progress !== undefined && (task.status === "running" || task.status === "queued")) {
        const progressTrack = meta.createDiv({ cls: "aos-task-progress-track" });
        const progressFill = progressTrack.createDiv({ cls: "aos-task-progress-fill" });
        progressFill.style.width = `${task.progress}%`;
      } else if (task.detail && mini) {
        meta.createSpan({ text: task.detail, cls: "aos-task-mini-detail" });
      } else {
        meta.createSpan({ text: task.source, cls: "aos-task-source" });
      }

      const actions = row.createDiv({ cls: "aos-task-actions" });
      if (task.action) {
        const btn = actions.createEl("button", {
          cls: "aos-task-action-btn",
          text: task.action.label,
        });
        btn.addEventListener("click", event => {
          event.stopPropagation();
          this.handleTaskAction(task);
        });
      }
    }
  }

  private handleTaskAction(task: OperationTask): void {
    if (!task.action) return;
    const cmd = task.action.command;
    if (cmd === "refresh-hamasxiang") {
      void this.plugin.hamasxiangAdapter.refresh(true);
    } else if (cmd === "run-x-watch") {
      void this.runXWatch();
    } else if (cmd === "open-hamasxiang-console") {
      void this.plugin.openHamasxiangConsole();
    }
  }

  private promptAddFolder(): void {
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder)
      .map(f => f.path)
      .filter(Boolean);
    new FolderSuggestModal(this.app, folders, (selectedFolder) => {
      this.toggleFavoriteFolder(selectedFolder);
    }).open();
  }

  private metric(parent: HTMLElement, label: string, value: string, detail: string): void {
    const card = parent.createDiv({ cls: "aos-metric-card" });
    card.createDiv({ cls: "aos-metric-label", text: label });
    card.createDiv({ cls: "aos-metric-value", text: value });
    card.createDiv({ cls: "aos-metric-detail", text: detail });
  }

  private renderHeatmap(parent: HTMLElement, workspace: AethericWorkspace | null): void {
    const activity = this.plugin.indexService.getActivityByDay(56, workspace);
    const container = parent.createDiv({ cls: "aos-heatmap-container" });
    const grid = container.createDiv({ cls: "aos-heatmap" });
    
    let totalEdits = 0;
    let maxEdits = 0;
    let streak = 0;
    let streakActive = true;
    
    for (let offset = 55; offset >= 0; offset -= 1) {
      const date = new Date(Date.now() - offset * 86400000);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      const key = `${y}-${m}-${d}`;
      const count = activity.get(key) ?? 0;
      totalEdits += count;
      if (count > maxEdits) maxEdits = count;
      
      const level = count === 0 ? 0 : count < 2 ? 1 : count < 5 ? 2 : count < 10 ? 3 : 4;
      const cell = grid.createDiv({ cls: `aos-heat-cell level-${level}` });
      cell.setAttribute("title", `${key} · ${count} 个节点修改`);
    }

    for (let offset = 0; offset < 56; offset += 1) {
      const date = new Date(Date.now() - offset * 86400000);
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      const key = `${y}-${m}-${d}`;
      const count = activity.get(key) ?? 0;
      if (count > 0 && streakActive) {
        streak += 1;
      } else {
        if (offset > 0 || count > 0) {
          streakActive = false;
        }
      }
    }

    const stats = container.createDiv({ cls: "aos-heatmap-stats" });
    
    const s1 = stats.createDiv({ cls: "aos-heatmap-stat" });
    s1.createDiv({ cls: "aos-heatmap-stat-val", text: `${totalEdits}` });
    s1.createDiv({ cls: "aos-heatmap-stat-lbl", text: "近 8 周总修改" });
    
    const s2 = stats.createDiv({ cls: "aos-heatmap-stat" });
    s2.createDiv({ cls: "aos-heatmap-stat-val", text: `${streak}` });
    s2.createDiv({ cls: "aos-heatmap-stat-lbl", text: "当前连击天数" });
    
    const s3 = stats.createDiv({ cls: "aos-heatmap-stat" });
    s3.createDiv({ cls: "aos-heatmap-stat-val", text: `${maxEdits}` });
    s3.createDiv({ cls: "aos-heatmap-stat-lbl", text: "单日最高修改" });
  }

  private renderDistribution(parent: HTMLElement, workspace: AethericWorkspace | null): void {
    const items = this.plugin.indexService.getCategoryDistribution(6, workspace);
    const max = Math.max(1, ...items.map(item => item.count));
    const list = parent.createDiv({ cls: "aos-distribution" });
    for (const item of items) {
      const row = list.createDiv({ cls: "aos-distribution-row" });
      const head = row.createDiv({ cls: "aos-distribution-head" });
      const label = head.createSpan({ cls: "aos-distribution-label", text: item.label });
      label.setAttribute("title", item.label);
      head.createSpan({ text: `${item.count}` });
      const track = row.createDiv({ cls: "aos-bar-track" });
      const bar = track.createDiv({ cls: "aos-bar-fill" });
      bar.style.width = `${(item.count / max) * 100}%`;
    }
  }

  private renderRecentNodeCards(parent: HTMLElement, limit: number): void {
    const recent = this.plugin.store.getSnapshot().recentFilePaths.slice(0, limit);
    if (!recent.length) {
      parent.createDiv({ cls: "aos-empty-state", text: "尚无真实打开记录。" });
      return;
    }
    for (const path of recent) {
      const node = this.toNode(path);
      if (!node) continue;
      const button = parent.createDiv({ cls: "aos-recent-node" });
      button.createDiv({ cls: "aos-recent-node-title", text: node.title });
      button.createDiv({ cls: "aos-recent-node-path", text: node.parentPath || "Vault" });
      button.addEventListener("click", () => {
        this.switchModule("navigation");
        this.selectFolder(node.parentPath);
        this.selectNode(node);
        this.virtualList?.focusPath(node.path);
      });
      button.addEventListener("mouseover", event => {
        this.app.workspace.trigger("hover-link", {
          event,
          source: "aetheric-os",
          hoverParent: this,
          targetEl: button,
          linktext: node.path,
          sourcePath: node.path,
        });
      });
    }
  }

  private contextField(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv({ cls: "aos-context-field" });
    row.createSpan({ text: label });
    row.createSpan({ text: value });
  }

  private actionButton(parent: HTMLElement, label: string, action: () => void): void {
    const button = parent.createEl("button", { cls: "aos-action-button", text: label });
    button.addEventListener("click", action);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  private async fetchWeather(): Promise<any> {
    const cache = this.plugin.settings.weatherCache;
    const now = Date.now();
    if (cache && now - cache.timestamp < 3600000) {
      return cache.data;
    }
    try {
      const response = await requestUrl({
        url: "https://wttr.in/Hangzhou?format=j1",
        method: "GET",
        contentType: "application/json",
        throw: false,
      });
      if (response.status === 200) {
        let data = response.json;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch(e) {}
        }
        if (data && data.current_condition) {
          this.plugin.settings.weatherCache = { data, timestamp: now };
          await this.plugin.saveSettings();
          return data;
        }
      }
    } catch (e) {
      console.warn("Failed to fetch weather from wttr.in", e);
    }
    return cache ? cache.data : null;
  }

  private async loadTodoItems(): Promise<Array<{ index: number; text: string; completed: boolean; lineContent: string }>> {
    const path = "08_密室/todo.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const todos = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (match) {
        todos.push({
          index: i,
          completed: match[1].toLowerCase() === "x",
          text: match[2].trim(),
          lineContent: line
        });
      }
    }
    return todos;
  }

  private async toggleTodoItem(item: any): Promise<void> {
    const path = "08_密室/todo.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    if (lines[item.index] !== undefined) {
      const completedChar = !item.completed ? "x" : " ";
      lines[item.index] = lines[item.index].replace(/-\s*\[([ xX])\]/, `- [${completedChar}]`);
      await this.app.vault.modify(file, lines.join("\n"));
      this.renderOverview();
    }
  }

  private async addTodoItem(text: string): Promise<void> {
    const path = "08_密室/todo.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const separator = content.endsWith("\n") ? "" : "\n";
    const updated = content + `${separator}- [ ] ${text.trim()}\n`;
    await this.app.vault.modify(file, updated);
    this.renderOverview();
  }

  private async addInspiration(text: string): Promise<void> {
    const path = "08_密室/灵感池.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const content = await this.app.vault.read(file);
    const todayStr = new Date().toISOString().split("T")[0];
    const separator = content.endsWith("\n") ? "" : "\n";
    const updated = content + `${separator}*   *${todayStr}*：${text.trim()}\n`;
    await this.app.vault.modify(file, updated);
    new Notice("💡 灵感已成功记入密室灵感池！");
    this.renderOverview();
  }

  private async loadThreeFocusItems(): Promise<Array<{ completed: boolean; text: string }>> {
    const path = "08_密室/林下工作台.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [{ completed: false, text: "" }, { completed: false, text: "" }, { completed: false, text: "" }];
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const items = [];
    let inThreeThings = false;
    for (const line of lines) {
      if (line.includes("### 今日三件事")) {
        inThreeThings = true;
        continue;
      }
      if (inThreeThings) {
        if (line.startsWith("## ") || line.startsWith("---")) {
          break;
        }
        const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
        if (match) {
          const completed = match[1].toLowerCase() === "x";
          const text = match[2].trim();
          items.push({ completed, text });
        }
        if (items.length >= 3) break;
      }
    }
    while (items.length < 3) items.push({ completed: false, text: "" });
    return items;
  }

  private async getRandomFoodChoice(): Promise<string> {
    const path = "08_密室/生活计划/美食清单.md";
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return "今天随便吃点吧";
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const foods: string[] = [];
    let inWantToGo = false;
    for (const line of lines) {
      if (line.includes("## 🧭 种草待探")) {
        inWantToGo = true;
        continue;
      }
      if (line.includes("## ") && !line.includes("## 🧭 种草待探")) {
        inWantToGo = false;
      }
      if (inWantToGo) {
        const match = line.match(/^\s*-\s*\[\s*\]\s*(.*)$/);
        if (match) {
          foods.push(match[1].trim());
        }
      }
    }
    if (foods.length === 0) return "今天随便吃点吧";
    const random = foods[Math.floor(Math.random() * foods.length)];
    return random.replace(/\*\*/g, "").replace(/📍/g, "").replace(/#美食\/待探/g, "").trim();
  }

  private renderLifeDashboard(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "aos-life-grid" });
    const statusCard = grid.createDiv({ cls: "aos-panel aos-life-status-card" });
    const todoCard = grid.createDiv({ cls: "aos-panel aos-life-todo-card" });

    statusCard.createDiv({ cls: "aos-spinner-small" });
    todoCard.createDiv({ cls: "aos-spinner-small" });

    Promise.all([
      this.fetchWeather(),
      this.loadThreeFocusItems(),
      this.getRandomFoodChoice(),
      this.loadTodoItems()
    ]).then(([weather, focusItems, foodChoice, todos]) => {
      this.populateLifeStatus(statusCard, weather, focusItems, foodChoice);
      this.populateLifeTodo(todoCard, todos);
    }).catch(err => {
      console.error("Failed to load life dashboard data", err);
      statusCard.empty();
      statusCard.createDiv({ text: "生活数据加载失败", cls: "aos-panel-note" });
      todoCard.empty();
      todoCard.createDiv({ text: "待办数据加载失败", cls: "aos-panel-note" });
    });
  }

  private populateLifeStatus(card: HTMLDivElement, weather: any, focusItems: Array<{ completed: boolean; text: string }>, foodChoice: string): void {
    card.empty();
    card.createDiv({ cls: "aos-panel-title", text: "🏡 林下今日状态" });

    const dateObj = new Date();
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const month = String(dateObj.getMonth() + 1);
    const dateNum = String(dateObj.getDate());
    const weekdayStr = weekdays[dateObj.getDay()];
    const yearStr = String(dateObj.getFullYear());

    const dateRow = card.createDiv({ cls: "aos-life-date-row" });
    const calendar = dateRow.createDiv({ cls: "aos-life-calendar-icon" });
    calendar.createDiv({ cls: "month-tab", text: `${month}月` });
    calendar.createDiv({ cls: "day-num", text: dateNum });

    const dateText = dateRow.createDiv({ cls: "aos-life-date-text" });
    dateText.createDiv({ cls: "weekday", text: weekdayStr });
    dateText.createDiv({ cls: "full-date", text: `${yearStr}年${month}月${dateNum}日` });

    // Weather widget
    if (weather && weather.current_condition && weather.current_condition[0]) {
      const current = weather.current_condition[0];
      const temp = current.temp_C || "--";
      const desc = current.weatherDesc?.[0]?.value || "未知天气";
      const feels = current.FeelsLikeC || "--";
      const humidity = current.humidity || "--";

      const descLower = desc.toLowerCase();
      let weatherClass = "is-cloudy";
      if (descLower.includes("sun") || descLower.includes("clear")) {
        weatherClass = "is-sunny";
      } else if (descLower.includes("rain") || descLower.includes("shower") || descLower.includes("drizzle")) {
        weatherClass = "is-rainy";
      } else if (descLower.includes("snow") || descLower.includes("ice")) {
        weatherClass = "is-snowy";
      }

      const weatherWidget = card.createDiv({ cls: `aos-weather-widget ${weatherClass}` });
      const currentEl = weatherWidget.createDiv({ cls: "aos-weather-current" });
      currentEl.createDiv({ cls: "temp-val", text: `${temp}°C` });
      currentEl.createDiv({ cls: "desc-val", text: `${desc} (体感 ${feels}°C)` });
      currentEl.createDiv({ cls: "details-val", text: `湿度 ${humidity}%` });

      const forecastEl = weatherWidget.createDiv({ cls: "aos-weather-forecast" });
      const forecastDays = weather.weather || [];
      for (const day of forecastDays.slice(0, 3)) {
        const d = new Date(day.date);
        const dayLabel = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
        const dayRow = forecastEl.createDiv({ cls: "forecast-day" });
        dayRow.createSpan({ cls: "day-name", text: dayLabel });
        dayRow.createSpan({ cls: "day-temp", text: `${day.mintempC}°~${day.maxtempC}°` });
      }
    }

    // Today's Focus
    card.createDiv({ cls: "aos-life-sub-title", text: "🎯 今日三件事" });
    const focusContainer = card.createDiv({ cls: "aos-life-focus-list" });
    focusItems.forEach((item, index) => {
      const itemEl = focusContainer.createDiv({ cls: "aos-life-focus-item" });
      if (!item.text) {
        itemEl.classList.add("is-empty");
        itemEl.textContent = `🎯 设定第 ${index + 1} 件今日要事...`;
      } else {
        itemEl.textContent = `${item.completed ? "✅" : "⏳"} ${item.text}`;
      }
      itemEl.addEventListener("click", () => {
        this.openFileByPath("08_密室/林下工作台.md");
      });
    });

    // Food choice
    const foodRow = card.createDiv({ cls: "aos-life-food-recommend" });
    foodRow.createSpan({ cls: "food-label", text: "🐸 今日食路推荐：" });
    const foodName = foodRow.createSpan({ cls: "food-name", text: foodChoice });
    const refreshBtn = foodRow.createEl("button", { cls: "aos-life-food-refresh-btn", text: "🔄", attr: { title: "换一个" } });
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.classList.add("is-spinning");
      const newFood = await this.getRandomFoodChoice();
      foodName.textContent = newFood;
      setTimeout(() => refreshBtn.classList.remove("is-spinning"), 600);
    });
  }

  private openFileByPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      void leaf.openFile(file);
    } else {
      new Notice(`文件不存在: ${path}`);
    }
  }

  private populateLifeTodo(card: HTMLDivElement, todos: any[]): void {
    card.empty();
    card.createDiv({ cls: "aos-panel-title", text: "🌲 密室今日小目标" });

    const listContainer = card.createDiv({ cls: "aos-life-todo-list" });
    if (todos.length === 0) {
      listContainer.createDiv({ cls: "aos-empty-state", text: "今日暂无目标，在下方极速记录一个吧！" });
    } else {
      for (const todo of todos) {
        const row = listContainer.createDiv({ cls: "aos-life-todo-row" });
        const cb = row.createEl("input", { attr: { type: "checkbox" }, cls: "aos-life-todo-cb" });
        cb.checked = todo.completed;

        const label = row.createSpan({ text: todo.text, cls: "aos-life-todo-label" });
        if (todo.completed) label.classList.add("is-completed");

        cb.addEventListener("change", async () => {
          label.classList.toggle("is-completed", cb.checked);
          await this.toggleTodoItem(todo);
        });
      }
    }

    const inputRow = card.createDiv({ cls: "aos-life-input-row" });
    const todoInput = inputRow.createEl("input", {
      cls: "aos-life-todo-input",
      attr: { placeholder: "➕ 添加今日小目标..." }
    });
    todoInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && todoInput.value.trim()) {
        const text = todoInput.value.trim();
        todoInput.value = "";
        await this.addTodoItem(text);
      }
    });

    const inspirationInput = inputRow.createEl("input", {
      cls: "aos-life-inspiration-input",
      attr: { placeholder: "💡 记录随笔与灵感..." }
    });
    inspirationInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && inspirationInput.value.trim()) {
        const text = inspirationInput.value.trim();
        inspirationInput.value = "";
        await this.addInspiration(text);
      }
    });
  }
}

class FolderSuggestModal extends FuzzySuggestModal<string> {
  constructor(app: App, private folders: string[], private onSelect: (folder: string) => void) {
    super(app);
    this.setPlaceholder("选择要添加的快捷目录…");
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
    this.onSelect(item);
  }
}
