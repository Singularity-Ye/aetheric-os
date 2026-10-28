import {
  App,
  FuzzySuggestModal,
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  setIcon,
} from "obsidian";
import ScriptoriumPlugin from "../main";
import { DEFAULT_SCHEDULE_SHORTCUTS, ScheduleShortcutSettings } from "../settings";
import { CompatAdapter } from "./CompatAdapter";
import type {
  HamasxiangAssetLinkReceipt,
  HamasxiangCaptureReceipt,
  HamasxiangPlatformHealthSnapshot,
  HamasxiangRefinementReceipt,
} from "./HamasxiangAdapter";
import { capturePlatformLabel, dedupeCaptureUrls } from "./CaptureUrlUtils";
import { buildInspirationDecision } from "./InspirationDecisionPolicy";
import {
  buildInspirationRefinementProjection,
  copyInspirationRefinementFields,
  inspirationRefinementTerminalStatus,
  isCompletedInspirationRefinement,
  isTerminalInspirationRefinement,
  pickInspirationRefinementFields,
} from "./InspirationRefinementState";
import {
  captureIdeaIdentity,
  isInspirationEvidence,
  hasExplicitInspirationOptIn,
  inferInspirationAreaId,
  isScheduledWatcherCapture,
  passesScheduledWatcherValueGate,
  shouldAutoProjectCaptureToInspiration,
} from "./InspirationRailPolicy";
import { GitStatusItem } from "./operations/HamasxiangOperationsService";
import { ProcessRegistryEntry } from "./operations/ProcessRegistry";
import * as fs from "fs";
import * as path from "path";
import { LogDock } from "./LogDock";
import type {
  ImageGovernanceBatchReceipt,
  ImageRegistrationReceipt,
  ImageGovernanceCandidate,
  ImageGovernanceCandidateSort,
} from "./ImageGovernanceService";
import { sortImageGovernanceCandidates } from "./ImageGovernanceService";
import type { CreatePlanItemInput, PlanItem, PlanItemKind, PlanTodaySnapshot, UpdatePlanItemPatch } from "./PlanLedgerService";
import { VirtualFileList } from "./VirtualFileList";
import {
  buildWorkspaceRelationGraph,
  buildWorkspaceSemanticGraph,
  buildInboxTemplateGraph,
  displayInboxPlatform,
  getInboxFacetOptions,
  InboxGraphFilters,
  InboxTemplateGraphNode,
  WorkspaceGraphDepth,
} from "./InboxGraphAdapter";
import { ForceGraphRuntime, type ForceGraphEdgeLabelMode, type ForceGraphPerformanceSample } from "./ForceGraphRuntime";
import { CanvasLocalGraph, type CanvasLocalGraphData } from "./CanvasLocalGraph";
import {
  DEFAULT_RELATION_NODE_BUDGET,
  MAX_RELATION_NODE_BUDGET,
  enterGraphRelationship,
  expandRelationNodeBudget,
  isGraphPathWithinWorkspace,
  normalizeGraphModuleState,
  normalizeRelationNodeBudget,
  prepareGraphModuleEntry,
  type GraphModuleContext,
  type GraphModuleState,
} from "./GraphModuleState";
import { isGraphVisiblePath } from "./GraphVisibilityPolicy";
import { moduleUsesContextPane } from "./ModuleSurfacePolicy";
import {
  DEFAULT_WORKSPACE_SHORTCUTS,
  GRAPH_DEPTH_SHORTCUT_IDS,
  MODULE_SHORTCUT_IDS,
  WORKSPACE_SHORTCUT_DEFINITIONS,
  formatShortcut,
  normalizeWorkspaceShortcuts,
  serializeShortcutEvent,
  shortcutMatches,
  type WorkspaceShortcutId,
  type WorkspaceShortcutSettings,
} from "./WorkspaceKeymap";
import type {
  AethericShellHistoryHost,
  AethericShellHistorySnapshot,
} from "./NavigationHistoryService";
import {
  AethericModule,
  AethericWorkspace,
  GraphScope,
  IndexedFile,
  IntelligenceItem,
  KnowledgeNodeViewModel,
  ModuleLayoutState,
  OperationArtifact,
  OperationTask,
  WorkspaceCapability,
  CORE_MODULES,
  normalizeModuleLayout,
} from "./types";

export const AETHERIC_SHELL_VIEW = "aetheric-os-shell-view";

// 时间轴按 15 分钟吸附；保留一个完整的最后时间块，避免把 24:00 写入账本。
const SCHEDULE_DAY_START = 6 * 60;
const SCHEDULE_DAY_END = 24 * 60 - 15;
const SCHEDULE_STEP = 15;
// Coalesce Obsidian's create/modify/metadata burst before replacing the graph
// host; otherwise every low-level event restarts a settled simulation.
const KNOWLEDGE_GRAPH_REFRESH_DEBOUNCE_MS = 180;

type ScheduleShortcutName = keyof ScheduleShortcutSettings;

const SCHEDULE_SHORTCUT_LABELS: Array<{ key: ScheduleShortcutName; label: string; description: string }> = [
  { key: "moveDayPrevious", label: "前一天", description: "在当前周时间轴向左移动" },
  { key: "moveDayNext", label: "后一天", description: "在当前周时间轴向右移动" },
  { key: "moveTimeEarlier", label: "提前开始", description: "开始时间提前 15 分钟" },
  { key: "moveTimeLater", label: "延后开始", description: "开始时间延后 15 分钟" },
  { key: "resizeShorter", label: "缩短时长", description: "结束时间提前 15 分钟" },
  { key: "resizeLonger", label: "延长时长", description: "结束时间延后 15 分钟" },
  { key: "openDetails", label: "打开详情", description: "打开当前计划卡片详情" },
  { key: "toggleDone", label: "完成 / 恢复", description: "切换任务完成状态" },
];

const WORKSPACE_GRAPH_DEPTHS: Array<{ value: WorkspaceGraphDepth; label: string; hint: string }> = [
  { value: 0, label: "工作域", hint: "查看整个工作域" },
  { value: 1, label: "分区", hint: "进入各分区" },
  { value: 2, label: "子目录", hint: "查看子目录" },
  { value: 3, label: "笔记", hint: "查看笔记内容" },
];

type WorkspaceGraphDropAction = "inspiration" | "schedule" | "agent";

const WORKSPACE_GRAPH_DROP_ACTIONS: Array<{
  id: WorkspaceGraphDropAction;
  label: string;
  hint: string;
  icon: string;
}> = [
  { id: "inspiration", label: "挂入灵感", hint: "生成或提升一张灵感卡", icon: "lightbulb" },
  { id: "schedule", label: "放进日程", hint: "以目录上下文新建候选任务", icon: "calendar-plus" },
  { id: "agent", label: "交给 Agent", hint: "带着目录样本打开 Copilot", icon: "bot" },
];

const GRAPH_SCOPE_OPTIONS: ReadonlyArray<{ scope: GraphScope; label: string; icon: string; hint: string }> = [
  { scope: "current-folder", label: "当前目录", icon: "folder-tree", hint: "只看当前阅览目录" },
  { scope: "current-file", label: "当前笔记", icon: "file-text", hint: "当前笔记与一层双链" },
  { scope: "current-tag", label: "当前标签", icon: "tag", hint: "按当前笔记标签聚合" },
  { scope: "current-workspace", label: "整个工作域", icon: "layout-dashboard", hint: "查看当前工作域入口" },
  { scope: "vault", label: "全库对照", icon: "globe-2", hint: "高密度调试视图" },
];

function scheduleMinutes(value: string): number {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function minutesToScheduleTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekDates(dateText: string): string[] {
  const date = parseLocalDate(dateText);
  const day = date.getDay() || 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(monday);
    current.setDate(monday.getDate() + index);
    return formatLocalDate(current);
  });
}

const MODULES: Array<{ id: AethericModule; label: string; icon: string }> = [
  { id: "overview", label: "总览", icon: "layout-dashboard" },
  { id: "schedule", label: "日程", icon: "calendar-days" },
  { id: "navigation", label: "导航", icon: "compass" },
  { id: "collection", label: "采集", icon: "radio-tower" },
  { id: "tasks", label: "任务", icon: "clipboard-list" },
  { id: "intelligence", label: "情报", icon: "chart-no-axes-combined" },
  { id: "inspiration", label: "灵感", icon: "lightbulb" },
  { id: "knowledge", label: "图谱", icon: "git-branch" },
  { id: "logs", label: "日志", icon: "file-terminal" },
];

const INBOX_ROOT_PATH = "00_松果池（收件箱）";
const INSPIRATION_INBOX_PATH = `${INBOX_ROOT_PATH}/微信想法`;
const INSPIRATION_RECYCLE_BIN_PATH = `${INBOX_ROOT_PATH}/00_残卷回收站`;

type RecycleAttachmentCandidate = {
  path: string;
  name: string;
  backlinks: string[];
};

type PermanentDeletionPreflight = {
  backlinks: string[];
  exclusiveAttachments: RecycleAttachmentCandidate[];
  sharedAttachments: RecycleAttachmentCandidate[];
};

const INBOX_SOURCE_LABELS: Record<string, { id: string; label: string; icon: string }> = {
  "B站": { id: "bilibili", label: "B站", icon: "video" },
  "抖音": { id: "douyin", label: "抖音", icon: "music-2" },
  "小红书": { id: "xiaohongshu", label: "小红书", icon: "book-heart" },
  "X情报": { id: "x", label: "X / 推特", icon: "radar" },
  "微信想法": { id: "weixin", label: "微信想法", icon: "message-circle" },
  "GitHub": { id: "github", label: "GitHub", icon: "github" },
  "大众点评": { id: "dianping", label: "大众点评", icon: "map-pin" },
  "其他": { id: "other", label: "其他网页", icon: "globe-2" },
};

type ContextTab = "overview" | "relations" | "preview";

interface NoteEditorDraft {
  path: string;
  content: string;
}

interface InspirationMediaRef {
  value: string;
  remote: boolean;
  localPath?: string;
  alt?: string;
}

interface InspirationMediaViewModel {
  refs: InspirationMediaRef[];
  cover: InspirationMediaRef | null;
}

export class AethericShellView extends ItemView implements AethericShellHistoryHost {
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
  private unsubscribeImageGovernance: (() => void) | null = null;
  private unsubscribeAnalytics: (() => void) | null = null;
  private gitChanges: GitStatusItem[] | null = [];
  private isScanningGit = false;
  private gitAcknowledgement = false;
  private gitCommitMsg = "";
  private isRunningGitSync = false;
  private analyticsSearchQuery = "";
  private ledgerDisplayLimit = 50;
  private isDedupEnabled: boolean | null = null;
  private intelligenceFilter: "attention" | "relevant" | "all" = "attention";
  private intelligencePlatformFilter = "all";
  private imageGovernanceCandidates: ImageGovernanceCandidate[] | null = null;
  private selectedGovernancePaths = new Set<string>();
  private imageGovernanceBatchReceipt: ImageGovernanceBatchReceipt | null = null;
  private imageGovernanceBatchRunning = false;
  private imageRegistrationSelection = new Set<string>();
  private imageRegistrationReceipt: ImageRegistrationReceipt | null = null;
  private imageRegistrationRunning = false;
  private imagePanelExpanded = { local: false, cloud: true, retention: false };
  private imageGovernanceCandidateFilter: "recommended" | "referenced" | "unreferenced" | "attention" | "all" = "recommended";
  private imageGovernanceCandidateSort: ImageGovernanceCandidateSort = "largest";

  private getWorkspaceEmoji(icon: string | undefined | null): string {
    if (!icon) return "◇";
    if (icon === "frog") return "🐸";
    if (icon === "pinecone") return "🌲";
    if (icon === "tree-pine") return "🌲";
    if (icon === "feather") return "✒️";
    if (icon === "book-open") return "📚";
    if (icon === "swords") return "⚔️";
    return icon;
  }
  private isTogglingDedup = false;
  private contextTab: ContextTab = "overview";
  private collectionTab = "dashboard";
  private collectionRenderToken = 0;
  private collectionTabToken = 0;
  private envConfig: Record<string, string> = {};
  private envLastModified = 0;
  private envLoading = false;
  private envLoaded = false;
  private selectedNode: KnowledgeNodeViewModel | null = null;
  private commandResults!: HTMLDivElement;
  private commandMatches: KnowledgeNodeViewModel[] = [];
  private graphScope: GraphScope = "current-workspace";
  private knowledgeLens: "inbox" | "native" | "relation" = "native";
  private inboxGraphFilters: InboxGraphFilters = { limit: 48, showFolders: false, includePassive: false, detail: "overview" };
  private workspaceGraphDetail: "overview" | "focus" = "overview";
  private workspaceGraphDepth: WorkspaceGraphDepth = 1;
  private workspaceGraphFocus: string | undefined;
  /** Physical folder shared by the directory map and relationship projection. */
  private graphFolderPath: string | undefined;
  private semanticGraphFolderPath: string | undefined;
  /** Latest real Markdown context, independent from the shell's stale selection store. */
  private activeDocumentFolderPath: string | undefined;
  private semanticGraphSelection: InboxTemplateGraphNode | null = null;
  private hoveredSemanticGraphNode: InboxTemplateGraphNode | null = null;
  /** The packaged Aetheric SVG force-graph renderer, hosted by the shell adapter. */
  private inboxGraphRuntime: ForceGraphRuntime | null = null;
  private canvasGraph: CanvasLocalGraph | null = null;
  private atlasFilterQuery = "";
  private atlasGraphEngine: "native" | "canvas" = "native";
  private atlasGraphScope: "current-folder" | "current-file" = "current-folder";
  private graphEdgeLabelMode: ForceGraphEdgeLabelMode = "explore";
  private relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
  private nativeGraphView: any = null;
  private nativeGraphLeaf: any = null;
  private knowledgeGraphRefreshTimer: number | null = null;
  private deferredSurfaceRefresh = {
    navigator: false,
    main: false,
    context: false,
    virtualList: false,
  };
  private currentRenderId = 0;
  private overviewPage: HTMLDivElement | null = null;
  private overviewData: HTMLDivElement | null = null;
  private overviewRecentMetricValue: HTMLDivElement | null = null;
  private overviewRecentPanel: HTMLDivElement | null = null;
  private lifeDashboard: { statusCard: HTMLDivElement; todoCard: HTMLDivElement } | null = null;
  private lifeRefreshTx = 0;
  /** Recycle is a dedicated Inspiration sub-surface, not a second lifecycle state. */
  private inspirationRecycleOpen = false;
  private schedulePreviewOverrides = new Map<string, { date: string; start: string; end: string }>();
  private scheduleRenderToken = 0;
  private scheduleDetailOpen = false;
  private selectedScheduleItemId: string | null = null;
  private scheduleKeyboardUpdates = new Set<string>();
  private inspirationAttachInFlight = new Set<string>();
  private inspirationRefinementSyncInFlight = new Set<string>();
  private moduleLayoutEditing = false;
  private draggedModule: AethericModule | null = null;

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

  showImageGovernanceCandidates(): void {
    this.imagePanelExpanded.local = true;
    this.imageGovernanceCandidates = this.plugin.imageGovernance.listGovernanceCandidates(30);
    this.selectedGovernancePaths.clear();
    if (this.plugin.store.getSnapshot().activeModule === "overview") this.renderMain();
    else this.switchModule("overview");
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("aos-view-content");
    this.root = this.contentEl.createDiv({ cls: "aos-shell" });
    // Obsidian renders `aria-label` as its own dark tooltip while the browser
    // renders `title` as a second native bubble. Older controls sometimes set
    // both. Keep the accessible Obsidian layer and suppress only the duplicate
    // native title before its hover delay can fire.
    this.root.addEventListener("pointerover", event => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[aria-label][title]")
        : null;
      if (target && this.root.contains(target)) target.removeAttribute("title");
    }, true);
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
    this.captureActiveDocumentFolder(this.app.workspace.getActiveFile());

    this.applyPanelWidths();
    this.renderModeRail();
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
    this.registerDomEvent(document, "keydown", event => this.handleShellShortcut(event as KeyboardEvent), true);
    this.plugin.navigationHistory.registerShell(this);
    this.recordHistoryState(true);

    this.logDock = new LogDock(this.root, this.plugin.logBus, {
      getState: () => this.plugin.store.getSnapshot(),
      onStateChange: patch => {
        const state = this.plugin.store.getSnapshot();
        this.plugin.store.patch({ logDock: { ...state.logDock, ...patch } });
      },
    });

    this.unsubscribeIndex = this.plugin.indexService.subscribe(change => {
      const state = this.plugin.store.getSnapshot();
      if (state.selectedFilePath && (change.structureChanged || change.contentChanged)) {
        this.selectedNode = this.toNode(state.selectedFilePath);
      }
      const navigatorChanged = change.structureChanged;
      const listChanged = state.activeModule === "navigation" && (change.structureChanged || change.contentChanged);
      const mainChanged = (state.activeModule === "overview" && (change.structureChanged || change.contentChanged))
        || (state.activeModule === "knowledge" && (change.structureChanged || change.contentChanged || change.relationsChanged));
      const contextChanged = state.activeModule === "navigation"
        && (change.structureChanged || change.contentChanged || (change.relationsChanged && this.contextTab === "relations"));
      if (!this.isShellActive()) {
        this.deferSurfaceRefresh({
          navigator: navigatorChanged,
          main: mainChanged,
          context: contextChanged,
          virtualList: listChanged,
        });
        return;
      }
      this.updateIndexStatus();
      if (navigatorChanged) this.renderNavigator();
      if (state.activeModule === "overview" && mainChanged) this.renderOverview();
      if (listChanged) this.refreshVirtualList();
      if (state.activeModule === "knowledge" && mainChanged) this.scheduleKnowledgeGraphRefresh();
      if (contextChanged) this.renderContext();
    });
    this.unsubscribeHamasxiang = this.plugin.hamasxiangAdapter.subscribe(() => {
      const module = this.plugin.store.getSnapshot().activeModule;
      if (!["overview", "collection", "tasks", "intelligence", "inspiration", "logs"].includes(module)) return;
      if (!this.isShellActive()) {
        this.deferSurfaceRefresh({ main: true });
        return;
      }
      this.renderMain();
    });
    this.unsubscribeImageGovernance = this.plugin.imageGovernance.subscribe(() => {
      if (this.plugin.store.getSnapshot().activeModule !== "overview") return;
      if (!this.isShellActive()) {
        this.deferSurfaceRefresh({ main: true });
        return;
      }
      this.renderOverview();
    });

    this.updateIndexStatus();
    this.plugin.logBus.append("success", "shell.lifecycle", "Aetheric OS Shell 已就绪");
  }

  async onClose(): Promise<void> {
    this.plugin.navigationHistory.unregisterShell(this);
    this.clearScheduleInteractionOverlays();
    this.lifeRefreshTx++;
    this.overviewPage = null;
    this.overviewData = null;
    this.overviewRecentMetricValue = null;
    this.overviewRecentPanel = null;
    this.lifeDashboard = null;
    this.currentRenderId += 1;
    this.collectionRenderToken += 1;
    this.collectionTabToken += 1;
    this.scheduleRenderToken += 1;
    this.cancelKnowledgeGraphRefresh();
    this.inspirationAttachInFlight.clear();
    this.canvasGraph?.destroy();
    this.canvasGraph = null;
    this.disposeInboxGraphRuntime();
    this.disposeNativeGraphView();
    this.virtualList?.destroy();
    this.virtualList = null;
    this.logDock?.destroy();
    this.logDock = null;
    this.unsubscribeIndex?.();
    this.unsubscribeIndex = null;
    this.unsubscribeHamasxiang?.();
    this.unsubscribeHamasxiang = null;
    this.unsubscribeImageGovernance?.();
    this.unsubscribeImageGovernance = null;
    this.unsubscribeAnalytics?.();
    this.unsubscribeAnalytics = null;
    this.contentEl.removeClass("aos-view-content");
  }

  onResize(): void {
    super.onResize();
    this.inboxGraphRuntime?.onResize();
    if (this.nativeGraphView && typeof this.nativeGraphView.onResize === "function") {
      this.nativeGraphView.onResize();
    }
  }

  getSelectedNodePath(): string | null {
    return this.selectedNode?.path ?? this.plugin.store.getSnapshot().selectedFilePath;
  }

  /** Receive Obsidian's real file-open context instead of guessing from the
   * shell's last selected node. Only a current-folder lens follows it; broad
   * workspace/Vault scopes remain explicit user choices. */
  handleActiveDocument(file: TFile | null): void {
    const nextFolder = this.captureActiveDocumentFolder(file);
    if (!nextFolder || this.plugin.store.getSnapshot().activeModule !== "knowledge" || this.graphScope !== "current-folder") return;
    if (nextFolder === this.graphFolderPath && nextFolder === this.semanticGraphFolderPath) return;
    this.applyGraphModuleState(normalizeGraphModuleState({
      ...this.currentGraphModuleState(),
      folderPath: nextFolder,
      semanticFolderPath: nextFolder,
      focus: undefined,
      detail: "overview",
      relationNodeBudget: DEFAULT_RELATION_NODE_BUDGET,
    }, this.graphModuleContext()));
    if (!this.isShellActive()) {
      this.deferSurfaceRefresh({ main: true });
      return;
    }
    this.renderKnowledgeGraph();
    this.plugin.logBus.append("info", "graph.follow-document", `图谱镜头跟随当前笔记：${nextFolder}`);
  }

  /**
   * Obsidian keeps inactive leaves mounted. Background index, crawler and
   * file-open events must therefore update state without repainting a hidden
   * workbench. The queued surfaces are refreshed once when the user returns.
   */
  handleShellActivated(): void {
    if (!this.isShellActive()) return;
    const activationStartedAt = performance.now();
    const pending = this.deferredSurfaceRefresh;
    this.deferredSurfaceRefresh = { navigator: false, main: false, context: false, virtualList: false };
    const activeModule = this.plugin.store.getSnapshot().activeModule;
    const dirtySurfaces = (["navigator", "main", "context", "virtualList"] as const)
      .filter(surface => pending[surface]);
    this.updateIndexStatus();
    if (pending.navigator) this.renderNavigator();
    if (pending.main) this.renderMain();
    else if (pending.virtualList) this.refreshVirtualList();
    if (pending.context) this.renderContext();
    const syncMs = performance.now() - activationStartedAt;

    // Log only after two animation frames so the log dock's own DOM update is
    // excluded from the synchronous refresh measurement and the first paint.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!this.contentEl.isConnected) return;
        try {
          const twoFrameMs = performance.now() - activationStartedAt;
          const dirtyLabel = dirtySurfaces.length > 0 ? dirtySurfaces.join(",") : "none";
          this.plugin.logBus.append(
            "info",
            "shell.activate",
            `模块 ${activeModule} · dirty ${dirtyLabel} · sync ${syncMs.toFixed(1)}ms · two-frame ${twoFrameMs.toFixed(1)}ms`,
            Math.round(twoFrameMs),
          );
        } catch {
          // Telemetry must never interfere with normal workbench activation.
        }
      });
    });
  }

  private isShellActive(): boolean {
    return this.app.workspace.getMostRecentLeaf() === this.leaf;
  }

  private deferSurfaceRefresh(patch: Partial<typeof this.deferredSurfaceRefresh>): void {
    this.deferredSurfaceRefresh.navigator ||= patch.navigator === true;
    this.deferredSurfaceRefresh.main ||= patch.main === true;
    this.deferredSurfaceRefresh.context ||= patch.context === true;
    this.deferredSurfaceRefresh.virtualList ||= patch.virtualList === true;
  }

  private captureActiveDocumentFolder(file: TFile | null): string | undefined {
    if (!file || file.extension.toLowerCase() !== "md" || !file.parent) return undefined;
    const workspace = this.getWorkspace();
    if (!workspace || !isGraphPathWithinWorkspace(file.path, workspace.rootPaths)) return undefined;
    const folderPath = normalizePath(file.parent.path);
    this.activeDocumentFolderPath = folderPath;
    return folderPath;
  }

  getNavigationLeaf(): WorkspaceLeaf | null {
    return this.leaf;
  }

  getNavigationSnapshot(): AethericShellHistorySnapshot {
    const state = this.plugin.store.getSnapshot();
    return {
      activeModule: state.activeModule,
      selectedWorkspaceId: state.selectedWorkspaceId,
      selectedFolderPath: state.selectedFolderPath,
      selectedFilePath: state.selectedFilePath,
      contextTab: this.contextTab,
      graphScope: this.graphScope,
      graphDepth: this.workspaceGraphDepth,
      graphFocus: this.workspaceGraphFocus,
      graphFolderPath: this.graphFolderPath,
      graphDetail: this.workspaceGraphDetail,
      knowledgeLens: this.knowledgeLens,
      graphRelationBudget: this.relationNodeBudget,
    };
  }

  restoreNavigationSnapshot(snapshot: AethericShellHistorySnapshot): void {
    const activeModule = snapshot.activeModule as AethericModule;
    const contextTab = snapshot.contextTab as ContextTab;
    this.contextTab = contextTab;
    if (["current-file", "current-folder", "current-workspace", "current-tag", "vault"].includes(snapshot.graphScope ?? "")) {
      this.graphScope = snapshot.graphScope as GraphScope;
    }
    if (snapshot.graphDepth === 0 || snapshot.graphDepth === 1 || snapshot.graphDepth === 2 || snapshot.graphDepth === 3) {
      this.workspaceGraphDepth = snapshot.graphDepth as WorkspaceGraphDepth;
    }
    this.workspaceGraphFocus = snapshot.graphFocus;
    this.graphFolderPath = snapshot.graphFolderPath;
    this.semanticGraphFolderPath = snapshot.graphFolderPath;
    if (snapshot.graphDetail === "overview" || snapshot.graphDetail === "focus") this.workspaceGraphDetail = snapshot.graphDetail;
    if (snapshot.knowledgeLens === "inbox" || snapshot.knowledgeLens === "native" || snapshot.knowledgeLens === "relation") this.knowledgeLens = snapshot.knowledgeLens;
    this.relationNodeBudget = normalizeRelationNodeBudget(snapshot.graphRelationBudget);

    if (snapshot.selectedWorkspaceId !== this.plugin.store.getSnapshot().selectedWorkspaceId) {
      this.selectWorkspace(snapshot.selectedWorkspaceId, false);
    }

    if (snapshot.selectedFolderPath !== this.plugin.store.getSnapshot().selectedFolderPath) {
      this.selectFolder(snapshot.selectedFolderPath, false);
    }

    const node = snapshot.selectedFilePath ? this.toNode(snapshot.selectedFilePath) : null;
    this.selectedNode = node;
    const state = this.plugin.store.getSnapshot();
    this.plugin.store.patch({
      selectedFilePath: node?.path ?? null,
      workspaceHistory: {
        ...state.workspaceHistory,
        [state.selectedWorkspaceId]: {
          folderPath: state.selectedFolderPath,
          selectedFilePath: node?.path ?? null,
        },
      },
    }, false);
    if (node) this.virtualList?.focusPath(node.path);

    if (activeModule !== this.plugin.store.getSnapshot().activeModule) {
      this.switchModule(activeModule, false);
    } else {
      this.renderModeRail();
      this.renderNavigator();
      this.renderMain();
      this.renderContext();
    }
  }

  selectFolder(folderPath: string, pushHistory = true): void {
    const normalized = normalizePath(folderPath);
    if (!this.plugin.indexService.getFolder(normalized)) {
      new Notice(`目录不存在：${normalized}`);
      return;
    }
    const state = this.plugin.store.getSnapshot();
    const expanded = this.getPathChain(normalized);
    this.graphFolderPath = normalized;
    this.semanticGraphFolderPath = normalized;
    const currentModule = state.activeModule;
    const targetModule = currentModule === "knowledge" ? "knowledge" : "navigation";
    this.plugin.store.patch({
      activeModule: targetModule,
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
    const recentCount = this.navigator?.querySelector<HTMLElement>("[data-aos-quick='recent'] .aos-quick-count");
    if (recentCount) recentCount.textContent = `${this.plugin.store.getSnapshot().recentFilePaths.length}`;
    if (this.plugin.store.getSnapshot().activeModule !== "overview") return;
    if (this.refreshOverviewRecent()) return;
    if (!this.isShellActive()) {
      this.deferSurfaceRefresh({ main: true });
      return;
    }
    this.renderOverview();
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
      this.workspaceSelect.createEl("option", { value: workspace.id, text: `${this.getWorkspaceEmoji(workspace.icon)} ${workspace.name}` });
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

    const actions = topbar.createDiv({ cls: "aos-topbar-actions" });
    const agentButton = actions.createEl("button", {
      cls: "aos-topbar-button aos-global-agent-button",
      attr: {
        type: "button",
        "aria-label": "打开全局蛤蟆祥 Agent",
        title: "打开当前选中笔记与 Copilot；未选中笔记时打开空白页和文件目录",
      },
    });
    const agentIcon = agentButton.createSpan({ cls: "aos-topbar-button-icon" });
    setIcon(agentIcon, "bot");
    agentButton.createSpan({ cls: "aos-topbar-button-label", text: "Agent" });
    agentButton.addEventListener("click", () => void this.openGlobalAgentDock());

    const nativeButton = actions.createEl("button", {
      cls: "aos-topbar-button",
      attr: { type: "button", title: "切换天工台外观与 Obsidian 原生界面" },
    });
    const nativeIcon = nativeButton.createSpan({ cls: "aos-topbar-button-icon" });
    const nativeLabel = nativeButton.createSpan({ cls: "aos-topbar-button-label" });
    const updateNativeButton = (applied: boolean): void => {
      nativeIcon.empty();
      setIcon(nativeIcon, applied ? "eye" : "eye-off");
      nativeLabel.setText(applied ? "恢复原生界面" : "隐藏原生界面");
      nativeButton.setAttribute("aria-label", applied ? "恢复原生界面" : "隐藏原生界面");
      nativeButton.classList.toggle("is-applied", applied);
    };
    updateNativeButton(this.plugin.nativeUi.isApplied());
    nativeButton.addEventListener("click", () => void this.plugin.toggleNativeUi().then(applied => {
      updateNativeButton(applied);
    }));
  }

  private renderModeRail(): void {
    this.modeRail.empty();
    const state = this.plugin.store.getSnapshot();
    const layout = normalizeModuleLayout(state.moduleLayout);
    const active = state.activeModule;
    this.modeRail.classList.toggle("is-editing", this.moduleLayoutEditing);

    const modulesById = new Map(MODULES.map(module => [module.id, module]));
    const visibleModules = this.getVisibleModuleOrder(layout);
    const shortcutSettings = normalizeWorkspaceShortcuts(this.plugin.settings.workspaceShortcuts);
    for (const id of visibleModules) {
      const module = modulesById.get(id);
      if (!module) continue;
      const item = this.modeRail.createDiv({ cls: "aos-mode-item" });
      item.dataset.moduleId = module.id;
      item.draggable = this.moduleLayoutEditing;
      item.classList.toggle("is-dragging", this.draggedModule === module.id);

      const button = item.createEl("button", { cls: "aos-mode-button" });
      button.classList.toggle("is-active", module.id === active);
      const shortcut = shortcutSettings[MODULE_SHORTCUT_IDS[module.id]];
      const tooltip = shortcut ? `${module.label} · ${formatShortcut(shortcut)}` : module.label;
      button.setAttribute("aria-label", this.moduleLayoutEditing ? `${tooltip} · 拖动排序` : tooltip);
      button.setAttribute("data-tooltip-position", "right");
      if (shortcut) button.setAttribute("aria-keyshortcuts", shortcut);
      if (this.moduleLayoutEditing) {
        const handle = button.createSpan({ cls: "aos-mode-drag-handle", text: "⋮⋮" });
        handle.setAttribute("aria-hidden", "true");
      }
      const icon = button.createSpan({ cls: "aos-mode-icon" });
      setIcon(icon, module.icon);
      button.createSpan({ cls: "aos-mode-label", text: module.label });
      button.addEventListener("click", () => this.switchModule(module.id));

      if (this.moduleLayoutEditing && !CORE_MODULES.includes(module.id)) {
        const hide = item.createEl("button", {
          cls: "aos-mode-action",
          attr: { "aria-label": `隐藏${module.label}`, title: `隐藏${module.label}` },
        });
        setIcon(hide, "eye-off");
        hide.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          this.setModuleHidden(module.id, true);
        });
      }

      if (this.moduleLayoutEditing) this.bindModuleDrag(item, module.id);
    }
    const recycleFiles = this.getInspirationRecycleFiles();
    const recycleItem = this.modeRail.createDiv({ cls: "aos-mode-item aos-mode-recycle-item" });
    const recycleButton = recycleItem.createEl("button", {
      cls: "aos-mode-button aos-mode-recycle-button",
      attr: {
        "aria-label": `回收站 · ${recycleFiles.length} 条已回收灵感`,
        "data-tooltip-position": "right",
        title: "打开工作台回收站；可恢复或彻底删除已回收灵感",
      },
    });
    recycleButton.classList.toggle("is-active", this.inspirationRecycleOpen);
    const recycleIcon = recycleButton.createSpan({ cls: "aos-mode-icon" });
    setIcon(recycleIcon, "trash-2");
    recycleButton.createSpan({ cls: "aos-mode-label", text: recycleFiles.length ? `回收站 ${recycleFiles.length}` : "回收站" });
    recycleButton.addEventListener("click", () => this.openInspirationRecycleBin());
    const spacer = this.modeRail.createDiv({ cls: "aos-mode-spacer" });
    spacer.setAttribute("aria-hidden", "true");
    if (this.moduleLayoutEditing) {
      const editHint = this.modeRail.createDiv({ cls: "aos-mode-edit-hint", text: "拖动排序 · 隐藏模块" });
      editHint.setAttribute("aria-live", "polite");
      const restore = this.modeRail.createEl("button", {
        cls: "aos-mode-button aos-mode-edit-button",
        attr: { title: "恢复隐藏模块" },
      });
      const restoreIcon = restore.createSpan({ cls: "aos-mode-icon" });
      setIcon(restoreIcon, "eye");
      restore.createSpan({ cls: "aos-mode-label", text: layout.hidden.length ? `恢复 (${layout.hidden.length})` : "无隐藏" });
      restore.disabled = layout.hidden.length === 0;
      restore.addEventListener("click", event => this.openRestoreMenu(event, layout.hidden));

      const reset = this.modeRail.createEl("button", {
        cls: "aos-mode-button aos-mode-edit-button",
        attr: { title: "恢复默认顺序并显示全部模块" },
      });
      const resetIcon = reset.createSpan({ cls: "aos-mode-icon" });
      setIcon(resetIcon, "rotate-ccw");
      reset.createSpan({ cls: "aos-mode-label", text: "默认" });
      reset.addEventListener("click", () => this.resetModuleLayout());
    }
    const shortcutHelp = this.modeRail.createEl("button", {
      cls: "aos-mode-button aos-mode-shortcut-help",
      attr: { title: "查看工作台快捷键说明" },
    });
    const shortcutIcon = shortcutHelp.createSpan({ cls: "aos-mode-icon" });
    setIcon(shortcutIcon, "keyboard");
    shortcutHelp.createSpan({ cls: "aos-mode-label", text: "快捷键" });
    shortcutHelp.addEventListener("click", () => {
      new WorkspaceShortcutModal(this.app, this.plugin, () => this.renderModeRail()).open();
    });
    const settings = this.modeRail.createEl("button", { cls: "aos-mode-button aos-mode-settings-button" });
    const icon = settings.createSpan({ cls: "aos-mode-icon" });
    setIcon(icon, this.moduleLayoutEditing ? "check" : "settings-2");
    settings.createSpan({ cls: "aos-mode-label", text: this.moduleLayoutEditing ? "完成" : "编辑布局" });
    settings.setAttribute("aria-label", this.moduleLayoutEditing ? "完成布局编辑" : "编辑左侧模块布局");
    settings.addEventListener("click", () => {
      this.moduleLayoutEditing = !this.moduleLayoutEditing;
      this.draggedModule = null;
      this.renderModeRail();
    });
  }

  private getVisibleModuleOrder(layout = normalizeModuleLayout(this.plugin.store.getSnapshot().moduleLayout)): AethericModule[] {
    return layout.order.filter(id => !layout.hidden.includes(id));
  }

  private bindModuleDrag(item: HTMLDivElement, module: AethericModule): void {
    item.addEventListener("dragstart", event => {
      if (!this.moduleLayoutEditing) return;
      this.draggedModule = module;
      item.classList.add("is-dragging");
      const dragEvent = event as DragEvent;
      if (dragEvent.dataTransfer) {
        dragEvent.dataTransfer.effectAllowed = "move";
        dragEvent.dataTransfer.setData("text/plain", module);
      }
    });
    item.addEventListener("dragover", event => {
      if (!this.moduleLayoutEditing || !this.draggedModule || this.draggedModule === module) return;
      event.preventDefault();
      const rect = item.getBoundingClientRect();
      item.classList.toggle("is-drop-before", (event as DragEvent).clientY < rect.top + rect.height / 2);
      item.classList.toggle("is-drop-after", (event as DragEvent).clientY >= rect.top + rect.height / 2);
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("is-drop-before", "is-drop-after");
    });
    item.addEventListener("drop", event => {
      if (!this.moduleLayoutEditing || !this.draggedModule || this.draggedModule === module) return;
      event.preventDefault();
      const rect = item.getBoundingClientRect();
      const after = (event as DragEvent).clientY >= rect.top + rect.height / 2;
      this.reorderModule(this.draggedModule, module, after);
      this.clearModuleDragState();
    });
    item.addEventListener("dragend", () => this.clearModuleDragState());
  }

  private clearModuleDragState(): void {
    this.draggedModule = null;
    this.modeRail.querySelectorAll(".aos-mode-item").forEach(element => {
      element.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
    });
  }

  private updateModuleLayout(mutator: (layout: ModuleLayoutState) => ModuleLayoutState): void {
    const next = normalizeModuleLayout(mutator(normalizeModuleLayout(this.plugin.store.getSnapshot().moduleLayout)));
    this.plugin.store.patch({ moduleLayout: next });
    this.renderModeRail();
  }

  private reorderModule(source: AethericModule, target: AethericModule, after: boolean): void {
    this.updateModuleLayout(layout => {
      const order = layout.order.filter(id => id !== source);
      const targetIndex = order.indexOf(target);
      if (targetIndex < 0) order.push(source);
      else order.splice(targetIndex + (after ? 1 : 0), 0, source);
      return { ...layout, order };
    });
  }

  private setModuleHidden(module: AethericModule, hidden: boolean): void {
    if (CORE_MODULES.includes(module)) {
      new Notice("总览与导航是工作台锚点，不能隐藏");
      return;
    }
    const active = this.plugin.store.getSnapshot().activeModule;
    this.updateModuleLayout(layout => ({
      ...layout,
      hidden: hidden ? [...layout.hidden, module] : layout.hidden.filter(id => id !== module),
    }));
    if (hidden && active === module) {
      this.plugin.store.patch({ activeModule: "overview" });
      this.renderMain();
      this.renderContext();
    }
  }

  private openRestoreMenu(event: MouseEvent, hidden: AethericModule[]): void {
    if (!hidden.length) return;
    const menu = new Menu();
    for (const moduleId of hidden) {
      const module = MODULES.find(candidate => candidate.id === moduleId);
      if (!module) continue;
      menu.addItem(item => item
        .setTitle(`恢复 ${module.label}`)
        .setIcon(module.icon)
        .onClick(() => this.setModuleHidden(module.id, false)));
    }
    menu.addSeparator();
    menu.addItem(item => item.setTitle("恢复全部模块").setIcon("eye").onClick(() => this.resetModuleLayout()));
    menu.showAtMouseEvent(event);
  }

  private resetModuleLayout(): void {
    this.plugin.store.patch({
      moduleLayout: normalizeModuleLayout({
        order: MODULES.map(module => module.id),
        hidden: [],
      }),
    });
    this.renderModeRail();
    new Notice("左侧模块布局已恢复默认");
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
    const iconSpan = workspaceCard.createSpan({ cls: "aos-workspace-icon" });
    if (workspace.icon && /^[a-z-]+$/.test(workspace.icon)) {
      setIcon(iconSpan, workspace.icon);
    } else {
      iconSpan.setText(workspace.icon ?? "◇");
    }
    const text = workspaceCard.createDiv();
    text.createDiv({ cls: "aos-workspace-name", text: workspace.name });
    const noteCount = this.plugin.indexService.getFileCount(workspace);
    text.createDiv({ cls: "aos-workspace-desc", text: `${noteCount} 篇知识笔记 · 圣地知识流` });

    if (state.navigatorMode === "collapsed") {
      for (const item of this.plugin.settings.workspaces) {
        const button = this.navigator.createEl("button", { cls: "aos-collapsed-workspace" });
        if (item.icon && /^[a-z-]+$/.test(item.icon)) {
          setIcon(button, item.icon);
        } else {
          button.setText(item.icon ?? "◇");
        }
        button.setAttribute("title", item.name);
        button.classList.toggle("is-active", item.id === workspace.id);
        button.addEventListener("click", () => this.selectWorkspace(item.id));
      }
      return;
    }

    // 1. Pinned Folders (★ 常用置顶目录)
    const pinnedSection = this.navigator.createDiv({ cls: "aos-nav-section aos-pinned-section" });
    const pinnedHeader = pinnedSection.createDiv({ cls: "aos-section-header" });
    pinnedHeader.createDiv({ cls: "aos-nav-section-title", text: "★ 常用置顶目录" });
    const addPinBtn = pinnedHeader.createEl("button", {
      cls: "aos-quick-add-btn",
      text: "+",
      attr: { title: "添加置顶目录" },
    });
    addPinBtn.addEventListener("click", () => this.promptAddFolder());

    const pinnedChips = pinnedSection.createDiv({ cls: "aos-pinned-chips" });
    const favoriteFolderPaths = state.favoriteFolderPaths || [];
    if (favoriteFolderPaths.length === 0) {
      pinnedChips.createDiv({ cls: "aos-empty-hint", text: "右键目录可固定至常用置顶" });
    } else {
      for (const folderPath of favoriteFolderPaths) {
        this.renderPinnedFolderChip(pinnedChips, folderPath, state.selectedFolderPath === folderPath);
      }
    }

    // 2. Pillars & Schools Tree (🏛️ 松果阁四大圣地体系)
    const pillarsSection = this.navigator.createDiv({ cls: "aos-nav-section aos-pillars-section" });
    const pillarsHeader = pillarsSection.createDiv({ cls: "aos-section-header" });
    pillarsHeader.createDiv({ cls: "aos-nav-section-title", text: "🏛️ 松果阁体系" });

    const treeContainer = pillarsSection.createDiv({ cls: "aos-pillars-tree" });
    const expandedSet = new Set(state.expandedFolderPaths);

    for (const rootPath of workspace.rootPaths) {
      const folder = this.plugin.indexService.getFolder(rootPath);
      if (folder) {
        this.renderPillarNode(treeContainer, folder, 0, expandedSet, state.selectedFolderPath);
      }
    }

    // 3. Quick Tools (⚡ 快捷工具)
    const quick = this.navigator.createDiv({ cls: "aos-nav-section aos-quick-section" });
    const quickHeader = quick.createDiv({ cls: "aos-section-header" });
    quickHeader.createDiv({ cls: "aos-nav-section-title", text: "⚡ 快捷工具" });

    const recentButton = this.renderQuickButton(quick, "最近访问", `${state.recentFilePaths.length}`, "history", () => this.showRecentFiles());
    recentButton.dataset.aosQuick = "recent";
    this.renderQuickButton(quick, "收藏节点", `${state.favoritePaths.length}`, "star", () => this.showFavoriteFiles());
    this.renderQuickButton(quick, "灵感待炼", `${this.getInspirationFiles().length}`, "lightbulb", () => this.switchModule("inspiration"));
    this.renderQuickButton(
      quick,
      state.folderTreeVisible ? "收起全库目录树" : "浏览全库目录树",
      "",
      "folder-tree",
      () => {
        this.plugin.store.patch({ folderTreeVisible: !state.folderTreeVisible });
        this.renderNavigator();
      }
    );

    if (state.folderTreeVisible) {
      this.renderFullVaultFolderTree();
    }
  }

  private getFolderIcon(folderName: string, folderPath: string): string {
    const lower = `${folderName} ${folderPath}`.toLowerCase();
    if (lower.includes("微信") || lower.includes("weixin")) return "message-square";
    if (lower.includes("x情报") || lower.includes("推特") || lower.includes("twitter")) return "rss";
    if (lower.includes("b站") || lower.includes("bilibili") || lower.includes("映卷")) return "tv";
    if (lower.includes("小红书") || lower.includes("redbook")) return "bookmark";
    if (lower.includes("技艺") || lower.includes("工具") || lower.includes("practical")) return "wrench";
    if (lower.includes("思辨") || lower.includes("手札") || lower.includes("屋主")) return "sparkles";
    if (lower.includes("刀笔") || lower.includes("锐评")) return "pen-tool";
    if (lower.includes("博物") || lower.includes("科普")) return "compass";
    if (lower.includes("格物") || lower.includes("学术") || lower.includes("课程")) return "graduation-cap";
    if (lower.includes("天工台") || lower.includes("aetheric") || lower.includes("丹炉")) return "flame";
    if (lower.includes("蛤蟆祥") || lower.includes("frog")) return "frog";
    if (lower.includes("博客") || lower.includes("blog")) return "globe";
    if (lower.includes("食味") || lower.includes("美食")) return "utensils";
    if (lower.includes("行路") || lower.includes("旅行")) return "map-pin";
    if (lower.includes("游艺") || lower.includes("游戏") || lower.includes("bg3")) return "gamepad-2";
    if (lower.includes("松果池") || lower.includes("收件箱") || lower.includes("inbox")) return "inbox";
    if (lower.includes("藏经阁")) return "book-open";
    if (lower.includes("生活簿")) return "coffee";
    return "folder";
  }

  private renderPinnedFolderChip(parent: HTMLElement, folderPath: string, isActive: boolean): void {
    const chip = parent.createDiv({ cls: "aos-pinned-chip" });
    chip.classList.toggle("is-active", isActive);

    const folderName = folderPath.split("/").pop() || folderPath;
    const iconName = this.getFolderIcon(folderName, folderPath);
    const iconEl = chip.createSpan({ cls: "aos-chip-icon" });
    setIcon(iconEl, iconName);

    const titleEl = chip.createSpan({ cls: "aos-chip-title", text: folderName });
    titleEl.setAttribute("title", folderPath);

    const fileCount = this.plugin.indexService.listFiles(folderPath).length;
    if (fileCount > 0) {
      chip.createSpan({ cls: "aos-chip-badge", text: `${fileCount}` });
    }

    chip.addEventListener("click", () => this.selectFolder(folderPath));
    chip.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem(item => {
        item.setTitle("★ 从常用置顶移除")
          .setIcon("star-off")
          .onClick(() => this.toggleFavoriteFolder(folderPath));
      });
      menu.addItem(item => {
        item.setTitle("在此目录新建笔记")
          .setIcon("file-plus-2")
          .onClick(() => {
            this.selectFolder(folderPath);
            void this.openNoteEditorModal();
          });
      });
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });
  }

  private renderPillarNode(
    parent: HTMLElement,
    folder: TFolder,
    depth: number,
    expanded: Set<string>,
    selectedFolderPath: string,
  ): void {
    const isExpanded = expanded.has(folder.path);
    const children = this.plugin.indexService.getChildFolders(folder.path);
    const isSelected = selectedFolderPath === folder.path;
    const isPillar = depth === 0;

    const row = parent.createDiv({ cls: `aos-pillar-row depth-${depth}` });
    row.classList.toggle("is-pillar", isPillar);
    row.classList.toggle("is-selected", isSelected);
    row.style.setProperty("--aos-folder-depth", `${depth}`);

    const toggle = row.createEl("button", {
      cls: "aos-pillar-toggle",
      text: children.length ? (isExpanded ? "⌄" : "›") : "·",
    });
    toggle.disabled = children.length === 0;
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      const next = new Set(this.plugin.store.getSnapshot().expandedFolderPaths);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      this.plugin.store.patch({ expandedFolderPaths: [...next] });
      this.renderNavigator();
    });

    const iconSpan = row.createSpan({ cls: "aos-pillar-icon" });
    const iconName = this.getFolderIcon(folder.name, folder.path);
    setIcon(iconSpan, iconName);

    const label = row.createSpan({ cls: "aos-pillar-label", text: folder.name });
    label.setAttribute("title", folder.path);

    const fileCount = this.plugin.indexService.listFiles(folder.path).length;
    if (fileCount > 0) {
      row.createSpan({ cls: "aos-pillar-badge", text: `${fileCount}` });
    }

    const favoriteFolderPaths = this.plugin.store.getSnapshot().favoriteFolderPaths || [];
    const isFav = favoriteFolderPaths.includes(folder.path);
    if (isFav) {
      const star = row.createSpan({ cls: "aos-pillar-pinned-star", text: "★" });
      star.setAttribute("title", "已置顶到常用");
    }

    row.addEventListener("click", () => this.selectFolder(folder.path));

    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem(item => {
        item.setTitle(isFav ? "★ 从常用置顶移除" : "★ 固定到常用置顶")
          .setIcon(isFav ? "star-off" : "star")
          .onClick(() => this.toggleFavoriteFolder(folder.path));
      });
      if (children.length > 0) {
        menu.addItem(item => {
          item.setTitle(isExpanded ? "收起子目录" : "展开子目录")
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
      menu.addItem(item => {
        item.setTitle("在此目录新建笔记")
          .setIcon("file-plus-2")
          .onClick(() => {
            this.selectFolder(folder.path);
            void this.openNoteEditorModal();
          });
      });
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });

    if (isExpanded && children.length > 0) {
      for (const child of children) {
        this.renderPillarNode(parent, child, depth + 1, expanded, selectedFolderPath);
      }
    }
  }

  private renderFullVaultFolderTree(): void {
    const section = this.navigator.createDiv({ cls: "aos-folder-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: "全库物理目录 · 按需展开" });
    const topFolders = this.plugin.indexService.getChildFolders("");
    const expanded = new Set(this.plugin.store.getSnapshot().expandedFolderPaths);
    for (const folder of topFolders) {
      this.renderFolderBranch(section, folder, 0, expanded);
    }
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
    this.collectionRenderToken += 1;
    this.scheduleRenderToken += 1;
    this.disposeInboxGraphRuntime();
    this.virtualList?.destroy();
    this.virtualList = null;
    const module = this.plugin.store.getSnapshot().activeModule;
    this.applyModuleSurfacePolicy(module);

    // Deactivate Analytics calculation if not viewing the analytics tab
    if (module !== "collection" || this.collectionTab !== "analytics") {
      this.plugin.analyticsService.setActive(false);
    }

    if (module === "overview") {
      this.renderOverview();
      return;
    }

    // The private life dashboard belongs to the overview shell. Invalidate pending
    // reads before the overview DOM is removed so stale promises cannot paint later.
    this.lifeRefreshTx++;
    this.overviewPage = null;
    this.overviewData = null;
    this.overviewRecentMetricValue = null;
    this.overviewRecentPanel = null;
    this.lifeDashboard = null;
    this.mainPane.empty();

    if (module === "navigation" || module === "knowledge") this.renderKnowledgeAtlas();
    else if (module === "schedule") this.renderSchedule();
    else if (module === "collection") this.renderCollection();
    else if (module === "tasks") this.renderTasks();
    else if (module === "intelligence") this.renderIntelligence();
    else if (module === "inspiration") this.renderInspiration();
    else if (module === "logs") this.renderLogsPage();
    else this.renderPlannedModule(module);
  }

  private renderOverview(): void {
    // Index and Daemon updates may be frequent. Keep the private life panel mounted
    // and only refresh the workspace-scoped part of the overview.
    if (this.overviewPage?.isConnected && this.overviewData?.isConnected) {
      this.renderOverviewData(this.overviewData);
      return;
    }

    this.mainPane.empty();
    const page = this.mainPane.createDiv({ cls: "aos-page aos-overview-page" });
    this.overviewPage = page;
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "总览 Overview" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "真实 Vault 活动、当前工作域与知识流状态" });

    this.renderLifeDashboard(page);

    const overviewData = page.createDiv({ cls: "aos-overview-workspace-data" });
    this.overviewData = overviewData;
    this.renderOverviewData(overviewData);
  }

  private renderOverviewData(parent: HTMLElement): void {
    parent.empty();

    const workspace = this.getWorkspace();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const metrics = parent.createDiv({ cls: "aos-metric-grid" });
    const adapterTasks = this.plugin.hamasxiangAdapter.getTasks();
    const runningTasks = adapterTasks.filter(task => task.status === "running" || task.status === "queued").length;
    const failedTasks = adapterTasks.filter(task => task.status === "failed" || task.status === "offline").length;
    this.metric(metrics, "索引节点", this.plugin.indexService.getFileCount(workspace).toLocaleString(), workspace ? `当前工作域: ${workspace.name}` : "Vault 当前已加载文件");
    this.metric(metrics, "索引体积", this.formatBytes(this.plugin.indexService.getTotalSize(workspace)), "工作域真实文件体积");
    this.metric(metrics, "今日修改", `${this.plugin.indexService.countModifiedSince(today.getTime(), workspace)}`, "按修改时间统计");
    this.metric(metrics, "运行任务", `${runningTasks}`, failedTasks ? `${failedTasks} 项需关注` : "Adapter 观测正常");
    const recentMetric = this.metric(metrics, "最近访问", `${this.plugin.store.getSnapshot().recentFilePaths.length}`, "真实打开记录");
    this.overviewRecentMetricValue = recentMetric.querySelector<HTMLDivElement>(".aos-metric-value");

    const imageGovernance = parent.createDiv({ cls: "aos-panel aos-panel-wide aos-image-governance-panel" });
    this.renderImageGovernancePanel(imageGovernance);

    const grid = parent.createDiv({ cls: "aos-overview-grid" });
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
    this.overviewRecentPanel = recent;
    recent.createDiv({ cls: "aos-panel-title", text: "最近知识节点" });
    this.renderRecentNodeCards(recent, 6);

    const inspirations = grid.createDiv({ cls: "aos-panel aos-panel-wide aos-overview-inspiration-panel" });
    const inspirationHeading = inspirations.createDiv({ cls: "aos-panel-header-row" });
    inspirationHeading.createDiv({ cls: "aos-panel-title", text: "最近灵感" });
    const inspirationLink = inspirationHeading.createEl("button", { cls: "aos-text-button", text: "查看全部 →" });
    inspirationLink.addEventListener("click", () => this.switchModule("inspiration"));
    this.renderRecentInspirations(inspirations, 4);

    const tasks = grid.createDiv({ cls: "aos-panel" });
    tasks.createDiv({ cls: "aos-panel-title", text: "当前任务快照" });
    this.renderTaskList(tasks, adapterTasks.slice(0, 4), true);


  }

  private visibleImageGovernanceCandidates(): ImageGovernanceCandidate[] {
    const candidates = this.imageGovernanceCandidates ?? [];
    const filtered = candidates.filter(candidate => {
      if (this.imageGovernanceCandidateFilter === "recommended") return candidate.kind === "recommended";
      if (this.imageGovernanceCandidateFilter === "referenced") return candidate.referenceCount > 0;
      if (this.imageGovernanceCandidateFilter === "unreferenced") return candidate.kind === "unreferenced";
      if (this.imageGovernanceCandidateFilter === "attention") return candidate.kind !== "recommended";
      return true;
    });
    return sortImageGovernanceCandidates(filtered, this.imageGovernanceCandidateSort);
  }

  private renderImageCatalog(parent: HTMLElement): void {
    const inventory = this.plugin.imageGovernance.getLocalImageInventory();
    const snapshot = this.plugin.imageGovernance.getSnapshot();
    const online = this.plugin.hamasxiangAdapter.getSnapshot().online;
    const availablePaths = new Set(inventory.map(item => item.path));
    this.imageRegistrationSelection = new Set([...this.imageRegistrationSelection].filter(path => availablePaths.has(path)));
    const section = parent.createDiv({ cls: "aos-image-catalog" });
    section.createDiv({ cls: "aos-image-catalog-policy", text: "图片留在原处 · 统一登记身份与引用 · 按需备份到云端" });
    const metrics = section.createDiv({ cls: "aos-image-cloud-metrics" });
    this.metric(metrics, "本地图片文件", `${inventory.length}`, this.formatBytes(inventory.reduce((sum, item) => sum + item.bytes, 0)));
    this.metric(metrics, "WebP 文件", `${inventory.filter(item => item.format === "webp").length}`, "包含已存在的展示图和独立图片");
    this.metric(metrics, "账本资产", snapshot.registry.available ? `${snapshot.registry.total}` : "未连接", "按内容身份计数，与文件数不是同一口径");
    this.metric(metrics, "COS 已验签资产", snapshot.cloud.available ? `${snapshot.cloud.remoteVerifiedAssets ?? "未知"}` : "未连接", "云端读取接线待完成");
    const workflow = section.createDiv({ cls: "aos-image-catalog-workflow" });
    for (const [title, detail] of [
      ["1 · 原位登记", "只记录路径、摘要和引用"],
      ["2 · 压缩与备份", "另行选择，再生成 WebP 或上传"],
      ["3 · 恢复核验", "验证云端副本能否取回"],
    ]) {
      const step = workflow.createDiv();
      step.createDiv({ cls: "aos-image-catalog-step-title", text: title });
      step.createDiv({ cls: "aos-panel-note", text: detail });
    }
    const groups = new Map<string, number>();
    for (const item of inventory) {
      const group = item.path.includes("/") ? item.path.split("/")[0] : "根目录";
      groups.set(group, (groups.get(group) ?? 0) + 1);
    }
    const folders = section.createDiv({ cls: "aos-image-catalog-folders" });
    for (const [path, count] of [...groups].sort((a, b) => b[1] - a[1])) {
      folders.createSpan({ text: `${path} · ${count}` });
    }
    section.createDiv({ cls: "aos-panel-note", text: "本地清单包含非隐藏目录中的 PNG/JPEG/WebP；文件数不能用于推算云仓覆盖率。登记不会移动图片、改写双链或提交上传。" });
    const picker = section.createEl("details", { cls: "aos-image-catalog-picker" });
    picker.createEl("summary", { text: "浏览本地图片 · 选择原位登记（最多 20 张）" });
    const search = picker.createEl("input", { type: "search", placeholder: "搜索文件名或目录，例如 attachments、图库…", cls: "aos-image-catalog-search" });
    search.setAttribute("aria-label", "筛选本地图片路径");
    const actions = picker.createDiv({ cls: "aos-action-row" });
    const selection = actions.createSpan({ cls: "aos-panel-note" });
    const busy = this.imageRegistrationRunning || snapshot.running;
    const register = this.actionButton(actions, "原位登记所选", async () => {
      if (this.imageRegistrationRunning || !this.imageRegistrationSelection.size) return;
      this.imageRegistrationRunning = true;
      this.renderMain();
      try {
        this.imageRegistrationReceipt = await this.plugin.imageGovernance.registerImagePathsInPlace([...this.imageRegistrationSelection]);
        for (const item of this.imageRegistrationReceipt.items) {
          if (!item.error) this.imageRegistrationSelection.delete(item.path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.imageRegistrationReceipt = {
          total: this.imageRegistrationSelection.size, registered: 0, failed: this.imageRegistrationSelection.size,
          items: [...this.imageRegistrationSelection].map(path => ({ path, error: message })),
        };
      } finally {
        this.imageRegistrationRunning = false;
        this.renderMain();
      }
    });
    const list = picker.createDiv({ cls: "aos-image-catalog-list" });
    const updateSelection = (): void => {
      selection.setText(`已选 ${this.imageRegistrationSelection.size}/20`);
      register.disabled = !online || busy || this.imageRegistrationSelection.size === 0;
      register.title = !online ? "本机 Daemon 离线" : busy ? "已有图片任务正在运行" : "只写资产账本，不压缩、不上传";
    };
    const drawList = (): void => {
      list.empty();
      const query = search.value.trim().toLowerCase();
      const filtered = inventory.filter(item => !query || item.path.toLowerCase().includes(query));
      list.createDiv({ cls: "aos-panel-note", text: `匹配 ${filtered.length} 张 · 当前显示前 60 张，可继续搜索缩小范围` });
      for (const item of filtered.slice(0, 60)) {
        const row = list.createEl("label", { cls: "aos-image-catalog-row" });
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = this.imageRegistrationSelection.has(item.path);
        checkbox.disabled = busy;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            if (this.imageRegistrationSelection.size >= 20) {
              checkbox.checked = false;
              new Notice("单次最多登记 20 张图片");
              return;
            }
            this.imageRegistrationSelection.add(item.path);
          } else this.imageRegistrationSelection.delete(item.path);
          updateSelection();
        });
        const copy = row.createDiv();
        copy.createDiv({ cls: "aos-image-catalog-path", text: item.path });
        copy.createDiv({ cls: "aos-panel-note", text: `${item.format.toUpperCase()} · ${this.formatBytes(item.bytes)} · ${item.noteCount} 篇笔记引用` });
      }
      updateSelection();
    };
    const clear = this.actionButton(actions, "清空选择", () => { this.imageRegistrationSelection.clear(); drawList(); });
    clear.disabled = busy;
    search.addEventListener("input", drawList);
    drawList();
    if (this.imageRegistrationReceipt) {
      const receipt = this.imageRegistrationReceipt;
      const result = section.createDiv({ cls: "aos-image-catalog-receipt" });
      result.createDiv({ cls: "aos-image-governance-section-title", text: `最近登记结果 · 成功 ${receipt.registered}/${receipt.total} · 失败 ${receipt.failed}` });
      for (const item of receipt.items) {
        result.createDiv({ cls: item.error ? "aos-panel-note is-warning" : "aos-panel-note", text: item.error ? `${item.path}：${item.error}` : `${item.path} → ${item.assetId}` });
      }
    }
  }

  private renderImageGovernancePanel(parent: HTMLElement): void {
    const settings = this.plugin.settings.imageGovernance;
    const snapshot = this.plugin.imageGovernance.getSnapshot();
    const heading = parent.createDiv({ cls: "aos-panel-header-row" });
    heading.createDiv({ cls: "aos-panel-title", text: "图片资产管理 · 原位登记与云端备份" });
    const status = settings.enabled
      ? (settings.autoCompress ? "实时治理已开启" : "仅监测")
      : "已暂停";
    heading.createSpan({ cls: `aos-image-governance-status ${settings.enabled ? "is-on" : "is-off"}`, text: status });
    this.renderImageCatalog(parent);

    const local = parent.createEl("details", { cls: "aos-image-governance-section is-local" });
    local.open = this.imagePanelExpanded.local;
    local.createEl("summary", { text: `WebP 转换 · ${snapshot.candidates} 张待评估` });
    local.addEventListener("toggle", () => { this.imagePanelExpanded.local = local.open; });
    local.createDiv({ cls: "aos-image-governance-section-title", text: "本地治理" });
    local.createDiv({
      cls: "aos-panel-note",
      text: `本次扫描 ${snapshot.scanned} 张 · 待压缩 ${snapshot.candidates} 张 · 本次已压缩 ${snapshot.converted} 张 · 压缩等待队列 ${snapshot.pending} 张`,
    });
    const savings = snapshot.bytesBefore > 0
      ? `${this.formatBytes(Math.max(0, snapshot.bytesBefore - snapshot.bytesAfter))} 已释放`
      : "尚未产生压缩回执";
    local.createDiv({ cls: "aos-panel-note", text: `${savings}；仅处理超过 ${this.formatBytes(settings.minBytes)} 的 PNG/JPEG，WebP 作为显示版本，原图继续保留。` });
    local.createDiv({
      cls: "aos-panel-note",
      text: "安全批次：每次最多编码 10 张新图；已有 PNG/JPG + WebP 每次最多补登记 20 对；.source-png 等隐藏原稿目录永不进入治理队列。",
    });
    if (snapshot.lastError) {
      local.createDiv({ cls: "aos-panel-note is-warning", text: `最近一次本地失败：${snapshot.lastError}` });
    }
    const localActions = local.createDiv({ cls: "aos-action-row" });
    this.actionButton(localActions, "扫描本地图片", async () => {
      await this.plugin.imageGovernance.scanNow(false);
      this.imageGovernanceCandidates = null;
      this.selectedGovernancePaths.clear();
      this.renderMain();
    });
    this.actionButton(localActions, "加载候选清单", () => {
      this.imageGovernanceCandidates = this.plugin.imageGovernance.listGovernanceCandidates(100);
      const available = new Set(this.imageGovernanceCandidates.map(item => item.path));
      this.selectedGovernancePaths = new Set(
        [...this.selectedGovernancePaths].filter(path => available.has(path)).slice(0, 10),
      );
      this.renderMain();
    });
    this.actionButton(localActions, settings.autoCompress ? "暂停自动治理" : "开启自动治理", async () => {
      settings.autoCompress = !settings.autoCompress;
      await this.plugin.saveSettings();
      this.renderMain();
    });

    if (this.imageGovernanceCandidates !== null) {
      const visibleCandidates = this.visibleImageGovernanceCandidates();
      const candidatePanel = local.createDiv({ cls: "aos-image-governance-candidates" });
      const candidateHeading = candidatePanel.createDiv({ cls: "aos-image-governance-candidate-heading" });
      const headingCopy = candidateHeading.createDiv();
      headingCopy.createDiv({ cls: "aos-image-governance-section-title", text: "历史图片候选 · 显式小批次" });
      headingCopy.createDiv({
        cls: "aos-panel-note",
        text: `当前可见 ${visibleCandidates.length} / 全部 ${this.imageGovernanceCandidates.length} 张；仅会处理勾选项，单批上限 10 张。`,
      });
      candidateHeading.createSpan({
        cls: "aos-image-governance-selection-count",
        text: `${this.selectedGovernancePaths.size} / 10`,
      });

      const filterRow = candidatePanel.createDiv({ cls: "aos-image-governance-filter-row" });
      const filters = [
        ["recommended", "推荐"],
        ["referenced", "有引用"],
        ["unreferenced", "无引用"],
        ["attention", "需留意"],
        ["all", "全部"],
      ] as const;
      for (const [value, label] of filters) {
        const button = filterRow.createEl("button", {
          cls: `aos-image-governance-filter${this.imageGovernanceCandidateFilter === value ? " is-active" : ""}`,
          text: label,
        });
        button.addEventListener("click", () => {
          this.imageGovernanceCandidateFilter = value;
          this.renderMain();
        });
      }
      const sort = filterRow.createEl("select", { cls: "aos-image-governance-sort" });
      for (const [value, label] of [
        ["largest", "体积最大"],
        ["newest", "最近更新"],
        ["most-referenced", "引用最多"],
      ] as const) {
        sort.createEl("option", { value, text: label });
      }
      sort.value = this.imageGovernanceCandidateSort;
      sort.addEventListener("change", () => {
        this.imageGovernanceCandidateSort = sort.value as ImageGovernanceCandidateSort;
        this.renderMain();
      });

      const selectionActions = candidatePanel.createDiv({ cls: "aos-action-row aos-image-governance-selection-actions" });
      this.actionButton(selectionActions, "选择前 10 张", () => {
        this.selectedGovernancePaths = new Set(
          this.visibleImageGovernanceCandidates()
            .filter(item => item.selectableByDefault)
            .slice(0, 10)
            .map(item => item.path),
        );
        this.renderMain();
      });
      this.actionButton(selectionActions, "清空选择", () => {
        this.selectedGovernancePaths.clear();
        this.renderMain();
      });
      const governSelected = this.actionButton(
        selectionActions,
        this.imageGovernanceBatchRunning
          ? "正在治理…"
          : `治理已选（${this.selectedGovernancePaths.size}）`,
        async () => {
          if (this.imageGovernanceBatchRunning || this.selectedGovernancePaths.size === 0) return;
          this.imageGovernanceBatchRunning = true;
          this.renderMain();
          try {
            this.imageGovernanceBatchReceipt = await this.plugin.imageGovernance.governSelectedImagesNow(
              [...this.selectedGovernancePaths],
            );
            const converted = new Set(
              this.imageGovernanceBatchReceipt.results
                .filter(item => item.status === "converted")
                .map(item => item.path),
            );
            this.selectedGovernancePaths = new Set(
              [...this.selectedGovernancePaths].filter(path => !converted.has(path)),
            );
            this.imageGovernanceCandidates = this.plugin.imageGovernance.listGovernanceCandidates(100);
            new Notice(`图片批次完成：${this.imageGovernanceBatchReceipt.results.filter(item => item.status === "converted").length} 张已转换`);
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          } finally {
            this.imageGovernanceBatchRunning = false;
            this.renderMain();
          }
        },
      );
      governSelected.disabled = this.imageGovernanceBatchRunning || this.selectedGovernancePaths.size === 0;

      if (visibleCandidates.length === 0) {
        candidatePanel.createDiv({ cls: "aos-panel-note", text: "当前筛选下没有满足体积门槛且尚无同名 WebP 的候选图片。" });
      } else {
        const candidateList = candidatePanel.createDiv({ cls: "aos-image-governance-candidate-list" });
        const kindLabel = {
          recommended: "推荐",
          unreferenced: "无引用",
          retired_source: "退役来源",
          operational_evidence: "运维证据",
        } as const;
        for (const candidate of visibleCandidates) {
          const row = candidateList.createEl("label", {
            cls: `aos-image-governance-candidate-row is-${candidate.kind}`,
          });
          const checkbox = row.createEl("input", { type: "checkbox" });
          checkbox.checked = this.selectedGovernancePaths.has(candidate.path);
          checkbox.disabled = this.imageGovernanceBatchRunning
            || (!checkbox.checked && this.selectedGovernancePaths.size >= 10);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              if (this.selectedGovernancePaths.size >= 10) {
                checkbox.checked = false;
                new Notice("单批最多选择 10 张图片");
                return;
              }
              this.selectedGovernancePaths.add(candidate.path);
            } else {
              this.selectedGovernancePaths.delete(candidate.path);
            }
            this.renderMain();
          });
          const copy = row.createDiv({ cls: "aos-image-governance-candidate-copy" });
          const title = copy.createDiv({ cls: "aos-image-governance-candidate-title" });
          title.createSpan({ cls: `aos-image-governance-candidate-kind is-${candidate.kind}`, text: kindLabel[candidate.kind] });
          title.createSpan({ cls: "aos-image-governance-candidate-name", text: candidate.name });
          copy.createDiv({ cls: "aos-image-governance-candidate-path", text: candidate.path });
          copy.createDiv({ cls: "aos-image-governance-candidate-reason", text: candidate.reason });
          row.createDiv({
            cls: "aos-image-governance-candidate-meta",
            text: `${this.formatBytes(candidate.bytes)} · ${candidate.referenceCount} 条引用 · ${candidate.area} · ${this.formatSnapshotTime(candidate.modifiedAt)}`,
          });
        }
      }
    }

    const batchHistory = this.plugin.imageGovernance.getBatchHistory().slice(0, 5);
    if (batchHistory.length > 0) {
      const receiptPanel = local.createDiv({ cls: "aos-image-governance-receipt" });
      receiptPanel.createDiv({ cls: "aos-image-governance-section-title", text: `治理账本 · 最近 ${batchHistory.length} 批` });
      const statusLabel = { converted: "已转换", skipped: "已跳过", failed: "失败" } as const;
      for (const batch of batchHistory) {
        const batchBlock = receiptPanel.createEl("details", { cls: "aos-image-governance-history-batch" });
        const summary = batchBlock.createEl("summary");
        summary.createSpan({ cls: "aos-image-governance-history-id", text: batch.manifestId });
        summary.createSpan({
          cls: "aos-image-governance-history-counts",
          text: `${batch.converted} 转换 · ${batch.skipped} 跳过 · ${batch.failed} 失败`,
        });
        summary.createSpan({
          cls: "aos-image-governance-history-time",
          text: this.formatSnapshotTime(batch.finishedAt || batch.createdAt),
        });
        const saved = Math.max(0, batch.bytesBefore - batch.bytesAfter);
        batchBlock.createDiv({
          cls: "aos-panel-note",
          text: `${batch.paths.length} 张合法候选 · 原始体积 ${this.formatBytes(batch.totalBytes)}${saved > 0 ? ` · 节省 ${this.formatBytes(saved)}` : ""}`,
        });
        const resultList = batchBlock.createDiv({ cls: "aos-image-governance-result-list" });
        for (const result of batch.results) {
          const row = resultList.createDiv({ cls: `aos-image-governance-result is-${result.status}` });
          row.createSpan({ cls: "aos-image-governance-result-status", text: statusLabel[result.status] });
          row.createSpan({ cls: "aos-image-governance-result-path", text: result.path });
          const delta = result.afterBytes !== undefined
            ? `${this.formatBytes(result.beforeBytes)} → ${this.formatBytes(result.afterBytes)}`
            : result.error || this.formatBytes(result.beforeBytes);
          const rewrite = result.status === "converted"
            && result.rewrittenNoteCount !== undefined
            && result.rewrittenTokenCount !== undefined
            ? ` · ${result.rewrittenNoteCount} 篇 / ${result.rewrittenTokenCount} token`
            : "";
          row.createSpan({ cls: "aos-image-governance-result-detail", text: `${delta}${rewrite}` });
        }
      }
    }

    const registry = snapshot.registry;
    const cloud = snapshot.cloud;
    const daemonOnline = this.plugin.hamasxiangAdapter.getSnapshot().online;
    const cloudSection = parent.createEl("details", { cls: "aos-image-governance-section is-cloud" });
    cloudSection.open = this.imagePanelExpanded.cloud;
    cloudSection.createEl("summary", { text: `COS 备份 · ${cloud.available ? `${cloud.remoteVerifiedAssets ?? "未知"} 项资产已验签` : "状态未连接"}` });
    cloudSection.addEventListener("toggle", () => { this.imagePanelExpanded.cloud = cloudSection.open; });
    const cloudHeading = cloudSection.createDiv({ cls: "aos-image-governance-section-heading" });
    cloudHeading.createDiv({ cls: "aos-image-governance-section-title", text: "图片云仓 · 私有 COS" });
    const cloudStateLabel: Record<string, string> = {
      disabled: "未启用",
      blocked: "等待配置",
      ready: "可用",
      pending: "已有待办",
      running: "正在上传",
      retry_wait: "等待重试",
      degraded: "部分异常",
      unknown: "未知",
    };
    const cloudStatus = !daemonOnline
      ? "Daemon 离线"
      : !cloud.available
        ? "状态未连接"
        : !cloud.enabled
          ? "尚未启用"
          : !cloud.configured
            ? "凭据未配置"
            : cloud.running
              ? "正在上传"
              : cloud.restore.running
                ? "恢复抽检中"
              : cloudStateLabel[cloud.state] ?? cloud.state;
    cloudHeading.createSpan({
      cls: `aos-image-governance-status${daemonOnline && cloud.available && cloud.configured ? " is-on" : " is-off"}`,
      text: cloudStatus || "未知",
    });

    const cloudMetrics = cloudSection.createDiv({ cls: "aos-image-cloud-metrics" });
    const cloudMetric = (label: string, value: string, detail: string): void => {
      const item = cloudMetrics.createDiv({ cls: "aos-image-cloud-metric" });
      item.createDiv({ cls: "aos-image-cloud-metric-label", text: label });
      item.createDiv({ cls: "aos-image-cloud-metric-value", text: value });
      item.createDiv({ cls: "aos-image-cloud-metric-detail", text: detail });
    };
    cloudMetric(
      "云上传队列",
      `${cloud.queued + cloud.leased}`,
      `排队 ${cloud.queued} · 上传中 ${cloud.leased} · 当前到期 ${cloud.due}`,
    );
    cloudMetric(
      "云端验签",
      `${cloud.remoteVerifiedAssets ?? "未知"} / ${cloud.remoteVerified}`,
      `COS 资产 / COS 对象 · 远端共 ${cloud.remoteTotal}`,
    );
    cloudMetric(
      "失败",
      `${cloud.failed}`,
      `可重试 ${cloud.retryableFailed} · 终止 ${cloud.terminalFailed} · 远端对象 ${cloud.remoteFailed}`,
    );
    const lastProductionVerification = cloud.lastSuccessAt ? Date.parse(cloud.lastSuccessAt) : Number.NaN;
    const hasProductionVerification = Number.isFinite(lastProductionVerification);
    cloudMetric(
      "最近生产验签",
      hasProductionVerification
        ? this.formatSnapshotTime(lastProductionVerification)
        : "尚无",
      hasProductionVerification
        ? `${cloud.provider || "tencent_cos"} · 状态刷新 ${cloud.checkedAt ? this.formatSnapshotTime(cloud.checkedAt) : "—"}`
        : `尚无生产验签 · ${cloudStateLabel[cloud.state] ?? cloud.state} · 状态刷新 ${cloud.checkedAt ? this.formatSnapshotTime(cloud.checkedAt) : "—"}`,
    );

    cloudSection.createDiv({
      cls: `aos-panel-note${registry.available ? "" : " is-warning"}`,
      text: registry.available
        ? `资产账本：发现 ${registry.discovered} · 衍生就绪 ${registry.derivativeReady} · 已上传 ${registry.uploaded} · 已验签 ${registry.verified} · 失败 ${registry.failed}`
        : `资产账本未连接${registry.lastError ? ` · ${registry.lastError}` : ""}`,
    });
    if (cloud.nextAttemptAt) {
      const nextAttempt = Date.parse(cloud.nextAttemptAt);
      cloudSection.createDiv({
        cls: "aos-panel-note",
        text: `下一次可重试：${Number.isFinite(nextAttempt) ? new Date(nextAttempt).toLocaleString("zh-CN", { hour12: false }) : cloud.nextAttemptAt}`,
      });
    }
    if (cloud.lastError) {
      const location = [cloud.lastError.layer, cloud.lastError.code].filter(Boolean).join(" / ");
      cloudSection.createDiv({
        cls: "aos-panel-note is-warning",
        text: `最近云仓错误${location ? `（${location}）` : ""}：${cloud.lastError.message}`,
      });
    }
    if (cloud.restore.running) {
      cloudSection.createDiv({ cls: "aos-panel-note", text: "恢复抽检正在下载 display 副本并重新核对内容摘要。" });
    } else if (cloud.restore.lastSuccessAt) {
      const restoredAt = Date.parse(cloud.restore.lastSuccessAt);
      cloudSection.createDiv({
        cls: "aos-panel-note",
        text: `最近恢复演练：${Number.isFinite(restoredAt) ? new Date(restoredAt).toLocaleString("zh-CN", { hour12: false }) : cloud.restore.lastSuccessAt} · ${cloud.restore.lastRole || "display"}`,
      });
    }
    if (cloud.restore.lastError) {
      const restoreLocation = [cloud.restore.lastError.layer, cloud.restore.lastError.code].filter(Boolean).join(" / ");
      cloudSection.createDiv({
        cls: "aos-panel-note is-warning",
        text: `最近恢复演练失败${restoreLocation ? `（${restoreLocation}）` : ""}：${cloud.restore.lastError.message}`,
      });
    }

    const cloudActions = cloudSection.createDiv({ cls: "aos-action-row" });
    const refreshCloud = this.actionButton(cloudActions, "刷新云仓状态", async () => {
      await this.plugin.imageGovernance.refreshRegistrySummary();
      this.renderMain();
    });
    refreshCloud.disabled = !daemonOnline;
    if (!daemonOnline) refreshCloud.title = "本机 Daemon 离线，无法读取云仓状态";

    const refreshCloudImageLinks = this.actionButton(cloudActions, "刷新云端笔记图片链接", async () => {
      const receipt = await this.plugin.hamasxiangAdapter.requestCloudImageLinkRefresh();
      new Notice(
        receipt.taskStarted
          ? "已启动云端图片链接刷新；只更新云端镜像，本机笔记与图片位置不变。"
          : "刷新请求已排队，镜像任务下一轮会更新云端图片链接。",
        6500,
      );
    });
    const cloudLinkRefreshBlocked = !daemonOnline
      ? "本机 Daemon 离线"
      : !cloud.available
        ? "请先刷新云仓状态"
        : !cloud.configured
          ? "COS 凭据当前不可用"
          : cloud.remoteVerifiedAssets === null
            ? "当前 Daemon 未提供 COS 验签资产数"
            : cloud.remoteVerifiedAssets <= 0
              ? "没有已验签的 COS 展示图可替换"
              : "";
    refreshCloudImageLinks.disabled = !!cloudLinkRefreshBlocked;
    if (cloudLinkRefreshBlocked) refreshCloudImageLinks.title = cloudLinkRefreshBlocked;
    cloudSection.createDiv({
      cls: "aos-panel-note",
      text: "只替换云端镜像中已通过 COS 验签的图片引用，链接有效期最长 1 小时；未验签图片保留原引用。不会改本机笔记或清理服务器图片副本。",
    });

    const reconcileExisting = this.actionButton(cloudActions, "补登记已有 WebP（最多 20 对）", async () => {
      await this.plugin.imageGovernance.reconcileExistingDerivativesNow(20);
      this.renderMain();
    });
    const reconcileBlockedReason = !daemonOnline
      ? "本机 Daemon 离线"
      : !cloud.available
        ? "请先刷新云仓状态并确认 Daemon Token"
        : snapshot.running
          ? "已有图片治理任务正在运行"
          : cloud.restore.running
            ? "图片恢复抽检正在运行"
          : "";
    reconcileExisting.disabled = !!reconcileBlockedReason;
    if (reconcileBlockedReason) reconcileExisting.title = reconcileBlockedReason;

    const uploadPending = this.actionButton(cloudActions, cloud.running ? "云上传进行中" : "上传待办", async () => {
      await this.plugin.imageGovernance.runPendingUploads(20);
      this.renderMain();
    });
    const uploadBlockedReason = !daemonOnline
      ? "本机 Daemon 离线"
      : !cloud.available
        ? "请先刷新云仓状态"
        : !cloud.enabled
          ? "云仓服务尚未启用"
          : !cloud.configured
            ? "云仓凭据尚未配置"
            : cloud.running
              ? "已有云上传任务正在运行"
              : cloud.restore.running
                ? "图片恢复抽检正在运行"
                : cloud.queued + cloud.retryableFailed <= 0
                  ? "当前没有待上传图片"
                  : "";
    uploadPending.disabled = !!uploadBlockedReason;
    if (uploadBlockedReason) uploadPending.title = uploadBlockedReason;

    const restoreDrill = this.actionButton(cloudActions, cloud.restore.running ? "恢复抽检进行中" : "恢复抽检", async () => {
      await this.plugin.imageGovernance.runRestoreDrill("display");
      this.renderMain();
    });
    const restoreBlockedReason = !daemonOnline
      ? "本机 Daemon 离线"
      : !cloud.available
        ? "请先刷新云仓状态"
        : !cloud.enabled
          ? "云仓服务尚未启用"
          : !cloud.configured
            ? "云仓尚未达到有效可用状态"
            : cloud.running
              ? "云上传任务正在运行"
              : cloud.restore.running
                ? "恢复抽检正在运行"
                : (cloud.remoteVerifiedAssets ?? 0) <= 0
                  ? cloud.remoteVerifiedAssets === null
                    ? "当前 Daemon 未提供 COS 专属验签资产数"
                    : "当前没有 COS 专属已验签资产"
                  : "";
    restoreDrill.disabled = !!restoreBlockedReason;
    if (restoreBlockedReason) restoreDrill.title = restoreBlockedReason;

    const retention = snapshot.retention;
    const retentionSection = parent.createEl("details", { cls: "aos-image-governance-section is-retention" });
    retentionSection.open = this.imagePanelExpanded.retention;
    retentionSection.createEl("summary", { text: "恢复核验与保留策略 · 展开查看待补证与阻塞项" });
    retentionSection.addEventListener("toggle", () => { this.imagePanelExpanded.retention = retentionSection.open; });
    const retentionHeading = retentionSection.createDiv({ cls: "aos-image-governance-section-heading" });
    retentionHeading.createDiv({
      cls: "aos-image-governance-section-title",
      text: "原图保留与恢复 SLA",
    });
    retentionHeading.createSpan({
      cls: `aos-image-governance-status${retention.available ? " is-on" : " is-off"}`,
      text: retention.available ? "只读评估" : "状态未连接",
    });

    const retentionStateLabels: Record<string, string> = {
      retained: "继续保留",
      verification_pending: "等待验签",
      restore_evidence_missing: "缺恢复证明",
      restore_evidence_stale: "证明已过期",
      grace_period: "保留期内",
      eligible_for_review: "可人工审查",
      blocked: "已阻塞",
    };
    const retentionReasonLabels: Record<string, string> = {
      local_original_missing: "本地原图缺失",
      local_display_missing: "本地展示图缺失",
      local_original_integrity_mismatch: "本地原图与登记摘要不符",
      local_display_integrity_mismatch: "本地展示图与登记摘要不符",
      remote_original_missing: "云端原图收据缺失",
      remote_display_missing: "云端展示图收据缺失",
      remote_original_binding_mismatch: "云端原图绑定不一致",
      remote_display_binding_mismatch: "云端展示图绑定不一致",
      upload_not_succeeded: "上传队列尚未成功闭环",
      restore_original_missing: "缺少原图恢复证明",
      restore_display_missing: "缺少展示图恢复证明",
      restore_original_stale: "原图恢复证明已过期",
      restore_display_stale: "展示图恢复证明已过期",
      restore_original_latest_failed_or_mismatched: "最近原图恢复失败或不匹配",
      restore_display_latest_failed_or_mismatched: "最近展示图恢复失败或不匹配",
      display_has_no_active_note_refs: "当前没有活动笔记引用展示图",
      minimum_local_retention_not_elapsed: "尚未走完最短本地保留期",
    };
    const retentionCounts = retention.byState;
    const retentionMetrics = retentionSection.createDiv({ cls: "aos-image-cloud-metrics" });
    const retentionMetric = (label: string, value: string, detail: string): void => {
      const item = retentionMetrics.createDiv({ cls: "aos-image-cloud-metric" });
      item.createDiv({ cls: "aos-image-cloud-metric-label", text: label });
      item.createDiv({ cls: "aos-image-cloud-metric-value", text: value });
      item.createDiv({ cls: "aos-image-cloud-metric-detail", text: detail });
    };
    retentionMetric(
      "本地保留期",
      `${retention.minimumLocalRetentionDays} 天`,
      `从云端双角色验签完成后重新起算`,
    );
    retentionMetric(
      "恢复证明 SLA",
      `${retention.restoreSlaMaxAgeDays} 天`,
      "original 与 display 都要逐资产抽检",
    );
    retentionMetric(
      "等待补证",
      `${(retentionCounts.restore_evidence_missing ?? 0) + (retentionCounts.restore_evidence_stale ?? 0)}`,
      `缺失 ${retentionCounts.restore_evidence_missing ?? 0} · 过期 ${retentionCounts.restore_evidence_stale ?? 0}`,
    );
    retentionMetric(
      "人工审查候选",
      `${retention.eligibleForReview}`,
      `保留期内 ${retentionCounts.grace_period ?? 0} · 阻塞 ${retentionCounts.blocked ?? 0}`,
    );

    retentionSection.createDiv({
      cls: "aos-panel-note",
      text: `当前版本没有删除、本地清退、tombstone 或 COS 删除动作。候选只用于审查，任何状态都不会自动移除原图。`,
    });
    if (retention.lastError) {
      retentionSection.createDiv({
        cls: "aos-panel-note is-warning",
        text: `保留策略状态读取失败：${retention.lastError}`,
      });
    }

    const sampler = cloud.restoreSampler;
    const samplerPanel = retentionSection.createDiv({ cls: "aos-image-restore-sampler" });
    const samplerHeading = samplerPanel.createDiv({ cls: "aos-image-governance-section-heading" });
    samplerHeading.createDiv({
      cls: "aos-image-governance-section-title",
      text: "定期恢复抽样",
    });
    const samplerLabel = sampler.running
      ? "运行中"
      : sampler.paused
        ? "已暂停"
        : sampler.enabled
          ? "自动开启"
          : "默认关闭";
    samplerHeading.createSpan({
      cls: `aos-image-governance-status${sampler.running || sampler.enabled ? " is-on" : " is-off"}`,
      text: samplerLabel,
    });
    const samplerNext = sampler.nextRunAt
      ? new Date(sampler.nextRunAt).toLocaleString("zh-CN", { hour12: false })
      : "未安排";
    const samplerLast = sampler.lastResult
      ? `${sampler.lastResult.status || "已结束"}${sampler.lastResult.role ? ` · ${sampler.lastResult.role}` : ""}`
      : "尚无抽样记录";
    samplerPanel.createDiv({
      cls: "aos-panel-note",
      text: `每轮最多 1 个资产/角色 · 间隔 ${Math.round(sampler.intervalSeconds / 86400)} 天 · 下次 ${samplerNext} · 最近 ${samplerLast}`,
    });
    samplerPanel.createDiv({
      cls: "aos-panel-note",
      text: "抽样只从云端恢复一份临时副本并写入逐资产恢复证明；不会删除本地原图、COS 对象或 tombstone。",
    });
    if (sampler.lastError) {
      samplerPanel.createDiv({
        cls: "aos-panel-note is-warning",
        text: `抽样状态：${sampler.lastError.message}`,
      });
    }
    const samplerActions = samplerPanel.createDiv({ cls: "aos-action-row" });
    const runSampler = this.actionButton(samplerActions, sampler.running ? "抽样进行中" : "立即抽样 1 项", async () => {
      await this.plugin.imageGovernance.runRestoreSampler();
      this.renderMain();
    });
    const samplerBlockedReason = !daemonOnline
      ? "本机 Daemon 离线"
      : !cloud.available
        ? "请先刷新云仓状态"
        : !cloud.enabled
          ? "云仓服务尚未启用"
          : !cloud.configured
            ? "云仓凭据尚未配置"
            : sampler.paused
              ? "恢复抽样已暂停"
              : cloud.running || cloud.restore.running || sampler.running
                ? "已有图片云端任务正在运行"
                : "";
    runSampler.disabled = !!samplerBlockedReason;
    if (samplerBlockedReason) runSampler.title = samplerBlockedReason;
    const pauseSampler = this.actionButton(
      samplerActions,
      sampler.paused ? "恢复自动抽样" : "暂停自动抽样",
      async () => {
        await this.plugin.imageGovernance.pauseRestoreSampler(!sampler.paused);
        this.renderMain();
      },
    );
    pauseSampler.disabled = !daemonOnline || !cloud.available;

    if (retention.available && retention.items.length > 0) {
      const retentionList = retentionSection.createDiv({ cls: "aos-image-retention-list" });
      for (const item of retention.items.slice(0, 12)) {
        const row = retentionList.createDiv({ cls: `aos-image-retention-item is-${item.state}` });
        const copy = row.createDiv({ cls: "aos-image-retention-copy" });
        const title = copy.createDiv({ cls: "aos-image-retention-title" });
        title.createSpan({
          cls: "aos-image-retention-state",
          text: retentionStateLabels[item.state] ?? item.state,
        });
        title.createSpan({ cls: "aos-image-retention-id", text: item.assetId });
        copy.createDiv({
          cls: "aos-image-retention-path",
          text: item.displayPath || item.originalPath || "本地路径未返回",
        });
        const receiptTime = (value?: string): string => {
          if (!value) return "缺失";
          const parsed = Date.parse(value);
          return Number.isFinite(parsed) ? this.formatSnapshotTime(parsed) : "时间无效";
        };
        const originalReceipt = receiptTime(item.restoreOriginal?.finishedAt);
        const displayReceipt = receiptTime(item.restoreDisplay?.finishedAt);
        copy.createDiv({
          cls: "aos-image-retention-detail",
          text: `引用 ${item.activeNoteRefCount} · 原图恢复 ${originalReceipt} · 展示图恢复 ${displayReceipt}`,
        });
        if (item.reasons.length > 0) {
          copy.createDiv({
            cls: "aos-image-retention-reasons",
            text: item.reasons
              .slice(0, 3)
              .map(reason => retentionReasonLabels[reason] ?? reason)
              .join(" · "),
          });
        }
        const rowActions = row.createDiv({ cls: "aos-image-retention-actions" });
        const runExactRestore = async (role: "original" | "display"): Promise<void> => {
          await this.plugin.imageGovernance.runRestoreDrill(role, item.assetId);
          this.renderMain();
        };
        const previewCloud = this.actionButton(rowActions, "云端预览", () => void this.openCloudAssetPreview(item.assetId));
        const exactBlockedReason = !daemonOnline
          ? "本机 Daemon 离线"
          : !cloud.available || !cloud.configured
            ? "云仓尚未达到可用状态"
            : cloud.running || cloud.restore.running
              ? "已有云端图片任务正在运行"
              : item.state === "verification_pending"
                ? "该资产尚未完成云端双角色验签"
                : "";
        const originalDrill = this.actionButton(rowActions, "抽检原图", () => runExactRestore("original"));
        const displayDrill = this.actionButton(rowActions, "抽检展示图", () => runExactRestore("display"));
        previewCloud.disabled = !!exactBlockedReason;
        originalDrill.disabled = !!exactBlockedReason;
        displayDrill.disabled = !!exactBlockedReason;
        if (exactBlockedReason) {
          previewCloud.title = exactBlockedReason;
          originalDrill.title = exactBlockedReason;
          displayDrill.title = exactBlockedReason;
        }
      }
    }

    const retentionActions = retentionSection.createDiv({ cls: "aos-action-row" });
    const copyManifest = this.actionButton(retentionActions, "复制候选 Manifest", async () => {
      const manifest = await this.plugin.imageGovernance.getRetentionManifest();
      await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
      new Notice(`已复制 ${Number(manifest.asset_count ?? 0)} 项只读审查候选；没有执行删除。`);
    });
    const manifestBlockedReason = !daemonOnline
      ? "本机 Daemon 离线"
      : !retention.available
        ? "请先刷新保留策略状态"
        : "";
    copyManifest.disabled = !!manifestBlockedReason;
    if (manifestBlockedReason) copyManifest.title = manifestBlockedReason;
  }

  private getInspirationFiles(includeArchived = false): KnowledgeNodeViewModel[] {
    return this.plugin.indexService
      .listFiles(INBOX_ROOT_PATH)
      .filter(file => file.extension.toLowerCase() === "md")
      .filter(file => !this.isInspirationRecycleBinPath(file.path))
      .filter(file => this.isInspirationCard(file))
      .filter(file => includeArchived || !isInspirationEvidence(file.frontmatter))
      .filter(file => includeArchived || this.frontmatterText(file, "status") !== "archived")
      .sort((a, b) => b.mtime - a.mtime);
  }

  private isInspirationRecycleBinPath(path: string): boolean {
    const normalized = normalizePath(path);
    return normalized === INSPIRATION_RECYCLE_BIN_PATH || normalized.startsWith(`${INSPIRATION_RECYCLE_BIN_PATH}/`);
  }

  private getInspirationRecycleFiles(): KnowledgeNodeViewModel[] {
    return this.plugin.indexService
      .listFiles(INSPIRATION_RECYCLE_BIN_PATH)
      .filter(file => file.extension.toLowerCase() === "md")
      .sort((a, b) => b.mtime - a.mtime);
  }

  private knownBacklinkPaths(file: TFile): string[] {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    return Object.entries(resolvedLinks)
      .filter(([sourcePath, destinations]) => sourcePath !== file.path && (destinations[file.path] ?? 0) > 0)
      .map(([sourcePath]) => sourcePath)
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  private permanentDeletionPreflight(file: TFile): PermanentDeletionPreflight {
    const cache = this.app.metadataCache.getFileCache(file);
    const attachmentPaths = new Set<string>();
    for (const reference of [...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
      const target = this.app.metadataCache.getFirstLinkpathDest(reference.link, file.path);
      if (target && target.extension.toLowerCase() !== "md") attachmentPaths.add(target.path);
    }
    const attachments = [...attachmentPaths]
      .map(pathValue => this.app.vault.getAbstractFileByPath(pathValue))
      .filter((candidate): candidate is TFile => candidate instanceof TFile)
      .map(attachment => ({
        path: attachment.path,
        name: attachment.name,
        backlinks: this.knownBacklinkPaths(attachment),
      }))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    return {
      backlinks: this.knownBacklinkPaths(file),
      exclusiveAttachments: attachments.filter(attachment => attachment.backlinks.length === 0
        || (attachment.backlinks.length === 1 && attachment.backlinks[0] === file.path)),
      sharedAttachments: attachments.filter(attachment => attachment.backlinks.some(backlink => backlink !== file.path)),
    };
  }

  private isInspirationCard(file: KnowledgeNodeViewModel): boolean {
    const type = this.frontmatterText(file, "type").toLowerCase();
    const rail = this.frontmatterText(file, "rail").toLowerCase();
    const tags = Array.isArray(file.frontmatter.tags)
      ? file.frontmatter.tags.filter(value => typeof value === "string").map(value => value.toLowerCase())
      : [];
    // Watch value belongs to the intelligence view. Only an explicit promotion
    // makes a scheduled item part of inspiration totals or schedule candidates.
    if (isScheduledWatcherCapture(file.frontmatter)) {
      return hasExplicitInspirationOptIn(file.frontmatter);
    }
    // Keep the original微信想法 path compatible while new sources opt in via metadata.
    return type === "inspiration_card"
      || rail === "inspiration"
      || rail === "灵感"
      || this.inboxSource(file).id === "weixin"
      || tags.some(tag => tag === "灵感" || tag === "inspiration" || tag === "灵感卡");
  }

  private inboxSource(file: KnowledgeNodeViewModel): { id: string; label: string; icon: string } {
    const prefix = `${INBOX_ROOT_PATH}/`;
    const relative = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : "";
    const folder = relative.split("/").filter(Boolean)[0] ?? "";
    return INBOX_SOURCE_LABELS[folder] ?? { id: "other", label: folder || "其他网页", icon: "globe-2" };
  }

  private getInboxCaptureCandidates(): KnowledgeNodeViewModel[] {
    return this.plugin.indexService
      .listFiles(INBOX_ROOT_PATH)
      .filter(file => file.extension.toLowerCase() === "md")
      .filter(file => !this.isInspirationCard(file))
      .filter(file => !isInspirationEvidence(file.frontmatter))
      .filter(file => shouldAutoProjectCaptureToInspiration(file.frontmatter))
      .filter(file => this.frontmatterText(file, "status") !== "archived")
      .filter(file => {
        const prefix = `${INBOX_ROOT_PATH}/`;
        const relative = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : "";
        const parts = relative.split("/").filter(Boolean);
        // Root instructions and the recycle bin are governance notes, not capture candidates.
        return parts.length >= 2 && parts[0] !== "00_残卷回收站";
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Passive Watch is not an inspiration card. Only classified high-value
   * signals are projected into the radar rail as a read-only intelligence
   * surface; explicit promotion is handled by the card action itself.
   */
  private getHighValueRadarSignals(): KnowledgeNodeViewModel[] {
    return this.plugin.indexService
      .listFiles(INBOX_ROOT_PATH)
      .filter(file => file.extension.toLowerCase() === "md")
      .filter(file => isScheduledWatcherCapture(file.frontmatter))
      .filter(file => !hasExplicitInspirationOptIn(file.frontmatter))
      .filter(file => passesScheduledWatcherValueGate(file.frontmatter))
      .filter(file => this.frontmatterText(file, "status") !== "archived")
      .sort((a, b) => b.mtime - a.mtime);
  }

  private inspirationIdentity(file: KnowledgeNodeViewModel): string {
    const ideaIdentity = captureIdeaIdentity(file.frontmatter);
    if (ideaIdentity) return ideaIdentity;
    const platform = this.frontmatterText(file, "source_platform").toLowerCase() || this.inboxSource(file).id;
    const sourceId = this.frontmatterText(file, "source_id")
      || this.frontmatterText(file, "tweet_id")
      || this.frontmatterText(file, "note_id")
      || this.frontmatterText(file, "video_id");
    if (sourceId) return `source:${platform}:${sourceId.toLowerCase()}`;

    const sourceUrl = this.inspirationSourceUrl(file);
    if (sourceUrl) {
      try {
        const parsed = new URL(sourceUrl);
        const host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
        const statusId = parsed.pathname.match(/\/(?:i\/web\/)?status\/(\d+)/u)?.[1];
        if (statusId && ["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) {
          return `source:x:${statusId}`;
        }
        const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
        return `url:${host}${pathname}`;
      } catch {
        return `url:${sourceUrl.trim().toLowerCase()}`;
      }
    }

    const captureId = this.frontmatterText(file, "capture_id")
      || this.frontmatterText(file, "capture_request_id");
    if (captureId) return `capture:${captureId.toLowerCase()}`;
    return `path:${file.path.toLowerCase()}`;
  }

  private dedupeInspirationFiles(files: KnowledgeNodeViewModel[]): KnowledgeNodeViewModel[] {
    const byIdentity = new Map<string, KnowledgeNodeViewModel>();
    for (const file of files) {
      const identity = this.inspirationIdentity(file);
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, file);
        continue;
      }
      const fileIsExplicit = this.isInspirationCard(file);
      const existingIsExplicit = this.isInspirationCard(existing);
      const priority = (item: KnowledgeNodeViewModel): number =>
        item.frontmatter.record_role === "primary" ? 2 : isInspirationEvidence(item.frontmatter) ? -1 : 0;
      if (priority(file) > priority(existing)
        || (priority(file) === priority(existing) && ((fileIsExplicit && !existingIsExplicit)
          || (fileIsExplicit === existingIsExplicit && file.mtime > existing.mtime)))) {
        byIdentity.set(identity, file);
      }
    }
    return [...byIdentity.values()].sort((a, b) => this.inspirationCapturedTime(b) - this.inspirationCapturedTime(a));
  }

  private getRailFiles(): KnowledgeNodeViewModel[] {
    const explicitCards = this.getInspirationFiles();
    const recentCandidates = this.dedupeInspirationFiles(this.getInboxCaptureCandidates());
    const radarSignals = this.getHighValueRadarSignals().slice(0, 12);
    return this.dedupeInspirationFiles([...explicitCards, ...recentCandidates, ...radarSignals]);
  }

  private async promoteInboxCandidate(file: KnowledgeNodeViewModel): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(file.path);
    if (!(abstract instanceof TFile)) {
      new Notice(`收件箱笔记不存在：${file.path}`);
      return;
    }
    const source = this.inboxSource(file);
    const area = this.inspirationArea(file);
    await this.app.fileManager.processFrontMatter(abstract, frontmatter => {
      frontmatter.contract_version = frontmatter.contract_version || "aos-capture/v1";
      frontmatter.type = "inspiration_card";
      frontmatter.rail = "inspiration";
      frontmatter.inbox_channel = frontmatter.inbox_channel || (source.id === "weixin" ? "weixin_hermes" : source.id === "x" ? "x_watch" : "local_capture");
      frontmatter.source_platform = frontmatter.source_platform || (source.id === "bilibili" ? "bilibili" : source.id === "douyin" ? "douyin" : source.id === "xiaohongshu" ? "xiaohongshu" : source.id === "x" ? "x" : source.id === "weixin" ? "weixin" : "manual");
      frontmatter.source_url = frontmatter.source_url || this.inspirationSourceUrl(file) || null;
      frontmatter.source_note_path = frontmatter.source_note_path || file.path;
      frontmatter.capture_id = frontmatter.capture_id || null;
      frontmatter.capture_request_id = frontmatter.capture_request_id || null;
      frontmatter.evidence_level = frontmatter.evidence_level || null;
      frontmatter.area = frontmatter.area || area.id;
      frontmatter.value_score = frontmatter.value_score ?? null;
      frontmatter.freshness = frontmatter.freshness || "warm";
      frontmatter.next_action = frontmatter.next_action || "review";
      frontmatter.derived_note_path = frontmatter.derived_note_path || null;
      frontmatter.agent_status = frontmatter.agent_status || "idle";
      frontmatter.refinement_status = frontmatter.refinement_status
        || (frontmatter.derived_note_path ? "refined" : frontmatter.status === "refining" ? "refining" : "idle");
      frontmatter.plan_link_status = frontmatter.plan_link_status
        || (frontmatter.status === "scheduled" ? "linked" : "unlinked");
      frontmatter.status = ["captured", "candidate", "refining", "refined", "scheduled", "archived"].includes(frontmatter.status)
        ? frontmatter.status
        : "candidate";
      frontmatter.captured_at = frontmatter.captured_at || frontmatter.created_at || frontmatter.date || new Date(file.mtime).toISOString();
      const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((value: unknown) => typeof value === "string") : [];
      if (!tags.some((tag: string) => tag === "灵感")) tags.push("灵感");
      frontmatter.tags = tags;
    });
    new Notice(`已将${source.label}素材挂入${area.label}`);
    // Let metadataCache/index events settle before rebuilding the rail.
    await new Promise(resolve => window.setTimeout(resolve, 120));
    this.renderMain();
  }

  private async updateInspirationStatus(file: KnowledgeNodeViewModel, status: "captured" | "candidate" | "refining" | "refined" | "scheduled" | "archived"): Promise<void> {
    const abstract = this.app.vault.getAbstractFileByPath(file.path);
    if (!(abstract instanceof TFile)) {
      new Notice(`灵感笔记不存在：${file.path}`);
      return;
    }
    await this.app.fileManager.processFrontMatter(abstract, frontmatter => {
      frontmatter.type = frontmatter.type || "inspiration_card";
      const completedRefinement = isCompletedInspirationRefinement(frontmatter);
      frontmatter.status = status === "candidate" && completedRefinement ? "refined" : status;
      if (status === "refined" || completedRefinement) frontmatter.refinement_status = "refined";
      if (status === "scheduled") frontmatter.plan_link_status = "linked";
      else if (status === "candidate") frontmatter.plan_link_status = "unlinked";
      if (!completedRefinement || status === "archived") {
        frontmatter.next_action = status === "archived" ? "archive" : status === "scheduled" ? "execute" : "review";
      }
      frontmatter.updated_at = new Date().toISOString();
    });
    new Notice(status === "archived" ? `已归档灵感：${file.title}` : `已更新灵感状态：${file.title}`);
    this.renderMain();
  }

  private openInspirationRecycleModal(file: KnowledgeNodeViewModel): void {
    if (this.isInspirationRecycleBinPath(file.path)) {
      new Notice("这条笔记已在工作台回收站中。请从回收站恢复或彻底删除。");
      return;
    }
    new NoteDeleteModal(this.app, file.title, () => this.moveInspirationToRecycleBin(file), {
      heading: "移入工作台回收站",
      warning: `确定将「${file.title}」移入工作台回收站吗？可在回收站恢复；不会立即调用系统回收站或永久删除。`,
      confirmLabel: "移入工作台回收站",
    }).open();
  }

  private async moveInspirationToRecycleBin(node: KnowledgeNodeViewModel): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) throw new Error("灵感笔记已不存在，请刷新后重试");
    if (!file.path.startsWith(`${INBOX_ROOT_PATH}/`) || this.isInspirationRecycleBinPath(file.path)) {
      throw new Error("只有收件箱中的灵感笔记可以移入工作台回收站");
    }
    if (this.frontmatterText(node, "refinement_status") === "refining") {
      throw new Error("整理任务正在执行，请等待它结束后再移入回收站");
    }
    const relativePath = file.path.slice(`${INBOX_ROOT_PATH}/`.length);
    const destination = normalizePath(`${INSPIRATION_RECYCLE_BIN_PATH}/${relativePath}`);
    if (this.app.vault.getAbstractFileByPath(destination)) {
      throw new Error(`回收站中已存在同路径笔记：${destination}`);
    }
    const parent = destination.includes("/") ? destination.slice(0, destination.lastIndexOf("/")) : "";
    if (parent) await this.ensureVaultFolder(parent);
    // Do not use fileManager.renameFile here: that API can rewrite wikilinks to
    // point at the recycle-bin path. A recycle action must preserve references
    // and remain reversible without touching unrelated notes.
    await this.app.vault.rename(file, destination);
    if (this.selectedNode?.path === node.path) {
      this.selectedNode = null;
      this.plugin.store.patch({ selectedFilePath: null });
    }
    this.plugin.logBus.append("info", "inspiration.recycle", `moved: ${node.path} -> ${destination}`);
    new Notice(`已移入工作台回收站：${node.title}`);
    await new Promise(resolve => window.setTimeout(resolve, 140));
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
  }

  private async restoreInspirationFromRecycleBin(node: KnowledgeNodeViewModel): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) throw new Error("回收站笔记已不存在，请刷新后重试");
    const prefix = `${INSPIRATION_RECYCLE_BIN_PATH}/`;
    if (!file.path.startsWith(prefix)) throw new Error("这不是工作台回收站中的灵感笔记");
    const destination = normalizePath(`${INBOX_ROOT_PATH}/${file.path.slice(prefix.length)}`);
    if (this.app.vault.getAbstractFileByPath(destination)) {
      throw new Error(`原位置已存在同名笔记，拒绝覆盖：${destination}`);
    }
    const parent = destination.includes("/") ? destination.slice(0, destination.lastIndexOf("/")) : "";
    if (parent) await this.ensureVaultFolder(parent);
    // Symmetric with recycle: restoring must not rewrite unrelated wikilinks.
    await this.app.vault.rename(file, destination);
    this.plugin.logBus.append("info", "inspiration.recycle", `restored: ${node.path} -> ${destination}`);
    new Notice(`已恢复到原收件箱路径：${node.title}`);
    await new Promise(resolve => window.setTimeout(resolve, 140));
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
  }

  private openPermanentDeleteModal(node: KnowledgeNodeViewModel): void {
    if (!this.isInspirationRecycleBinPath(node.path)) {
      new Notice("彻底删除只允许在工作台回收站内进行。");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) {
      new Notice("回收站笔记已不存在，请刷新后重试。");
      return;
    }
    const preflight = this.permanentDeletionPreflight(file);
    new PermanentNoteDeleteModal(this.app, node.title, preflight, attachmentPaths => this.permanentlyDeleteInspiration(node, attachmentPaths)).open();
  }

  private async permanentlyDeleteInspiration(node: KnowledgeNodeViewModel, requestedAttachmentPaths: readonly string[]): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) throw new Error("回收站笔记已不存在，请刷新后重试");
    if (!this.isInspirationRecycleBinPath(file.path)) throw new Error("彻底删除只允许在工作台回收站内进行");
    const latestPreflight = this.permanentDeletionPreflight(file);
    const safeAttachmentPaths = new Set(latestPreflight.exclusiveAttachments.map(attachment => attachment.path));
    const attachmentPaths = [...new Set(requestedAttachmentPaths)].filter(pathValue => safeAttachmentPaths.has(pathValue));
    await this.app.vault.delete(file);
    // Attachments are deleted only when the user explicitly selected an item
    // which was independently classified as exclusive immediately before this
    // irreversible operation. Shared or uncertain assets are intentionally kept.
    for (const attachmentPath of attachmentPaths) {
      const attachment = this.app.vault.getAbstractFileByPath(attachmentPath);
      if (attachment instanceof TFile) await this.app.vault.delete(attachment);
    }
    if (this.selectedNode?.path === node.path) {
      this.selectedNode = null;
      this.plugin.store.patch({ selectedFilePath: null });
    }
    this.plugin.logBus.append("info", "inspiration.recycle", `permanently deleted: ${node.path}; exclusive attachments deleted: ${attachmentPaths.length}`);
    new Notice(`已彻底删除：${node.title}${attachmentPaths.length ? `；已清理 ${attachmentPaths.length} 个独占附件` : ""}`);
    await new Promise(resolve => window.setTimeout(resolve, 140));
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
  }

  private async submitInspirationRefinement(file: KnowledgeNodeViewModel): Promise<boolean> {
    const declaredSourcePath = this.frontmatterText(file, "source_note_path").trim();
    const sourceNotePath = normalizePath(declaredSourcePath || file.path);
    const sourceNote = this.app.vault.getAbstractFileByPath(sourceNotePath);
    if (!(sourceNote instanceof TFile)) {
      const message = `来源笔记不存在：${sourceNotePath}`;
      this.plugin.logBus.append("error", "agent.refinement", message);
      new Notice(`无法整理：${message}`);
      return false;
    }

    let receipt: HamasxiangRefinementReceipt;
    try {
      receipt = await this.plugin.hamasxiangAdapter.submitRefinement(sourceNotePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.logBus.append("error", "agent.refinement", `${sourceNotePath} · ${message}`);
      new Notice(`整理未提交：${message}`, 5500);
      return false;
    }

    const submittedAt = new Date(receipt.submittedAt).toISOString();
    const queuedFields: Record<string, unknown> = {
      agent_status: "agent_sent",
      refinement_status: "refining",
      refinement_protocol: receipt.protocolVersion,
      refinement_job_id: receipt.jobId,
      refinement_request_id: receipt.requestId,
      refinement_submitted_at: submittedAt,
      agent_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let sourceAlreadyRefined = false;
    let sourceTerminalForReceipt = false;
    let sourceTerminalStatus = "";
    const sourceState: Record<string, unknown> = {};
    try {
      await this.app.fileManager.processFrontMatter(sourceNote, frontmatter => {
        sourceAlreadyRefined = isCompletedInspirationRefinement(frontmatter);
        sourceTerminalStatus = inspirationRefinementTerminalStatus(frontmatter) ?? "";
        const sameTerminalReceipt = Boolean(sourceTerminalStatus)
          && frontmatter.refinement_job_id === receipt.jobId
          && frontmatter.refinement_request_id === receipt.requestId;
        sourceTerminalForReceipt = sourceAlreadyRefined || sameTerminalReceipt;
        if (!sourceTerminalForReceipt) {
          copyInspirationRefinementFields(frontmatter, queuedFields);
          if (frontmatter.status !== "scheduled" && frontmatter.status !== "archived") {
            frontmatter.status = "refining";
          }
        }
        Object.assign(sourceState, pickInspirationRefinementFields(frontmatter));
      });

      const cardNote = normalizePath(file.path) === sourceNotePath
        ? sourceNote
        : this.app.vault.getAbstractFileByPath(normalizePath(file.path));
      if (cardNote instanceof TFile && cardNote.path !== sourceNote.path) {
        await this.app.fileManager.processFrontMatter(cardNote, frontmatter => {
          // A separate index card may already have observed the daemon's final
          // write. Never regress that terminal state while mirroring a reused
          // or newly queued request from the source capture.
          if (isCompletedInspirationRefinement(frontmatter)) return;
          frontmatter.source_note_path = sourceNotePath;
          copyInspirationRefinementFields(frontmatter, sourceTerminalForReceipt ? sourceState : queuedFields);
          if (!sourceTerminalForReceipt && frontmatter.status !== "scheduled" && frontmatter.status !== "archived") {
            frontmatter.status = "refining";
          }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.logBus.append(
        "error",
        "agent.refinement",
        `任务 ${receipt.jobId} 已入队，但来源笔记状态回写失败：${message}`,
      );
      new Notice(`整理任务已入队，但卡片状态回写失败：${message}`, 6000);
      return true;
    }

    this.plugin.logBus.append("success", "agent.refinement", `${sourceNotePath} → ${receipt.jobId}`);
    new Notice(
      sourceAlreadyRefined
        ? `整理成稿已存在：「${this.inspirationDisplayTitle(file)}」`
        : sourceTerminalForReceipt
        ? `整理未完成（${sourceTerminalStatus === "interrupted" ? "已中断" : sourceTerminalStatus === "blocked" ? "受阻" : "失败"}）：「${this.inspirationDisplayTitle(file)}」`
        : `已进入整理队列：「${this.inspirationDisplayTitle(file)}」`,
      4200,
    );
    await new Promise(resolve => window.setTimeout(resolve, 120));
    this.renderMain();
    return true;
  }

  private refinementSourceState(file: KnowledgeNodeViewModel): { sourcePath: string; frontmatter: Record<string, unknown> } | null {
    const declaredSourcePath = this.frontmatterText(file, "source_note_path").trim();
    if (!declaredSourcePath) return null;
    const sourcePath = normalizePath(declaredSourcePath);
    if (!sourcePath || sourcePath === normalizePath(file.path)) return null;
    const source = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(source instanceof TFile)) return null;
    const sourceFrontmatter = this.app.metadataCache.getFileCache(source)?.frontmatter;
    if (!sourceFrontmatter || !isTerminalInspirationRefinement(sourceFrontmatter)) return null;
    return { sourcePath, frontmatter: sourceFrontmatter };
  }

  private syncRefinementStateToIndexCard(
    file: KnowledgeNodeViewModel,
    sourcePath: string,
    fields: Record<string, unknown>,
  ): void {
    const cardPath = normalizePath(file.path);
    if (!cardPath || cardPath === sourcePath || this.inspirationRefinementSyncInFlight.has(cardPath)) return;
    const cachedProjection = buildInspirationRefinementProjection(file.frontmatter, fields);
    if (!cachedProjection.syncFields) return;
    const card = this.app.vault.getAbstractFileByPath(cardPath);
    if (!(card instanceof TFile)) return;
    this.inspirationRefinementSyncInFlight.add(cardPath);
    void this.app.fileManager.processFrontMatter(card, frontmatter => {
      const projection = buildInspirationRefinementProjection(frontmatter, fields);
      if (!projection.syncFields) return;
      frontmatter.source_note_path = sourcePath;
      copyInspirationRefinementFields(frontmatter, projection.syncFields);
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.plugin.logBus.append("warn", "agent.refinement", `索引卡终态同步失败：${cardPath} · ${message}`);
    }).finally(() => {
      this.inspirationRefinementSyncInFlight.delete(cardPath);
    });
  }

  private frontmatterText(file: KnowledgeNodeViewModel, key: string): string {
    const value = file.frontmatter[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
    return "";
  }

  private frontmatterValue(file: KnowledgeNodeViewModel, key: string): unknown {
    return file.frontmatter[key];
  }

  /**
   * Read-only media adapter for EvidencePacket-compatible frontmatter.
   *
   * The capture side already knows `images`, `cover_image`, `media` and
   * `local_path`; the workbench only surfaces those values and never starts a
   * downloader (gallery-dl or otherwise).
   */
  private normalizeInspirationMediaRef(value: unknown): InspirationMediaRef | null {
    const normalizeString = (candidate: unknown): { value: string; remote: boolean } | null => {
      if (typeof candidate !== "string") return null;
      const text = candidate.trim().replace(/^!?\[\[/, "").replace(/\]\]$/, "").split("|")[0].trim();
      if (!text || text.includes("\0")) return null;
      if (/^https?:\/\//i.test(text)) return { value: text, remote: true };
      if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(text)) return null;
      const pathValue = normalizePath(text.replace(/^\.\//, ""));
      return pathValue ? { value: pathValue, remote: false } : null;
    };

    if (typeof value === "string") {
      const normalized = normalizeString(value);
      return normalized ? { ...normalized } : null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    const localCandidate = ["local_path", "localPath", "path"].map(key => record[key]).find(Boolean);
    const remoteCandidate = ["url", "src", "currentSrc", "urlDefault", "urlPre", "url_pre", "original", "originalUrl"]
      .map(key => record[key])
      .find(Boolean);
    const local = normalizeString(localCandidate);
    const remote = normalizeString(remoteCandidate);
    const selected = remote?.remote ? remote : local;
    if (!selected) return null;
    const alt = typeof record.alt === "string" ? record.alt.trim() : typeof record.title === "string" ? record.title.trim() : "";
    return {
      value: selected.value,
      remote: selected.remote,
      localPath: local && !local.remote ? local.value : undefined,
      alt: alt || undefined,
    };
  }

  private inspirationMedia(file: KnowledgeNodeViewModel): InspirationMediaViewModel {
    const frontmatter = file.frontmatter as Record<string, unknown>;
    const refs: InspirationMediaRef[] = [];
    const coverRefs: InspirationMediaRef[] = [];
    const seen = new Set<string>();
    const addRef = (value: unknown, cover = false): void => {
      if (Array.isArray(value)) {
        value.forEach(item => addRef(item, cover));
        return;
      }
      const ref = this.normalizeInspirationMediaRef(value);
      if (!ref) return;
      const key = `${ref.remote ? "remote" : "vault"}:${ref.value}:${ref.localPath ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
      if (cover && !coverRefs.some(item => `${item.remote}:${item.value}` === `${ref.remote}:${ref.value}`)) coverRefs.push(ref);
    };
    const readPacket = (packet: unknown): void => {
      if (!packet || typeof packet !== "object" || Array.isArray(packet)) return;
      const record = packet as Record<string, unknown>;
      for (const key of ["cover_image", "coverImage", "cover"]) addRef(record[key], true);
      for (const key of ["images", "image_list", "imageList"]) addRef(record[key]);
      readPacket(record.media);
    };

    // Prefer the Clipper's explicit remote cover over a legacy local `cover`.
    // Local files remain readable as a compatibility fallback for older notes.
    for (const key of ["cover_image", "coverImage", "cover"]) addRef(this.frontmatterValue(file, key), true);
    for (const key of ["images", "image_list", "imageList"]) addRef(this.frontmatterValue(file, key));
    for (const key of ["evidence_packet", "evidencePacket", "evidence"]) readPacket(frontmatter[key]);
    readPacket(frontmatter.media);

    // Captures created by different collectors do not share one frontmatter
    // shape. Obsidian's metadata cache already indexes Markdown image embeds,
    // so use it as a read-only fallback for notes that keep media only in the
    // body, for example `![封面](images/cover.jpg)` or `![[cover.jpg]]`.
    const abstract = this.app.vault.getAbstractFileByPath(file.path);
    if (abstract instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(abstract);
      for (const embed of cache?.embeds ?? []) {
        if (typeof embed.link === "string") addRef(embed.link);
      }
    }

    return { refs, cover: coverRefs[0] ?? refs[0] ?? null };
  }

  private resolveInspirationMediaSrc(file: KnowledgeNodeViewModel, ref: InspirationMediaRef): string | null {
    const rawPaths = (ref.remote ? [ref.value, ref.localPath] : [ref.localPath, ref.value])
      .filter((value): value is string => Boolean(value));
    const parentPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    for (const rawPath of rawPaths) {
      const normalized = normalizePath(rawPath);
      const candidates = [
        parentPath ? normalizePath(`${parentPath}/${normalized}`) : normalized,
        normalized,
      ];
      for (const candidate of candidates) {
        const abstract = this.app.vault.getAbstractFileByPath(candidate);
        if (abstract instanceof TFile) return this.app.vault.getResourcePath(abstract);
      }
    }
    return ref.remote ? ref.value : null;
  }

  private inspirationSourceUrl(file: KnowledgeNodeViewModel): string {
    for (const key of ["source_url", "sourceUrl", "url", "canonical_url", "canonicalUrl"]) {
      const value = this.frontmatterText(file, key).trim();
      if (/^https?:\/\//i.test(value)) return value;
    }
    return "";
  }

  private inspirationStatus(file: KnowledgeNodeViewModel): { label: string; className: string } {
    const refinementStatus = this.frontmatterText(file, "refinement_status");
    const legacyStatus = this.frontmatterText(file, "status") || file.lifecycleStatus || "captured";
    const reviewState = this.frontmatterText(file, "review_state");
    if (reviewState === "historical") return { label: "历史资料", className: "is-captured" };
    if (reviewState === "duplicate") return { label: "来源证据", className: "is-captured" };
    if (!["archived", "refined", "reviewed", "scheduled"].includes(legacyStatus)
      && !["refined", "refining", "failed", "blocked", "interrupted"].includes(refinementStatus)) {
      if (reviewState === "awaiting_execution") return { label: "待落实", className: "is-pending" };
      if (reviewState === "awaiting_verification") return { label: "待复核", className: "is-pending" };
    }
    const status = legacyStatus === "archived"
      ? "archived"
      : ["refined", "refining", "failed", "blocked", "interrupted"].includes(refinementStatus)
        ? refinementStatus
        : legacyStatus;
    const labels: Record<string, string> = {
      captured: "已捕获",
      candidate: "待整理",
      refining: "整理中",
      refined: "已整理",
      failed: "整理失败",
      blocked: "整理受阻",
      interrupted: "整理中断",
      scheduled: "已挂接计划",
      archived: "已归档",
      pending: "待整理",
      reviewed: "已整理",
      draft_pending_confirm: "待确认",
      synced: "已入库",
      captured_local_ack_pending: "同步待确认",
      bridge_queued_local_captured: "本机已接收",
    };
    const className = ["failed", "blocked", "interrupted"].includes(status)
      ? "is-failed"
      : status === "archived"
      ? "is-captured"
      : ["candidate", "refining", "pending", "captured"].includes(status)
      ? "is-pending"
      : ["refined", "scheduled", "reviewed", "synced"].includes(status)
      ? "is-synced"
      : "is-captured";
    return { label: labels[status] ?? status, className };
  }

  private inspirationCapturedTime(file: KnowledgeNodeViewModel): number {
    const value = this.frontmatterText(file, "captured_at") || this.frontmatterText(file, "created_at");
    const stamp = value ? Date.parse(value) : NaN;
    return Number.isFinite(stamp) ? stamp : file.mtime;
  }

  private inspirationDate(file: KnowledgeNodeViewModel): string {
    const capturedAt = this.frontmatterText(file, "captured_at") || this.frontmatterText(file, "created_at");
    const date = capturedAt ? new Date(capturedAt) : new Date(file.mtime);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  private inspirationArea(file: KnowledgeNodeViewModel): { id: string; label: string; icon: string } {
    const area = inferInspirationAreaId(file.frontmatter, file.path, file.title);
    const labels = {
      radar: { id: "radar", label: "信息雷达轨", icon: "radar" },
      life: { id: "life", label: "生活轨", icon: "leaf" },
      knowledge: { id: "knowledge", label: "知识轨", icon: "book-open" },
      project: { id: "project", label: "项目轨", icon: "layers" },
      inbox: { id: "inbox", label: "待分区轨", icon: "inbox" },
    } as const;
    return labels[area];
  }

  private inspirationFreshness(file: KnowledgeNodeViewModel): { label: string; className: string } {
    const explicit = this.frontmatterText(file, "freshness").toLowerCase();
    if (explicit === "hot" || explicit === "fresh" || explicit === "新鲜") return { label: "新鲜", className: "is-fresh" };
    if (explicit === "warm" || explicit === "recent" || explicit === "近期") return { label: "近期", className: "is-recent" };
    if (explicit === "evergreen" || explicit === "常青") return { label: "常青", className: "is-evergreen" };
    if (explicit === "expired" || explicit === "stale" || explicit === "过期") return { label: "过期", className: "is-expired" };
    const capturedAt = this.frontmatterText(file, "captured_at") || this.frontmatterText(file, "created_at");
    const date = capturedAt ? new Date(capturedAt) : new Date(file.mtime);
    const ageDays = Number.isFinite(date.getTime()) ? Math.max(0, (Date.now() - date.getTime()) / 86400000) : Infinity;
    if (ageDays <= 3) return { label: "新鲜", className: "is-fresh" };
    if (ageDays <= 14) return { label: "近期", className: "is-recent" };
    return { label: "沉淀", className: "is-evergreen" };
  }

  private inspirationValue(file: KnowledgeNodeViewModel): string {
    const raw = this.frontmatterText(file, "value_score") || this.frontmatterText(file, "priority");
    const score = Number(raw);
    return Number.isFinite(score) && raw.trim() ? `价值 ${score}` : "价值未评估";
  }

  private inspirationSummary(file: KnowledgeNodeViewModel): string {
    for (const key of ["summary", "excerpt", "preview", "description"]) {
      const value = this.frontmatterText(file, key).replace(/\s+/g, " ").trim();
      if (value) return value.slice(0, 92);
    }
    const source = this.frontmatterText(file, "source");
    return source ? `来源：${source}` : "点击打开来源笔记，继续补充这张灵感卡";
  }

  private inspirationDisplayTitle(file: KnowledgeNodeViewModel): string {
    const generic = /^(?:x\s*情报|x\s*动态|@?[\w.-]+\s+x\s*动态)$/iu;
    for (const key of ["title_zh", "topic_title", "title"]) {
      const value = this.frontmatterText(file, key).replace(/\s+/g, " ").trim();
      if (value && !generic.test(value)) return value;
    }
    if (file.title && !generic.test(file.title.trim())) return file.title;
    const summary = this.inspirationSummary(file).replace(/\s+/g, " ").trim();
    if (summary && !summary.startsWith("来源：") && !summary.startsWith("点击打开")) {
      return summary.slice(0, 56).replace(/[，。；;:,：\s]+$/u, "");
    }
    return file.basename;
  }

  private appendInspirationActionContent(target: HTMLElement, label: string, icon: string): void {
    const iconSlot = target.createSpan({ cls: "aos-inspiration-button-icon" });
    iconSlot.setAttribute("aria-hidden", "true");
    setIcon(iconSlot, icon);
    target.createSpan({ cls: "aos-inspiration-button-label", text: label });
  }

  private createWorkbenchActionButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    cls = "",
    title = label,
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `aos-workbench-action ${cls}`.trim(),
      attr: { type: "button", title, "aria-label": title },
    });
    const iconSlot = button.createSpan({ cls: "aos-workbench-action-icon" });
    iconSlot.setAttribute("aria-hidden", "true");
    setIcon(iconSlot, icon);
    button.createSpan({ cls: "aos-workbench-action-label", text: label });
    return button;
  }

  private attachInspirationRailAutoScroll(scroller: HTMLDivElement): void {
    let direction = 0;
    let animationFrame: number | null = null;
    const stop = (): void => {
      direction = 0;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }
    };
    const tick = (): void => {
      if (!scroller.isConnected || direction === 0) {
        stop();
        return;
      }
      scroller.scrollLeft += direction * 3;
      animationFrame = window.requestAnimationFrame(tick);
    };
    const update = (event: PointerEvent): void => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        stop();
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const zone = Math.min(120, Math.max(56, rect.width * 0.24));
      const distanceFromLeft = event.clientX - rect.left;
      const distanceFromRight = rect.right - event.clientX;
      const nextDirection = distanceFromLeft <= zone ? -1 : distanceFromRight <= zone ? 1 : 0;
      if (nextDirection === direction) return;
      direction = nextDirection;
      if (direction !== 0 && animationFrame === null) animationFrame = window.requestAnimationFrame(tick);
      if (direction === 0) stop();
    };
    scroller.addEventListener("pointermove", update);
    scroller.addEventListener("pointerleave", stop);
    scroller.addEventListener("wheel", stop, { passive: true });
  }

  private renderInspirationCard(track: HTMLDivElement, file: KnowledgeNodeViewModel): void {
    const card = track.createDiv({ cls: "aos-inspiration-card" });
    const sourceRefinement = this.refinementSourceState(file);
    const refinementProjection = sourceRefinement
      ? buildInspirationRefinementProjection(file.frontmatter, sourceRefinement.frontmatter)
      : null;
    if (sourceRefinement && refinementProjection?.syncFields) {
      this.syncRefinementStateToIndexCard(file, sourceRefinement.sourcePath, sourceRefinement.frontmatter);
    }
    const effectiveFile = refinementProjection
      ? {
          ...file,
          frontmatter: refinementProjection.effectiveFrontmatter,
          lifecycleStatus: typeof refinementProjection.effectiveFrontmatter.status === "string"
            ? refinementProjection.effectiveFrontmatter.status
            : file.lifecycleStatus,
        }
      : file;
    const displayTitle = this.inspirationDisplayTitle(effectiveFile);
    const passiveRadarSignal = isScheduledWatcherCapture(file.frontmatter)
      && !hasExplicitInspirationOptIn(file.frontmatter);
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `打开卡片：${displayTitle}`);
    const area = this.inspirationArea(effectiveFile);
    const status = passiveRadarSignal
      ? { label: "高价值信号", className: "is-synced" }
      : this.inspirationStatus(effectiveFile);
    const freshness = this.inspirationFreshness(effectiveFile);
    const decision = buildInspirationDecision(effectiveFile.frontmatter, passiveRadarSignal, freshness.label);
    const refinementStatus = this.frontmatterText(effectiveFile, "refinement_status");
    const legacyLifecycleStatus = this.frontmatterText(effectiveFile, "status");
    const lifecycleStatus = legacyLifecycleStatus === "archived"
      ? "archived"
      : ["refined", "refining", "failed", "blocked", "interrupted"].includes(refinementStatus)
        ? refinementStatus
        : legacyLifecycleStatus;
    const refinementFailed = ["failed", "blocked", "interrupted"].includes(lifecycleStatus);
    const refinementError = this.frontmatterText(effectiveFile, "refinement_error");
    const media = this.inspirationMedia(effectiveFile);

    const header = card.createDiv({ cls: "aos-inspiration-card-header" });
    const icon = header.createSpan({ cls: "aos-inspiration-card-icon" });
    setIcon(icon, area.icon);
    header.createSpan({ cls: "aos-inspiration-card-area", text: area.label });
    header.createSpan({ cls: `aos-inspiration-card-status ${status.className}`, text: status.label });
    if (this.frontmatterText(effectiveFile, "sync_status") === "synced") {
      header.createSpan({ cls: "aos-inspiration-card-status is-synced", text: "已同步" });
    } else if (this.frontmatterText(effectiveFile, "sync_status") === "pending_confirmation") {
      header.createSpan({ cls: "aos-inspiration-card-status is-captured", text: "同步未确认" });
    }

    if (media.refs.length > 0) {
      card.addClass("has-media");
      const mediaBlock = card.createDiv({ cls: "aos-inspiration-card-media" });
      const placeholder = mediaBlock.createDiv({ cls: "aos-inspiration-card-media-placeholder" });
      const placeholderIcon = placeholder.createSpan({ cls: "aos-inspiration-card-media-placeholder-icon" });
      setIcon(placeholderIcon, "image");
      placeholder.createSpan({ text: media.cover ? "媒体已捕获" : "媒体字段已记录" });
      let cover = media.cover;
      let previewSrc = cover ? this.resolveInspirationMediaSrc(file, cover) : null;
      // If a stale/relative frontmatter cover cannot be resolved, fall back to
      // the first indexed body embed instead of hiding a valid image that is
      // visibly present in the source note.
      if (!previewSrc) {
        const fallback = media.refs
          .map(ref => ({ ref, src: this.resolveInspirationMediaSrc(file, ref) }))
          .find(item => Boolean(item.src));
        cover = fallback?.ref ?? null;
        previewSrc = fallback?.src ?? null;
      }
      if (cover && previewSrc) {
        const image = mediaBlock.createEl("img", {
          cls: "aos-inspiration-card-media-image",
          attr: { alt: cover.alt || `${displayTitle} 媒体预览`, loading: "lazy", decoding: "async" },
        });
        image.src = previewSrc;
        image.addEventListener("load", () => placeholder.remove());
        image.addEventListener("error", () => {
          image.remove();
          mediaBlock.addClass("is-missing");
        });
      } else {
        mediaBlock.addClass("is-missing");
      }
      const mediaBadge = mediaBlock.createSpan({
        cls: "aos-inspiration-card-media-badge",
        text: media.refs.length > 1 ? `图集 · ${media.refs.length} 张` : "单张媒体",
      });
      mediaBadge.setAttribute("aria-label", `${media.refs.length} 个媒体引用`);
    }

    // Keep media and content as separate layout regions. A late-loading image
    // must never be able to push over the title, summary, or action row.
    const content = card.createDiv({ cls: "aos-inspiration-card-content" });
    content.createDiv({ cls: "aos-inspiration-card-title", text: displayTitle });
    content.createDiv({ cls: "aos-inspiration-card-summary", text: this.inspirationSummary(effectiveFile) });

    const decisionBand = content.createDiv({ cls: `aos-inspiration-decision is-${decision.level}` });
    decisionBand.tabIndex = 0;
    decisionBand.setAttribute("role", "button");
    decisionBand.setAttribute(
      "aria-label",
      `打开「${displayTitle}」并在 Copilot 中查看当前笔记上下文`,
    );
    decisionBand.setAttribute("title", "打开来源笔记和 Copilot；不会自动发送模型请求");
    const decisionHeading = decisionBand.createDiv({ cls: "aos-inspiration-decision-heading" });
    decisionHeading.createSpan({ cls: "aos-inspiration-value-badge", text: decision.scoreLabel });
    decisionHeading.createSpan({
      cls: `aos-inspiration-decision-freshness ${freshness.className}`,
      text: decision.freshness,
    });
    const reasonLine = decisionBand.createDiv({ cls: "aos-inspiration-decision-line" });
    reasonLine.createSpan({ cls: "aos-inspiration-decision-label", text: `${decision.reasonLabel}：` });
    reasonLine.createSpan({ cls: "aos-inspiration-decision-text", text: decision.reason });
    const nextLine = decisionBand.createDiv({ cls: "aos-inspiration-decision-line is-next" });
    nextLine.createSpan({ cls: "aos-inspiration-decision-label", text: "建议：" });
    nextLine.createSpan({ cls: "aos-inspiration-decision-text", text: decision.nextAction });

    const openDecisionContext = (): void => {
      void this.openGlobalAgentDock(undefined, file).catch(error => {
        new Notice(`打开来源笔记与 Copilot 失败：${error instanceof Error ? error.message : String(error)}`);
      });
    };
    decisionBand.addEventListener("click", event => {
      event.stopPropagation();
      openDecisionContext();
    });
    decisionBand.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      openDecisionContext();
    });

    const meta = content.createDiv({ cls: "aos-inspiration-card-meta" });
    meta.createSpan({ text: this.inboxSource(file).label });
    meta.createSpan({ text: " · " });
    meta.createSpan({ text: this.inspirationDate(file) });

    const actions = content.createDiv({ cls: "aos-inspiration-card-actions" });
    const primaryActions = actions.createDiv({ cls: "aos-inspiration-card-primary-actions" });
    const deepen = primaryActions.createEl("button", {
      cls: "aos-inspiration-card-action is-primary",
      attr: {
        type: "button",
        title: lifecycleStatus === "refining"
          ? "整理任务正在执行"
          : refinementFailed
          ? `${refinementError || "上一轮整理未完成"}；点击重新提交`
          : "提交权威整理任务，生成正式笔记草稿、归类建议与下一步",
        "aria-label": lifecycleStatus === "refining" ? "灵感卡正在整理" : refinementFailed ? "重新整理这张灵感卡" : "整理这张灵感卡",
      },
    });
    this.appendInspirationActionContent(deepen, lifecycleStatus === "refining" ? "整理中" : refinementFailed ? "重试整理" : "整理", "sparkles");
    deepen.disabled = lifecycleStatus === "refining";
    if (lifecycleStatus !== "refining") {
      deepen.addEventListener("click", async event => {
        event.stopPropagation();
        deepen.disabled = true;
        deepen.addClass("is-loading");
        const label = deepen.querySelector<HTMLElement>(".aos-inspiration-button-label");
        if (label) label.textContent = "排队中";
        const submitted = await this.submitInspirationRefinement(file);
        if (!submitted && deepen.isConnected) {
          deepen.disabled = false;
          deepen.removeClass("is-loading");
          if (label) label.textContent = "整理";
        }
      });
    }
    const schedule = primaryActions.createEl("button", {
      cls: "aos-inspiration-card-action",
      attr: { type: "button", title: "以当前卡片为来源创建日程项", "aria-label": "将灵感卡排入日程" },
    });
    this.appendInspirationActionContent(schedule, "排入日程", "calendar-plus");
    schedule.addEventListener("click", event => {
      event.stopPropagation();
      void this.plugin.planLedger.refreshTodaySnapshot()
        .then(snapshot => this.openScheduleCreateModal({ title: displayTitle, date: snapshot.date, scheduled: false, sourceNotePath: file.path }))
        .catch(error => new Notice(`打开日程失败：${error instanceof Error ? error.message : String(error)}`));
    });
    const more = actions.createEl("details", { cls: "aos-inspiration-card-more" });
    more.setAttribute("aria-label", "灵感卡更多操作");
    const moreSummary = more.createEl("summary", {
      cls: "aos-inspiration-card-action aos-inspiration-card-more-toggle",
      attr: { title: "展开立项、状态和原帖操作", "aria-label": "展开灵感卡更多操作" },
    });
    this.appendInspirationActionContent(moreSummary, "更多", "more-horizontal");
    const secondaryActions = more.createDiv({ cls: "aos-inspiration-card-secondary-actions" });
    more.addEventListener("click", event => event.stopPropagation());

    const promote = secondaryActions.createEl("button", {
      cls: "aos-inspiration-card-action is-primary",
      attr: { type: "button", title: "打开来源笔记，准备进入对应工作台", "aria-label": "从灵感卡立项" },
    });
    this.appendInspirationActionContent(promote, "立项", "folder");
    promote.addEventListener("click", event => {
      event.stopPropagation();
      void this.openNode(file).then(() => new Notice(`已打开「${displayTitle}」，可以继续说“立项”`));
    });
    const discuss = secondaryActions.createEl("button", {
      cls: "aos-inspiration-card-action",
      attr: { type: "button", title: "只在 Copilot 中讨论，不提交第二个整理任务", "aria-label": "在 Copilot 中讨论" },
    });
    this.appendInspirationActionContent(discuss, "讨论", "message-circle");
    discuss.addEventListener("click", event => {
      event.stopPropagation();
      void this.openGlobalAgentDock(this.buildInspirationPrompt(file), file).then(sent => {
        new Notice(
          sent
            ? `已把「${displayTitle}」交给 Copilot 讨论；未重复提交整理任务`
            : `已打开「${displayTitle}」；请在 Copilot 侧栏继续讨论`,
          4500,
        );
      });
    });
    if (passiveRadarSignal) {
      const register = secondaryActions.createEl("button", {
        cls: "aos-inspiration-card-action is-primary",
        attr: { type: "button", title: "把这条高价值情报正式登记为灵感卡", "aria-label": "登记为灵感卡" },
      });
      this.appendInspirationActionContent(register, "挂入灵感", "lightbulb");
      register.addEventListener("click", event => {
        event.stopPropagation();
        void this.promoteInboxCandidate(file);
      });
      const dismiss = secondaryActions.createEl("button", {
        cls: "aos-inspiration-card-action",
        attr: { type: "button", title: "保留原始情报，但不再显示在高价值雷达轨", "aria-label": "忽略这条雷达信号" },
      });
      this.appendInspirationActionContent(dismiss, "忽略", "archive");
      dismiss.addEventListener("click", event => {
        event.stopPropagation();
        void this.updateInspirationStatus(file, "archived");
      });
    } else if (lifecycleStatus === "archived") {
      const restore = secondaryActions.createEl("button", {
        cls: "aos-inspiration-card-action",
        attr: { type: "button", title: "将灵感卡恢复到待整理轨", "aria-label": "恢复灵感卡" },
      });
      this.appendInspirationActionContent(restore, "恢复", "rotate-ccw");
      restore.addEventListener("click", event => {
        event.stopPropagation();
        void this.updateInspirationStatus(file, "candidate");
      });
    } else {
      const derivedNotePath = this.frontmatterText(effectiveFile, "derived_note_path").trim();
      if (derivedNotePath) {
        const openDraft = secondaryActions.createEl("button", {
          cls: "aos-inspiration-card-action is-primary",
          attr: { type: "button", title: "打开整理任务产出的正式笔记草稿", "aria-label": "查看整理成稿" },
        });
        this.appendInspirationActionContent(openDraft, "查看成稿", "file-check");
        openDraft.addEventListener("click", event => {
          event.stopPropagation();
          this.openFileByPath(derivedNotePath);
        });
      }
      const archive = secondaryActions.createEl("button", {
        cls: "aos-inspiration-card-action",
        attr: { type: "button", title: "保留原笔记，但从默认灵感轨和日程候选池移除", "aria-label": "归档灵感卡" },
      });
      this.appendInspirationActionContent(archive, "归档", "archive");
      archive.addEventListener("click", event => {
        event.stopPropagation();
        void this.updateInspirationStatus(file, "archived");
      });
    }
    const recycle = secondaryActions.createEl("button", {
      cls: "aos-inspiration-card-action is-danger",
      attr: {
        type: "button",
        title: "移入工作台回收站；保留双链与附件，可在回收站恢复",
        "aria-label": "将灵感卡移入工作台回收站",
      },
    });
    this.appendInspirationActionContent(recycle, "回收站", "trash-2");
    recycle.addEventListener("click", event => {
      event.stopPropagation();
      this.openInspirationRecycleModal(file);
    });
    const sourceUrl = this.inspirationSourceUrl(file);
    if (sourceUrl) {
      const sourceLink = secondaryActions.createEl("a", {
        cls: "aos-inspiration-card-action",
        attr: { title: "打开已记录的来源链接；不会触发新的采集任务", "aria-label": "打开原帖" },
      });
      this.appendInspirationActionContent(sourceLink, "原帖", "external-link");
      sourceLink.href = sourceUrl;
      sourceLink.target = "_blank";
      sourceLink.rel = "noopener noreferrer";
      sourceLink.addEventListener("click", event => event.stopPropagation());
      sourceLink.addEventListener("keydown", event => event.stopPropagation());
    }

    const open = (): void => void this.openNode(file);
    card.addEventListener("click", event => {
      if ((event.target as Element | null)?.closest("button, a")) return;
      open();
    });
    card.addEventListener("keydown", event => {
      if ((event.target as Element | null)?.closest("button, a")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  }

  private renderInspirationRails(parent: HTMLDivElement, files: KnowledgeNodeViewModel[]): void {
    const railHeader = parent.createDiv({ cls: "aos-inspiration-rails-heading" });
    railHeader.createDiv({ cls: "aos-panel-title", text: "灵感轨 · Inspiration Rails" });
    railHeader.createDiv({ cls: "aos-panel-note", text: "主动采集先进入对应内容轨；后台监控只有通过高价值门才投影到信息雷达轨，并且不计入灵感总数。鼠标靠近两端即可滑动。" });
    const railGrid = parent.createDiv({ cls: "aos-inspiration-rails" });
    const buckets = [
      { id: "knowledge", label: "知识轨", icon: "book-open" },
      { id: "life", label: "生活轨", icon: "leaf" },
      { id: "project", label: "项目轨", icon: "layers" },
      { id: "radar", label: "信息雷达轨", icon: "radar" },
      { id: "inbox", label: "待分区轨", icon: "inbox" },
    ];
    for (const bucket of buckets) {
      const bucketFiles = files.filter(file => this.inspirationArea(file).id === bucket.id);
      const rail = railGrid.createDiv({ cls: "aos-inspiration-rail" });
      const heading = rail.createDiv({ cls: "aos-inspiration-rail-heading" });
      const headingIcon = heading.createSpan({ cls: "aos-inspiration-rail-icon" });
      setIcon(headingIcon, bucket.icon);
      heading.createSpan({ cls: "aos-inspiration-rail-title", text: bucket.label });
      heading.createSpan({ cls: "aos-inspiration-rail-count", text: `${bucketFiles.length} 张` });
      const scroller = rail.createDiv({ cls: "aos-inspiration-rail-scroller" });
      const track = scroller.createDiv({ cls: "aos-inspiration-rail-track" });
      if (bucketFiles.length === 0) {
        track.createDiv({ cls: "aos-inspiration-rail-empty", text: "暂无卡片 · 等待新的灵感进入" });
      } else {
        bucketFiles.sort((a, b) => this.inspirationCapturedTime(b) - this.inspirationCapturedTime(a)).forEach(file => this.renderInspirationCard(track, file));
      }
      this.attachInspirationRailAutoScroll(scroller);
    }
  }

  private renderRecentInspirations(parent: HTMLElement, limit: number): void {
    const files = this.dedupeInspirationFiles(this.getInspirationFiles()).slice(0, limit);
    if (files.length === 0) {
      parent.createDiv({ cls: "aos-empty-state", text: "灵感轨还没有已挂卡片。微信想法或平台素材挂卡后会出现在这里。" });
      return;
    }
    const list = parent.createDiv({ cls: "aos-inspiration-mini-list" });
    for (const file of files) {
      const row = list.createEl("button", { cls: "aos-inspiration-mini-row" });
      row.createSpan({ cls: "aos-inspiration-mini-title", text: file.title });
      row.createSpan({ cls: "aos-inspiration-mini-date", text: this.inspirationDate(file) });
      row.addEventListener("click", () => void this.openNode(file));
    }
  }

  private renderInspiration(): void {
    const page = this.mainPane.createDiv({ cls: "aos-page aos-inspiration-page" });
    if (this.inspirationRecycleOpen) {
      this.renderInspirationRecycleBinPage(page);
      return;
    }
    const heading = page.createDiv({ cls: "aos-page-heading" });
    const headingText = heading.createDiv();
    headingText.createDiv({ cls: "aos-page-title", text: "灵感区 Inspiration" });
    headingText.createDiv({ cls: "aos-page-subtitle", text: "微信想法与各平台采集卷宗的统一灵感索引" });
    const actions = heading.createDiv({ cls: "aos-page-heading-actions" });
    const refresh = this.createWorkbenchActionButton(actions, "刷新", "refresh-cw", "is-quiet", "重新读取灵感轨");
    refresh.addEventListener("click", () => this.renderMain());
    const openInbox = this.createWorkbenchActionButton(actions, "打开收件箱", "inbox", "is-quiet", "打开收件箱目录");
    openInbox.addEventListener("click", () => this.selectFolder(INBOX_ROOT_PATH));

    const files = this.getInspirationFiles(true);
    const recycleFiles = this.getInspirationRecycleFiles();
    const openRecycleBin = this.createWorkbenchActionButton(
      actions,
      `回收站 (${recycleFiles.length})`,
      "trash-2",
      "is-quiet",
      "查看、恢复或彻底删除已回收的灵感笔记",
    );
    openRecycleBin.addEventListener("click", () => this.openInspirationRecycleBin());
    const candidates = this.getInboxCaptureCandidates();
    const railFiles = this.getRailFiles();
    const activeFiles = this.dedupeInspirationFiles(this.getInspirationFiles());
    const pending = activeFiles.filter(file => this.inspirationStatus(file).className === "is-pending").length;
    const archived = files.filter(file => this.frontmatterText(file, "status") === "archived"
      || this.frontmatterText(file, "review_state") === "historical").length;
    const evidenceCount = files.filter(file => file.frontmatter.record_role === "evidence").length;
    const independentCount = this.dedupeInspirationFiles(files.filter(file => file.frontmatter.record_role !== "evidence")).length;
    const stats = page.createDiv({ cls: "aos-inspiration-stats" });
    this.metric(stats, "独立想法", `${independentCount}`, "按来源身份去重，包含历史记录");
    this.metric(stats, "待处理", `${pending}`, pending ? "整理、落实或复核" : "当前没有待处理项");
    this.metric(stats, "历史与归档", `${archived}`, "保留原文，可在时间归档回看");
    this.metric(stats, "来源证据", `${evidenceCount}`, "同源旧稿保留，不重复占用卡片");
    this.metric(stats, "待挂灵感", `${candidates.length}`, candidates.length ? "主动采集候选" : "暂无候选素材");

    const panel = page.createDiv({ cls: "aos-panel aos-inspiration-panel" });
    panel.createDiv({ cls: "aos-panel-note", text: `数据源：${INBOX_ROOT_PATH}/ · 内容归属由 area/分流建议决定，平台只表示来源；后台定时监控仅在评为高价值后显示于信息雷达轨，明确挂卡后才进入灵感生命周期。` });
    if (railFiles.length === 0) {
      panel.createDiv({ cls: "aos-empty-state", text: "灵感轨暂无内容；发送链接、微信想法或手动采集后会出现待整理卡片。" });
    } else {
      this.renderInspirationRails(panel, railFiles);
    }
    if (files.length > 0) {
      const archiveHeading = panel.createDiv({ cls: "aos-inspiration-archive-heading" });
      archiveHeading.createDiv({ cls: "aos-panel-title", text: "时间归档" });
      archiveHeading.createDiv({ cls: "aos-panel-note", text: "保留原有按月份浏览方式，方便从灵感轨回看完整收件箱。" });

      const groups = new Map<string, KnowledgeNodeViewModel[]>();
      for (const file of files) {
        const month = file.path.match(/(\d{4}-\d{2})\//)?.[1] ?? "未分组";
        const group = groups.get(month) ?? [];
        group.push(file);
        groups.set(month, group);
      }
      for (const [month, group] of groups) {
        const section = panel.createDiv({ cls: "aos-inspiration-month" });
        const sectionHeader = section.createDiv({ cls: "aos-inspiration-month-heading" });
        sectionHeader.createSpan({ cls: "aos-inspiration-month-title", text: month });
        sectionHeader.createSpan({ cls: "aos-inspiration-month-count", text: `${group.length} 条` });
        const list = section.createDiv({ cls: "aos-inspiration-list" });
        for (const file of group) {
          const row = list.createEl("button", { cls: "aos-inspiration-row" });
          const icon = row.createSpan({ cls: "aos-inspiration-row-icon" });
          setIcon(icon, this.inboxSource(file).icon);
          const content = row.createDiv({ cls: "aos-inspiration-row-content" });
          content.createDiv({ cls: "aos-inspiration-row-title", text: file.title });
          const meta = content.createDiv({ cls: "aos-inspiration-row-meta" });
          meta.createSpan({ text: `${this.inboxSource(file).label} · ${this.frontmatterText(file, "source") || "本地记录"}` });
          meta.createSpan({ text: " · " });
          meta.createSpan({ text: this.inspirationDate(file) });
          const mediaCount = this.inspirationMedia(file).refs.length;
          if (mediaCount > 0) meta.createSpan({ text: ` · 媒体 ${mediaCount}` });
          const tags = Array.isArray(file.frontmatter.tags) ? file.frontmatter.tags.filter(value => typeof value === "string").slice(0, 3) : [];
          if (tags.length) meta.createSpan({ text: ` · ${tags.join(" · ")}` });
          const status = this.inspirationStatus(file);
          const badge = row.createSpan({ cls: `aos-inspiration-status ${status.className}`, text: status.label });
          badge.setAttribute("aria-label", `状态：${status.label}`);
          row.addEventListener("click", () => void this.openNode(file));
        }
      }
    }
    this.renderInboxCandidatePanel(panel, candidates);
  }

  private openInspirationRecycleBin(): void {
    this.inspirationRecycleOpen = true;
    const activeModule = this.plugin.store.getSnapshot().activeModule;
    if (activeModule !== "inspiration") this.plugin.store.patch({ activeModule: "inspiration" });
    this.renderModeRail();
    this.renderMain();
    this.renderContext();
    this.plugin.logBus.append("info", "inspiration.recycle", "打开工作台回收站与归档浏览页");
    this.recordHistoryState(true);
  }

  private renderInspirationRecycleBinPage(page: HTMLDivElement): void {
    const recycleFiles = this.getInspirationRecycleFiles();
    const archivedFiles = this.getInspirationFiles(true)
      .filter(file => this.frontmatterText(file, "status") === "archived");
    const heading = page.createDiv({ cls: "aos-page-heading" });
    const headingText = heading.createDiv();
    headingText.createDiv({ cls: "aos-page-title", text: "回收站与归档" });
    headingText.createDiv({
      cls: "aos-page-subtitle",
      text: "回收站用于删除前恢复；归档仅隐藏于默认灵感轨，原笔记仍留在原路径。",
    });
    const actions = heading.createDiv({ cls: "aos-page-heading-actions" });
    const back = this.createWorkbenchActionButton(actions, "返回灵感区", "arrow-left", "is-quiet", "返回默认灵感轨");
    back.addEventListener("click", () => {
      this.inspirationRecycleOpen = false;
      this.renderModeRail();
      this.renderMain();
    });
    const refresh = this.createWorkbenchActionButton(actions, "刷新", "refresh-cw", "is-quiet", "重新读取回收站和归档状态");
    refresh.addEventListener("click", () => this.renderMain());

    const stats = page.createDiv({ cls: "aos-inspiration-stats" });
    this.metric(stats, "待恢复 / 待删", `${recycleFiles.length}`, recycleFiles.length ? "已实际移入工作台回收站" : "当前没有待删除笔记");
    this.metric(stats, "已归档", `${archivedFiles.length}`, archivedFiles.length ? "保留原文，可恢复到灵感轨" : "当前没有已归档灵感");

    const panel = page.createDiv({ cls: "aos-panel aos-inspiration-panel aos-inspiration-recycle-panel" });
    panel.createDiv({
      cls: "aos-panel-note",
      text: "不会自动把归档笔记移进回收站，也不会改写双链。归档和回收站是两条不同、可逆的生命周期。",
    });
    this.renderRecycleBinSection(panel, "待恢复 / 彻底删除", "trash-2", recycleFiles, file => {
      const actions = [
        { label: "打开", icon: "external-link", run: () => void this.openNode(file) },
        { label: "恢复", icon: "rotate-ccw", run: () => void this.restoreInspirationFromRecycleBin(file) },
        { label: "彻底删除", icon: "trash", danger: true, run: () => this.openPermanentDeleteModal(file) },
      ];
      return actions;
    }, "回收站为空：只有点击“回收站”操作后真正移入的灵感笔记会出现在这里。");
    this.renderRecycleBinSection(panel, "已归档灵感", "archive", archivedFiles, file => {
      const actions = [
        { label: "打开", icon: "external-link", run: () => void this.openNode(file) },
        { label: "恢复灵感", icon: "rotate-ccw", run: () => void this.updateInspirationStatus(file, "candidate") },
      ];
      return actions;
    }, "暂无已归档灵感。");
  }

  private renderRecycleBinSection(
    parent: HTMLElement,
    title: string,
    iconName: string,
    files: KnowledgeNodeViewModel[],
    buildActions: (file: KnowledgeNodeViewModel) => Array<{ label: string; icon: string; danger?: boolean; run: () => void }>,
    emptyText: string,
  ): void {
    const section = parent.createDiv({ cls: "aos-inspiration-recycle-section" });
    const heading = section.createDiv({ cls: "aos-inspiration-recycle-heading" });
    const icon = heading.createSpan({ cls: "aos-inspiration-recycle-heading-icon" });
    setIcon(icon, iconName);
    heading.createSpan({ cls: "aos-panel-title", text: title });
    heading.createSpan({ cls: "aos-inspiration-month-count", text: `${files.length} 条` });
    if (!files.length) {
      section.createDiv({ cls: "aos-empty-state", text: emptyText });
      return;
    }
    const list = section.createDiv({ cls: "aos-inspiration-list" });
    for (const file of files) {
      const row = list.createDiv({ cls: "aos-inspiration-row aos-inspiration-recycle-row" });
      const icon = row.createSpan({ cls: "aos-inspiration-row-icon" });
      setIcon(icon, this.inboxSource(file).icon);
      const content = row.createDiv({ cls: "aos-inspiration-row-content" });
      content.createDiv({ cls: "aos-inspiration-row-title", text: file.title });
      const meta = content.createDiv({ cls: "aos-inspiration-row-meta" });
      meta.createSpan({ text: file.path });
      meta.createSpan({ text: " · " });
      meta.createSpan({ text: this.inspirationDate(file) });
      const actions = row.createDiv({ cls: "aos-inspiration-recycle-actions" });
      for (const action of buildActions(file)) {
        const button = this.createWorkbenchActionButton(actions, action.label, action.icon, action.danger ? "is-danger" : "is-quiet");
        button.addEventListener("click", action.run);
      }
    }
  }

  private renderInboxCandidatePanel(parent: HTMLDivElement, candidates: KnowledgeNodeViewModel[]): void {
    const section = parent.createDiv({ cls: "aos-inspiration-candidate-panel" });
    const heading = section.createDiv({ cls: "aos-inspiration-candidate-heading" });
    const headingText = heading.createDiv();
    headingText.createDiv({ cls: "aos-panel-title", text: "来源候选池 · Inbox Candidates" });
    headingText.createDiv({ cls: "aos-panel-note", text: "主动采集的原始卷宗留在原地并进入候选池；后台监控原文全部保留，只有高价值信号进入雷达轨，明确挂卡后才进入正式日程候选池。" });

    const counts = new Map<string, { label: string; count: number }>();
    for (const file of candidates) {
      const source = this.inboxSource(file);
      const current = counts.get(source.id) ?? { label: source.label, count: 0 };
      current.count += 1;
      counts.set(source.id, current);
    }
    const sourceSummary = section.createDiv({ cls: "aos-inspiration-source-summary" });
    if (counts.size === 0) {
      sourceSummary.createSpan({ cls: "aos-inspiration-source-empty", text: "暂无未挂卡的平台素材" });
      return;
    }
    for (const item of counts.values()) {
      sourceSummary.createSpan({ cls: "aos-inspiration-source-chip", text: `${item.label} ${item.count}` });
    }

    const list = section.createDiv({ cls: "aos-inspiration-candidate-list" });
    for (const file of candidates.slice(0, 12)) {
      const source = this.inboxSource(file);
      const row = list.createDiv({ cls: "aos-inspiration-candidate-row" });
      const icon = row.createSpan({ cls: "aos-inspiration-candidate-icon" });
      setIcon(icon, source.icon);
      const content = row.createDiv({ cls: "aos-inspiration-candidate-content" });
      content.createDiv({ cls: "aos-inspiration-candidate-title", text: file.title });
      content.createDiv({ cls: "aos-inspiration-candidate-meta", text: `${source.label} · ${this.inspirationArea(file).label} · ${this.inspirationDate(file)}` });
      const actions = row.createDiv({ cls: "aos-inspiration-candidate-actions" });
      const open = actions.createEl("button", { cls: "aos-compact-button", text: "查看" });
      open.addEventListener("click", event => {
        event.stopPropagation();
        void this.openNode(file);
      });
      const promote = actions.createEl("button", { cls: "aos-compact-button mod-cta", text: "登记正式卡" });
      promote.addEventListener("click", event => {
        event.stopPropagation();
        promote.disabled = true;
        promote.textContent = "挂入中…";
        void this.promoteInboxCandidate(file).finally(() => {
          if (promote.isConnected) {
            promote.disabled = false;
            promote.textContent = "已登记";
          }
        });
      });
    }
    if (candidates.length > 12) {
      section.createDiv({ cls: "aos-panel-note aos-inspiration-candidate-more", text: `还有 ${candidates.length - 12} 条候选素材；可按来源目录打开收件箱继续挑选。` });
    }
  }

  private renderKnowledgeAtlas(): void {
    this.currentRenderId += 1;
    this.disposeInboxGraphRuntime();
    this.disposeNativeGraphView();
    if (this.canvasGraph) {
      this.canvasGraph.destroy();
      this.canvasGraph = null;
    }
    this.mainPane.empty();

    const state = this.plugin.store.getSnapshot();
    const folderPath = state.selectedFolderPath || this.getWorkspace()?.rootPaths[0] || "";

    const page = this.mainPane.createDiv({ cls: "aos-page aos-atlas-page" });
    const stream = page.createDiv({ cls: "aos-atlas-stream" });
    this.renderAtlasNoteStream(stream, folderPath);

    const graph = page.createDiv({ cls: "aos-atlas-graph" });
    this.renderAtlasCanvasGraph(graph, folderPath);
  }

  private renderAtlasNoteStream(parent: HTMLElement, folderPath: string): void {
    const state = this.plugin.store.getSnapshot();
    
    // Header & Clickable Breadcrumbs
    const header = parent.createDiv({ cls: "aos-atlas-stream-header" });
    const breadcrumb = header.createDiv({ cls: "aos-atlas-breadcrumb" });
    const parts = folderPath.split("/").filter(Boolean);
    let accum = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accum = accum ? `${accum}/${part}` : part;
      const targetPath = accum;
      const isLast = i === parts.length - 1;
      
      const crumb = breadcrumb.createEl("button", {
        cls: `aos-crumb-btn ${isLast ? "is-current" : ""}`,
        text: part,
      });
      crumb.addEventListener("click", () => this.selectFolder(targetPath));
      if (!isLast) {
        breadcrumb.createSpan({ cls: "aos-crumb-sep", text: "›" });
      }
    }

    const countBadge = header.createSpan({ cls: "aos-atlas-count-badge" });

    // Search and Action bar
    const searchBar = parent.createDiv({ cls: "aos-atlas-search-bar" });
    const searchInput = searchBar.createEl("input", {
      cls: "aos-atlas-search-input",
      attr: { placeholder: "搜索过滤当前笔记…" },
    });
    searchInput.value = this.atlasFilterQuery || "";

    const addNoteBtn = searchBar.createEl("button", {
      cls: "aos-icon-button aos-atlas-add-btn",
      attr: { title: "在此目录新建笔记" },
    });
    setIcon(addNoteBtn, "file-plus-2");
    addNoteBtn.addEventListener("click", () => void this.openNoteEditorModal());

    // Note List Viewport
    const listContainer = parent.createDiv({ cls: "aos-atlas-note-list" });

    const renderList = (filter = "") => {
      listContainer.empty();
      let allNotes = this.plugin.indexService.listFiles(folderPath);
      if (filter.trim()) {
        const needle = filter.trim().toLowerCase();
        allNotes = allNotes.filter(n =>
          n.title.toLowerCase().includes(needle) ||
          n.path.toLowerCase().includes(needle) ||
          n.tags.some(t => t.toLowerCase().includes(needle))
        );
      }

      countBadge.textContent = `${allNotes.length} 篇`;

      if (allNotes.length === 0) {
        listContainer.createDiv({ cls: "aos-empty-hint", text: "当前目录暂无笔记" });
        return;
      }

      for (const node of allNotes) {
        const isSelected = (this.selectedNode?.path === node.path) || (state.selectedFilePath === node.path);
        const card = listContainer.createDiv({ cls: `aos-atlas-note-card ${isSelected ? "is-selected" : ""}` });
        
        // Icon
        const iconSpan = card.createSpan({ cls: `aos-atlas-card-icon is-${node.kind}` });
        setIcon(iconSpan, node.kind === "project" ? "folder" : "file-text");

        // Primary info
        const body = card.createDiv({ cls: "aos-atlas-card-body" });
        const titleRow = body.createDiv({ cls: "aos-atlas-card-title-row" });
        titleRow.createSpan({ cls: "aos-atlas-card-title", text: node.title });

        const metaRow = body.createDiv({ cls: "aos-atlas-card-meta-row" });
        metaRow.createSpan({ cls: "aos-atlas-card-date", text: this.formatAtlasDate(node.mtime) });
        if (node.relationCount > 0) {
          metaRow.createSpan({ cls: "aos-atlas-card-relations", text: `🔗 ${node.relationCount}` });
        }
        if (node.tags && node.tags.length > 0) {
          for (const t of node.tags.slice(0, 2)) {
            metaRow.createSpan({ cls: "aos-atlas-card-tag", text: `#${t}` });
          }
        }

        card.addEventListener("click", () => {
          this.selectNode(node);
          if (this.atlasGraphEngine === "canvas") {
            this.canvasGraph?.setSelectedNode(node.path);
          } else if (this.atlasGraphEngine === "native" && this.nativeGraphView) {
            if (this.atlasGraphScope === "current-file") {
              const tFile = this.app.vault.getAbstractFileByPath(node.path);
              if (tFile instanceof TFile) {
                CompatAdapter.safeSetGraphFile(this.nativeGraphView, tFile);
              }
            }
          }
          listContainer.querySelectorAll(".aos-atlas-note-card").forEach(el => el.classList.remove("is-selected"));
          card.classList.add("is-selected");
        });

        card.addEventListener("dblclick", () => {
          void this.openNode(node);
        });

        card.addEventListener("contextmenu", event => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          menu.addItem(item => {
            item.setTitle("在编辑器中打开")
              .setIcon("file-edit")
              .onClick(() => void this.openNode(node));
          });
          menu.addItem(item => {
            item.setTitle(this.plugin.store.getSnapshot().favoritePaths.includes(node.path) ? "★ 取消收藏" : "☆ 收藏笔记")
              .setIcon("star")
              .onClick(() => this.toggleFavorite(node.path));
          });
          menu.showAtPosition({ x: event.clientX, y: event.clientY });
        });
      }
    };

    searchInput.addEventListener("input", () => {
      this.atlasFilterQuery = searchInput.value;
      renderList(searchInput.value);
    });

    renderList(this.atlasFilterQuery || "");
  }

  private formatAtlasDate(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();
    const month = d.getMonth() + 1;
    const date = d.getDate();
    return isThisYear ? `${month}/${date}` : `${d.getFullYear()}/${month}/${date}`;
  }

  private renderAtlasCanvasGraph(parent: HTMLElement, folderPath: string): void {
    parent.empty();
    const state = this.plugin.store.getSnapshot();
    const folderName = folderPath.split("/").pop() || folderPath;

    // Scoped graph data using our fixed VaultIndexService
    const rawData = this.plugin.indexService.getGraphData(
      state.selectedFilePath,
      "current-folder",
      this.getWorkspace(),
      folderPath,
      64,
    );

    // Graph Toolbar
    const toolbar = parent.createDiv({ cls: "aos-atlas-graph-toolbar" });
    const info = toolbar.createDiv({ cls: "aos-atlas-graph-info" });
    const folderIcon = info.createSpan({ cls: "aos-atlas-folder-icon" });
    setIcon(folderIcon, "git-fork");
    info.createSpan({ cls: "aos-atlas-folder-title", text: `局部关系图谱 · ${folderName}` });

    const tools = toolbar.createDiv({ cls: "aos-atlas-graph-tools" });

    // Mode Toggle: Native vs Canvas
    const nativeBtn = tools.createEl("button", {
      cls: `aos-graph-native-btn ${this.atlasGraphEngine === "native" ? "is-active" : ""}`,
      text: "✦ 原生图谱",
    });
    this.decorateGraphButton(nativeBtn, "git-branch");
    nativeBtn.addEventListener("click", () => {
      if (this.atlasGraphEngine === "native") return;
      this.atlasGraphEngine = "native";
      this.renderAtlasCanvasGraph(parent, folderPath);
    });

    const canvasBtn = tools.createEl("button", {
      cls: `aos-graph-native-btn ${this.atlasGraphEngine === "canvas" ? "is-active" : ""}`,
      text: "⚡ 轻量图谱",
    });
    this.decorateGraphButton(canvasBtn, "zap");
    canvasBtn.addEventListener("click", () => {
      if (this.atlasGraphEngine === "canvas") return;
      this.atlasGraphEngine = "canvas";
      this.renderAtlasCanvasGraph(parent, folderPath);
    });

    // Engine-specific tools
    if (this.atlasGraphEngine === "canvas") {
      const resetBtn = tools.createEl("button", { cls: "aos-graph-native-btn", text: "居中复位" });
      this.decorateGraphButton(resetBtn, "maximize-2");
      resetBtn.addEventListener("click", () => this.canvasGraph?.resetView());

      const relayoutBtn = tools.createEl("button", { cls: "aos-graph-native-btn", text: "重新布局" });
      this.decorateGraphButton(relayoutBtn, "refresh-cw");
      relayoutBtn.addEventListener("click", () => this.canvasGraph?.restartLayout());
    } else {
      // In native mode: Scope toggle (folder vs local file)
      if (state.selectedFilePath) {
        const isFileScope = this.atlasGraphScope === "current-file";
        const scopeToggleBtn = tools.createEl("button", {
          cls: `aos-graph-native-btn ${isFileScope ? "is-active" : ""}`,
          text: isFileScope ? "📁 目录图谱" : "🔍 焦点单篇",
        });
        this.decorateGraphButton(scopeToggleBtn, isFileScope ? "folder" : "focus");
        scopeToggleBtn.addEventListener("click", () => {
          this.atlasGraphScope = isFileScope ? "current-folder" : "current-file";
          this.renderAtlasCanvasGraph(parent, folderPath);
        });
      }
    }

    // Stats indicator
    const stats = toolbar.createDiv({ cls: "aos-atlas-graph-stats" });
    stats.textContent = `${rawData.nodes.length} 节点 · ${rawData.edges.length} 关联`;

    // Canvas Host
    const canvasHost = parent.createDiv({ cls: "aos-atlas-canvas-host" });

    if (this.atlasGraphEngine === "native") {
      if (this.canvasGraph) {
        this.canvasGraph.destroy();
        this.canvasGraph = null;
      }
      const seedPath = (state.selectedFilePath && rawData.nodes.some(n => n.path === state.selectedFilePath))
        ? state.selectedFilePath
        : (rawData.nodes[0]?.path || "");

      void this.mountNativeGraph(canvasHost, seedPath, rawData, this.atlasGraphScope, []);
    } else {
      this.disposeNativeGraphView();

      const graphData: CanvasLocalGraphData = {
        nodes: rawData.nodes,
        edges: rawData.edges,
        folderName,
      };

      this.canvasGraph = new CanvasLocalGraph(canvasHost, {
        onSelectNode: (path) => {
          const node = this.toNode(path);
          if (node) {
            this.selectNode(node);
            const streamList = this.mainPane.querySelector(".aos-atlas-note-list");
            if (streamList) {
              streamList.querySelectorAll(".aos-atlas-note-card").forEach(c => {
                const match = c.querySelector(".aos-atlas-card-title")?.textContent === node.title;
                c.classList.toggle("is-selected", match);
                if (match) c.scrollIntoView({ behavior: "smooth", block: "nearest" });
              });
            }
          }
        },
        onOpenNode: (path) => {
          const node = this.toNode(path);
          if (node) void this.openNode(node);
        },
      });

      this.canvasGraph.setData(graphData, state.selectedFilePath);
    }
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

    const toolbarActions = toolbar.createDiv({ cls: "aos-file-toolbar-actions" });
    const createNote = this.createWorkbenchActionButton(toolbarActions, "新建笔记", "file-plus-2", "is-primary", "在当前目录新建 Markdown 笔记");
    createNote.addEventListener("click", () => void this.openNoteEditorModal());

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

  private async openNoteEditorModal(node?: KnowledgeNodeViewModel): Promise<void> {
    if (node && node.extension.toLowerCase() !== "md") {
      new Notice("当前节点不是 Markdown 笔记，暂不提供全文编辑。");
      return;
    }
    const state = this.plugin.store.getSnapshot();
    const defaultFolder = node?.parentPath || state.selectedFolderPath || this.getWorkspace()?.rootPaths[0] || "";
    const defaultPath = node?.path || normalizePath(`${defaultFolder}/未命名笔记.md`);
    let content = node
      ? ""
      : ["---", "title: \"未命名笔记\"", "tags: []", "---", "", "# 未命名笔记", "", "在这里开始记录。", ""].join("\n");
    if (node) {
      const file = this.app.vault.getAbstractFileByPath(node.path);
      if (!(file instanceof TFile)) {
        new Notice(`笔记不存在：${node.path}`);
        return;
      }
      try {
        content = await this.app.vault.cachedRead(file);
      } catch (error) {
        new Notice(`读取笔记失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    new NoteEditorModal(this.app, {
      mode: node ? "edit" : "create",
      path: defaultPath,
      content,
      onSubmit: draft => this.saveNoteDraft(draft, node?.path ?? null),
    }).open();
  }

  private normalizeNoteDraftPath(rawPath: string, originalPath: string | null): string {
    const trimmed = normalizePath(rawPath.trim());
    if (!trimmed || trimmed.includes("\0") || trimmed.startsWith("/") || /^[a-z]:[\\/]/i.test(trimmed)) {
      throw new Error("笔记路径必须是 Vault 内的相对路径");
    }
    const parts = trimmed.split("/").filter(Boolean);
    if (parts.some(part => part === "..")) throw new Error("笔记路径不能跳出 Vault");
    if (!trimmed.toLowerCase().endsWith(".md")) throw new Error("笔记路径必须以 .md 结尾");
    if (originalPath && normalizePath(originalPath) !== trimmed) throw new Error("编辑时不允许修改原笔记路径");
    return trimmed;
  }

  private async saveNoteDraft(draft: NoteEditorDraft, originalPath: string | null): Promise<void> {
    const notePath = this.normalizeNoteDraftPath(draft.path, originalPath);
    const content = draft.content.replace(/^\uFEFF/, "");
    if (!content.trim()) throw new Error("笔记正文不能为空");
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (originalPath) {
      if (!(existing instanceof TFile)) throw new Error("原笔记已不存在，请刷新导航后重试");
      await this.app.vault.modify(existing, content);
      new Notice(`笔记已更新：${notePath}`);
    } else {
      if (existing) throw new Error(`目标已存在：${notePath}；请改名后再新建，避免覆盖原文`);
      const parent = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
      if (parent) await this.ensureVaultFolder(parent);
      await this.app.vault.create(notePath, content);
      new Notice(`笔记已新建：${notePath}`);
    }
    this.plugin.logBus.append("success", "vault.note", `${originalPath ? "updated" : "created"}: ${notePath}`);
    await new Promise(resolve => window.setTimeout(resolve, 140));
    const nextNode = this.toNode(notePath);
    if (nextNode) {
      this.selectedNode = nextNode;
      this.plugin.store.patch({ selectedFilePath: notePath });
    }
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
  }

  private openNoteDeleteModal(node: KnowledgeNodeViewModel): void {
    if (node.extension.toLowerCase() !== "md") {
      new Notice("当前节点不是 Markdown 笔记，暂不提供移入回收站操作。");
      return;
    }
    new NoteDeleteModal(this.app, node.title, () => this.deleteNote(node)).open();
  }

  private async deleteNote(node: KnowledgeNodeViewModel): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) throw new Error("笔记已不存在，请刷新导航");
    await this.app.vault.trash(file, true);
    if (this.selectedNode?.path === node.path) {
      this.selectedNode = null;
      this.plugin.store.patch({ selectedFilePath: null });
    }
    this.plugin.logBus.append("info", "vault.note", `trashed: ${node.path}`);
    new Notice(`已移入系统回收站：${node.title}`);
    await new Promise(resolve => window.setTimeout(resolve, 140));
    this.renderNavigator();
    this.renderMain();
    this.renderContext();
  }

  public renderContext(): void {
    const module = this.plugin.store.getSnapshot().activeModule;
    this.applyModuleSurfacePolicy(module);
    this.contextPane.empty();
    if (!moduleUsesContextPane(module)) return;
    const header = this.contextPane.createDiv({ cls: "aos-context-header" });
    header.createDiv({ cls: "aos-context-title", text: this.selectedNode?.title ?? "节点上下文" });
    if (this.selectedNode) header.createDiv({ cls: "aos-context-path", text: this.selectedNode.path });
    else header.createDiv({ cls: "aos-context-path", text: "选择知识节点后显示真实上下文" });

    if (!(["overview", "relations", "preview"] as string[]).includes(this.contextTab)) {
      this.contextTab = "overview";
    }
    const tabs = this.contextPane.createDiv({ cls: "aos-context-tabs" });
    const tabItems: Array<[ContextTab, string]> = [["overview", "概览"], ["relations", "关联"], ["preview", "预览"]];
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
      const create = this.createWorkbenchActionButton(body, "新建笔记", "file-plus-2", "is-primary", "在当前导航目录新建 Markdown 笔记");
      create.addEventListener("click", () => void this.openNoteEditorModal());
      return;
    }
    if (this.contextTab === "overview") this.renderContextOverview(body, this.selectedNode);
    if (this.contextTab === "relations") this.renderContextRelations(body, this.selectedNode);
    if (this.contextTab === "preview") void this.renderContextPreview(body, this.selectedNode);

    const actions = this.contextPane.createDiv({ cls: "aos-context-actions" });
    const open = this.createWorkbenchActionButton(actions, "打开", "external-link", "is-quiet", "在 Obsidian 编辑器打开笔记");
    open.addEventListener("click", () => void this.openNode(this.selectedNode!));
    const edit = this.createWorkbenchActionButton(actions, "编辑", "pencil", "is-primary", "编辑这篇笔记的完整 Markdown");
    edit.disabled = this.selectedNode.extension.toLowerCase() !== "md";
    edit.addEventListener("click", () => void this.openNoteEditorModal(this.selectedNode!));
    const favorite = this.createWorkbenchActionButton(
      actions,
      this.plugin.store.getSnapshot().favoritePaths.includes(this.selectedNode.path) ? "取消收藏" : "收藏",
      "star",
      "is-quiet",
      "切换节点收藏",
    );
    favorite.addEventListener("click", () => this.toggleFavorite(this.selectedNode!.path));
    if (this.isInspirationRecycleBinPath(this.selectedNode.path)) {
      const restore = this.createWorkbenchActionButton(actions, "恢复", "rotate-ccw", "is-primary", "恢复到原收件箱路径；不改写双链");
      restore.addEventListener("click", () => void this.restoreInspirationFromRecycleBin(this.selectedNode!));
      const permanentlyDelete = this.createWorkbenchActionButton(actions, "彻底删除", "trash", "is-danger", "不可逆；会先展示双链与附件清理预检");
      permanentlyDelete.addEventListener("click", () => this.openPermanentDeleteModal(this.selectedNode!));
    } else {
      const remove = this.createWorkbenchActionButton(actions, "移入回收站", "trash-2", "is-danger", "将笔记移入 Obsidian 系统回收站");
      remove.addEventListener("click", () => this.openNoteDeleteModal(this.selectedNode!));
    }
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
    const outgoingPaths = this.plugin.indexService.getOutgoingPaths(normalized);
    const backlinks = this.plugin.indexService.getBacklinkPaths(normalized);
    const relationCounts = this.plugin.indexService.getRelationCounts(normalized);

    // 1. Overview counts card
    const countsCard = parent.createDiv({ cls: "aos-context-card" });
    this.contextField(countsCard, "出链数量", `${outgoingPaths.length}`);
    this.contextField(countsCard, "反链数量", `${backlinks.length}`);
    this.contextField(countsCard, "未解析链接", `${relationCounts.unresolved}`);

    const graphBtn = countsCard.createEl("button", { cls: "aos-action-button", text: "在工作台图谱中聚焦" });
    graphBtn.setAttribute("style", "width: 100%; margin-top: 8px; font-size: 10px;");
    graphBtn.addEventListener("click", () => {
      this.graphScope = "current-file";
      this.switchModule("knowledge");
    });

    // 2. Outgoing Links list
    const outgoingSection = parent.createDiv({ cls: "aos-context-card" });
    outgoingSection.createDiv({ text: "🔗 出链节点列表", cls: "aos-relation-section-title" });
    const outgoingList = outgoingSection.createDiv({ cls: "aos-relation-list" });
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

    // Native Hermes sidecar is the primary surface.  It deliberately exposes
    // only node metadata here; text and write actions need an explicit consent
    // flow in the follow-up bridge implementation.
    if ((window as any).__aosNativeHermes !== false) {
    const hermes = card.createDiv({ cls: "aos-hermes-sidecar" });
    hermes.createDiv({ cls: "aos-hermes-title", text: "🐸 蛤蟆祥 · 本机 Hermes" });
    const status = hermes.createDiv({ cls: "aos-hermes-status", text: "正在检查本机回环服务…" });
    const context = hermes.createDiv({ cls: "aos-hermes-context" });
    context.createDiv({ text: "当前节点（受限上下文）", cls: "aos-hermes-context-title" });
    context.createDiv({ text: node.title });
    context.createDiv({ text: node.path, cls: "aos-hermes-path" });
    context.createDiv({ text: "仅传递标题与 Vault 相对路径；正文、附件与写入权限均未开放。", cls: "aos-hermes-hint" });
    const actions = hermes.createDiv({ cls: "aos-hermes-actions" });
    const openBtn = actions.createEl("button", { text: "启动本机 Hermes 服务" });
    openBtn.addEventListener("click", () => new Notice("请在本机 PowerShell 运行：hermes serve --host 127.0.0.1。Aetheric 不会代为启动进程。"));
    const fallbackBtn = actions.createEl("button", { text: "使用 Claudian 回退" });
    fallbackBtn.disabled = !CompatAdapter.isClaudianAvailable(this.app);
    fallbackBtn.addEventListener("click", () => {
      new Notice("Claudian 回退容器保留中；原生 Hermes 会话桥完成前请从原 Claudian 视图使用。 ");
    });
    try {
      const health = await requestUrl({ url: "http://127.0.0.1:9119/health", method: "GET", throw: false });
      status.setText(health.status >= 200 && health.status < 500 ? "● 本机 Hermes 服务可达（回环）" : "○ 本机 Hermes 服务未启动");
      status.toggleClass("is-online", health.status >= 200 && health.status < 500);
    } catch {
      status.setText("○ 本机 Hermes 服务未启动；可先在 PowerShell 启动");
    }
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
          cls: "aos-capability-draft-btn",
          text: "生成调度草案: " + cap.name
        });
        btn.setAttribute("title", "当前仅写入协同 Agent 对话草案，不会启动外部 Agent 或修改节点内容。");
        btn.addEventListener("click", () => {
          new Notice("已生成 Agent 调度草案；当前不会自动启动 Agent 或修改节点内容。");
          void this.appendAgentChatMessage("System", "调度草案: " + cap.name + " (" + cap.id + ") 对当前节点 《" + node.title + "》");
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

  private async loadEnvConfig(): Promise<void> {
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const envPath = path.join(systemPath, ".env");
    this.envLoading = true;
    try {
      if (!fs.existsSync(envPath)) {
        this.envConfig = {};
        this.envLastModified = 0;
        return;
      }
      const stat = await fs.promises.stat(envPath);
      this.envLastModified = stat.mtimeMs;

      const content = await fs.promises.readFile(envPath, "utf-8");
      const config: Record<string, string> = {};
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index > 0) {
          const key = trimmed.substring(0, index).trim();
          const val = trimmed.substring(index + 1).trim();
          config[key] = val;
        }
      }
      this.envConfig = config;
    } catch (e) {
      console.error("Failed to read env config", e);
      this.envConfig = {};
    } finally {
      this.envLoading = false;
    }
  }

  private async saveEnvConfig(updates: Record<string, string>): Promise<void> {
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const envPath = path.join(systemPath, ".env");
    const timestamp = Date.now();
    const pid = process.pid;
    const tempPath = path.join(systemPath, `.env.tmp-${pid}-${timestamp}`);

    try {
      if (fs.existsSync(envPath)) {
        const stat = await fs.promises.stat(envPath);
        if (stat.mtimeMs > this.envLastModified) {
          throw new Error("检测到配置文件冲突：该文件已被外部修改，为了防止覆盖，已中止本次保存。请刷新页面后重试！");
        }
      }

      let content = "";
      if (fs.existsSync(envPath)) {
        content = await fs.promises.readFile(envPath, "utf-8");
      }
      const lines = content.split(/\r?\n/);

      const whitelist = new Set([
        "X_WATCH_HANDLES",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "DOUYIN_BROWSER_WAIT_MS",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY"
      ]);

      const keysToUpdate = new Set(Object.keys(updates).filter(k => whitelist.has(k)));

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const index = trimmed.indexOf("=");
          if (index > 0) {
            const key = trimmed.substring(0, index).trim();
            if (keysToUpdate.has(key)) {
              if ((key === "DEEPSEEK_API_KEY" || key === "GROQ_API_KEY") && !updates[key]) {
                keysToUpdate.delete(key);
                continue;
              }
              lines[i] = `${key}=${updates[key]}`;
              keysToUpdate.delete(key);
            }
          }
        }
      }

      for (const key of keysToUpdate) {
        if ((key === "DEEPSEEK_API_KEY" || key === "GROQ_API_KEY") && !updates[key]) {
          continue;
        }
        lines.push(`${key}=${updates[key]}`);
      }

      await fs.promises.writeFile(tempPath, lines.join("\n"), "utf-8");
      await fs.promises.rename(tempPath, envPath);

      const newStat = await fs.promises.stat(envPath);
      this.envLastModified = newStat.mtimeMs;

      for (const key of Object.keys(updates)) {
        if (updates[key] || !(key === "DEEPSEEK_API_KEY" || key === "GROQ_API_KEY")) {
          this.envConfig[key] = updates[key];
        }
      }
    } catch (e) {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      throw e;
    }
  }

  private renderCollection(): void {
    if (this.plugin.store.getSnapshot().activeModule !== "collection") return;
    const renderToken = ++this.collectionRenderToken;
    const pageRenderId = this.currentRenderId;
    const isCurrentCollection = (): boolean =>
      this.isShellActive()
      && this.plugin.store.getSnapshot().activeModule === "collection"
      && this.collectionRenderToken === renderToken
      && this.currentRenderId === pageRenderId;
    this.mainPane.empty();
    const snapshot = this.plugin.hamasxiangAdapter.getSnapshot();
    const page = this.mainPane.createDiv({ cls: "aos-page aos-hamasxiang-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "采集 · 蛤蟆祥系统" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "通过本地 Daemon 公共端点接入，不复制爬虫后端" });

    const tabRow = page.createDiv({ cls: "aos-collection-tab-row" });
    const tabs = [
      { id: "dashboard", icon: "gauge", label: "运行看板" },
      { id: "sources", icon: "radio", label: "数据源与任务" },
      { id: "operations", icon: "wrench", label: "工造中枢" },
      { id: "analytics", icon: "line-chart", label: "卷宗分析" },
      { id: "config", icon: "sliders", label: "环境配置" }
    ];

    tabs.forEach(tab => {
      const btn = tabRow.createEl("button", {
        cls: `aos-collection-tab-btn ${this.collectionTab === tab.id ? "is-active" : ""}`
      });
      const iconBadge = btn.createDiv({ cls: `aos-tab-icon-badge is-${tab.id}` });
      setIcon(iconBadge, tab.icon);
      btn.createSpan({ cls: "aos-tab-label", text: tab.label });
      btn.addEventListener("click", async () => {
        const tabToken = ++this.collectionTabToken;
        this.collectionTab = tab.id;

        // Toggle Analytics active state
        if (tab.id === "analytics") {
          this.plugin.analyticsService.setActive(true);
          // Subscribe if not subscribed
          if (!this.unsubscribeAnalytics) {
            this.unsubscribeAnalytics = this.plugin.analyticsService.subscribe(() => {
              if (isCurrentCollection() && this.collectionTab === "analytics") {
                this.renderCollection();
              }
            });
          }
        } else {
          this.plugin.analyticsService.setActive(false);
        }

        if (tab.id === "config" || tab.id === "sources") {
          await this.loadEnvConfig();
        }
        if (tabToken === this.collectionTabToken && isCurrentCollection()) this.renderCollection();
      });
    });

    if (!this.envLoading && !this.envLoaded) {
      this.envLoaded = true;
      void this.loadEnvConfig().then(() => {
        if (isCurrentCollection()) this.renderCollection();
      });
    }

    // Auto-polling re-render if background tasks are running
    const activeProcs = this.plugin.processRegistry.list();
    if (activeProcs.length > 0) {
      window.setTimeout(() => {
        if (isCurrentCollection() && (this.collectionTab === "operations" || this.collectionTab === "analytics")) {
          this.renderCollection();
        }
      }, 1000);
    }

    if (this.collectionTab === "dashboard") {
      this.renderCollectionDashboard(page, snapshot);
    } else if (this.collectionTab === "sources") {
      if (this.envLoading) {
        page.createDiv({ cls: "aos-spinner-small" });
      } else {
        this.renderCollectionSources(page, snapshot);
      }
    } else if (this.collectionTab === "operations") {
      this.renderCollectionOperations(page);
    } else if (this.collectionTab === "analytics") {
      this.renderCollectionAnalytics(page);
    } else {
      if (this.envLoading) {
        page.createDiv({ cls: "aos-spinner-small" });
      } else {
        this.renderCollectionConfig(page);
      }
    }
  }

  private renderCollectionDashboard(page: HTMLDivElement, snapshot: any): void {
    const hero = page.createDiv({ cls: "aos-hamasxiang-hero" });
    hero.createDiv({ cls: "aos-hamasxiang-mark", text: "🐸" });
    const intro = hero.createDiv();
    intro.createDiv({ cls: "aos-panel-title", text: "蛤蟆祥 · 本地 Daemon 托管面板" });

    const owner = this.plugin.daemonOwnership;
    let daemonDetailText = "服务离线";
    if (owner === "managed") daemonDetailText = "天工台单实例进程守护中";
    else if (owner === "external") daemonDetailText = "复用外部活动进程运行中";

    intro.createDiv({ cls: "aos-panel-note", text: `Daemon 状态: ${daemonDetailText}` });

    const badge = hero.createSpan({ cls: `aos-service-badge ${snapshot.online ? "is-online" : "is-offline"}` });
    badge.createSpan({ cls: "aos-badge-dot" });
    badge.createSpan({ text: snapshot.online ? "本地 Daemon 在线" : "本地 Daemon 离线" });

    const resourceErrors = this.plugin.hamasxiangAdapter.getResourceErrors();
    const health = page.createDiv({ cls: `aos-capture-health ${snapshot.online ? "is-online" : "is-offline"}` });
    health.createSpan({ cls: "aos-capture-health-dot" });
    health.createSpan({
      cls: "aos-capture-health-main",
      text: snapshot.online ? "采集入口可用" : "采集入口暂不可用",
    });
    health.createSpan({
      cls: "aos-capture-health-detail",
      text: snapshot.checkedAt ? `最近检查 ${this.formatSnapshotTime(snapshot.checkedAt)}` : "尚未完成健康检查",
    });
    if (resourceErrors.length) {
      health.createSpan({
        cls: "aos-capture-health-warning",
        text: `${resourceErrors.length} 个附属数据源暂时不可读`,
        attr: { title: resourceErrors.map(error => `${error.resource}: ${error.message}`).join("\n") },
      });
    }
    if (snapshot.online && snapshot.platformHealth) {
      this.renderPlatformHealth(page, snapshot.platformHealth);
    }

    // Configuration drift detection warning banner
    const diskHandles = this.normalizeHandlesStr(this.envConfig["X_WATCH_HANDLES"]);
    const memHandles = this.normalizeHandlesStr(snapshot.xWatch?.handles);
    if (snapshot.online && diskHandles !== memHandles) {
      const alertDiv = page.createDiv({ cls: "aos-confirm-block aos-drift-warning" });
      alertDiv.createDiv({
        cls: "confirm-message",
        text: this.getDriftWarningText(diskHandles, memHandles, snapshot.activeJobs, owner)
      });
    }

    const controlRow = page.createDiv({ cls: "aos-action-row aos-daemon-controls" });
    this.actionButton(controlRow, "刷新炉火", () => void this.plugin.hamasxiangAdapter.refresh(true));
    this.actionButton(controlRow, "立即巡逻 X", () => void this.runXWatch());

    if (!snapshot.online) {
      this.actionButton(controlRow, "🚀 启动 Daemon", () => void this.plugin.startDaemon());
    } else if (owner === "managed") {
      this.actionButton(controlRow, "🛑 停止 Daemon", () => void this.plugin.stopDaemon());
    }

    // Dedup Lock Status loading
    if (this.isDedupEnabled === null && !this.isTogglingDedup && snapshot.online) {
      this.isTogglingDedup = true;
      this.plugin.workerControl.fetchStatus()
        .then(enabled => {
          this.isDedupEnabled = enabled;
          this.isTogglingDedup = false;
          this.renderCollection();
        })
        .catch(err => {
          this.isTogglingDedup = false;
          console.error("[Dedup Lock]", err.message);
        });
    }

    let dedupLabelText = "去重锁 · 离线";
    if (snapshot.online) {
      if (this.isDedupEnabled === null) {
        dedupLabelText = "去重锁 · 检查中...";
      } else {
        dedupLabelText = this.isDedupEnabled ? "🔒 去重锁 · 已开启" : "🔓 去重锁 · 已禁用";
      }
    }

    const dedupBtn = controlRow.createEl("button", {
      cls: "aos-action-button",
      text: dedupLabelText
    });
    if (!snapshot.online || this.isDedupEnabled === null || this.isTogglingDedup) {
      dedupBtn.setAttribute("disabled", "true");
    }

    if (snapshot.online && this.isDedupEnabled === true) {
      dedupBtn.style.cssText = "background: rgba(40, 88, 58, 0.1) !important; border-color: rgba(40, 88, 58, 0.3) !important; color: #28583a !important;";
    }

    dedupBtn.addEventListener("click", async () => {
      if (!snapshot.online || this.isDedupEnabled === null || this.isTogglingDedup) return;
      this.isTogglingDedup = true;
      const originalState = this.isDedupEnabled;
      // Optimistic UI update
      this.isDedupEnabled = !originalState;
      this.renderCollection();

      try {
        const newEnabled = await this.plugin.workerControl.toggleStatus(originalState);
        this.isDedupEnabled = newEnabled;
        new Notice(newEnabled ? "🔒 1h 去重锁已成功开启" : "🔓 1h 去重锁已成功禁用");
      } catch (err: any) {
        // Rollback on error
        this.isDedupEnabled = originalState;
        new Notice(err.message);
      } finally {
        this.isTogglingDedup = false;
        this.renderCollection();
      }
    });

    const metrics = page.createDiv({ cls: "aos-metric-grid aos-adapter-metrics" });
    this.metric(metrics, "端口", snapshot.online ? "8765" : "未连接", snapshot.online ? "127.0.0.1 · hamaxiang-daemon" : "服务离线");
    this.metric(metrics, "服务版本", snapshot.version ? `v${snapshot.version}` : "--", "GET /health");
    this.metric(metrics, "活跃任务数", `${snapshot.activeJobs}`, "排队或抓取中");
    this.metric(metrics, "X Watch 状态", this.xWatchLabel(snapshot.xWatch), "定时任务循环");
    this.metric(metrics, "下次巡逻时间", this.formatNextRun(snapshot.xWatch.next_run_at), "X Watch");

    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });

    // Top-row: Left card Tasks
    const taskPanel = leftPane.createDiv({ cls: "aos-panel" });
    taskPanel.createDiv({ cls: "aos-panel-title", text: "采集任务快照" });
    this.renderTaskList(taskPanel, this.plugin.hamasxiangAdapter.getTasks(), false);

    // Top-row: Right card Enqueue Form
    const rightPane = grid.createDiv({ cls: "aos-collection-right-pane" });
    const enqueuePanel = rightPane.createDiv({ cls: "aos-panel" });
    enqueuePanel.createDiv({ cls: "aos-panel-title", text: "🧭 统一链接采集" });
    enqueuePanel.createDiv({ cls: "aos-panel-note", text: "B站 / 抖音 / 小红书 / X / 普通网页自动选择适配器；视频正式保存必须拿到可信字幕或 ASR。" });
    const form = enqueuePanel.createDiv({ cls: "aos-job-enqueue-form" });
    const urlInput = form.createEl("textarea", {
      cls: "aos-job-url-input",
      attr: { placeholder: "粘贴一个或多个链接（换行分隔）", rows: "3", spellcheck: "false" }
    });
    const inputHint = enqueuePanel.createDiv({ cls: "aos-job-input-hint", text: "等待粘贴链接" });
    const updateInputHint = (): void => {
      const urls = dedupeCaptureUrls(urlInput.value);
      if (!urls.length) {
        inputHint.setText("支持微信分享文案、Markdown 和多条链接；只提交有效 HTTPS 页面。");
        inputHint.removeClass("has-links");
        return;
      }
      const platforms = [...new Set(urls.map(capturePlatformLabel))];
      inputHint.setText(`已识别 ${urls.length} 条 · ${platforms.join(" / ")} · 提交后只会创建一份任务`);
      inputHint.addClass("has-links");
    };
    urlInput.addEventListener("input", updateInputHint);
    const submitBtn = form.createEl("button", {
      cls: "aos-job-submit-btn",
      text: "加入采集队列"
    });
    const receiptHost = enqueuePanel.createDiv({ cls: "aos-capture-receipt-host" });
    const previousReceipt = this.plugin.hamasxiangAdapter.getLastCaptureReceipt();
    if (previousReceipt) this.renderCaptureReceipt(receiptHost, previousReceipt);
    submitBtn.addEventListener("click", async () => {
      const urls = dedupeCaptureUrls(urlInput.value);
      if (!urls.length) {
        new Notice("没有有效 HTTPS 页面链接");
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = "入队中...";
      try {
        const receipt = await this.enqueueCaptureJob(urlInput.value);
        urlInput.value = "";
        updateInputHint();
        this.renderCaptureReceipt(receiptHost, receipt);
        new Notice(`🧭 已提交 ${receipt.sourceUrls.length || urls.length} 条链接；任务状态会自动更新。`);
      } catch (e) {
        new Notice(`采集未入队：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "加入采集队列";
      }
    });

    // Bottom-row: Daemon Event Stream
    const logPanel = page.createDiv({ cls: "aos-panel aos-daemon-logs-panel" });
    const logHeader = logPanel.createDiv({ cls: "aos-panel-header-row" });
    logHeader.createDiv({ cls: "aos-panel-title", text: "🐸 Daemon 实时事件流" });
    const expandLogBtn = logHeader.createEl("button", { cls: "aos-logs-expand-btn", text: "展开完整日志坞" });
    expandLogBtn.addEventListener("click", () => {
      const state = this.plugin.store.getSnapshot();
      this.plugin.store.patch({ logDock: { ...state.logDock, open: true } });
    });

    const logsContainer = logPanel.createDiv({ cls: "aos-daemon-logs-console" });
    const allLogs = this.plugin.logBus.getEntries();
    const daemonLogs = allLogs.filter(entry => entry.source.startsWith("hamaxiang") || entry.source.startsWith("hamasxiang"));

    if (daemonLogs.length === 0) {
      logsContainer.createDiv({ cls: "aos-empty-logs", text: "暂无 Daemon 事件日志，等待后台触发或启动服务。" });
    } else {
      // Only show top 5 latest event streams
      for (const log of daemonLogs.slice(-5)) {
        const line = logsContainer.createDiv({ cls: `aos-console-line is-${log.level}` });
        const time = new Date(log.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
        line.createSpan({ cls: "console-time", text: `[${time}] ` });
        line.createSpan({ cls: "console-msg", text: log.message });
      }
      window.setTimeout(() => {
        logsContainer.scrollTop = logsContainer.scrollHeight;
      }, 50);
    }
  }

  private async enqueueCaptureJob(rawValue: string): Promise<HamasxiangCaptureReceipt> {
    const urls = dedupeCaptureUrls(rawValue);
    if (!urls.length) throw new Error("没有识别到有效 HTTPS 页面链接");
    return await this.plugin.hamasxiangAdapter.submitCaptureJob({
      source_urls: urls,
      intent: "save",
      title: urls.length > 1 ? `统一采集 · ${urls.length} 条链接` : "手动采集任务",
      source: "aetheric-workbench",
    });
  }

  private renderCollectionSources(page: HTMLDivElement, snapshot: any): void {
    const env = this.envConfig;
    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });

    const xPanel = leftPane.createDiv({ cls: "aos-panel" });
    xPanel.createDiv({ cls: "aos-panel-title", text: "📡 Twitter/X 情报数据源" });
    xPanel.createDiv({ cls: "aos-panel-note", text: "配置要巡逻的 X 账号句柄列表（从 Daemon .env 读取）" });

    // Add config drift alert warning
    const diskHandles = this.normalizeHandlesStr(env["X_WATCH_HANDLES"]);
    const memHandles = this.normalizeHandlesStr(snapshot.xWatch?.handles);
    if (snapshot.online && diskHandles !== memHandles) {
      const alertDiv = xPanel.createDiv({ cls: "aos-confirm-block aos-drift-warning" });
      alertDiv.style.cssText = "margin: 10px 0 15px 0; padding: 10px;";
      alertDiv.createDiv({
        cls: "confirm-message",
        text: this.getDriftWarningText(diskHandles, memHandles, snapshot.activeJobs, this.plugin.daemonOwnership)
      });
    }

    const handlesStr = env["X_WATCH_HANDLES"] || "";
    const handles = handlesStr.split(",").map(h => h.trim()).filter(Boolean);
    const syncState = xPanel.createDiv({ cls: "aos-source-sync-state" });
    const diskState = syncState.createDiv({ cls: "aos-source-sync-item" });
    diskState.createSpan({ cls: "aos-source-sync-label", text: "已保存到 .env" });
    diskState.createSpan({
      cls: "aos-source-sync-value",
      text: handles.length ? `${handles.length} 个巡逻账号` : "尚未配置"
    });
    const runtimeState = syncState.createDiv({ cls: "aos-source-sync-item" });
    runtimeState.createSpan({ cls: "aos-source-sync-label", text: "Daemon 当前内存" });
    runtimeState.createSpan({
      cls: `aos-source-sync-value ${snapshot.online && diskHandles === memHandles ? "is-current" : "is-pending"}`,
      text: !snapshot.online
        ? "Daemon 未运行，启动后读取配置"
        : diskHandles === memHandles
          ? "已与 .env 一致"
          : "仍在使用上一版配置"
    });
    const tagsContainer = xPanel.createDiv({ cls: "aos-x-handles-tags" });

    if (handles.length === 0) {
      tagsContainer.createDiv({ cls: "aos-empty-state", text: "当前未配置任何巡逻账号" });
    } else {
      handles.forEach(handle => {
        const tag = tagsContainer.createDiv({ cls: "aos-x-handle-tag" });
        tag.createSpan({ text: `@${handle}` });

        const actions = tag.createDiv({ cls: "aos-x-handle-actions" });
        const testBtn = actions.createEl("button", {
          cls: "aos-x-handle-action aos-x-handle-test",
          text: "测试巡逻",
          attr: { type: "button", "aria-label": `测试单源抓取 @${handle}` }
        });
        testBtn.setAttribute("title", `仅为 @${handle} 发起一次测试巡逻`);
        testBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          testBtn.classList.add("is-running");
          testBtn.disabled = true;
          testBtn.textContent = "测试中…";
          new Notice(`开始单源测试巡逻：@${handle}`);
          try {
            await this.plugin.hamasxiangAdapter.runXWatch(handle);
            new Notice(`@${handle} 单源测试巡逻已入队`);
          } catch (err) {
            new Notice(`测试失败：${err instanceof Error ? err.message : String(err)}`);
          } finally {
            testBtn.classList.remove("is-running");
            testBtn.disabled = false;
            testBtn.textContent = "测试巡逻";
          }
        });

        const removeBtn = actions.createEl("button", {
          cls: "aos-x-handle-action aos-x-handle-remove",
          text: "移除",
          attr: { type: "button", "aria-label": `从 .env 配置中移除 @${handle}` }
        });
        removeBtn.setAttribute("title", `从 .env 配置中移除 @${handle}`);
        removeBtn.addEventListener("click", async () => {
          const updated = handles.filter(h => h !== handle).join(",");
          env["X_WATCH_HANDLES"] = updated;
          await this.saveEnvConfig(env);
          new Notice(`已从 .env 配置移除 @${handle}`);
          this.renderCollection();
        });
      });
    }

    const addForm = xPanel.createDiv({ cls: "aos-add-handle-form" });
    const addInput = addForm.createEl("input", {
      cls: "aos-add-handle-input",
      attr: { placeholder: "新增巡逻账号句柄（如 thsottiaux）", "aria-label": "新增 X Watch 巡逻账号" }
    });
    const addBtn = addForm.createEl("button", { cls: "aos-add-handle-btn", text: "添加账号", attr: { type: "button" } });
    addBtn.addEventListener("click", async () => {
      const handle = addInput.value.trim().replace(/^@/, "");
      if (!handle) return;
      if (handles.includes(handle)) {
        new Notice("此账号已在列表中");
        return;
      }
      handles.push(handle);
      env["X_WATCH_HANDLES"] = handles.join(",");
      await this.saveEnvConfig(env);
      addInput.value = "";
      new Notice(`已添加巡逻账号 @${handle} 到 .env 配置`);
      this.renderCollection();
    });

    const artPanel = leftPane.createDiv({ cls: "aos-panel" });
    artPanel.createDiv({ cls: "aos-panel-title", text: "最近情报与采集产物" });
    this.renderArtifactList(artPanel, this.plugin.hamasxiangAdapter.getArtifacts().slice(0, 10));

    const rightPane = grid.createDiv({ cls: "aos-collection-right-pane" });
    const guideCard = rightPane.createDiv({ cls: "aos-panel" });
    guideCard.createDiv({ cls: "aos-panel-title", text: "来源与运行说明" });

    const infoList = guideCard.createEl("ul", { cls: "aos-guide-list" });
    infoList.createEl("li", { text: "本页增删账号会先写入 Daemon 的 .env 配置文件。" });
    infoList.createEl("li", { text: "运行中的 Daemon 不会自动改写内存配置；出现“上一版配置”提示时，按页面指引重启后生效。" });
    infoList.createEl("li", { text: "X Watch 以本地浏览器会话巡逻；入库产物会显示在“最近情报与采集产物”。" });
  }

  private renderCollectionOperations(page: HTMLDivElement): void {
    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });
    const rightPane = grid.createDiv({ cls: "aos-collection-right-pane" });

    const opsPanel = leftPane.createDiv({ cls: "aos-panel" });
    const opsTitle = opsPanel.createDiv({ cls: "aos-panel-title aos-ops-title" });
    const opsTitleIcon = opsTitle.createSpan({ cls: "aos-ops-title-icon" });
    setIcon(opsTitleIcon, "wrench");
    opsTitle.createSpan({ text: "工造中枢" });
    opsPanel.createDiv({ cls: "aos-panel-note", text: "从采集到修复的本地执行入口。动作会进入真实进程队列，并在底部日志留下回执。" });

    // Row 1: 网页参悟 (Manual Grab URL)
    const grabSection = opsPanel.createDiv({ cls: "aos-grab-section aos-ops-grab-section" });
    grabSection.createDiv({ cls: "aos-section-label aos-ops-section-label", text: "网页参悟" });
    grabSection.createDiv({ cls: "aos-ops-section-note", text: "把一个链接加入采集队列；只有明确需要重跑已有卷宗时，才勾选覆写。" });

    const grabRow = grabSection.createDiv({ cls: "aos-grab-row" });
    const grabInput = grabRow.createEl("input", {
      cls: "aos-grab-input",
      attr: { placeholder: "请输入网页 URL (支持抖音/B站/小红书/网页)" }
    });

    const forceLabel = grabRow.createEl("label");
    const forceCheck = forceLabel.createEl("input", { attr: { type: "checkbox" } });
    forceLabel.createSpan({ text: "覆写已有结果" });

    const grabBtn = grabRow.createEl("button", { cls: "aos-btn", text: "参悟" });
    grabBtn.style.cssText = "padding: 6px 12px; font-size: 12px;";
    grabBtn.addEventListener("click", () => {
      const url = grabInput.value.trim();
      if (!url) {
        new Notice("请输入需要参悟的网页链接！");
        return;
      }
      grabBtn.disabled = true;
      grabBtn.textContent = "入队中…";
      void this.plugin.hamasxiangOperations.runManualGrab(url, forceCheck.checked).then(() => {
        grabInput.value = "";
        this.renderCollection();
        new Notice("统一采集任务已入队");
      }).catch((err: unknown) => {
        new Notice(err instanceof Error ? err.message : String(err));
      }).finally(() => {
        grabBtn.disabled = false;
        grabBtn.textContent = "参悟";
      });
    });

    // Row 2: Standard buttons
    const btnGrid = opsPanel.createDiv({ cls: "aos-ops-action-grid" });

    const syncBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "感应并拉取云端" });
    syncBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runSync();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const knowledgeExportBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "导出知识镜像" });
    knowledgeExportBtn.title = "只导出允许的收件箱与松果天工台笔记，不自动 Git 推送";
    knowledgeExportBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runKnowledgeExport();
        new Notice("知识镜像已开始生成，完成后可在 hamaxiang-system/data/knowledge/export 检查。", 5000);
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const repairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "全库 ASR 精修" });
    repairBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runRepair();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const biliRepairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "B站 ASR 修复" });
    biliRepairBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runPlatformRepair("bilibili");
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const dyRepairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "抖音 ASR 修复" });
    dyRepairBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runPlatformRepair("douyin");
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const quarantineBtn = btnGrid.createEl("button", { cls: "aos-btn aos-ops-caution", text: "隔离异常卷宗" });
    quarantineBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runQuarantine();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const restoreBtn = btnGrid.createEl("button", { cls: "aos-btn aos-ops-caution", text: "还原隔离卷宗" });
    restoreBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runRestore();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const previewPanel = leftPane.createDiv({ cls: "aos-panel aos-preview-panel" });
    previewPanel.createDiv({ cls: "aos-panel-title", text: "本地预览与发布" });
    previewPanel.createDiv({ cls: "aos-panel-note", text: "编译生成个人博客的图谱拓扑或启动本地开发服务器进行静态预览" });

    const previewGrid = previewPanel.createDiv({ cls: "aos-ops-action-grid" });

    const publishBtn = previewGrid.createEl("button", { cls: "aos-btn aos-preview-action", text: "编译图谱（Astro）" });
    publishBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.runPublish();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const isPreviewRunning = this.plugin.processRegistry.isRunning("preview");
    const previewToggleBtn = previewGrid.createEl("button", {
      cls: `aos-btn aos-preview-action ${isPreviewRunning ? "is-danger" : ""}`,
      text: isPreviewRunning ? "关闭本地预览" : "开启本地预览"
    });
    if (isPreviewRunning) {
      previewToggleBtn.style.cssText = "background: rgba(239, 68, 68, 0.1) !important; border: 1px solid rgba(239, 68, 68, 0.4) !important; color: #ef4444 !important;";
    }
    previewToggleBtn.addEventListener("click", () => {
      try {
        this.plugin.hamasxiangOperations.toggleDevServer();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    // Right Panel 1: Git 安全归档备份
    const gitPanel = rightPane.createDiv({ cls: "aos-panel aos-git-backup-panel" });
    gitPanel.createDiv({ cls: "aos-panel-title", text: "Git 安全归档备份" });
    gitPanel.createDiv({ cls: "aos-panel-note", text: "扫描仓库变更，预防敏感密钥泄漏，执行二次确认安全提交与备份" });
    gitPanel.createDiv({ cls: "aos-git-flow-note", text: "先扫描工作区；确认无敏感项后再本地提交。远端同步独立执行，不会替代本地备份。" });

    const gitActionsRow = gitPanel.createDiv({ cls: "aos-git-action-row" });

    const scanBtn = gitActionsRow.createEl("button", {
      cls: `aos-btn aos-git-action aos-git-scan ${this.isScanningGit ? "is-loading" : ""}`,
      text: this.isScanningGit ? "正在扫描…" : "扫描工作区"
    });
    scanBtn.addEventListener("click", async () => {
      this.isScanningGit = true;
      this.renderCollection();
      try {
        this.gitChanges = await this.plugin.hamasxiangOperations.checkGitStatus();
        this.gitAcknowledgement = false;
        // Pre-fill default commit message
        this.gitCommitMsg = `卷宗入藏与工造备份 ${new Date().toLocaleString()}`;
      } catch (err: any) {
        new Notice(`扫描失败: ${err.message}`);
      } finally {
        this.isScanningGit = false;
        this.renderCollection();
      }
    });

    const isRunningGit = this.plugin.processRegistry.isRunning("git");
    const remoteSyncBtn = gitActionsRow.createEl("button", {
      cls: "aos-btn aos-git-action aos-git-remote",
      text: "同步远端"
    });
    if (isRunningGit) remoteSyncBtn.setAttribute("disabled", "true");
    remoteSyncBtn.addEventListener("click", async () => {
      try {
        new Notice("开始远端 Git 同步 (pull & push)...");
        await this.plugin.hamasxiangOperations.runGitSyncRemote();
      } catch (err: any) {
        new Notice(err.message);
      } finally {
        this.renderCollection();
      }
    });

    if (this.gitChanges === null) {
      const errorBlock = gitPanel.createDiv();
      errorBlock.style.cssText = "margin-bottom: 12px; padding: 8px 12px; background: rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444; border-radius: 4px; font-size: 11px; color: #ef4444; line-height: 1.4;";
      errorBlock.createDiv({ text: "⚠️ 扫描失败：Git 状态检查异常退出。" }).style.cssText = "font-weight: bold; margin-bottom: 4px;";
      errorBlock.createDiv({ text: "可能是当前目录非 Git 仓库，或者包含未决冲突，亦或是网络原因无法连接远端 origin。请在终端解决冲突或检查配置。" });
    } else if (this.gitChanges.length > 0) {
      const changeHeader = gitPanel.createDiv();
      changeHeader.style.cssText = "font-size: 11px; font-weight: bold; margin-bottom: 6px; color: var(--aos-ink-muted);";
      changeHeader.setText(`工作区检出 ${this.gitChanges.length} 处变更:`);

      const listDiv = gitPanel.createDiv();
      listDiv.style.cssText = "max-height: 150px; overflow-y: auto; border: 1px solid var(--aos-border); border-radius: 6px; padding: 4px; background: rgba(0,0,0,0.05); margin-bottom: 12px;";

      let hasSensitive = false;
      this.gitChanges.forEach(item => {
        const row = listDiv.createDiv();
        row.style.cssText = "display: flex; justify-content: space-between; align-items: center; font-size: 11px; padding: 3px 6px; border-bottom: 1px solid rgba(0,0,0,0.03);";
        if (item.isSensitive) {
          hasSensitive = true;
          row.style.cssText += "background: rgba(239, 68, 68, 0.08); border: 1px dashed rgba(239, 68, 68, 0.3); border-radius: 4px; margin-bottom: 2px;";
        }

        const left = row.createSpan();
        const statSpan = left.createSpan();
        statSpan.style.cssText = `font-weight: bold; margin-right: 6px; color: ${item.status === "??" ? "#0369a1" : item.status === "D" ? "#ef4444" : "#28583a"};`;
        statSpan.setText(item.status);
        left.createSpan({ text: item.path });

        if (item.isSensitive) {
          const badge = row.createSpan({ cls: "aos-badge is-error", text: `⚠️ 敏感警告: ${item.reason}` });
          badge.style.cssText = "font-size: 9px; padding: 1px 4px; border-radius: 3px; background: rgba(239, 68, 68, 0.2); color: #ef4444;";
        }
      });

      if (hasSensitive) {
        const warnBlock = gitPanel.createDiv();
        warnBlock.style.cssText = "margin-bottom: 12px; padding: 8px 12px; background: rgba(239, 68, 68, 0.1); border-left: 3px solid #ef4444; border-radius: 4px; font-size: 11px; color: #ef4444; line-height: 1.4;";
        warnBlock.createDiv({ text: "⚠️ 警告：检测到未提交的敏感文件（如 .env 或临时测试垃圾）。" }).style.cssText = "font-weight: bold; margin-bottom: 4px;";
        warnBlock.createDiv({ text: "为了您的数据与隐私安全，已锁定一键备份功能。请先通过终端或 Git 工具处理敏感文件，或在排除列表 (.gitignore) 中将其屏蔽后再行备份。" });
      } else {
        // Commit message input
        const msgDiv = gitPanel.createDiv();
        msgDiv.style.cssText = "margin-bottom: 10px;";
        msgDiv.createDiv({ text: "提交说明:" }).style.cssText = "font-size: 11px; margin-bottom: 3px; font-weight: bold; color: var(--aos-ink-muted);";
        const msgInput = msgDiv.createEl("input", {
          attr: { type: "text", value: this.gitCommitMsg }
        });
        msgInput.style.cssText = "width: 100%; padding: 6px; font-size: 12px;";
        msgInput.addEventListener("input", () => {
          this.gitCommitMsg = msgInput.value;
        });

        // Acknowledgement Checkbox
        const ackLabel = gitPanel.createEl("label");
        ackLabel.style.cssText = "font-size: 11px; display: flex; align-items: flex-start; gap: 6px; margin-bottom: 12px; cursor: pointer; line-height: 1.3; color: var(--aos-ink-muted);";
        const ackCheck = ackLabel.createEl("input", { attr: { type: "checkbox" } });
        ackCheck.checked = this.gitAcknowledgement;
        ackLabel.createSpan({ text: "我已确认待暂存的变更不含任何敏感密钥/测试垃圾，且当前网络状态健康。" });

        const backupBtn = gitPanel.createEl("button", {
          cls: "aos-btn aos-git-backup-action",
          text: "确认后创建本地备份提交"
        });
        backupBtn.toggle(this.gitAcknowledgement && !isRunningGit);

        ackCheck.addEventListener("change", () => {
          this.gitAcknowledgement = ackCheck.checked;
          backupBtn.toggle(this.gitAcknowledgement && !isRunningGit);
        });

        backupBtn.addEventListener("click", async () => {
          try {
            const files = (this.gitChanges || []).map(c => c.path);
            new Notice("正在启动本地 Git 备份归档...");
            const ok = await this.plugin.hamasxiangOperations.runGitBackup(files, this.gitCommitMsg);
            if (ok) {
              new Notice("本地 Git 备份归档完成！");
              this.gitChanges = [];
              this.gitAcknowledgement = false;
            }
          } catch (err: any) {
            new Notice(err.message);
          } finally {
            this.renderCollection();
          }
        });
      }
    } else {
      const emptyDiv = gitPanel.createDiv({ cls: "aos-empty-state" });
      emptyDiv.style.cssText = "font-size: 11px; text-align: center; color: var(--aos-ink-muted); padding: 20px 0;";
      emptyDiv.setText("已完成工作区扫描，暂未发现变更。工作区干净。");
    }

    // Right Panel 2: 法阵运行日志与监控 (Active Processes Monitor)
    const monitorPanel = rightPane.createDiv({ cls: "aos-panel" });
    monitorPanel.style.cssText = "margin-top: 14px;";
    monitorPanel.createDiv({ cls: "aos-panel-title", text: "📊 法阵运行监控" });
    monitorPanel.createDiv({ cls: "aos-panel-note", text: "实时查看天工台托管进程的进度、状态及控制" });

    const activeProcesses = this.plugin.processRegistry.list();
    // Filter out daemon from general user monitors
    const userProcesses = activeProcesses.filter((p: ProcessRegistryEntry) => p.taskType !== "daemon");

    if (userProcesses.length === 0) {
      const emptyDiv = monitorPanel.createDiv({ cls: "aos-empty-state" });
      emptyDiv.style.cssText = "font-size: 11px; text-align: center; color: var(--aos-ink-muted); padding: 20px 0;";
      emptyDiv.setText("当前无任何活动仙术法阵在运行中");
    } else {
      const procList = monitorPanel.createDiv();
      procList.style.cssText = "display: flex; flex-direction: column; gap: 10px; margin-top: 10px;";

      userProcesses.forEach((proc: ProcessRegistryEntry) => {
        const pCard = procList.createDiv();
        pCard.style.cssText = "border: 1px solid var(--aos-border); border-radius: 6px; padding: 10px; background: rgba(0,0,0,0.02);";

        const topRow = pCard.createDiv();
        topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;";

        const titleDiv = topRow.createDiv();
        const typeBadge = titleDiv.createSpan();
        typeBadge.style.cssText = "font-size: 9px; font-weight: bold; text-transform: uppercase; background: #0369a1; color: white; padding: 2px 5px; border-radius: 3px; margin-right: 6px;";
        typeBadge.setText(proc.taskType);

        titleDiv.createSpan({ text: `PID: ${proc.process.pid}` }).style.cssText = "font-size: 11px; color: var(--aos-ink-muted);";

        const elapsed = Math.round((Date.now() - proc.startedAt) / 1000);
        const timeSpan = topRow.createSpan({ text: `已运行 ${elapsed} 秒` });
        timeSpan.style.cssText = "font-size: 11px; color: var(--aos-ink-muted);";

        // Progress bar
        const prog = this.plugin.hamasxiangOperations.getLastProgress(proc.taskType);
        const barContainer = pCard.createDiv();
        barContainer.style.cssText = "height: 6px; background: rgba(0,0,0,0.1); border-radius: 3px; overflow: hidden; margin: 8px 0;";

        const bar = barContainer.createDiv();
        bar.style.cssText = "height: 100%; background: var(--aos-blueprint); width: 0%; transition: width 0.3s ease;";

        const descRow = pCard.createDiv();
        descRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; font-size: 11px;";

        const desc = descRow.createSpan();
        desc.style.cssText = "color: var(--aos-ink-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;";

        if (prog) {
          const pct = Math.round((prog.current / prog.total) * 100);
          bar.style.width = `${pct}%`;
          desc.setText(`${prog.stage}: ${prog.current}/${prog.total}`);
          descRow.createSpan({ text: `${pct}%` }).style.cssText = "font-weight: bold; color: var(--aos-ink);";
        } else {
          // Indeterminate state
          bar.style.width = "40%";
          bar.style.background = "repeating-linear-gradient(45deg, var(--aos-blueprint), var(--aos-blueprint) 10px, rgba(3,105,161,0.5) 10px, rgba(3,105,161,0.5) 20px)";
          desc.setText("正在执行中，等待流式输出...");
        }

        const controlRow = pCard.createDiv();
        controlRow.style.cssText = "margin-top: 8px; text-align: right;";
        const killBtn = controlRow.createEl("button", {
          cls: "aos-btn",
          text: "⏹️ 中止法阵"
        });
        killBtn.style.cssText = "padding: 3px 8px; font-size: 10px; background: rgba(239, 68, 68, 0.08) !important; border: 1px solid rgba(239, 68, 68, 0.3) !important; color: #ef4444 !important;";
        killBtn.addEventListener("click", async () => {
          new Notice(`正在中止 PID ${proc.process.pid} (${proc.taskType})...`);
          await this.plugin.processRegistry.kill(proc.taskType);
          this.renderCollection();
        });
      });
    }
  }

  private renderCollectionAnalytics(page: HTMLDivElement): void {
    const snap = this.plugin.analyticsService.getSnapshot();

    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });
    const rightPane = grid.createDiv({ cls: "aos-collection-right-pane" });

    // Left Pane Card 1: 卷宗体量与审计
    const statsCard = leftPane.createDiv({ cls: "aos-panel" });
    statsCard.createDiv({ cls: "aos-panel-title", text: "📊 卷宗体量与审计" });
    statsCard.createDiv({ cls: "aos-panel-note", text: "收件箱中待整理卷宗的总体审计与健康度指标" });

    // Stats Grid
    const statGrid = statsCard.createDiv();
    statGrid.style.cssText = "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 10px; margin-bottom: 14px;";

    const makeStatBox = (parent: HTMLDivElement, label: string, val: string | number, borderCol = "var(--aos-border)") => {
      const box = parent.createDiv();
      box.style.cssText = `border: 1px solid ${borderCol}; border-radius: 6px; padding: 10px; text-align: center; background: rgba(0,0,0,0.01);`;
      box.createDiv({ text: label }).style.cssText = "font-size: 10px; font-weight: bold; color: var(--aos-ink-muted); margin-bottom: 4px;";
      box.createDiv({ text: String(val) }).style.cssText = "font-size: 18px; font-weight: 800; color: var(--aos-ink);";
    };

    makeStatBox(statGrid, "池中卷宗总数", snap.totalNotes, "var(--aos-border-blueprint)");
    makeStatBox(statGrid, "今日新增卷宗", snap.todayNotes, "var(--aos-border-green)");
    makeStatBox(statGrid, "ASR 故障挂起", snap.evidenceCounts.asr_failed + snap.evidenceCounts.asr_pending, snap.evidenceCounts.asr_failed > 0 ? "rgba(239, 68, 68, 0.4)" : "var(--aos-border)");

    // Evidence Audit Details
    statsCard.createDiv({ text: "🔍 证据等级健康审计:" }).style.cssText = "font-size: 11px; font-weight: bold; margin-bottom: 6px; color: var(--aos-ink-muted);";
    const auditRow = statsCard.createDiv();
    auditRow.style.cssText = "display: grid; grid-template-columns: 1fr; gap: 4px; font-size: 11px;";

    const makeAuditLabel = (parent: HTMLDivElement, text: string, count: number, cls: string) => {
      const row = parent.createDiv();
      row.style.cssText = "display: flex; justify-content: space-between; padding: 4px 6px; border-bottom: 1px solid rgba(0,0,0,0.02);";
      row.createSpan({ text });
      const badge = row.createSpan({ text: String(count) });
      badge.style.cssText = "font-weight: bold; border-radius: 3px; padding: 1px 4px;";
      if (cls === "green") badge.style.cssText += "background: rgba(40, 88, 58, 0.15); color: #28583a;";
      else if (cls === "amber") badge.style.cssText += "background: rgba(197, 139, 43, 0.15); color: #c58b2b;";
      else if (cls === "red") badge.style.cssText += "background: rgba(239, 68, 68, 0.15); color: #ef4444;";
      else if (cls === "blue") badge.style.cssText += "background: rgba(3, 105, 161, 0.15); color: #0369a1;";
      else badge.style.cssText += "background: rgba(0,0,0,0.05); color: var(--aos-ink-muted);";
    };

    makeAuditLabel(auditRow, "完整双轨字幕 (subtitle_full)", snap.evidenceCounts.subtitle_full, "green");
    makeAuditLabel(auditRow, "不稳双轨字幕 (subtitle_unstable)", snap.evidenceCounts.subtitle_unstable, "amber");
    makeAuditLabel(auditRow, "低置信双轨字幕 (subtitle_suspect)", snap.evidenceCounts.subtitle_suspect, "red");
    makeAuditLabel(auditRow, "元数据大纲 (toc_metadata)", snap.evidenceCounts.toc_metadata, "blue");
    makeAuditLabel(auditRow, "ASR 等待中 (asr_pending)", snap.evidenceCounts.asr_pending, "gray");
    makeAuditLabel(auditRow, "ASR 故障挂死 (asr_failed)", snap.evidenceCounts.asr_failed, "red");

    // Left Pane Card 2: 分流与平台特征分布
    const distCard = leftPane.createDiv({ cls: "aos-panel" });
    distCard.style.cssText = "margin-top: 14px;";
    distCard.createDiv({ cls: "aos-panel-title", text: "📐 分流与数据源结构" });

    // Category list progress bars
    distCard.createDiv({ text: "分流建议方向分布:" }).style.cssText = "font-size: 11px; font-weight: bold; margin-bottom: 8px; margin-top: 6px; color: var(--aos-ink-muted);";
    const catList = distCard.createDiv();
    catList.style.cssText = "display: flex; flex-direction: column; gap: 6px;";

    const categories = Object.keys(snap.categoryCounts).sort((a, b) => snap.categoryCounts[b] - snap.categoryCounts[a]);
    categories.forEach(cat => {
      const count = snap.categoryCounts[cat];
      if (count === 0) return;
      const pct = snap.totalNotes > 0 ? Math.round((count / snap.totalNotes) * 100) : 0;

      const row = catList.createDiv();
      row.style.cssText = "font-size: 11px; display: flex; flex-direction: column; gap: 2px;";

      const top = row.createDiv();
      top.style.cssText = "display: flex; justify-content: space-between;";
      top.createSpan({ text: cat });
      top.createSpan({ text: `${count} 篇 (${pct}%)` }).style.cssText = "font-weight: bold;";

      const barWrap = row.createDiv();
      barWrap.style.cssText = "height: 4px; background: rgba(0,0,0,0.06); border-radius: 2px; overflow: hidden;";
      const barInner = barWrap.createDiv();
      barInner.style.cssText = `height: 100%; background: var(--aos-blueprint); width: ${pct}%;`;
    });

    // Platform distribution
    distCard.createDiv({ text: "数据源平台分布:" }).style.cssText = "font-size: 11px; font-weight: bold; margin-bottom: 8px; margin-top: 12px; color: var(--aos-ink-muted);";
    const platRow = distCard.createDiv();
    platRow.style.cssText = "display: flex; gap: 8px; justify-content: space-between; font-size: 11px;";

    Object.keys(snap.platformCounts).forEach(plat => {
      const count = snap.platformCounts[plat];
      const box = platRow.createDiv();
      box.style.cssText = "flex: 1; border: 1px solid var(--aos-border); border-radius: 4px; padding: 6px; text-align: center;";
      box.createDiv({ text: plat }).style.cssText = "color: var(--aos-ink-muted); font-size: 10px; margin-bottom: 2px;";
      box.createDiv({ text: String(count) }).style.cssText = "font-weight: bold;";
    });

    // Right Pane: 卷宗分析台账 (Scrolls Ledger)
    const ledgerPanel = rightPane.createDiv({ cls: "aos-panel" });
    ledgerPanel.createDiv({ cls: "aos-panel-title", text: "🗃️ 采集卷宗台账" });
    ledgerPanel.createDiv({ cls: "aos-panel-note", text: "模糊匹配和查看收件箱的所有流转卷宗，点击直接翻阅" });

    // Search header
    const searchForm = ledgerPanel.createDiv();
    searchForm.style.cssText = "display: flex; gap: 8px; margin-top: 10px; margin-bottom: 10px;";
    const searchInput = searchForm.createEl("input", {
      cls: "aos-search-input",
      attr: { type: "text", value: this.analyticsSearchQuery, placeholder: "输入关键词过滤卷宗列表..." }
    });
    searchInput.style.cssText = "flex: 1; padding: 6px; font-size: 12px;";
    searchInput.addEventListener("input", () => {
      this.analyticsSearchQuery = searchInput.value;
      this.ledgerDisplayLimit = 50;
      this.renderCollection();
    });

    const resetBtn = searchForm.createEl("button", { cls: "aos-btn", text: "重置" });
    resetBtn.addEventListener("click", () => {
      this.analyticsSearchQuery = "";
      this.ledgerDisplayLimit = 50;
      searchInput.value = "";
      this.renderCollection();
    });

    // Ledger table
    const tableDiv = ledgerPanel.createDiv();
    tableDiv.style.cssText = "max-height: 480px; overflow-y: auto; border: 1px solid var(--aos-border); border-radius: 6px; background: rgba(0,0,0,0.01);";

    const tbl = tableDiv.createEl("table");
    tbl.style.cssText = "width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;";

    const thead = tbl.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.style.cssText = "background: rgba(0,0,0,0.03); border-bottom: 1px solid var(--aos-border); font-weight: bold;";
    headerRow.createEl("th", { text: "卷宗题名" }).style.cssText = "padding: 6px;";
    headerRow.createEl("th", { text: "来源" }).style.cssText = "padding: 6px; width: 60px;";
    headerRow.createEl("th", { text: "建议分流" }).style.cssText = "padding: 6px; width: 110px;";
    headerRow.createEl("th", { text: "审计" }).style.cssText = "padding: 6px; width: 90px;";

    const tbody = tbl.createEl("tbody");

    // Filter scrolls
    const filterText = this.analyticsSearchQuery.toLowerCase().trim();
    const filteredScrolls = snap.scrollsList.filter(s => {
      if (!filterText) return true;
      return s.title.toLowerCase().includes(filterText) ||
             s.filePath.toLowerCase().includes(filterText) ||
             s.platform.toLowerCase().includes(filterText) ||
             s.category.toLowerCase().includes(filterText);
    });

    if (filteredScrolls.length === 0) {
      const tr = tbody.createEl("tr");
      const td = tr.createEl("td", { attr: { colspan: 4 }, text: "暂无符合条件的卷宗记载。" });
      td.style.cssText = "padding: 12px; text-align: center; color: var(--aos-ink-muted);";
    } else {
      const visibleScrolls = filteredScrolls.slice(0, this.ledgerDisplayLimit);
      visibleScrolls.forEach(item => {
        const tr = tbody.createEl("tr");
        tr.style.cssText = "border-bottom: 1px solid rgba(0,0,0,0.02); cursor: pointer; transition: background 0.1s ease;";
        tr.addEventListener("mouseenter", () => { tr.style.background = "rgba(119,157,116,0.05)"; });
        tr.addEventListener("mouseleave", () => { tr.style.background = "transparent"; });
        tr.addEventListener("click", () => {
          const file = this.app.vault.getAbstractFileByPath(item.filePath);
          if (file instanceof TFile) {
            void this.app.workspace.getLeaf(false).openFile(file);
          } else {
            new Notice(`无法找到该卷宗文件: ${item.filePath}`);
          }
        });

        // Title
        const tdTitle = tr.createEl("td");
        tdTitle.style.cssText = "padding: 6px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;";
        tdTitle.createSpan({ text: item.title });

        // Platform
        const tdPlat = tr.createEl("td");
        tdPlat.style.cssText = "padding: 6px; color: var(--aos-ink-muted);";
        tdPlat.setText(item.platform);

        // Suggested Route
        const tdRoute = tr.createEl("td");
        tdRoute.style.cssText = "padding: 6px;";
        tdRoute.setText(item.category);

        // Evidence Badge
        const tdEv = tr.createEl("td");
        tdEv.style.cssText = "padding: 6px;";
        const evBadge = tdEv.createSpan({ text: this.getEvidenceFriendlyName(item.evidence) });
        evBadge.style.cssText = "font-size: 9px; padding: 1px 4px; border-radius: 3px;";

        const ev = item.evidence;
        if (ev === "subtitle_full") evBadge.style.cssText += "background: rgba(40, 88, 58, 0.12); color: #28583a;";
        else if (ev === "subtitle_unstable") evBadge.style.cssText += "background: rgba(197, 139, 43, 0.12); color: #c58b2b;";
        else if (ev === "subtitle_suspect") evBadge.style.cssText += "background: rgba(239, 68, 68, 0.12); color: #ef4444;";
        else if (ev === "asr_failed") evBadge.style.cssText += "background: rgba(239, 68, 68, 0.15); color: #ef4444; font-weight: bold;";
        else if (ev === "asr_pending") evBadge.style.cssText += "background: rgba(0,0,0,0.06); color: var(--aos-ink-muted);";
        else evBadge.style.cssText += "background: rgba(3, 105, 161, 0.12); color: #0369a1;";
      });

      if (filteredScrolls.length > this.ledgerDisplayLimit) {
        const moreRow = tbody.createEl("tr");
        const moreTd = moreRow.createEl("td", { attr: { colspan: 4 } });
        moreTd.style.cssText = "padding: 8px; text-align: center;";
        const moreBtn = moreTd.createEl("button", { cls: "aos-btn", text: `显示更多 (还有 ${filteredScrolls.length - this.ledgerDisplayLimit} 条)...` });
        moreBtn.style.cssText = "font-size: 10px; padding: 2px 8px; cursor: pointer;";
        moreBtn.addEventListener("click", () => {
          this.ledgerDisplayLimit += 100;
          this.renderCollection();
        });
      }
    }
  }

  private getEvidenceFriendlyName(ev: string): string {
    if (ev === "subtitle_full") return "完整双轨";
    if (ev === "subtitle_unstable") return "不稳字幕";
    if (ev === "subtitle_suspect") return "低置信度";
    if (ev === "toc_metadata") return "大纲目录";
    if (ev === "asr_pending") return "ASR 处理中";
    if (ev === "asr_failed") return "ASR 故障";
    return ev;
  }

  private renderCollectionConfig(page: HTMLDivElement): void {
    const env = this.envConfig;
    const configPanel = page.createDiv({ cls: "aos-panel aos-daemon-config-panel" });
    configPanel.createDiv({ cls: "aos-panel-title", text: "⚙️ 蛤蟆祥 Daemon 环境配置编辑器" });

    const owner = this.plugin.daemonOwnership;
    let restartNote = "";
    if (owner === "managed") {
      restartNote = "保存后天工台将自动重启 Daemon 生效。";
    } else if (owner === "external") {
      restartNote = "配置已保存；当前 Daemon 由外部进程管理，请到原启动位置手动重启。";
    } else {
      restartNote = "保存配置并在下次启动时生效。";
    }

    configPanel.createDiv({
      cls: "aos-panel-note",
      text: `直接读取并安全回写 hamaxiang-system/.env 配置文件；${restartNote}`
    });

    const form = configPanel.createDiv({ cls: "aos-config-form" });

    // Tracks override status
    const overrides: Record<string, string> = {};

    const addConfigField = (key: string, name: string, desc: string, isPassword = false) => {
      const row = form.createDiv({ cls: "aos-config-row" });
      const info = row.createDiv({ cls: "aos-config-info" });
      info.createDiv({ cls: "aos-config-name", text: name });
      info.createDiv({ cls: "aos-config-desc", text: desc });

      let inputEl: HTMLInputElement;
      const value = env[key] || "";

      if (isPassword && value) {
        const statusContainer = row.createDiv({ cls: "aos-config-pwd-status" });
        statusContainer.createSpan({ cls: "aos-pwd-configured-tag", text: "🔑 已配置" });
        const modifyBtn = statusContainer.createEl("button", { cls: "aos-pwd-modify-btn", text: "修改" });

        inputEl = row.createEl("input", {
          cls: "aos-config-input is-hidden",
          attr: { type: "password", placeholder: "输入新密钥以覆盖" }
        });

        modifyBtn.addEventListener("click", () => {
          statusContainer.style.display = "none";
          inputEl.classList.remove("is-hidden");
          inputEl.focus();
        });
      } else {
        inputEl = row.createEl("input", {
          cls: "aos-config-input",
          attr: { type: isPassword ? "password" : "text", value }
        });
      }

      inputEl.addEventListener("input", () => {
        overrides[key] = inputEl.value;
      });

      return inputEl;
    };

    addConfigField("DEEPSEEK_API_KEY", "DeepSeek API 密钥", "本地大语言模型智能分析与提炼卡片摘要所用接口 Key", true);
    addConfigField("GROQ_API_KEY", "Groq API 密钥", "用于快速进行 Douyin 音频 ASR 转换的本地端点凭证", true);
    const handles = addConfigField("X_WATCH_HANDLES", "X Watch 巡逻账号", "Twitter 定时侦查目标（半角逗号分隔）");
    const proxy = addConfigField("HTTP_PROXY", "本地 HTTP 代理", "解决国内网络连接 Worker 超时问题（例如 http://127.0.0.1:7897）");
    const browserWait = addConfigField("DOUYIN_BROWSER_WAIT_MS", "抖音浏览器抓取等待时间 (ms)", "Playwright 模拟浏览页面加载的延迟阈值");

    const saveBtn = configPanel.createEl("button", {
      cls: "aos-config-save-btn",
      text: "💾 保存配置并重启 Daemon"
    });

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = "保存中...";

      const updates: Record<string, string> = {
        X_WATCH_HANDLES: handles.value.trim(),
        HTTP_PROXY: proxy.value.trim(),
        HTTPS_PROXY: proxy.value.trim(),
        DOUYIN_BROWSER_WAIT_MS: browserWait.value.trim()
      };

      // Override sensitive keys only if modified
      if (overrides["DEEPSEEK_API_KEY"] !== undefined) updates["DEEPSEEK_API_KEY"] = overrides["DEEPSEEK_API_KEY"].trim();
      if (overrides["GROQ_API_KEY"] !== undefined) updates["GROQ_API_KEY"] = overrides["GROQ_API_KEY"].trim();

      const doSaveAndRestart = async () => {
        try {
          await this.saveEnvConfig(updates);
          new Notice("配置已成功写入 .env 文件！");

          if (this.plugin.daemonOwnership === "managed") {
            const stopped = await this.plugin.stopDaemon();
            if (stopped) {
              await this.plugin.startDaemon();
              new Notice("蛤蟆祥 Daemon 进程已成功重新拉起生效！");
            } else {
              new Notice("配置已保存；但 Daemon 停止失败，请手动重启进程。");
            }
          } else if (this.plugin.daemonOwnership === "external") {
            new Notice("配置已保存；当前 Daemon 由外部进程管理，请在原启动位置重启。");
          } else {
            // offline, try start
            await this.plugin.startDaemon();
          }

          this.collectionTab = "dashboard";
          this.renderCollection();
        } catch (e) {
          new Notice(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
          saveBtn.disabled = false;
          saveBtn.textContent = "💾 保存配置并重启 Daemon";
        }
      };

      // Check active jobs count before stopping
      const snapshot = this.plugin.hamasxiangAdapter.getSnapshot();
      const activeJobs = snapshot.activeJobs || 0;
      if (activeJobs > 0 && this.plugin.daemonOwnership === "managed") {
        const confirmDiv = configPanel.createDiv({ cls: "aos-confirm-block" });
        confirmDiv.createDiv({ cls: "confirm-message", text: `⚠️ 当前有 ${activeJobs} 个任务运行中。强制重启会截断正在进行的 ASR 或巡逻任务，是否继续强制重启？` });
        const btns = confirmDiv.createDiv({ cls: "confirm-buttons" });
        const yesBtn = btns.createEl("button", { cls: "btn-confirm-yes", text: "强制重启" });
        const noBtn = btns.createEl("button", { cls: "btn-confirm-no", text: "取消" });

        yesBtn.addEventListener("click", async () => {
          confirmDiv.remove();
          await doSaveAndRestart();
        });

        noBtn.addEventListener("click", () => {
          confirmDiv.remove();
          saveBtn.disabled = false;
          saveBtn.textContent = "💾 保存配置并重启 Daemon";
        });
        return;
      }

      await doSaveAndRestart();
    });
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
    this.metric(summary, "异常", `${tasks.filter(task => task.status === "failed" || task.status === "interrupted" || task.status === "offline").length}`, "failed / interrupted / offline");
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
    const orderedItems = [...items].sort((a, b) => {
      const attentionDelta = Number(b.shouldNotify) - Number(a.shouldNotify);
      if (attentionDelta) return attentionDelta;
      const relevanceDelta = Number(b.relevant) - Number(a.relevant);
      if (relevanceDelta) return relevanceDelta;
      return b.capturedAt - a.capturedAt;
    });
    const platformCounts = new Map<string, number>();
    for (const item of items) platformCounts.set(item.platform, (platformCounts.get(item.platform) ?? 0) + 1);
    const visibleItems = orderedItems.filter(item => {
      if (this.intelligencePlatformFilter !== "all" && item.platform !== this.intelligencePlatformFilter) return false;
      if (this.intelligenceFilter === "attention") return item.shouldNotify;
      if (this.intelligenceFilter === "relevant") return item.relevant;
      return true;
    });
    const page = this.mainPane.createDiv({ cls: "aos-page aos-intelligence-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "情报 Intelligence" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "读取 X Watch 与情报雷达的真实分类结果；不在 Shell 内重复运行爬虫" });

    const freshness = page.createDiv({ cls: `aos-intelligence-freshness ${snapshot.online ? "is-online" : "is-offline"}` });
    freshness.createSpan({ cls: "aos-capture-health-dot" });
    freshness.createSpan({
      text: snapshot.online
        ? `Daemon ${snapshot.checkedAt ? `最近刷新 ${this.formatSnapshotTime(snapshot.checkedAt)}` : "在线"}`
        : "Daemon 离线，以下为最近一次成功快照",
    });
    const resourceErrors = this.plugin.hamasxiangAdapter.getResourceErrors();
    if (resourceErrors.length) {
      freshness.createSpan({
        cls: "aos-capture-health-warning",
        text: `${resourceErrors.length} 个数据源刷新失败`,
        attr: { title: resourceErrors.map(error => `${error.resource}: ${error.message}`).join("\n") },
      });
    }

    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    this.metric(metrics, "情报条目", `${items.length}`, "GET /intelligence");
    this.metric(metrics, "高相关", `${items.filter(item => item.relevant).length}`, "classifier relevant");
    this.metric(metrics, "需通知", `${items.filter(item => item.shouldNotify).length}`, "should_notify");
    this.metric(metrics, "巡逻状态", this.xWatchLabel(snapshot.xWatch), snapshot.online ? "Daemon 在线" : "Daemon 离线");

    const actions = page.createDiv({ cls: "aos-action-row" });
    this.actionButton(actions, "刷新情报", () => this.refreshIntelligence());
    this.actionButton(actions, "立即巡逻 X", () => this.runXWatch());

    const filters = page.createDiv({ cls: "aos-intelligence-filters" });
    filters.createSpan({ cls: "aos-filter-label", text: "查看范围" });
    const addFilter = (filter: "attention" | "relevant" | "all", label: string, count: number) => {
      const button = filters.createEl("button", {
        cls: "aos-intelligence-filter",
        text: `${label} ${count}`,
        attr: { type: "button", "aria-pressed": String(this.intelligenceFilter === filter) }
      });
      button.classList.toggle("is-active", this.intelligenceFilter === filter);
      button.addEventListener("click", () => {
        this.intelligenceFilter = filter;
        this.renderIntelligence();
      });
    };
    addFilter("attention", "需处理", items.filter(item => item.shouldNotify).length);
    addFilter("relevant", "高相关", items.filter(item => item.relevant).length);
    addFilter("all", "全部", items.length);

    const platformFilters = page.createDiv({ cls: "aos-intelligence-filters aos-intelligence-platform-filters" });
    platformFilters.createSpan({ cls: "aos-filter-label", text: "来源平台" });
    const platformFilterEntries = ["all", ...[...platformCounts.keys()].sort()];
    for (const platform of platformFilterEntries) {
      const button = platformFilters.createEl("button", {
        cls: "aos-intelligence-filter aos-intel-platform-filter",
        text: `${platform === "all" ? "全部" : platform} ${platform === "all" ? items.length : platformCounts.get(platform) ?? 0}`,
        attr: { type: "button", "aria-pressed": String(this.intelligencePlatformFilter === platform) },
      });
      button.classList.toggle("is-active", this.intelligencePlatformFilter === platform);
      button.addEventListener("click", () => {
        this.intelligencePlatformFilter = platform;
        this.renderIntelligence();
      });
    }

    const panel = page.createDiv({ cls: "aos-panel" });
    panel.createDiv({ cls: "aos-panel-title", text: "最近分类结果" });
    panel.createDiv({
      cls: "aos-panel-note aos-intelligence-evidence-note",
      text: "“需处理”由 Daemon 的 should_notify 标记；“高相关”是分类器相关性判断。信号等级与置信度用于排序参考，不等同于事实确认；请通过原文或已入库卷宗复核。"
    });
    if (visibleItems.length === 0 && items.length > 0) {
      panel.createDiv({ cls: "aos-empty-state", text: "当前筛选没有匹配条目；可切换关注级别或来源平台。" });
    } else {
      this.renderIntelligenceList(panel, visibleItems);
    }
  }

  private renderPlatformHealth(parent: HTMLElement, health: HamasxiangPlatformHealthSnapshot): void {
    const panel = parent.createDiv({ cls: "aos-platform-health-panel" });
    const header = panel.createDiv({ cls: "aos-platform-health-header" });
    header.createDiv({ cls: "aos-panel-title", text: "🩺 平台体检中心" });
    header.createDiv({
      cls: "aos-panel-note",
      text: `只读本机检查 · ${this.formatSnapshotTime(health.checkedAt)} · 不访问平台、不启动浏览器`,
    });

    const platformMeta: Array<[string, string, string]> = [
      ["bilibili", "B站", "📺"],
      ["douyin", "抖音", "🎵"],
      ["xiaohongshu", "小红书", "📕"],
      ["x", "X / Twitter", "𝕏"],
      ["youtube", "YouTube", "▶"],
    ];
    const grid = panel.createDiv({ cls: "aos-platform-health-grid" });
    for (const [key, label, icon] of platformMeta) {
      const value = health.platforms[key] ?? {};
      const tone = ["ready", "fallback_ready", "sidecar_ready"].includes(value.status ?? "")
        ? "is-ready"
        : ["degraded", "public_fallback_only", "login_unverified"].includes(value.status ?? "")
          ? "is-warn"
          : "is-error";
      const card = grid.createDiv({ cls: `aos-platform-health-card ${tone}` });
      const title = card.createDiv({ cls: "aos-platform-health-title" });
      title.createSpan({ text: icon });
      title.createSpan({ text: label });
      title.createSpan({ cls: "aos-platform-health-state", text: this.platformHealthStatusLabel(value.status) });
      const details: string[] = [];
      if (value.login) details.push(this.platformLoginStatusLabel(value.login));
      if (key === "bilibili") details.push(value.clipper_installed ? "Clipper 已装" : "旧 Playwright 回退");
      if (key === "douyin" && value.audio_strategy) details.push(`音轨 ${value.audio_strategy}`);
      if (key === "xiaohongshu") details.push(value.direct_core_installed ? "直连核心" : value.sidecar_installed ? "按需 Sidecar" : "公开页兜底");
      if (key === "x" && value.media_extension) details.push(value.media_extension === "ready" ? "媒体扩展开启" : value.media_extension === "available_off" ? "媒体扩展待启用" : "仅正文/页面媒体");
      if (key === "youtube") details.push(value.asr_fallback ? "ASR 兜底开启" : "字幕优先");
      card.createDiv({ cls: "aos-platform-health-detail", text: details.filter(Boolean).join(" · ") || "等待本机检查" });
    }

    const dependencies = health.dependencies;
    const cache = health.evidenceCache;
    const footer = panel.createDiv({ cls: "aos-platform-health-footer" });
    footer.createSpan({ text: `Playwright ${dependencies.playwright?.available ? "✓" : "×"}` });
    footer.createSpan({ text: `ffmpeg ${dependencies.ffmpeg?.available ? "✓" : "×"}` });
    footer.createSpan({ text: `yt-dlp ${dependencies.yt_dlp?.available ? "✓" : "×"}` });
    footer.createSpan({ text: `Groq ${dependencies.groq?.configured ? "已配置" : "未配置"}` });
    if (cache) {
      const kilobytes = Math.round((cache.bytes ?? 0) / 1024);
      footer.createSpan({ text: `重启证据 ${cache.entries ?? 0}/${cache.max_entries ?? 0} · ${kilobytes} KB · TTL ${Math.round((cache.ttl_seconds ?? 0) / 60)} 分钟` });
    }
    if (health.daemon?.capture_busy) footer.createSpan({ cls: "is-busy", text: "采集锁占用中" });
  }

  private platformHealthStatusLabel(status: string | undefined): string {
    const labels: Record<string, string> = {
      ready: "可用",
      fallback_ready: "回退链可用",
      sidecar_ready: "Sidecar 可用",
      degraded: "部分能力",
      public_fallback_only: "公开页兜底",
      dependency_missing: "缺少依赖",
    };
    return labels[status ?? ""] ?? "待检查";
  }

  private platformLoginStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      ready: "登录快照已认证",
      login_unverified: "已有 Profile，登录待验证",
      login_required: "尚无专用登录态",
    };
    return labels[status] ?? status;
  }

  private decorateGraphButton(button: HTMLButtonElement, icon: string): void {
    const label = button.textContent?.trim() ?? "";
    button.empty();
    const iconSlot = button.createSpan({ cls: "aos-graph-control-icon" });
    setIcon(iconSlot, icon);
    button.createSpan({ cls: "aos-graph-control-label", text: label });
  }

  private renderGraphPerformanceMeter(parent: HTMLElement): (sample: ForceGraphPerformanceSample) => void {
    const meter = parent.createDiv({ cls: "aos-graph-performance-meter", attr: { "data-level": "good" } });
    const toggle = meter.createEl("button", {
      cls: "aos-graph-performance-toggle",
      attr: { type: "button", title: "查看图谱性能拆解", "aria-expanded": "false" },
    });
    const icon = toggle.createSpan({ cls: "aos-graph-performance-icon" });
    setIcon(icon, "gauge");
    const label = toggle.createSpan({ cls: "aos-graph-performance-label", text: "性能采样中" });
    const detail = meter.createDiv({ cls: "aos-graph-performance-detail", attr: { hidden: "true" } });
    const detailRows = [detail.createDiv(), detail.createDiv(), detail.createDiv(), detail.createDiv({ cls: "aos-graph-performance-focus" })];
    let lastPaintedAt = 0;
    toggle.addEventListener("click", () => {
      const nextHidden = detail.getAttribute("hidden") !== null;
      if (nextHidden) detail.removeAttribute("hidden");
      else detail.setAttribute("hidden", "true");
      toggle.setAttribute("aria-expanded", String(nextHidden));
    });

    return (sample): void => {
      const now = performance.now();
      if (now - lastPaintedAt < 120) return;
      lastPaintedAt = now;
      const p95 = sample.p95FrameIntervalMs;
      const pressure = sample.simulationAlpha > 0.08 ? "力场仍在运算" : "布局已基本稳定";
      const bottleneck = sample.labelLayoutMs >= 4 && sample.labelLayoutMs >= sample.renderCommitMs * 0.45
        ? "边标签排版"
        : p95 >= 33
          ? "SVG 帧绘制 / 节点数量"
          : sample.simulationAlpha > 0.08 && p95 >= 22
            ? "力场模拟"
            : "暂无明显瓶颈";
      meter.dataset.level = p95 >= 33 ? "hot" : p95 >= 22 ? "warn" : "good";
      label.textContent = p95 > 0 ? `性能 ${Math.round(p95)}ms` : "性能采样中";
      detailRows[0]!.textContent = `节点 ${sample.nodeCount} · 连线 ${sample.edgeCount}`;
      detailRows[1]!.textContent = `p95 帧间隔 ${p95.toFixed(1)}ms · SVG 提交 ${sample.renderCommitMs.toFixed(1)}ms`;
      detailRows[2]!.textContent = `边标签排版 ${sample.labelLayoutMs.toFixed(1)}ms · 文字 ${sample.edgeLabelsVisible ? "显示" : "隐藏"} · α ${sample.simulationAlpha.toFixed(3)}`;
      detailRows[3]!.textContent = `重点：${bottleneck} · ${pressure}`;
    };
  }

  private renderGraphLabelModeControl(parent: HTMLElement): void {
    const labels: Record<ForceGraphEdgeLabelMode, string> = {
      explore: "关系文字 · 按需",
      review: "关系文字 · 全部",
      performance: "关系文字 · 关闭",
    };
    const hints: Record<ForceGraphEdgeLabelMode, string> = {
      explore: "只在选中节点时显示一跳关系",
      review: "显示全部关系文字与交叉关系线，适合审阅",
      performance: "完全关闭连线文字，优先性能",
    };
    const modes: ForceGraphEdgeLabelMode[] = ["explore", "review", "performance"];
    const button = parent.createEl("button", { cls: "aos-graph-native-btn", text: labels[this.graphEdgeLabelMode] });
    this.decorateGraphButton(button, "tags");
    const text = button.querySelector<HTMLElement>(".aos-graph-control-label");
    const update = (): void => {
      if (text) text.textContent = labels[this.graphEdgeLabelMode];
      button.setAttribute("title", hints[this.graphEdgeLabelMode]);
      button.setAttribute("aria-label", hints[this.graphEdgeLabelMode]);
    };
    button.addEventListener("click", () => {
      const currentIndex = modes.indexOf(this.graphEdgeLabelMode);
      this.graphEdgeLabelMode = modes[(currentIndex + 1) % modes.length]!;
      update();
      this.inboxGraphRuntime?.setEdgeLabelMode(this.graphEdgeLabelMode);
    });
    update();
  }

  private renderInboxGraph(): void {
    this.currentRenderId += 1;
    this.disposeInboxGraphRuntime();
    this.disposeNativeGraphView();
    this.mainPane.empty();

    const page = this.mainPane.createDiv({ cls: "aos-page aos-inbox-graph-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "收件箱地图 · Inbox Lens" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "原始卷宗的关系入口：主动采集默认入镜，后台定时信号按需展开" });

    const files = this.plugin.indexService.listFiles(INBOX_ROOT_PATH);
    const options = getInboxFacetOptions(files);
    const controls = page.createDiv({ cls: "aos-inbox-graph-controls" });
    const addSelect = (
      label: string,
      key: "area" | "platform" | "status" | "period",
      values: string[],
      display: (value: string) => string = value => value,
    ): void => {
      const field = controls.createEl("label", { cls: "aos-inbox-graph-filter" });
      field.createSpan({ text: label });
      const select = field.createEl("select");
      select.createEl("option", { value: "", text: "全部" });
      for (const value of values) select.createEl("option", { value, text: display(value) });
      select.value = this.inboxGraphFilters[key] ?? "";
      select.addEventListener("change", () => {
        this.inboxGraphFilters[key] = select.value || undefined;
        this.renderInboxGraph();
      });
    };
    addSelect("领域", "area", options.area);
    addSelect("来源", "platform", options.platform, displayInboxPlatform);
    addSelect("状态", "status", options.status);
    addSelect("月份", "period", options.period);

    const folderField = controls.createEl("label", { cls: "aos-inbox-graph-check" });
    const folderToggle = folderField.createEl("input", { attr: { type: "checkbox" } });
    folderToggle.checked = Boolean(this.inboxGraphFilters.showFolders);
    folderField.createSpan({ text: "按目录拆分来源簇" });
    folderToggle.addEventListener("change", () => {
      this.inboxGraphFilters.showFolders = folderToggle.checked;
      this.renderInboxGraph();
    });

    const passiveField = controls.createEl("label", { cls: "aos-inbox-graph-check aos-inbox-graph-passive-toggle" });
    const passiveToggle = passiveField.createEl("input", { attr: { type: "checkbox" } });
    passiveToggle.checked = Boolean(this.inboxGraphFilters.includePassive);
    passiveField.createSpan({ text: "包含后台定时信号" });
    passiveToggle.addEventListener("change", () => {
      this.inboxGraphFilters.includePassive = passiveToggle.checked;
      this.inboxGraphFilters.cluster = undefined;
      this.renderInboxGraph();
    });

    const lensActions = controls.createDiv({ cls: "aos-inbox-graph-lens-actions" });
    const overviewButton = lensActions.createEl("button", { cls: "aos-graph-native-btn", text: "总览入口" });
    this.decorateGraphButton(overviewButton, "layout-dashboard");
    overviewButton.classList.toggle("is-active", this.inboxGraphFilters.detail !== "focus");
    overviewButton.setAttribute("aria-pressed", String(this.inboxGraphFilters.detail !== "focus"));
    overviewButton.addEventListener("click", () => {
      this.inboxGraphFilters.detail = "overview";
      this.inboxGraphFilters.cluster = undefined;
      this.renderInboxGraph();
    });
    const focusButton = lensActions.createEl("button", { cls: "aos-graph-native-btn", text: "展开笔记" });
    this.decorateGraphButton(focusButton, "book-open");
    focusButton.classList.toggle("is-active", this.inboxGraphFilters.detail === "focus");
    focusButton.setAttribute("aria-pressed", String(this.inboxGraphFilters.detail === "focus"));
    focusButton.addEventListener("click", () => {
      this.inboxGraphFilters.detail = "focus";
      this.renderInboxGraph();
    });
    const nativeButton = lensActions.createEl("button", { cls: "aos-graph-native-btn", text: "返回工作台图谱" });
    this.decorateGraphButton(nativeButton, "git-branch");
    nativeButton.addEventListener("click", () => {
      this.knowledgeLens = "native";
      this.renderKnowledgeGraph();
    });

    const data = buildInboxTemplateGraph(files, this.inboxGraphFilters);
    const meta = page.createDiv({ cls: "aos-graph-meta aos-inbox-graph-meta" });
    meta.createSpan({ text: `${data.filteredCount} 条当前镜头` });
    meta.createSpan({ text: data.detail === "overview" ? `${data.noteCount} 条素材 · 标签按需展开` : `${data.nodes.filter(node => node.kind === "note").length} 条笔记节点` });
    meta.createSpan({ text: `${data.areaCount} 个区域 · ${data.sourceCount} 个来源簇 · ${data.clusterCount} 个主题簇` });
    meta.createSpan({ text: `${data.edges.length} 条模板关系` });
    if (data.hiddenNoteCount > 0) meta.createSpan({ text: `${data.hiddenNoteCount} 条未进入当前上限`, cls: "is-muted" });
    if (data.passiveExcludedCount > 0) meta.createSpan({ text: `${data.passiveExcludedCount} 条后台信号已隐藏`, cls: "is-muted" });
    if (data.truncated) meta.createSpan({ text: "已按最近修改时间截取", cls: "is-warn" });
    if (this.inboxGraphFilters.cluster) {
      const clearCluster = meta.createEl("button", { cls: "aos-graph-native-btn aos-inbox-graph-clear", text: "清除主题簇聚焦" });
      clearCluster.addEventListener("click", () => {
        this.inboxGraphFilters.cluster = undefined;
        this.renderInboxGraph();
      });
    }

    if (!this.plugin.indexService.isReady()) {
      page.createDiv({ cls: "aos-empty-state", text: "知识索引正在准备中，完成后将显示收件箱地图。" });
      return;
    }
    if (data.notes.length === 0) {
      page.createDiv({ cls: "aos-empty-state", text: "当前筛选没有收件箱笔记；可以清除筛选或先采集一条素材。" });
      return;
    }

    const layout = page.createDiv({ cls: "aos-inbox-graph-layout" });
    const mapPanel = layout.createDiv({ cls: "aos-panel aos-inbox-graph-map-panel" });
    mapPanel.createDiv({ cls: "aos-panel-title", text: data.detail === "overview" ? "语义总览地图" : "笔记聚焦地图" });
    mapPanel.createDiv({ cls: "aos-panel-note", text: data.detail === "overview"
      ? "先看区域与来源入口，不把几十个标题铺在画布上；点击入口会进入笔记聚焦。"
      : "当前只展开一个可控范围；点击笔记节点打开原文，点“总览入口”返回上一级。" });
    const legend = mapPanel.createDiv({ cls: "aos-inbox-graph-legend" });
    legend.createSpan({ text: "金色：区域" });
    legend.createSpan({ text: "蓝色：来源" });
    legend.createSpan({ text: "紫色：主题簇" });
    legend.createSpan({ text: "绿色：笔记" });
    legend.createSpan({ text: "悬停/选中：突出一跳关系" });
    const viewportTools = mapPanel.createDiv({ cls: "aos-inbox-graph-viewport-tools" });
    const resetViewport = viewportTools.createEl("button", { cls: "aos-graph-native-btn", text: "重置视角" });
    this.decorateGraphButton(resetViewport, "rotate-ccw");
    const fitViewport = viewportTools.createEl("button", { cls: "aos-graph-native-btn", text: "适配画布" });
    this.decorateGraphButton(fitViewport, "maximize-2");
    const updatePerformance = this.renderGraphPerformanceMeter(viewportTools);
    this.renderGraphLabelModeControl(viewportTools);
    const canvas = mapPanel.createDiv({ cls: "aos-inbox-graph-canvas" });
    const selection = layout.createDiv({ cls: "aos-panel aos-inbox-graph-selection" });
    selection.createDiv({ cls: "aos-panel-title", text: "选中节点" });
    const selectionBody = selection.createDiv({ cls: "aos-inbox-graph-selection-body" });
    selectionBody.createDiv({ cls: "aos-panel-note", text: "点击图上的节点查看关系详情；笔记节点会同时打开原文。" });

    const renderSelection = (node: InboxTemplateGraphNode | null): void => {
      selectionBody.empty();
      if (!node) {
        selectionBody.createDiv({ cls: "aos-panel-note", text: "点击图上的节点查看关系详情；笔记节点会同时打开原文。" });
        return;
      }
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-title", text: node.label });
      const detail = node.kind === "note" && node.note
        ? `${displayInboxPlatform(node.note.platform)} · ${node.note.captureMode === "passive" ? "后台定时" : node.note.captureMode === "active" ? "主动采集" : "来源未标注"} · ${node.note.status} · ${node.note.period}`
        : `${node.kind} · ${node.count} 条笔记`;
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-meta", text: detail });
      if (node.path) selectionBody.createDiv({ cls: "aos-inbox-graph-selection-path", text: node.path });
      if (node.path) {
        const open = selectionBody.createEl("button", { cls: "aos-graph-native-btn", text: "打开原文" });
        open.addEventListener("click", () => {
          const selected = this.toNode(node.path!);
          if (selected) {
            this.selectNode(selected);
            void this.openNode(selected);
          }
        });
      }
    };

    this.inboxGraphRuntime = new ForceGraphRuntime(canvas, data, {
      onSelect: renderSelection,
      onActivate: node => {
        if (node.kind === "note" && node.path) {
          const selected = this.toNode(node.path);
          if (selected) {
            this.selectNode(selected);
            void this.openNode(selected);
          }
          return;
        }
        if (node.kind === "area" || node.kind === "platform") {
          if (node.kind === "area") {
            this.inboxGraphFilters.area = node.area ?? node.label;
            this.inboxGraphFilters.platform = undefined;
          } else {
            this.inboxGraphFilters.platform = node.platform ?? node.label;
            this.inboxGraphFilters.area = node.area;
          }
          this.inboxGraphFilters.cluster = undefined;
          this.inboxGraphFilters.detail = "focus";
          this.renderInboxGraph();
          return;
        }
        if (node.kind === "cluster" && node.clusterKey) {
          this.inboxGraphFilters.cluster = node.clusterKey;
          this.inboxGraphFilters.detail = "focus";
          this.renderInboxGraph();
        }
      },
      onPerformanceSample: updatePerformance,
      edgeLabelMode: this.graphEdgeLabelMode,
    });
    resetViewport.addEventListener("click", () => this.inboxGraphRuntime?.resetViewport());
    fitViewport.addEventListener("click", () => this.inboxGraphRuntime?.fitToView());
    this.inboxGraphRuntime.fitToView();

    const recentPanel = layout.createDiv({ cls: "aos-panel aos-inbox-graph-recent" });
    recentPanel.createDiv({ cls: "aos-panel-title", text: data.detail === "overview" ? "当前镜头的素材" : "当前聚焦的笔记" });
    recentPanel.createDiv({ cls: "aos-panel-note", text: data.detail === "overview"
      ? "地图只显示入口；从这里可以精确打开某条原始笔记。"
      : "原始卷宗保留在原目录；这里提供可直接打开的笔记入口。" });
    const recentRows = recentPanel.createDiv({ cls: "aos-inbox-graph-recent-rows" });
    for (const note of data.notes.slice(0, 6)) {
      const row = recentRows.createDiv({ cls: "aos-inbox-graph-recent-row" });
      row.createDiv({ cls: "aos-inbox-graph-recent-title", text: note.title });
      row.createDiv({ cls: "aos-inbox-graph-recent-meta", text: `${displayInboxPlatform(note.platform)} · ${note.status} · ${note.period}` });
      row.setAttribute("title", note.path);
      row.addEventListener("click", () => {
        const node = this.toNode(note.path);
        if (node) {
          this.selectNode(node);
          void this.openNode(node);
        }
      });
    }
  }

  private renderKnowledgeGraph(): void {
    this.cancelKnowledgeGraphRefresh();
    this.renderKnowledgeAtlas();
  }

  /**
   * Coalesce VaultIndexService's create/modify/metadata/resolved burst before
   * replacing the graph host. The force simulation itself is stable after it
   * settles; the flicker came from tearing down and mounting a fresh runtime
   * for every low-level index event.
   */
  private scheduleKnowledgeGraphRefresh(): void {
    this.cancelKnowledgeGraphRefresh();
    this.knowledgeGraphRefreshTimer = window.setTimeout(() => {
      this.knowledgeGraphRefreshTimer = null;
      if (this.plugin.store.getSnapshot().activeModule === "knowledge") {
        this.renderKnowledgeGraph();
      }
    }, KNOWLEDGE_GRAPH_REFRESH_DEBOUNCE_MS);
  }

  private cancelKnowledgeGraphRefresh(): void {
    if (this.knowledgeGraphRefreshTimer === null) return;
    window.clearTimeout(this.knowledgeGraphRefreshTimer);
    this.knowledgeGraphRefreshTimer = null;
  }

  /**
   * Resolve the physical folder represented by the current semantic lens.
   *
   * The map remains a virtual projection, but the browser beside it needs a
   * concrete folder so that it can show only direct children.  We deliberately
   * derive the path from an existing note when a semantic group is focused;
   * this keeps the projection safe for root-level notes and for workspaces
   * whose first segment is not itself a folder.
   */
  private semanticBrowserRootPath(
    workspace: AethericWorkspace | null,
    selectedFolderPath: string,
    notes: Array<{ path: string }>,
  ): string {
    if (this.graphScope === "current-folder") {
      return this.effectiveGraphFolderPath(selectedFolderPath);
    }

    const roots = (workspace?.rootPaths ?? []).map(value => normalizePath(value)).sort((a, b) => b.length - a.length);
    const defaultRoot = roots[0] ?? "";
    if (!this.workspaceGraphFocus) return defaultRoot;
    const [focusGroup, focusCluster] = this.workspaceGraphFocus.split("\u0000");

    for (const note of notes) {
      const normalized = normalizePath(note.path);
      const root = roots.find(candidate => normalized === candidate || normalized.startsWith(`${candidate}/`));
      const relative = root ? normalized.slice(root.length).replace(/^\//, "") : normalized;
      const segments = relative.split("/").filter(Boolean);
      const firstSegment = segments[0];
      if (firstSegment !== focusGroup) continue;
      if (focusCluster && focusCluster !== "根目录" && segments[1] !== focusCluster) continue;
      const candidate = root
        ? normalizePath([root, firstSegment, focusCluster && focusCluster !== "根目录" ? focusCluster : ""].filter(Boolean).join("/"))
        : normalizePath([firstSegment, focusCluster && focusCluster !== "根目录" ? focusCluster : ""].filter(Boolean).join("/"));
      const abstract = candidate ? this.app.vault.getAbstractFileByPath(candidate) : this.app.vault.getRoot();
      if (abstract instanceof TFolder) return candidate;
    }

    return defaultRoot;
  }

  private semanticBrowserChildren(rootPath: string): {
    folder: TFolder | null;
    folders: TFolder[];
    notes: KnowledgeNodeViewModel[];
  } {
    const folder = rootPath
      ? this.app.vault.getAbstractFileByPath(rootPath)
      : this.app.vault.getRoot();
    if (!(folder instanceof TFolder)) return { folder: null, folders: [], notes: [] };

    const folders: TFolder[] = [];
    const notes: KnowledgeNodeViewModel[] = [];
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        if (isGraphVisiblePath(child.path)) folders.push(child);
        continue;
      }
      if (!(child instanceof TFile) || child.extension.toLowerCase() !== "md" || !isGraphVisiblePath(child.path)) continue;
      const node = this.toNode(child.path);
      if (node) notes.push(node);
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    notes.sort((a, b) => b.mtime - a.mtime);
    return { folder, folders, notes };
  }

  private focusSemanticFolder(folderPath: string): void {
    const normalized = normalizePath(folderPath);
    const folder = this.app.vault.getAbstractFileByPath(normalized);
    if (!(folder instanceof TFolder)) {
      new Notice(`目录不存在：${normalized}`);
      return;
    }
    const state = this.plugin.store.getSnapshot();
    this.plugin.store.patch({
      selectedFolderPath: normalized,
      selectedFilePath: null,
      workspaceHistory: {
        ...state.workspaceHistory,
        [state.selectedWorkspaceId]: { folderPath: normalized, selectedFilePath: null },
      },
    });
    this.selectedNode = null;
    this.graphScope = "current-folder";
    this.graphFolderPath = normalized;
    this.semanticGraphFolderPath = normalized;
    this.workspaceGraphFocus = undefined;
    this.workspaceGraphDetail = "focus";
    this.renderKnowledgeGraph();
    this.recordHistoryState(true);
  }

  private renderSemanticBrowser(
    parent: HTMLElement,
    rootPath: string,
    workspace: AethericWorkspace | null,
    fallbackNotes: Array<{ path: string; title: string; folder: string; period: string; status: string }>,
  ): void {
    const browser = parent.createDiv({ cls: "aos-panel aos-semantic-browser" });
    const header = browser.createDiv({ cls: "aos-panel-header-row" });
    header.createDiv({ cls: "aos-panel-title", text: "当前层内容" });
    const physical = header.createEl("button", {
      cls: "aos-text-button",
      text: "物理目录 ↗",
      attr: { title: "在工作台导航中打开此目录" },
    });
    physical.addEventListener("click", () => {
      if (rootPath) this.selectFolder(rootPath);
    });

    const breadcrumb = browser.createDiv({ cls: "aos-semantic-breadcrumb" });
    const rootLabel = workspace?.name || "全库";
    const rootButton = breadcrumb.createEl("button", { text: rootLabel, attr: { title: "返回工作域入口" } });
    rootButton.addEventListener("click", () => {
      this.graphScope = "current-workspace";
      this.workspaceGraphFocus = undefined;
      this.workspaceGraphDetail = "overview";
      this.renderKnowledgeGraph();
    });
    const pathParts = rootPath.split("/").filter(Boolean);
    const workspaceRoot = normalizePath(workspace?.rootPaths?.[0] ?? "");
    const relativeParts = workspaceRoot && rootPath.startsWith(`${workspaceRoot}/`)
      ? rootPath.slice(workspaceRoot.length).split("/").filter(Boolean)
      : pathParts;
    let runningPath = workspaceRoot;
    for (const part of relativeParts) {
      breadcrumb.createSpan({ cls: "aos-semantic-breadcrumb-separator", text: "/" });
      runningPath = normalizePath(runningPath ? `${runningPath}/${part}` : part);
      const partButton = breadcrumb.createEl("button", { text: part });
      const targetPath = runningPath;
      partButton.addEventListener("click", () => this.focusSemanticFolder(targetPath));
    }

    const children = this.semanticBrowserChildren(rootPath);
    const content = browser.createDiv({ cls: "aos-semantic-browser-content" });
    if (children.folder && children.folders.length > 0) {
      const folderSection = content.createDiv({ cls: "aos-semantic-browser-section" });
      folderSection.createDiv({ cls: "aos-semantic-browser-section-title", text: "子目录" });
      const folderList = folderSection.createDiv({ cls: "aos-semantic-browser-folder-list" });
      for (const folder of children.folders) {
        const button = folderList.createEl("button", { cls: "aos-semantic-browser-folder" });
        const icon = button.createSpan({ cls: "aos-semantic-browser-folder-icon" });
        setIcon(icon, "folder");
        const copy = button.createDiv({ cls: "aos-semantic-browser-entry-copy" });
        copy.createDiv({ cls: "aos-semantic-browser-entry-title", text: folder.name });
        const count = this.plugin.indexService.listFiles(folder.path).filter(file => file.extension.toLowerCase() === "md" && isGraphVisiblePath(file.path)).length;
        copy.createDiv({ cls: "aos-semantic-browser-entry-meta", text: `${count} 篇笔记 · 进入下一层` });
        button.addEventListener("click", () => this.focusSemanticFolder(folder.path));
      }
    }

    const noteEntries = children.notes.length > 0 ? children.notes : fallbackNotes.map(note => this.toNode(note.path)).filter((note): note is KnowledgeNodeViewModel => Boolean(note));
    if (noteEntries.length > 0) {
      const noteSection = content.createDiv({ cls: "aos-semantic-browser-section" });
      noteSection.createDiv({ cls: "aos-semantic-browser-section-title", text: children.notes.length > 0 ? "当前层笔记" : "当前镜头笔记" });
      const noteList = noteSection.createDiv({ cls: "aos-semantic-browser-note-list" });
      for (const note of noteEntries.slice(0, 12)) {
        const button = noteList.createEl("button", { cls: "aos-semantic-browser-note" });
        const copy = button.createDiv({ cls: "aos-semantic-browser-entry-copy" });
        copy.createDiv({ cls: "aos-semantic-browser-entry-title", text: note.title });
        copy.createDiv({ cls: "aos-semantic-browser-entry-meta", text: `${note.lifecycleStatus || "captured"} · ${new Date(note.mtime).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}` });
        button.addEventListener("click", () => {
          this.selectNode(note);
          void this.openNode(note);
        });
      }
      if (noteEntries.length > 12) {
        noteSection.createDiv({ cls: "aos-semantic-browser-more", text: `还有 ${noteEntries.length - 12} 篇，使用搜索或聚焦地图继续查看` });
      }
    }

    if (children.folders.length === 0 && noteEntries.length === 0) {
      content.createDiv({ cls: "aos-empty-state", text: "当前层没有可展示的 Markdown 笔记或子目录。" });
    }
  }

  private effectiveGraphFolderPath(fallback?: string): string {
    const candidate = this.graphScope === "current-folder" && this.graphFolderPath
      ? this.graphFolderPath
      : fallback ?? this.plugin.store.getSnapshot().selectedFolderPath;
    return candidate ? normalizePath(candidate) : "";
  }

  private selectedNoteFolderPath(): string | undefined {
    const state = this.plugin.store.getSnapshot();
    const selectedPath = this.selectedNode?.path ?? state.selectedFilePath ?? "";
    const selected = selectedPath ? this.app.vault.getAbstractFileByPath(selectedPath) : null;
    return selected instanceof TFile && selected.parent
      ? normalizePath(selected.parent.path)
      : undefined;
  }

  private graphModuleContext(): GraphModuleContext {
    const state = this.plugin.store.getSnapshot();
    return {
      selectedFilePath: this.selectedNode?.path ?? state.selectedFilePath ?? null,
      selectedFolderPath: normalizePath(state.selectedFolderPath),
      selectedNoteFolderPath: this.selectedNoteFolderPath(),
      activeDocumentFolderPath: this.activeDocumentFolderPath,
      workspaceRootPaths: this.getWorkspace()?.rootPaths ?? [],
      folderExists: folderPath => this.app.vault.getAbstractFileByPath(normalizePath(folderPath)) instanceof TFolder,
    };
  }

  private currentGraphModuleState(): GraphModuleState {
    return {
      scope: this.graphScope,
      lens: this.knowledgeLens,
      folderPath: this.graphFolderPath,
      semanticFolderPath: this.semanticGraphFolderPath,
      depth: this.workspaceGraphDepth,
      focus: this.workspaceGraphFocus,
      detail: this.workspaceGraphDetail,
      relationNodeBudget: this.relationNodeBudget,
    };
  }

  private applyGraphModuleState(state: GraphModuleState): void {
    this.graphScope = state.scope;
    this.knowledgeLens = state.lens;
    this.graphFolderPath = state.folderPath;
    this.semanticGraphFolderPath = state.semanticFolderPath;
    this.workspaceGraphDepth = state.depth;
    this.workspaceGraphFocus = state.focus;
    this.workspaceGraphDetail = state.detail;
    this.relationNodeBudget = state.relationNodeBudget;
  }

  /** Entering the graph module is a safe directory-map route, never a replay
   * of a previous full-project force graph. A selected note contributes its
   * parent folder; otherwise the navigator's current physical folder wins. */
  private prepareKnowledgeModuleEntry(): void {
    this.applyGraphModuleState(prepareGraphModuleEntry(this.graphModuleContext()));
  }

  private graphContextDetail(
    selectedFilePath: string | null,
    selectedTags: readonly string[],
    folderPath: string,
  ): string {
    if (this.graphScope === "current-file") return selectedFilePath?.split("/").pop() ?? "尚未选择笔记";
    if (this.graphScope === "current-tag") return selectedTags.slice(0, 2).join(" · ") || "尚无标签";
    if (this.graphScope === "current-workspace") return this.getWorkspace()?.name ?? "当前工作域";
    if (this.graphScope === "vault") return "全部可见笔记";
    if (
      this.graphScope === "current-folder"
      && this.activeDocumentFolderPath
      && normalizePath(folderPath) === normalizePath(this.activeDocumentFolderPath)
    ) return `跟随当前笔记 · ${folderPath || "Vault 根目录"}`;
    return folderPath || "Vault 根目录";
  }

  private setGraphScope(scope: GraphScope): void {
    const state = this.plugin.store.getSnapshot();
    this.graphScope = scope;
    if (scope === "current-folder") {
      this.graphFolderPath = normalizePath(
        this.graphFolderPath
        || this.semanticGraphFolderPath
        || state.selectedFolderPath,
      );
    }
    this.workspaceGraphFocus = undefined;
    this.workspaceGraphDepth = 1;
    this.workspaceGraphDetail = "overview";
    this.relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
    this.renderKnowledgeGraph();
    this.recordHistoryState(true);
  }

  private enterRelationshipForFolder(folderPath?: string): void {
    const result = enterGraphRelationship(
      this.currentGraphModuleState(),
      folderPath,
      this.graphModuleContext(),
    );
    this.applyGraphModuleState(result.state);
    if (result.blocked) {
      this.renderKnowledgeGraph();
      this.recordHistoryState(true);
      new Notice(result.reason === "missing-folder"
        ? "当前没有可用目录；请先在目录地图中选择一个目录。"
        : "先在目录地图中进入一个子目录，再打开关系探索；工作域根目录不会默认加载整项目节点。");
      return;
    }
    this.renderKnowledgeGraph();
    this.recordHistoryState(true);
  }

  private openGraphScopeMenu(
    event: MouseEvent,
    selectedFilePath: string | null,
    selectedTags: readonly string[],
  ): void {
    const menu = new Menu();
    for (const option of GRAPH_SCOPE_OPTIONS) {
      const unavailable = option.scope === "current-file"
        ? !selectedFilePath
        : option.scope === "current-tag" && selectedTags.length === 0;
      menu.addItem(item => item
        .setTitle(`${this.graphScope === option.scope ? "✓ " : ""}${option.label} · ${option.hint}`)
        .setIcon(option.icon)
        .setDisabled(unavailable)
        .onClick(() => this.setGraphScope(option.scope)));
    }
    menu.showAtMouseEvent(event);
  }

  private openGraphMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item => item
      .setTitle("回到工作域入口")
      .setIcon("home")
      .onClick(() => {
        this.graphScope = "current-workspace";
        this.graphFolderPath = undefined;
        this.workspaceGraphFocus = undefined;
        this.workspaceGraphDepth = 1;
        this.workspaceGraphDetail = "overview";
        this.knowledgeLens = "native";
        this.relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
        this.renderKnowledgeGraph();
        this.recordHistoryState(true);
      }));
    menu.addItem(item => item
      .setTitle("打开收件箱地图")
      .setIcon("inbox")
      .onClick(() => {
        this.knowledgeLens = "inbox";
        this.renderKnowledgeGraph();
        this.recordHistoryState(true);
      }));
    menu.addSeparator();
    menu.addItem(item => item
      .setTitle("打开官方全库图谱对照")
      .setIcon("external-link")
      .onClick(() => {
        this.app.workspace.getLeaf("tab").setViewState({ type: "graph", active: true });
        new Notice("已打开官方全库图谱；它是调试对照，不改变工作台当前目录。");
      }));
    menu.addItem(item => item
      .setTitle("快捷键设置")
      .setIcon("keyboard")
      .onClick(() => new WorkspaceShortcutModal(this.app, this.plugin, () => this.renderModeRail()).open()));
    menu.showAtMouseEvent(event);
  }

  private renderGraphCompactToolbar(
    parent: HTMLElement,
    lens: "native" | "relation",
    folderPath: string,
    selectedFilePath: string | null,
    selectedTags: readonly string[],
  ): HTMLDivElement {
    const shortcuts = normalizeWorkspaceShortcuts(this.plugin.settings.workspaceShortcuts);
    const toolbar = parent.createDiv({ cls: "aos-graph-context-toolbar" });
    const scope = GRAPH_SCOPE_OPTIONS.find(option => option.scope === this.graphScope) ?? GRAPH_SCOPE_OPTIONS[0]!;
    const context = toolbar.createEl("button", {
      cls: "aos-graph-context-trigger",
      attr: { type: "button", title: "切换图谱范围" },
    });
    const contextIcon = context.createSpan({ cls: "aos-graph-context-icon" });
    setIcon(contextIcon, scope.icon);
    const contextCopy = context.createSpan({ cls: "aos-graph-context-copy" });
    contextCopy.createSpan({ cls: "aos-graph-context-label", text: scope.label });
    contextCopy.createSpan({
      cls: "aos-graph-context-path",
      text: this.graphContextDetail(selectedFilePath, selectedTags, folderPath),
    });
    context.createSpan({ cls: "aos-graph-context-chevron", text: "⌄" });
    context.addEventListener("click", event => this.openGraphScopeMenu(event, selectedFilePath, selectedTags));

    const lenses = toolbar.createDiv({ cls: "aos-graph-lens-switch", attr: { role: "group", "aria-label": "图谱视图" } });
    const mapButton = lenses.createEl("button", {
      cls: lens === "native" ? "is-active" : "",
      attr: {
        type: "button",
        "aria-pressed": String(lens === "native"),
        "aria-keyshortcuts": shortcuts["graph.map"],
        title: "固定地块目录地图",
      },
    });
    const mapIcon = mapButton.createSpan({ cls: "aos-graph-control-icon" });
    setIcon(mapIcon, "map");
    mapButton.createSpan({ text: "目录" });
    mapButton.addEventListener("click", () => {
      if (this.knowledgeLens === "native" && this.graphScope !== "current-file") return;
      this.knowledgeLens = "native";
      if (this.graphScope === "current-file" && this.graphFolderPath) this.graphScope = "current-folder";
      this.renderKnowledgeGraph();
      this.recordHistoryState(true);
    });

    const relationButton = lenses.createEl("button", {
      cls: lens === "relation" ? "is-active" : "",
      attr: {
        type: "button",
        "aria-pressed": String(lens === "relation"),
        "aria-keyshortcuts": shortcuts["graph.relation"],
        title: "当前目录的关系探索",
      },
    });
    const relationIcon = relationButton.createSpan({ cls: "aos-graph-control-icon" });
    setIcon(relationIcon, "git-branch");
    relationButton.createSpan({ text: "关系" });
    relationButton.addEventListener("click", () => {
      if (this.knowledgeLens === "relation") return;
      this.enterRelationshipForFolder(folderPath);
    });

    const more = toolbar.createEl("button", {
      cls: "aos-graph-more-button",
      attr: { type: "button", title: "更多图谱入口", "aria-label": "更多图谱入口" },
    });
    setIcon(more, "ellipsis");
    more.addEventListener("click", event => this.openGraphMoreMenu(event));
    return toolbar;
  }

  private setWorkspaceGraphDepth(depth: WorkspaceGraphDepth, pushHistory = true): void {
    const next = WORKSPACE_GRAPH_DEPTHS.some(option => option.value === depth) ? depth : 1;
    this.workspaceGraphDepth = next;
    this.workspaceGraphDetail = next >= 3 ? "focus" : "overview";
    if (next <= 1) this.workspaceGraphFocus = undefined;
    this.renderKnowledgeGraph();
    if (pushHistory) this.recordHistoryState(true);
  }

  /**
   * Global module routing uses configurable modifier chords; the active graph
   * surface owns its unmodified A/D and Q/W/E/R keys. X1/X2 remains owned by
   * NavigationHistoryService so keyboard routing never forks browser history.
   */
  private handleShellShortcut(event: KeyboardEvent): void {
    if (this.app.workspace.activeLeaf !== this.leaf) return;
    const target = event.target;
    if (target instanceof HTMLElement && (
      target.matches("input, textarea, select, [contenteditable='true']")
      || target.closest(".aos-claudian-embed, .modal-container, .modal")
    )) return;
    const shortcuts = normalizeWorkspaceShortcuts(this.plugin.settings.workspaceShortcuts);
    const activeModule = this.plugin.store.getSnapshot().activeModule;
    const semanticMap = this.mainPane?.querySelector<HTMLElement>(".aos-semantic-graph-page") ?? null;
    const consume = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (activeModule === "knowledge") {
      if (shortcutMatches(event, shortcuts["graph.map"])) {
        consume();
        if (this.knowledgeLens !== "native" || !semanticMap) {
          this.knowledgeLens = "native";
          if (this.graphScope === "current-file" && this.graphFolderPath) this.graphScope = "current-folder";
          this.renderKnowledgeGraph();
          this.recordHistoryState(true);
          new Notice("目录地图 · A");
        }
        return;
      }
      if (shortcutMatches(event, shortcuts["graph.relation"])) {
        consume();
        if (this.knowledgeLens !== "relation") {
          this.enterRelationshipForFolder(
            this.semanticGraphFolderPath ?? this.effectiveGraphFolderPath(),
          );
          new Notice("关系探索 · D");
        }
        return;
      }

      if (semanticMap) {
        const hovered = this.hoveredSemanticGraphNode;
        if (hovered) {
          for (const depth of [0, 1, 2, 3] as const) {
            if (!shortcutMatches(event, shortcuts[GRAPH_DEPTH_SHORTCUT_IDS[depth]])) continue;
            consume();
            this.workspaceGraphFocus = this.workspaceGraphFocusForNode(hovered);
            this.setWorkspaceGraphDepth(depth);
            const option = WORKSPACE_GRAPH_DEPTHS.find(item => item.value === depth);
            new Notice(`「${hovered.label}」→ ${option?.label ?? "当前层"}`);
            return;
          }
        }

        let nextDepth: WorkspaceGraphDepth | null = null;
        if (shortcutMatches(event, shortcuts["graph.depth.previous"])) {
          nextDepth = Math.max(0, this.workspaceGraphDepth - 1) as WorkspaceGraphDepth;
        } else if (shortcutMatches(event, shortcuts["graph.depth.next"])) {
          nextDepth = Math.min(3, this.workspaceGraphDepth + 1) as WorkspaceGraphDepth;
        }
        if (nextDepth !== null) {
          consume();
          if (nextDepth !== this.workspaceGraphDepth) this.setWorkspaceGraphDepth(nextDepth);
          return;
        }
      }
    }

    for (const module of this.getVisibleModuleOrder()) {
      if (!shortcutMatches(event, shortcuts[MODULE_SHORTCUT_IDS[module]])) continue;
      consume();
      if (module !== activeModule) this.switchModule(module);
      return;
    }
  }

  private workspaceGraphDepthAtPointer(rail: HTMLElement, event: PointerEvent): WorkspaceGraphDepth | null {
    const track = rail.querySelector<HTMLElement>(".aos-semantic-depth-track");
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const verticalPadding = 28;
    if (event.clientY < rect.top - verticalPadding || event.clientY > rect.bottom + verticalPadding) return null;
    if (event.clientX < rect.left - 12 || event.clientX > rect.right + 12) return null;
    const ratio = clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    return Math.round(ratio * 3) as WorkspaceGraphDepth;
  }

  private workspaceGraphDropActionAtPointer(rail: HTMLElement, event: PointerEvent): WorkspaceGraphDropAction | null {
    const targets = Array.from(rail.querySelectorAll<HTMLElement>("[data-drop-action]"));
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      const padding = 10;
      if (
        event.clientX >= rect.left - padding
        && event.clientX <= rect.right + padding
        && event.clientY >= rect.top - padding
        && event.clientY <= rect.bottom + padding
      ) {
        const action = target.dataset.dropAction;
        if (action === "inspiration" || action === "schedule" || action === "agent") return action;
      }
    }
    return null;
  }

  private workspaceGraphRepresentative(node: InboxTemplateGraphNode): KnowledgeNodeViewModel | null {
    const paths = node.memberPaths?.length ? node.memberPaths : node.path ? [node.path] : [];
    const candidates = paths
      .map(pathValue => this.toNode(pathValue))
      .filter((candidate): candidate is KnowledgeNodeViewModel => Boolean(candidate))
      .sort((a, b) => b.mtime - a.mtime);
    return candidates[0] ?? null;
  }

  /** Preserve the selected directory path when drilling from a subdirectory. */
  private workspaceGraphFocusForNode(node: InboxTemplateGraphNode): string | undefined {
    if (node.kind === "area") return undefined;
    if (node.kind === "cluster") {
      const parent = node.groupKey ?? "根目录";
      const child = node.clusterKey ?? node.label;
      return `${parent}\u0000${child}`;
    }
    return node.groupKey ?? node.label;
  }

  private async handleWorkspaceGraphDropAction(action: WorkspaceGraphDropAction, node: InboxTemplateGraphNode): Promise<void> {
    const representative = this.workspaceGraphRepresentative(node);
    if (action === "inspiration") {
      if (representative && this.isInspirationCard(representative)) {
        await this.openNode(representative);
        new Notice(`「${representative.title}」已经是灵感卡，已打开来源笔记`);
        return;
      }
      if (representative && representative.path.startsWith(`${INBOX_ROOT_PATH}/`)) {
        await this.promoteInboxCandidate(representative);
        return;
      }
      const sample = representative ? `\n\n代表笔记：${representative.path}` : "";
      await this.addInspiration(
        `来自关系图谱目录「${node.label}」的灵感入口。\n\n请从这个入口继续筛选、深化和立项。${sample}`,
        { sourceNotePath: representative?.path, area: "knowledge" },
      );
      return;
    }

    if (action === "schedule") {
      const sourceNotePath = representative?.path;
      const snapshot = await this.plugin.planLedger.refreshTodaySnapshot();
      this.openScheduleCreateModal({
        title: `整理「${node.label}」中的内容`,
        kind: "micro_task",
        date: snapshot.date,
        scheduled: false,
        sourceNotePath,
      });
      return;
    }

    const paths = (node.memberPaths ?? (node.path ? [node.path] : [])).slice(0, 8);
    const sample = paths.length > 0
      ? paths.map(pathValue => `- ${pathValue}`).join("\n")
      : "- 当前入口暂无可列出的笔记路径";
    const prompt = [
      `请把关系图谱中的入口「${node.label}」当作一个工作上下文。`,
      `该入口约包含 ${node.count} 篇笔记；先根据代表性路径总结主题、高价值内容和待整理方向。`,
      "这是一次预览式投喂：先给出分析与建议，不要批量移动、删除、覆盖或新建笔记。",
      "代表性路径：",
      sample,
    ].join("\n");
    await this.openGlobalAgentDock(prompt, representative ?? undefined);
  }

  private renderWorkspaceGraphDropRail(parent: HTMLElement): HTMLDivElement {
    const rail = parent.createDiv({ cls: "aos-semantic-drop-rail" });
    const heading = rail.createDiv({ cls: "aos-semantic-drop-heading" });
    const titleRow = heading.createDiv({ cls: "aos-semantic-drop-heading-row" });
    const titleIcon = titleRow.createSpan({ cls: "aos-semantic-drop-heading-icon" });
    setIcon(titleIcon, "workflow");
    titleRow.createSpan({ cls: "aos-semantic-drop-title", text: "投放台" });
    titleRow.createSpan({ cls: "aos-semantic-drop-eyebrow", text: "DROP ACTIONS" });
    heading.createDiv({ cls: "aos-semantic-drop-current", text: "拖动目录/入口到目标；也可先选中节点后点击" });
    const targets = rail.createDiv({ cls: "aos-semantic-drop-actions" });
    for (const [index, action] of WORKSPACE_GRAPH_DROP_ACTIONS.entries()) {
      const target = targets.createEl("button", {
        cls: "aos-semantic-drop-action",
        attr: {
          type: "button",
          "data-drop-action": action.id,
          title: action.hint,
          "aria-label": `${action.label}：${action.hint}`,
        },
      });
      target.createSpan({ cls: "aos-semantic-drop-action-index", text: String(index + 1).padStart(2, "0") });
      const icon = target.createSpan({ cls: "aos-semantic-drop-action-icon" });
      setIcon(icon, action.icon);
      const copy = target.createSpan({ cls: "aos-semantic-drop-action-copy" });
      copy.createSpan({ cls: "aos-semantic-drop-action-label", text: action.label });
      copy.createSpan({ cls: "aos-semantic-drop-action-hint", text: action.hint });
      target.addEventListener("click", event => {
        event.stopPropagation();
        const selected = this.semanticGraphSelection;
        if (!selected) {
          new Notice("先在图谱中选中一个入口，再点击投放目标");
          return;
        }
        void this.handleWorkspaceGraphDropAction(action.id, selected);
      });
    }
    return rail;
  }

  private renderWorkspaceDepthRail(parent: HTMLElement, currentDepth: WorkspaceGraphDepth): HTMLDivElement {
    const rail = parent.createDiv({ cls: "aos-semantic-depth-rail" });
    const shortcuts = normalizeWorkspaceShortcuts(this.plugin.settings.workspaceShortcuts);
    const heading = rail.createDiv({ cls: "aos-semantic-depth-heading" });
    const titleRow = heading.createDiv({ cls: "aos-semantic-depth-heading-row" });
    const titleIcon = titleRow.createSpan({ cls: "aos-semantic-depth-heading-icon" });
    setIcon(titleIcon, "layers-3");
    titleRow.createSpan({ cls: "aos-semantic-depth-title", text: "展开轨" });
    titleRow.createSpan({ cls: "aos-semantic-depth-eyebrow", text: "DEPTH" });
    const current = heading.createDiv({ cls: "aos-semantic-depth-current", text: "整条轨道均可拖动或点击 · 悬停地块后按 Q/W/E/R" });
    const track = rail.createDiv({
      cls: "aos-semantic-depth-track",
      attr: {
        role: "slider",
        tabindex: "0",
        "aria-label": "目录展开深度",
        "aria-valuemin": "0",
        "aria-valuemax": "3",
        "aria-valuenow": String(currentDepth),
      },
    });
    track.createDiv({ cls: "aos-semantic-depth-track-bed" });
    track.createDiv({ cls: "aos-semantic-depth-progress" });
    const thumb = track.createDiv({ cls: "aos-semantic-depth-thumb" });
    thumb.createSpan({ cls: "aos-semantic-depth-thumb-core" });
    for (const option of WORKSPACE_GRAPH_DEPTHS) {
      track.createSpan({ cls: "aos-semantic-depth-notch", attr: { "data-depth": String(option.value), "aria-hidden": "true" } });
    }
    const stops = rail.createDiv({ cls: "aos-semantic-depth-stops" });
    const stopElements = new Map<WorkspaceGraphDepth, HTMLButtonElement>();

    for (const option of WORKSPACE_GRAPH_DEPTHS) {
      const stop = stops.createEl("button", {
        cls: "aos-semantic-depth-stop",
        attr: {
          type: "button",
          "data-depth": String(option.value),
          "aria-keyshortcuts": shortcuts[GRAPH_DEPTH_SHORTCUT_IDS[option.value]],
          title: option.hint,
        },
      });
      stop.createSpan({ cls: "aos-semantic-depth-stop-dot" });
      stop.createSpan({ cls: "aos-semantic-depth-stop-label", text: option.label });
      stop.createSpan({ cls: "aos-semantic-depth-stop-hint", text: option.hint });
      stop.addEventListener("click", () => {
        this.setWorkspaceGraphDepth(option.value);
      });
      stopElements.set(option.value, stop);
    }

    const updatePreview = (rawDepth: number): WorkspaceGraphDepth => {
      const depth = Math.max(0, Math.min(3, Math.round(rawDepth))) as WorkspaceGraphDepth;
      const option = WORKSPACE_GRAPH_DEPTHS.find(item => item.value === depth) ?? WORKSPACE_GRAPH_DEPTHS[1]!;
      current.setText(`${option.label} · ${option.hint}`);
      track.dataset.depth = String(depth);
      track.setAttribute("aria-valuenow", String(depth));
      track.setAttribute("aria-valuetext", `${option.label}，${option.hint}`);
      for (const [value, stop] of stopElements.entries()) stop.classList.toggle("is-active", value === depth);
      return depth;
    };

    const depthAtClientX = (clientX: number): WorkspaceGraphDepth => {
      const rect = track.getBoundingClientRect();
      const ratio = clampNumber((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      return Math.round(ratio * 3) as WorkspaceGraphDepth;
    };
    let dragDepth = currentDepth;
    track.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      track.focus();
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
      dragDepth = updatePreview(depthAtClientX(event.clientX));
    });
    track.addEventListener("pointermove", event => {
      if (!track.hasPointerCapture(event.pointerId)) return;
      dragDepth = updatePreview(depthAtClientX(event.clientX));
    });
    const finishDrag = (event: PointerEvent): void => {
      if (!track.hasPointerCapture(event.pointerId)) return;
      track.releasePointerCapture(event.pointerId);
      track.classList.remove("is-dragging");
      this.setWorkspaceGraphDepth(dragDepth);
    };
    track.addEventListener("pointerup", finishDrag);
    track.addEventListener("pointercancel", finishDrag);
    track.addEventListener("keydown", event => {
      let next = Number(track.dataset.depth ?? currentDepth);
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") next -= 1;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") next += 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = 3;
      else return;
      event.preventDefault();
      const depth = updatePreview(next);
      this.setWorkspaceGraphDepth(depth);
    });
    updatePreview(currentDepth);
    return rail;
  }

  private renderSemanticKnowledgeGraph(): void {
    this.renderKnowledgeAtlas();
    return;
    this.currentRenderId += 1;
    this.disposeInboxGraphRuntime();
    this.disposeNativeGraphView();
    this.mainPane.empty();
    this.semanticGraphSelection = null;
    this.hoveredSemanticGraphNode = null;

    const state = this.plugin.store.getSnapshot();
    const workspace = this.getWorkspace();
    const selectedFilePath = this.selectedNode?.path ?? state.selectedFilePath ?? null;
    const selectedTags = selectedFilePath
      ? (this.plugin.indexService.getIndexedFile(selectedFilePath as string)?.tags ?? [])
      : [];
    const folderPath = this.effectiveGraphFolderPath(state.selectedFolderPath);
    const rawData = this.plugin.indexService.getGraphData(
      selectedFilePath,
      this.graphScope,
      workspace,
      folderPath,
    );
    const data = buildWorkspaceSemanticGraph(
      rawData,
      this.graphScope === "vault" ? null : workspace,
      pathValue => this.plugin.indexService.getIndexedFile(pathValue),
      { detail: this.workspaceGraphDetail, depth: this.workspaceGraphDepth, focusGroup: this.workspaceGraphFocus },
    );
    const browserRoot = this.semanticBrowserRootPath(workspace, folderPath, data.notes);
    this.semanticGraphFolderPath = browserRoot || folderPath;

    const page = this.mainPane.createDiv({ cls: "aos-page aos-graph-page aos-semantic-graph-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "目录地图 · 固定地块索引" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "当前层级的内容总览；需要跨层级连线时进入独立的关系探索" });
    this.renderGraphCompactToolbar(
      page,
      "native",
      this.semanticGraphFolderPath || folderPath,
      selectedFilePath,
      selectedTags,
    );
    const meta = page.createDiv({ cls: "aos-graph-meta" });
    meta.createSpan({ text: `${data.noteCount} 条笔记进入索引` });
    meta.createSpan({ text: `${data.sourceCount} 个主题入口` });
    meta.createSpan({ text: data.detail === "overview" ? "默认隐藏标题，按需展开" : "已展开当前入口笔记" });
    if (data.hiddenNoteCount > 0) meta.createSpan({ text: `${data.hiddenNoteCount} 条未进入当前上限`, cls: "is-muted" });
    if (data.truncated) meta.createSpan({ text: "索引已按交互上限截取", cls: "is-warn" });

    if (!this.plugin.indexService.isReady() || data.notes.length === 0) {
      page.createDiv({ cls: "aos-empty-state", text: !this.plugin.indexService.isReady()
        ? "知识索引正在准备中，完成后将显示语义地图。"
        : "当前作用域没有可展示的正式笔记；机器缓存与临时输出不会进入默认地图。" });
      return;
    }

    const layout = page.createDiv({ cls: "aos-inbox-graph-layout aos-semantic-graph-layout" });
    const mapPanel = layout.createDiv({ cls: "aos-inbox-graph-map-panel aos-semantic-map-panel" });
    const depthLabel = WORKSPACE_GRAPH_DEPTHS.find(option => option.value === this.workspaceGraphDepth)?.label ?? "分区";
    mapPanel.createDiv({ cls: "aos-panel-title", text: `${depthLabel}层目录地图` });
    mapPanel.createDiv({ cls: "aos-panel-note", text: this.workspaceGraphDepth >= 3
      ? "当前层级以笔记地块呈现；方块面积按内容量加权。拖到展开轨可重新聚焦，投放台可把上下文交给灵感、日程或 Agent。"
      : "这是固定的内容地图：方块面积代表笔记量，点击方块进入下一层；地图不运行力导向，也不需要缩放或平移。" });
    const legend = mapPanel.createDiv({ cls: "aos-inbox-graph-legend" });
    legend.createSpan({ text: "面积：笔记量" });
    legend.createSpan({ text: "浅青：目录入口" });
    if (this.workspaceGraphDepth >= 2) legend.createSpan({ text: "浅紫：子目录" });
    if (this.workspaceGraphDepth >= 3) legend.createSpan({ text: "米白：笔记" });
    legend.createSpan({ text: "关系探索：查看跨层级连线" });
    legend.createSpan({ cls: "is-shortcut-hint", text: "悬停地块 + Q/W/E/R：按上下文切深度" });
    const canvas = mapPanel.createDiv({ cls: "aos-inbox-graph-canvas" });
    const dropRail: HTMLDivElement = this.renderWorkspaceGraphDropRail(mapPanel);
    const sidePanel = layout.createDiv({ cls: "aos-semantic-side" });
    // The depth rail is navigation chrome, not part of the canvas. Keeping it
    // in the side rail leaves the graph a stable, tall viewport and prevents
    // the page scrollbar from becoming the accidental depth control.
    const depthRail: HTMLDivElement = this.renderWorkspaceDepthRail(sidePanel, this.workspaceGraphDepth);
    const selection = sidePanel.createDiv({ cls: "aos-panel aos-inbox-graph-selection" });
    selection.createDiv({ cls: "aos-panel-title", text: "选中入口" });
    const selectionBody = selection.createDiv({ cls: "aos-inbox-graph-selection-body" });

    const renderSelection = (node: InboxTemplateGraphNode | null): void => {
      this.semanticGraphSelection = node;
      selectionBody.empty();
      if (!node) {
        selectionBody.createDiv({ cls: "aos-panel-note", text: "点击入口查看包含笔记数量；进入聚焦后可打开原文。" });
        return;
      }
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-title", text: node.label });
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-meta", text: node.presentation === "overflow"
        ? `可读性聚合 · ${node.count} 条笔记`
        : node.kind === "note"
          ? `${node.note?.status ?? "captured"} · ${node.note?.period ?? ""}`
          : `${node.kind === "area" ? "工作域" : node.kind === "platform" ? "主题入口" : "主题簇"} · ${node.count} 条笔记` });
      if (node.presentation === "overflow") {
        selectionBody.createDiv({ cls: "aos-panel-note", text: "为保证所有方块文字可读，地图把低权重入口收进这一格；原始笔记没有隐藏或删除。" });
        const paths = node.memberPaths?.slice(0, 8) ?? [];
        for (const pathValue of paths) {
          const entry = this.toNode(pathValue);
          if (!entry) continue;
          const open = selectionBody.createEl("button", { cls: "aos-semantic-browser-note" });
          open.createSpan({ cls: "aos-semantic-browser-entry-title", text: entry.title });
          open.addEventListener("click", () => {
            this.selectNode(entry);
            void this.openNode(entry);
          });
        }
        if ((node.memberPaths?.length ?? 0) > paths.length) {
          selectionBody.createDiv({ cls: "aos-semantic-browser-more", text: `另有 ${(node.memberPaths?.length ?? 0) - paths.length} 篇，可用顶部搜索定位` });
        }
        return;
      }
      if (node.path) {
        selectionBody.createDiv({ cls: "aos-inbox-graph-selection-path", text: node.path });
        const open = selectionBody.createEl("button", { cls: "aos-graph-native-btn", text: "打开原文" });
        open.addEventListener("click", () => {
          const selected = this.toNode(node.path!);
          if (selected) {
            this.selectNode(selected);
            void this.openNode(selected);
          }
        });
      } else if (node.memberPaths?.length) {
        selectionBody.createDiv({ cls: "aos-inbox-graph-selection-path", text: `包含 ${node.memberPaths.length} 条笔记` });
        const expand = selectionBody.createEl("button", { cls: "aos-graph-native-btn", text: "展开此入口" });
        expand.addEventListener("click", () => {
          this.workspaceGraphFocus = this.workspaceGraphFocusForNode(node);
          this.setWorkspaceGraphDepth(3);
        });
      }
    };

    this.inboxGraphRuntime = new ForceGraphRuntime(canvas, data, {
      mode: "map",
      onSelect: renderSelection,
      onHover: node => {
        this.hoveredSemanticGraphNode = node?.presentation === "overflow" ? null : node;
      },
      onActivate: node => {
        if (node.presentation === "overflow") return;
        if (node.kind === "note" && node.path) {
          const selected = this.toNode(node.path);
          if (selected) {
            this.selectNode(selected);
            void this.openNode(selected);
          }
          return;
        }
        if (node.kind === "area" || node.kind === "platform" || node.kind === "cluster") {
          this.workspaceGraphFocus = this.workspaceGraphFocusForNode(node);
          this.setWorkspaceGraphDepth(node.kind === "area" ? 1 : 3);
        }
      },
      onNodeDragMove: (node, event) => {
        if (node.presentation === "overflow") return;
        const action = dropRail ? this.workspaceGraphDropActionAtPointer(dropRail, event) : null;
        const depth = node.kind === "note" || !depthRail ? null : this.workspaceGraphDepthAtPointer(depthRail, event);
        const dropHint = dropRail?.querySelector<HTMLElement>(".aos-semantic-drop-current");
        if (dropRail) {
          dropRail.classList.toggle("is-drop-target", action !== null);
          if (action) dropRail.dataset.dropAction = action;
          else delete dropRail.dataset.dropAction;
        }
        if (depthRail) {
          depthRail.classList.toggle("is-drop-target", action === null && depth !== null);
          if (action === null && depth !== null) depthRail.dataset.dropDepth = String(depth);
          else delete depthRail.dataset.dropDepth;
        }
        if (dropHint) {
          if (action) {
            const target = WORKSPACE_GRAPH_DROP_ACTIONS.find(item => item.id === action);
            dropHint.setText(`松手${target?.label ?? "执行操作"} · ${target?.hint ?? ""}`);
          } else if (depth !== null) {
            const depthLabel = WORKSPACE_GRAPH_DEPTHS.find(item => item.value === depth)?.label ?? "当前层";
            dropHint.setText(`松手展开到${depthLabel} · 只改变地图镜头`);
          } else {
            dropHint.setText("拖动目录/入口到目标；也可先选中节点后点击");
          }
        }
      },
      onNodeDrop: (node, event) => {
        if (node.presentation === "overflow") return false;
        const action = dropRail ? this.workspaceGraphDropActionAtPointer(dropRail, event) : null;
        const dropHint = dropRail?.querySelector<HTMLElement>(".aos-semantic-drop-current");
        if (dropRail) {
          dropRail.classList.remove("is-drop-target");
          delete dropRail.dataset.dropAction;
        }
        if (depthRail) {
          depthRail.classList.remove("is-drop-target");
          delete depthRail.dataset.dropDepth;
        }
        dropHint?.setText("拖动目录/入口到目标；也可先选中节点后点击");
        if (action) {
          void this.handleWorkspaceGraphDropAction(action, node);
          return true;
        }
        if (node.kind === "note" || !depthRail) return false;
        const depth = this.workspaceGraphDepthAtPointer(depthRail, event);
        if (depth === null) return false;
        this.workspaceGraphFocus = this.workspaceGraphFocusForNode(node);
        this.setWorkspaceGraphDepth(depth);
        new Notice(`已将「${node.label}」展开到${WORKSPACE_GRAPH_DEPTHS[depth]?.label ?? "当前层"}`);
        return true;
      },
    });

    this.renderSemanticBrowser(sidePanel, browserRoot, workspace, data.notes);

    const recentPanel = sidePanel.createDiv({ cls: "aos-panel aos-inbox-graph-recent" });
    recentPanel.createDiv({ cls: "aos-panel-title", text: "关系焦点" });
    recentPanel.createDiv({ cls: "aos-panel-note", text: "地图负责发现语义关系；点击入口或笔记后，右侧保留可直接打开的路径。" });
    const recentRows = recentPanel.createDiv({ cls: "aos-inbox-graph-recent-rows" });
    for (const note of data.notes.slice(0, 6)) {
      const row = recentRows.createDiv({ cls: "aos-inbox-graph-recent-row" });
      row.createDiv({ cls: "aos-inbox-graph-recent-title", text: note.title });
      row.createDiv({ cls: "aos-inbox-graph-recent-meta", text: `${note.folder.split("/").pop() ?? "根目录"} · ${note.period}` });
      row.setAttribute("title", note.path);
      row.addEventListener("click", () => {
        const node = this.toNode(note.path);
        if (node) {
          this.selectNode(node);
          void this.openNode(node);
        }
      });
    }
  }

  /**
   * Budgeted relationship explorer backed by the packaged SVG force-graph runtime.
   * Unlike the embedded Obsidian Graph, this renderer consumes the exact node
   * set returned by VaultIndexService, so the visible budget is real rather
   * than a metadata-only estimate beside an unbounded canvas.
   */
  private renderRelationshipKnowledgeGraph(): void {
    this.currentRenderId += 1;
    const reusableCanvas = this.mainPane.querySelector<HTMLDivElement>(".aos-relation-graph-canvas");
    const reusableRuntime = reusableCanvas ? this.inboxGraphRuntime : null;
    const previousContextKey = reusableCanvas?.dataset.graphContextKey ?? "";
    const previousScrollTop = this.mainPane.scrollTop;
    reusableCanvas?.remove();
    if (!reusableRuntime) this.disposeInboxGraphRuntime();
    this.disposeNativeGraphView();
    this.mainPane.empty();

    const state = this.plugin.store.getSnapshot();
    const selectedFilePath = this.selectedNode?.path ?? state.selectedFilePath ?? null;
    const selectedTags = selectedFilePath
      ? (this.plugin.indexService.getIndexedFile(selectedFilePath)?.tags ?? [])
      : [];
    const hasCurrentTag = selectedTags.length > 0;
    const folderPath = this.effectiveGraphFolderPath(state.selectedFolderPath);
    const rawData = this.graphScope === "current-tag" && !hasCurrentTag
      ? { nodes: [], edges: [], truncated: false }
      : this.plugin.indexService.getGraphData(
        selectedFilePath,
        this.graphScope,
        this.getWorkspace(),
        folderPath,
        this.relationNodeBudget,
      );
    const data = buildWorkspaceRelationGraph(
      rawData,
      pathValue => this.plugin.indexService.getIndexedFile(pathValue),
    );
    const contextKey = [this.graphScope, folderPath, this.graphScope === "current-file" ? selectedFilePath ?? "" : ""].join("|");

    const page = this.mainPane.createDiv({ cls: "aos-page aos-graph-page aos-relation-graph-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "关系探索 · Aetheric Graph" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "只渲染当前范围内的真实笔记与双链；点击节点可收束为一跳邻域" });
    this.renderGraphCompactToolbar(page, "relation", folderPath, selectedFilePath, selectedTags);

    const meta = page.createDiv({ cls: "aos-graph-meta aos-relation-graph-meta" });
    meta.createSpan({ text: `${data.nodes.length} 个节点` });
    meta.createSpan({ text: `${data.edges.length} 条真实关系` });
    meta.createSpan({ text: `当前预算 ${this.relationNodeBudget}` });
    if (rawData.truncated) meta.createSpan({ text: "其余节点尚未挂载", cls: "is-warn" });
    const budgetActions = meta.createDiv({ cls: "aos-relation-budget-actions" });
    if (rawData.truncated && this.relationNodeBudget < MAX_RELATION_NODE_BUDGET) {
      const expand = budgetActions.createEl("button", { cls: "aos-graph-native-btn", text: "继续展开" });
      this.decorateGraphButton(expand, "unfold-vertical");
      expand.addEventListener("click", () => {
        this.relationNodeBudget = expandRelationNodeBudget(this.relationNodeBudget);
        this.renderRelationshipKnowledgeGraph();
        this.recordHistoryState(true);
      });
    }
    if (this.relationNodeBudget > DEFAULT_RELATION_NODE_BUDGET) {
      const compact = budgetActions.createEl("button", { cls: "aos-graph-native-btn", text: "恢复轻量" });
      this.decorateGraphButton(compact, "minimize-2");
      compact.addEventListener("click", () => {
        this.relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
        this.renderRelationshipKnowledgeGraph();
        this.recordHistoryState(true);
      });
    }

    if (!this.plugin.indexService.isReady()) {
      reusableRuntime?.destroy();
      if (this.inboxGraphRuntime === reusableRuntime) this.inboxGraphRuntime = null;
      page.createDiv({ cls: "aos-empty-state", text: "知识索引正在准备中，完成后将显示当前范围关系。" });
      return;
    }
    if (data.nodes.length === 0) {
      reusableRuntime?.destroy();
      if (this.inboxGraphRuntime === reusableRuntime) this.inboxGraphRuntime = null;
      const message = this.graphScope === "current-file"
        ? "当前笔记没有可展示的一跳关系。可返回当前目录继续探索。"
        : this.graphScope === "current-tag"
          ? "当前笔记没有可用标签，无法生成标签关系。"
          : "当前目录内暂无可展示的笔记关系。";
      page.createDiv({ cls: "aos-empty-state", text: message });
      return;
    }

    const layout = page.createDiv({ cls: "aos-relation-graph-layout" });
    const mapPanel = layout.createDiv({ cls: "aos-panel aos-relation-graph-map" });
    const mapHeader = mapPanel.createDiv({ cls: "aos-relation-graph-map-header" });
    const mapHeading = mapHeader.createDiv();
    mapHeading.createDiv({ cls: "aos-panel-title", text: this.graphScope === "current-file" ? "一跳关系镜头" : "当前目录关系镜头" });
    mapHeading.createDiv({ cls: "aos-panel-note", text: "默认只显示选中节点的一跳文字；继续展开会提高真实渲染预算。" });
    const tools = mapHeader.createDiv({ cls: "aos-inbox-graph-viewport-tools" });
    this.renderGraphLabelModeControl(tools);
    const resetViewport = tools.createEl("button", { cls: "aos-graph-native-btn", text: "重置" });
    this.decorateGraphButton(resetViewport, "rotate-ccw");
    const fitViewport = tools.createEl("button", { cls: "aos-graph-native-btn", text: "适配" });
    this.decorateGraphButton(fitViewport, "maximize-2");
    const updatePerformance = this.renderGraphPerformanceMeter(tools);
    const canvas = reusableCanvas ?? mapPanel.createDiv({ cls: "aos-inbox-graph-canvas aos-relation-graph-canvas" });
    if (reusableCanvas) mapPanel.appendChild(reusableCanvas);
    canvas.dataset.graphContextKey = contextKey;

    const side = layout.createDiv({ cls: "aos-panel aos-relation-graph-side" });
    side.createDiv({ cls: "aos-panel-title", text: "关系焦点" });
    const selectionBody = side.createDiv({ cls: "aos-inbox-graph-selection-body" });
    const renderSelection = (node: InboxTemplateGraphNode | null): void => {
      selectionBody.empty();
      if (!node?.path) {
        selectionBody.createDiv({ cls: "aos-panel-note", text: "点击一个节点查看路径；可打开原文，或只保留它的一跳邻域。" });
        return;
      }
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-title", text: node.label });
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-path", text: node.path });
      const relationCounts = this.plugin.indexService.getRelationCounts(node.path);
      selectionBody.createDiv({ cls: "aos-inbox-graph-selection-meta", text: `出链 ${relationCounts.outgoing} · 反链 ${relationCounts.backlinks}` });
      const actions = selectionBody.createDiv({ cls: "aos-relation-focus-actions" });
      const open = actions.createEl("button", { cls: "aos-graph-native-btn", text: "打开原文" });
      this.decorateGraphButton(open, "file-text");
      open.addEventListener("click", () => {
        const selected = this.toNode(node.path!);
        if (selected) {
          this.selectNode(selected);
          void this.openNode(selected);
        }
      });
      const focus = actions.createEl("button", { cls: "aos-graph-native-btn is-primary", text: "以此为中心" });
      this.decorateGraphButton(focus, "focus");
      focus.addEventListener("click", () => {
        const selected = this.toNode(node.path!);
        if (!selected) return;
        this.selectNode(selected, false);
        this.graphScope = "current-file";
        this.relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
        this.renderRelationshipKnowledgeGraph();
        this.recordHistoryState(true);
      });
    };
    renderSelection(null);
    if (this.graphScope === "current-file" && this.graphFolderPath) {
      const back = side.createEl("button", { cls: "aos-graph-native-btn aos-relation-back-folder", text: "返回当前目录" });
      this.decorateGraphButton(back, "folder-tree");
      back.addEventListener("click", () => {
        this.graphScope = "current-folder";
        this.relationNodeBudget = DEFAULT_RELATION_NODE_BUDGET;
        this.renderRelationshipKnowledgeGraph();
        this.recordHistoryState(true);
      });
    }

    const runtimeOptions = {
      mode: "force",
      relationshipLayout: "force",
      edgeLabelMode: this.graphEdgeLabelMode,
      preserveViewportOnUpdate: previousContextKey === contextKey,
      onSelect: renderSelection,
      onPerformanceSample: updatePerformance,
    } as const;
    if (reusableRuntime) {
      reusableRuntime.updateData(data, runtimeOptions);
      this.inboxGraphRuntime = reusableRuntime;
    } else {
      this.inboxGraphRuntime = new ForceGraphRuntime(canvas, data, runtimeOptions);
    }
    resetViewport.addEventListener("click", () => this.inboxGraphRuntime?.resetViewport());
    fitViewport.addEventListener("click", () => this.inboxGraphRuntime?.fitToView());
    this.mainPane.scrollTop = previousScrollTop;
  }

  private renderNativeKnowledgeGraph(): void {
    if (this.knowledgeLens === "inbox") {
      this.renderInboxGraph();
      return;
    }
    this.disposeInboxGraphRuntime();
    if (this.mainPane.querySelector(".aos-inbox-graph-page, .aos-semantic-graph-page")) {
      this.mainPane.empty();
    }
    // Treat every scope/context update as a new render transaction so delayed
    // work from an older native graph cannot overwrite the current scope.
    this.currentRenderId += 1;
    const state = this.plugin.store.getSnapshot();
    const selectedFilePath = this.selectedNode?.path ?? state.selectedFilePath ?? null;
    const selectedTags = selectedFilePath
      ? (this.plugin.indexService.getIndexedFile(selectedFilePath)?.tags ?? [])
      : [];
    const hasCurrentTag = selectedTags.length > 0;

    const folderPath = this.effectiveGraphFolderPath(state.selectedFolderPath);

    // ── 原地热更新 (In-place Hot Update) ──
    const existingPage = this.mainPane.querySelector(".aos-graph-page");
    if (existingPage) {
      // Rebuild only the lightweight context bar. The native graph host stays
      // mounted, so changing scope does not flash or restart the whole page.
      const staleToolbar = existingPage.querySelector(".aos-graph-context-toolbar");
      const nextToolbar = this.renderGraphCompactToolbar(
        existingPage as HTMLElement,
        "relation",
        folderPath,
        selectedFilePath,
        selectedTags,
      );
      if (staleToolbar) {
        existingPage.insertBefore(nextToolbar, staleToolbar);
        staleToolbar.remove();
      } else {
        existingPage.insertBefore(nextToolbar, existingPage.querySelector(".aos-graph-meta"));
      }

      // Fetch new graph data based on scope & workspace.
      const data = this.graphScope === "current-tag" && !hasCurrentTag
        ? { nodes: [], edges: [], truncated: false }
        : this.plugin.indexService.getGraphData(
          selectedFilePath,
          this.graphScope,
          this.getWorkspace(),
          folderPath,
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
    heading.createDiv({ cls: "aos-page-title", text: this.knowledgeLens === "relation" ? "关系探索 · Aetheric Graph" : "局部关系图谱 · Aetheric Graph" });
    heading.createDiv({ cls: "aos-page-subtitle", text: this.knowledgeLens === "relation"
      ? "跨层级查看双链与语义关系；这里保留缩放、平移和力导向，只服务于关系探索"
      : "当前节点的原生局部关系；目录总览请返回固定目录地图" });
    this.renderGraphCompactToolbar(page, "relation", folderPath, selectedFilePath, selectedTags);

    const data = this.graphScope === "current-tag" && !hasCurrentTag
      ? { nodes: [], edges: [], truncated: false }
      : this.plugin.indexService.getGraphData(
        selectedFilePath,
        this.graphScope,
        this.getWorkspace(),
        folderPath,
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
      const folderPath = this.effectiveGraphFolderPath(this.plugin.store.getSnapshot().selectedFolderPath);
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

  private formatSnapshotTime(value: number): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  private taskStatusLabel(status: OperationTask["status"] | string): string {
    const labels: Record<string, string> = {
      online: "在线",
      offline: "离线",
      queued: "排队中",
      running: "抓取中",
      awaiting_sync: "等待同步",
      insufficient_evidence: "证据不足",
      blocked: "被阻塞",
      success: "已完成",
      failed: "失败",
      interrupted: "被 Daemon 重启打断",
      idle: "待命",
      unknown: "未知",
    };
    return labels[status] ?? status;
  }

  private renderCaptureReceipt(parent: HTMLElement, receipt: HamasxiangCaptureReceipt): void {
    parent.empty();
    const task = this.plugin.hamasxiangAdapter.getTasks().find(item => item.id === `hamaxiang-job-${receipt.jobId}`);
    const status = task ? task.status : receipt.status;
    const row = parent.createDiv({ cls: `aos-capture-receipt ${status}` });
    const header = row.createDiv({ cls: "aos-capture-receipt-header" });
    header.createSpan({ cls: "aos-capture-receipt-title", text: "最近一次采集" });
    header.createSpan({ cls: "aos-task-status-badge", text: this.taskStatusLabel(status) });
    row.createDiv({
      cls: "aos-capture-receipt-detail",
      text: `${receipt.sourceUrls.length || 1} 条链接${receipt.platform ? ` · ${receipt.platform}` : ""} · 任务 ${receipt.jobId.slice(0, 8)}`,
    });
    const humanDetail = status === "success"
      ? "已完成；请在收件箱或灵感轨查看结果。"
      : status === "awaiting_sync"
        ? "内容已抓取，正在等待 Vault / 云端同步。"
        : status === "insufficient_evidence"
          ? "页面已访问，但正文、字幕或 ASR 证据不足，未写入正式笔记。"
          : status === "interrupted"
            ? "Daemon 已尝试从本地证据断点续跑，但当前条件不足；证据过期或缺失时再按原链接重试。"
            : status === "failed"
            ? "采集失败；可在任务页查看发生层级后重试。"
            : "任务已交给本地 Daemon，状态会自动刷新。";
    row.createDiv({ cls: "aos-capture-receipt-message", text: humanDetail });
  }

  private renderPlannedModule(module: AethericModule): void {
    const meta: Record<string, [string, string]> = {
      collection: ["采集 Collection", "通过 HamasxiangAdapter 消费本地 Daemon 状态与操作入口。"],
      tasks: ["任务 Tasks", "统一消费 Daemon 的真实任务快照；未提供的审批状态保持为空。"],
      intelligence: ["情报 Intelligence", "读取 X Watch 与情报雷达的真实分类结果。"],
      inspiration: ["灵感 Inspiration", "读取微信想法收件箱中的真实灵感笔记。"],
      knowledge: ["工作台图谱 Aetheric Graph", "以当前工作域节点为主镜头的关系图谱；收件箱地图作为独立镜头。"],
      overview: ["总览", ""], navigation: ["导航", ""], logs: ["日志", ""],
    };
    const [title, detail] = meta[module];
    const page = this.mainPane.createDiv({ cls: "aos-page aos-planned-page" });
    page.createDiv({ cls: "aos-page-title", text: title });
    page.createDiv({ cls: "aos-empty-state", text: detail });
    const actions = page.createDiv({ cls: "aos-action-row" });
  }

  private refreshVirtualList(): void {
    if (!this.virtualList) return;
    const state = this.plugin.store.getSnapshot();
    const workspace = this.getWorkspace();
    const items = this.plugin.indexService.search(state.searchQuery, workspace, state.selectedFolderPath, state.searchScope);
    this.virtualList.setItems(items, state.selectedFilePath);
  }

  private switchModule(module: AethericModule, pushHistory = true): void {
    const previousModule = this.plugin.store.getSnapshot().activeModule;
    if (module === previousModule) {
      if (module === "inspiration" && this.inspirationRecycleOpen) {
        this.inspirationRecycleOpen = false;
        this.renderModeRail();
        this.renderMain();
      }
      return;
    }
    const startedAt = performance.now();
    if (module === "knowledge" && previousModule !== "knowledge") {
      this.prepareKnowledgeModuleEntry();
    }
    if (module === "inspiration") this.inspirationRecycleOpen = false;
    this.plugin.store.patch({ activeModule: module });
    this.renderModeRail();
    const navigationSurfaceChanged = previousModule === "navigation" || module === "navigation";
    if (navigationSurfaceChanged) this.renderNavigator();
    this.renderMain();
    if (navigationSurfaceChanged) this.renderContext();
    this.plugin.logBus.append(
      "info",
      "shell.route",
      `切换到 ${MODULES.find(item => item.id === module)?.label ?? module}`,
      Math.round(performance.now() - startedAt),
    );
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
    this.activeDocumentFolderPath = undefined;
    this.captureActiveDocumentFolder(this.app.workspace.getActiveFile());
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
    if (capability.id === "cloud-sync") {
      this.switchModule("tasks");
      new Notice("云端同步：已切换至任务流面板");
      return;
    }
    if (capability.id === "asr-repair") {
      this.switchModule("tasks");
      new Notice("ASR 修复：已切换至任务流面板");
      return;
    }
    if (capability.id === "publish") {
      this.switchModule("navigation");
      new Notice("松果屋博客发布控制台已就绪；1.0 旧版外部窗口已退役。");
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
        ["灵感", "打开灵感收件箱", () => this.switchModule("inspiration")],
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
        .map(workspace => ({ primary: `${this.getWorkspaceEmoji(workspace.icon)} ${workspace.name}`, secondary: "切换工作域", action: () => this.selectWorkspace(workspace.id) })));
      return;
    }
    if (value.startsWith("@")) {
      this.showCommandItems([{ primary: "Agent 路由尚未接入", secondary: "不会虚构 Agent 执行；当前可在蛤蟆祥控制台使用现有能力", action: () => this.switchModule("tasks") }]);
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
    if (!push) return;
    this.plugin.navigationHistory.recordShellState(this, this.getNavigationSnapshot());
  }

  private async openNode(node: KnowledgeNodeViewModel): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) {
      new Notice(`文件不存在：${node.path}`);
      return;
    }

    const transitionToken = this.plugin.layoutCoordinator.beginDocumentOpen();

    // 1. If the file is already open in any workspace tab, switch to it immediately
    let existingLeaf: any = null;
    this.app.workspace.iterateAllLeaves(l => {
      if (l.view && (l.view as any).file && (l.view as any).file.path === file.path) {
        existingLeaf = l;
      }
    });

    if (existingLeaf) {
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      this.plugin.logBus.append("success", "workspace.open", `已切换 to 已有标签页：${node.path}`);
      this.plugin.layoutCoordinator.completeDocumentOpen(transitionToken);
      return;
    }

    // 2. Spawn a new tab leaf
    const leaf = this.app.workspace.getLeaf("tab");

    // 3. Load the file before activating its tab. Activating an empty leaf first
    // can leave the shell visually selected while the Markdown leaf is still
    // mounting, which looks like an empty centre pane once both sidebars open.
    try {
      await leaf.openFile(file);
      // Make the loaded Markdown leaf, not the temporary empty leaf, the
      // authoritative active surface. This is also what lets Copilot pick up
      // the current note context after the dock is revealed.
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      this.plugin.logBus.append("success", "workspace.open", `已在原生编辑器和右侧大纲栏打开：${node.path}`);
    } finally {
      this.plugin.layoutCoordinator.completeDocumentOpen(transitionToken);
    }
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
    if (!this.indexStatus) return;
    const nextText = this.showIndexStatusText();
    if (this.indexStatus.textContent !== nextText) this.indexStatus.textContent = nextText;
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

  /**
   * Apply the module-to-surface contract in one place.  The rails stay
   * persistent, while the node context pane is mounted only by navigation.
   * Feature pages therefore cannot accidentally inherit navigation DOM.
   */
  private applyModuleSurfacePolicy(module = this.plugin.store.getSnapshot().activeModule): void {
    if (!this.root) return;
    this.root.dataset.aosModule = module;
    const contextVisible = moduleUsesContextPane(module);
    this.root.classList.toggle("aos-hide-context-pane", !contextVisible);
    this.contextPane?.setAttribute("aria-hidden", contextVisible ? "false" : "true");
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
      if (item.shouldNotify) row.addClass("is-attention");
      const dot = row.createSpan({ cls: "aos-status-dot" });
      if (!item.relevant) dot.addClass("is-idle");
      else if (item.shouldNotify) dot.addClass("is-running");

      const primary = row.createDiv({ cls: "aos-task-primary" });
      const titleRow = primary.createDiv({ cls: "aos-task-title-row" });
      titleRow.createSpan({ cls: "aos-task-title", text: item.title });
      titleRow.createSpan({ cls: "aos-intel-platform-badge", text: item.platform || "网页" });

      if (item.relevant) {
        titleRow.createSpan({ cls: "aos-core-badge", text: "高相关" });
      }
      if (item.shouldNotify) {
        titleRow.createSpan({ cls: "aos-attention-badge", text: "需处理" });
      }

      const detailContainer = primary.createDiv({ cls: "aos-task-detail-container" });
      const metadataParts = [
        item.author,
        `信号 ${item.signalLevel}`,
        item.confidence !== undefined ? `置信度 ${Math.round(item.confidence * 100)}%` : "",
        item.capturedAt ? `抓取 ${this.formatSnapshotTime(item.capturedAt)}` : "",
      ].filter(Boolean);

      detailContainer.createSpan({ cls: "aos-task-detail", text: metadataParts.join(" · ") || "暂无元数据" });
      if (item.summary) {
        const summary = item.summary.replace(/\s+/g, " ").trim();
        detailContainer.createDiv({
          cls: "aos-intelligence-summary",
          text: summary.length > 260 ? `${summary.slice(0, 257)}…` : summary,
        });
      }

      if (item.tags && item.tags.length > 0) {
        const tagContainer = detailContainer.createDiv({ cls: "aos-intel-tag-container" });
        item.tags.slice(0, 5).forEach(tag => {
          tagContainer.createSpan({ cls: "aos-intel-tag", text: `#${tag}` });
        });
      }

      if (item.resultPath || item.url) {
        const actions = row.createDiv({ cls: "aos-task-actions" });
        if (item.resultPath) {
          const resultButton = actions.createEl("button", { cls: "aos-task-action-btn", text: "打开卷宗" });
          resultButton.addEventListener("click", () => this.openFileByPath(item.resultPath!));
        }
        if (item.url) {
          const sourceButton = actions.createEl("button", { cls: "aos-task-action-btn", text: "查看原文" });
          sourceButton.addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
        }
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
      if (task.status === "failed" || task.status === "interrupted" || task.status === "offline" || task.status === "blocked") {
        dot.addClass("is-error");
      } else if (task.status === "running" || task.status === "awaiting_sync") {
        dot.addClass("is-running");
      } else if (task.status === "queued" || task.status === "insufficient_evidence") {
        dot.addClass("is-queued");
      } else if (task.status === "idle" || task.status === "unknown") {
        dot.addClass("is-idle");
      }

      const primary = row.createDiv({ cls: "aos-task-primary" });
      const titleRow = primary.createDiv({ cls: "aos-task-title-row" });
      titleRow.createSpan({ cls: "aos-task-title", text: task.title });
      titleRow.createSpan({ cls: `aos-task-status-badge is-${task.status}`, text: this.taskStatusLabel(task.status) });
      if (task.detail && !mini) {
        primary.createDiv({ cls: "aos-task-detail", text: task.detail });
      }

      const meta = row.createDiv({ cls: "aos-task-meta" });
      if (task.progress !== undefined && (task.status === "running" || task.status === "awaiting_sync" || task.status === "queued")) {
        const progressTrack = meta.createDiv({ cls: "aos-task-progress-track" });
        const progressFill = progressTrack.createDiv({ cls: "aos-task-progress-fill" });
        progressFill.style.width = `${task.progress}%`;
      } else if (task.detail && mini) {
        meta.createSpan({ text: task.detail, cls: "aos-task-mini-detail" });
      } else {
        meta.createSpan({ text: this.taskStatusLabel(task.status), cls: "aos-task-source" });
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
      this.switchModule("tasks");
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

  private metric(parent: HTMLElement, label: string, value: string, detail: string): HTMLDivElement {
    const card = parent.createDiv({ cls: "aos-metric-card" });
    card.createDiv({ cls: "aos-metric-label", text: label });
    card.createDiv({ cls: "aos-metric-value", text: value });
    card.createDiv({ cls: "aos-metric-detail", text: detail });
    return card;
  }

  private refreshOverviewRecent(): boolean {
    const value = this.overviewRecentMetricValue;
    const panel = this.overviewRecentPanel;
    if (!value?.isConnected || !panel?.isConnected) return false;
    const recentCount = `${this.plugin.store.getSnapshot().recentFilePaths.length}`;
    if (value.textContent !== recentCount) value.textContent = recentCount;
    panel.empty();
    panel.createDiv({ cls: "aos-panel-title", text: "最近知识节点" });
    this.renderRecentNodeCards(panel, 6);
    return true;
  }

  private disposeInboxGraphRuntime(): void {
    const runtime = this.inboxGraphRuntime;
    this.inboxGraphRuntime = null;
    this.hoveredSemanticGraphNode = null;
    runtime?.destroy();
  }

  private buildInspirationPrompt(file: KnowledgeNodeViewModel): string {
    return [
      "请整理当前上下文中的这条收件箱素材，作为 Aetheric OS 的灵感卡处理。",
      `来源笔记：${file.path}`,
      "先不要改写、移动、覆盖或删除原始卷宗，也不要直接创建正式笔记。请在当前对话输出：",
      "1. 一句话核心；",
      "2. 3–7 条高密度事实或方法；",
      "3. 可迁移到我的项目/写作/生活的灵感；",
      "4. 建议归入的领域与关键词；",
      "5. 是否值得深化为正式笔记，以及推荐落点；",
      "6. 一个可排入日程的最小下一步。",
      "如果素材价值很低或已经过时，请明确标记并给出归档建议。等我说“落库”后，再按工作台流程写入。",
    ].join("\n");
  }

  private async openGlobalAgentDock(prompt?: string, nodeOverride?: KnowledgeNodeViewModel | null): Promise<boolean> {
    const node = nodeOverride === undefined ? this.selectedNode : nodeOverride;
    if (node) {
      await this.openNode(node);
    } else {
      await this.openBlankNativePage();
      await this.revealFileExplorer();
    }

    if (!CompatAdapter.isCopilotAvailable(this.app)) {
      new Notice("Copilot 尚未启用，无法打开蛤蟆祥对话侧栏。");
      return false;
    }
    try {
      let leaf: any = this.app.workspace.getLeavesOfType("copilot-chat-view")[0] ?? null;
      if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(true);
        if (!leaf) throw new Error("Right sidebar leaf unavailable");
        await leaf.setViewState({ type: "copilot-chat-view", active: true });
      }
      if (leaf.view?.getViewType?.() !== "copilot-chat-view") {
        await leaf.setViewState({ type: "copilot-chat-view", active: true });
      }
      await this.app.workspace.revealLeaf(leaf);
      const restored = await this.plugin.copilotSessionBridge.restoreLatestOnce();
      // The view is mounted asynchronously; let Copilot finish its React
      // mount before using its public chat state bridge.
      if (prompt) await new Promise(resolve => window.setTimeout(resolve, 80));
      const sent = prompt
        ? await this.plugin.copilotSessionBridge.sendPrompt(prompt, node?.path)
        : false;
      const target = node ? node.path : "空白原生页";
      this.plugin.logBus.append("info", "agent.dock", `已打开${target}并唤出右侧蛤蟆祥`);
      if (!prompt) {
        new Notice(
          restored
            ? "已打开蛤蟆祥并恢复上一次 Copilot 对话。"
            : node
            ? "已打开对应笔记并唤出蛤蟆祥；需要全文时请在右侧点击 Add context。"
            : "当前未选中笔记：已打开空白页、文件目录与蛤蟆祥。",
          5000,
        );
      }
      return sent;
    } catch (error) {
      console.warn("Failed to reveal Copilot agent dock", error);
      new Notice("无法打开 Copilot 对话侧栏；请确认插件已启用后重试。");
      return false;
    }
  }

  private async refreshIntelligence(): Promise<void> {
    await this.plugin.hamasxiangAdapter.refresh(true);
    new Notice("情报已刷新");
  }

  private async openBlankNativePage(): Promise<void> {
    const transitionToken = this.plugin.layoutCoordinator.beginDocumentOpen();
    const leaf = this.app.workspace.getLeaf("tab");
    try {
      await leaf.setViewState({ type: "empty", active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } finally {
      this.plugin.layoutCoordinator.completeDocumentOpen(transitionToken);
    }
  }

  private async revealFileExplorer(): Promise<void> {
    this.app.workspace.leftSplit.expand();
    const fileExplorerLeaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (fileExplorerLeaf) await this.app.workspace.revealLeaf(fileExplorerLeaf);
  }

  private isActualSchedule(item: PlanItem): boolean {
    return Boolean(item.schedule && !item.schedule.preview);
  }

  private planExecutorLabel(item: PlanItem): string {
    const labels: Record<string, string> = { user: "用户", hermes: "Hermes", codex: "Codex" };
    return labels[item.execution.executor] ?? item.execution.executor;
  }

  private planExecutionStatusLabel(item: PlanItem): string {
    const labels: Record<string, string> = {
      idle: item.execution.mode === "agent" ? "待入队" : "手动执行",
      queued: "排队中",
      running: "执行中",
      review: "待验收",
      done: "已完成",
      failed: "执行失败",
    };
    return labels[item.execution.status] ?? item.execution.status;
  }

  private planExecutionMeta(item: PlanItem): string {
    return item.execution.mode === "agent"
      ? `${this.planExecutorLabel(item)} · ${this.planExecutionStatusLabel(item)}`
      : this.planExecutionStatusLabel(item);
  }

  private agentPlanAction(item: PlanItem): { label: string; title: string; icon: string } | null {
    if (item.execution.mode !== "agent") return null;
    if (item.execution.status === "idle") return { label: "进入队列", title: "将 Agent 任务加入执行队列", icon: "list-plus" };
    if (item.execution.status === "failed") return { label: "重新排队", title: "清除失败态并重新加入执行队列", icon: "refresh-cw" };
    if (item.execution.status === "review") return { label: "验收通过", title: "确认已有产物并通过状态机完成任务", icon: "badge-check" };
    return null;
  }

  private async runAgentPlanAction(item: PlanItem): Promise<void> {
    try {
      if (item.execution.mode !== "agent") throw new Error("这不是 Agent 执行任务");
      if (item.execution.status === "idle" || item.execution.status === "failed") {
        await this.plugin.planLedger.queueExecution(item.item_id, item.execution.executor);
        new Notice(item.execution.status === "failed" ? "Agent 任务已重新排队" : "Agent 任务已进入执行队列");
      } else if (item.execution.status === "review") {
        await this.plugin.planLedger.completeExecution(item.item_id, {}, item.execution.run_id);
        new Notice("Agent 产物已验收，任务已完成");
      } else {
        throw new Error(`任务当前为「${this.planExecutionStatusLabel(item)}」，没有可执行的人工状态动作`);
      }
      this.selectedScheduleItemId = item.item_id;
      await this.renderSchedule();
    } catch (error) {
      new Notice(`Agent 任务更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private clearScheduleInteractionOverlays(): void {
    // Drag/resize previews live on document.body so they can escape the
    // timeline's stacking context. If Obsidian switches views during a
    // pointer gesture, the old clone can otherwise survive as a ghost card.
    document.querySelectorAll<HTMLElement>(".aos-schedule-time-card.is-overlay").forEach(element => element.remove());
  }

  private scheduleValue(date: string, start: string, end: string): NonNullable<PlanItem["schedule"]> {
    return {
      date,
      start,
      end,
      timezone: "Asia/Shanghai",
      fixed: false,
      preview: false,
    };
  }

  private quickScheduleSlot(): { start: string; end: string } {
    const now = new Date();
    const rounded = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
    const start = clampNumber(Math.max(9 * 60, rounded), 9 * 60, 22 * 60);
    const end = Math.min(start + 60, 23 * 60);
    return { start: minutesToScheduleTime(start), end: minutesToScheduleTime(end) };
  }

  private async updateScheduleItem(item: PlanItem, patch: UpdatePlanItemPatch, successText: string): Promise<void> {
    try {
      await this.plugin.planLedger.updatePlanItem(item, patch);
      this.schedulePreviewOverrides.delete(item.item_id);
      this.selectedScheduleItemId = item.item_id;
      new Notice(successText);
      await this.renderSchedule();
    } catch (error) {
      new Notice(`更新计划失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openScheduleEditModal(item: PlanItem): void {
    const schedule = item.schedule && !item.schedule.preview ? item.schedule : undefined;
    new ScheduleCreateModal(this.app, {
      title: item.title,
      kind: item.kind,
      date: schedule?.date ?? item.plan_date,
      scheduled: Boolean(schedule),
      start: schedule?.start ?? "09:00",
      end: schedule?.end ?? "10:00",
      sourceNotePath: item.source_note?.path,
    }, async input => {
      await this.updateScheduleItem(item, {
        title: input.title,
        kind: input.kind,
        plan_date: input.date,
        schedule: input.scheduled ? this.scheduleValue(input.date, input.start, input.end) : null,
      }, input.scheduled ? "计划卡片已更新并排期" : "计划卡片已更新，暂存候选池");
    }, { heading: "编辑计划卡片", submit: "保存修改" }).open();
  }

  private async scheduleCandidate(item: PlanItem, date: string): Promise<void> {
    const slot = this.quickScheduleSlot();
    await this.scheduleCandidateAt(item, date, scheduleMinutes(slot.start), 60);
  }

  private async scheduleCandidateAt(item: PlanItem, date: string, startMinutes: number, duration = 60): Promise<void> {
    const safeDuration = Math.max(SCHEDULE_STEP, Math.min(duration, SCHEDULE_DAY_END - SCHEDULE_DAY_START));
    const start = clampNumber(snapMinutes(startMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - safeDuration);
    const end = clampNumber(start + safeDuration, start + SCHEDULE_STEP, SCHEDULE_DAY_END);
    const startText = minutesToScheduleTime(start);
    const endText = minutesToScheduleTime(end);
    await this.updateScheduleItem(item, {
      plan_date: date,
      schedule: this.scheduleValue(date, startText, endText),
    }, `已排到 ${date} ${startText}-${endText}`);
  }

  private async togglePlanDone(item: PlanItem): Promise<void> {
    if (item.execution.mode === "agent") {
      new Notice("Agent 任务必须按「排队 → 执行 → 验收」状态机推进，不能用普通完成按钮越级结案");
      return;
    }
    await this.updateScheduleItem(item, {
      status: item.status === "done" ? "proposed" : "done",
    }, item.status === "done" ? "已恢复计划卡片；来源灵感仍保持挂接" : "已标记完成；来源灵感已收口");
  }

  private async removePlanItem(item: PlanItem): Promise<void> {
    if (item.execution.mode === "agent" && ["queued", "running", "review"].includes(item.execution.status)) {
      new Notice("Agent 任务仍在排队、执行或验收中；当前没有可靠取消接口，未移除任务");
      return;
    }
    try {
      await this.plugin.planLedger.deletePlanItem(item);
      this.schedulePreviewOverrides.delete(item.item_id);
      if (this.selectedScheduleItemId === item.item_id) this.selectedScheduleItemId = null;
      this.scheduleDetailOpen = false;
      new Notice(item.source_note ? "计划已移入回收区；来源灵感已回到未挂接候选" : "卡片已移入计划回收区");
      await this.renderSchedule();
    } catch (error) {
      new Notice(`移除卡片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private createScheduleButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    cls: string,
    title = label,
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls, attr: { type: "button", title, "aria-label": title } });
    const iconSlot = button.createSpan({ cls: "aos-schedule-button-icon" });
    setIcon(iconSlot, icon);
    button.createSpan({ cls: "aos-schedule-button-label", text: label });
    return button;
  }

  private openScheduleCardMenu(item: PlanItem, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(entry => entry.setTitle("编辑卡片").setIcon("pencil").onClick(() => this.openScheduleEditModal(item)));
    if (item.execution.mode === "manual") {
      menu.addItem(entry => entry
        .setTitle(item.status === "done" ? "恢复任务" : "完成任务")
        .setIcon(item.status === "done" ? "rotate-ccw" : "check")
        .onClick(() => void this.togglePlanDone(item)));
    } else {
      const action = this.agentPlanAction(item);
      if (action) {
        menu.addItem(entry => entry
          .setTitle(action.title)
          .setIcon(action.icon)
          .onClick(() => void this.runAgentPlanAction(item)));
      }
    }
    if (this.isActualSchedule(item)) {
      menu.addItem(entry => entry
        .setTitle("退回待安排")
        .setIcon("inbox")
        .onClick(() => void this.updateScheduleItem(item, { schedule: null }, item.source_note ? "已退回待安排；来源灵感仍保持挂接" : "已退回待安排")));
    } else if (item.status !== "done") {
      menu.addItem(entry => entry
        .setTitle("排到今天")
        .setIcon("calendar-plus")
        .onClick(() => void this.scheduleCandidate(item, formatLocalDate(new Date()))));
    }
    if (item.source_note) {
      menu.addItem(entry => entry
        .setTitle("打开来源灵感")
        .setIcon("lightbulb")
        .onClick(() => {
          const node = this.toNode(item.source_note?.path ?? "");
          if (node) void this.openNode(node);
          else new Notice(`灵感笔记不存在：${item.source_note?.path ?? ""}`);
        }));
    }
    menu.addSeparator();
    menu.addItem(entry => entry
      .setTitle("移入计划回收区")
      .setIcon("trash-2")
      .onClick(() => void this.removePlanItem(item)));
    menu.showAtMouseEvent(event);
  }

  private async attachInspirationToCandidate(file: KnowledgeNodeViewModel, date: string): Promise<void> {
    if (this.inspirationAttachInFlight.has(file.path)) return;
    this.inspirationAttachInFlight.add(file.path);
    try {
      const existing = await this.plugin.planLedger.findPlanItemBySource(file.path);
      if (existing) {
        this.selectedScheduleItemId = existing.item_id;
        this.scheduleDetailOpen = true;
        new Notice(existing.status === "done" ? "这条灵感已对应一张已完成计划，已打开详情" : "这条灵感已经挂接到候选任务，已打开详情");
        await this.renderSchedule();
        return;
      }
      const item = await this.plugin.planLedger.createPlanItem({
        title: file.title,
        kind: "micro_task",
        date,
        scheduled: false,
        start: "09:00",
        end: "10:00",
        sourceNotePath: file.path,
      });
      this.selectedScheduleItemId = item.item_id;
      this.scheduleDetailOpen = true;
      await this.renderSchedule();
      new Notice("已加入候选任务；来源灵感自动从未挂接列表移出");
    } catch (error) {
      new Notice("加入候选任务失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      this.inspirationAttachInFlight.delete(file.path);
    }
  }

  private async renderSchedule(): Promise<void> {
    if (this.plugin.store.getSnapshot().activeModule !== "schedule") return;
    this.clearScheduleInteractionOverlays();
    const renderToken = ++this.scheduleRenderToken;
    const isCurrentSchedule = (): boolean =>
      this.plugin.store.getSnapshot().activeModule === "schedule" && this.scheduleRenderToken === renderToken;

    const previousPage = this.mainPane.querySelector<HTMLDivElement>(".aos-schedule-page");
    const scrollState = {
      mainTop: this.mainPane.scrollTop,
      mainLeft: this.mainPane.scrollLeft,
      sidebarTop: previousPage?.querySelector<HTMLElement>(".aos-schedule-sidebar")?.scrollTop ?? 0,
      detailTop: previousPage?.querySelector<HTMLElement>(".aos-schedule-detail")?.scrollTop ?? 0,
    };
    const initialSnapshot = await this.plugin.planLedger.refreshTodaySnapshot();
    if (!isCurrentSchedule()) return;
    // 在脱离 DOM 的页面树里完成异步数据和事件绑定，最后一次性替换可见页面。
    // 这样保存/切换详情时不会先清空主面板再等待 weekly ledger，避免白屏闪烁。
    const page = document.createElement("div") as HTMLDivElement;
    page.className = "aos-page aos-schedule-page";
    const heading = page.createDiv({ cls: "aos-page-heading" });
    const titleBlock = heading.createDiv();
    titleBlock.createDiv({ cls: "aos-page-title", text: "日程 Schedule" });
    titleBlock.createDiv({ cls: "aos-page-subtitle", text: "灵感来源 → 候选任务 → 计划中 → 已完成；每一步只需一次操作" });
    const actions = heading.createDiv({ cls: "aos-schedule-actions" });
    const addCard = this.createScheduleButton(actions, "新增卡片", "plus", "aos-compact-button is-primary");
    const refresh = this.createScheduleButton(actions, "刷新日程", "refresh-cw", "aos-compact-button");
    const detailToggle = this.createScheduleButton(
      actions,
      this.scheduleDetailOpen ? "收起详情" : "详情",
      this.scheduleDetailOpen ? "panel-right-close" : "panel-right-open",
      "aos-compact-button",
    );

    const shell = page.createDiv({ cls: `aos-schedule-shell ${this.scheduleDetailOpen ? "has-detail" : ""}` });
    const inbox = shell.createDiv({ cls: "aos-schedule-sidebar aos-panel" });
    const canvas = shell.createDiv({ cls: "aos-schedule-canvas aos-panel" });
    const detail = shell.createDiv({ cls: `aos-schedule-detail aos-panel ${this.scheduleDetailOpen ? "is-open" : ""}` });

    const render = async (seed?: PlanTodaySnapshot): Promise<void> => {
      const snapshot = seed ?? await this.plugin.planLedger.refreshTodaySnapshot();
      if (!isCurrentSchedule()) return;
      const weekDates = getWeekDates(snapshot.date);
      const weeklyLedgerItems = await this.plugin.planLedger.loadPlanItemsForDates(weekDates);
      if (!isCurrentSchedule()) return;
      const byId = new Map<string, PlanItem>();
      for (const item of [...snapshot.items, ...weeklyLedgerItems]) byId.set(item.item_id, item);
      const displayItems = [...byId.values()];
      const linkedSourcePaths = new Set(
        displayItems
          .map(item => item.source_note?.path)
          .filter((value): value is string => Boolean(value)),
      );
      const pendingItems = displayItems
        .filter(item => item.status !== "done" && !this.isActualSchedule(item))
        .sort((a, b) => Number(a.kind === "focus") - Number(b.kind === "focus") || b.updated_at.localeCompare(a.updated_at));
      const scheduledItems = displayItems.filter(item => this.isActualSchedule(item));
      const activeScheduledItems = scheduledItems.filter(item => item.status !== "done");
      const completedItems = displayItems.filter(item => item.status === "done").sort((a, b) => b.updated_at.localeCompare(a.updated_at));

      inbox.empty();
      canvas.empty();
      detail.empty();

      const inboxHeader = inbox.createDiv({ cls: "aos-schedule-section-header" });
      const inboxTitle = inboxHeader.createDiv();
      inboxTitle.createDiv({ cls: "aos-panel-title", text: "候选任务 · 待安排" });
      inboxTitle.createDiv({ cls: "aos-panel-note", text: `${pendingItems.length} 张待安排 · 拖入时间轴才算进入计划中` });
      const addInboxCard = inboxHeader.createEl("button", {
        cls: "aos-icon-button aos-schedule-add-icon",
        attr: { type: "button", "aria-label": "新增计划卡片", title: "新增计划卡片" },
      });
      setIcon(addInboxCard, "plus");
      addInboxCard.addEventListener("click", () => this.openScheduleCreateModal({ date: snapshot.date, scheduled: false }));

      const renderPlanRow = (item: PlanItem, group: "pending" | "scheduled" | "completed"): void => {
        const row = inbox.createDiv({ cls: `aos-schedule-candidate ${item.status === "done" ? "is-done" : ""} ${item.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""} ${this.selectedScheduleItemId === item.item_id ? "is-selected" : ""}` });
        if (group === "pending") {
          row.setAttribute("draggable", "true");
          row.setAttribute("title", "拖到右侧时间轴的日期与时间格");
          row.addEventListener("dragstart", event => {
            event.dataTransfer?.setData("application/x-aos-plan-item", item.item_id);
            event.dataTransfer?.setData("text/plain", item.item_id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            row.classList.add("is-dragging");
          });
          row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        }
        const body = row.createDiv({ cls: "aos-schedule-candidate-body" });
        body.createDiv({ cls: "aos-schedule-candidate-title", text: item.title || "未命名事项" });
        const schedule = item.schedule && !item.schedule.preview ? `${item.schedule.date.slice(5)} ${item.schedule.start}-${item.schedule.end}` : "未排期";
        body.createDiv({ cls: "aos-schedule-candidate-meta", text: `${schedule} · ${item.kind === "focus" ? "今日要事" : "小目标"} · ${this.planExecutionMeta(item)}` });
        const rowActions = row.createDiv({ cls: "aos-schedule-candidate-actions" });
        const select = (label: string, title: string, handler: () => void | Promise<void>, primary = false, icon = "circle-dot"): void => {
          const button = this.createScheduleButton(rowActions, label, icon, `aos-schedule-inline-action ${primary ? "is-primary" : ""}`, title);
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void handler(); });
        };
        if (group === "pending") select("排今天", "按一个快捷时段排到今天", () => this.scheduleCandidate(item, snapshot.date), item.execution.mode === "manual", "calendar-plus");
        if (item.execution.mode === "manual") {
          if (group === "scheduled") select("完成", "标记完成", () => this.togglePlanDone(item), true, "check");
          if (group === "completed") select("恢复", "恢复到计划", () => this.togglePlanDone(item), false, "rotate-ccw");
        } else {
          const agentAction = this.agentPlanAction(item);
          if (agentAction) select(agentAction.label, agentAction.title, () => this.runAgentPlanAction(item), true, agentAction.icon);
        }
        select("编辑", "编辑标题、日期或时段", () => this.openScheduleEditModal(item), false, "pencil");
        select("移除", "移入计划回收区", () => this.removePlanItem(item), false, "trash-2");
        row.addEventListener("click", () => {
          this.selectedScheduleItemId = item.item_id;
          this.scheduleDetailOpen = true;
          void this.renderSchedule();
        });
      };

      const pendingHeader = inbox.createDiv({ cls: "aos-schedule-subsection-header" });
      pendingHeader.createSpan({ cls: "aos-schedule-subsection-title", text: "待安排" });
      pendingHeader.createSpan({ cls: "aos-schedule-subsection-count", text: `${pendingItems.length}` });
      if (!pendingItems.length) inbox.createDiv({ cls: "aos-empty-state", text: "暂无待安排任务 · 从灵感来源加入或新增一张计划" });
      pendingItems.slice(0, 12).forEach(item => renderPlanRow(item, "pending"));

      const scheduledHeader = inbox.createDiv({ cls: "aos-schedule-subsection-header aos-schedule-subsection-spaced" });
      scheduledHeader.createSpan({ cls: "aos-schedule-subsection-title", text: "时间块 · 计划中" });
      scheduledHeader.createSpan({ cls: "aos-schedule-subsection-count", text: `${activeScheduledItems.length}` });
      if (!activeScheduledItems.length) inbox.createDiv({ cls: "aos-empty-state", text: "本周还没有未完成排期" });
      activeScheduledItems.slice(0, 8).forEach(item => renderPlanRow(item, "scheduled"));

      if (completedItems.length) {
        const completedDetails = inbox.createEl("details", { cls: "aos-schedule-completed" });
        const completedSummary = completedDetails.createEl("summary");
        completedSummary.createSpan({ text: `已完成 / 历史 · ${completedItems.length}` });
        completedItems.slice(0, 8).forEach(item => renderPlanRow(item, "completed"));
      }

      const inspirationCandidates = inbox.createDiv({ cls: "aos-schedule-inspiration-candidates" });
      const inspirationCandidateHeader = inspirationCandidates.createDiv({ cls: "aos-schedule-section-header" });
      inspirationCandidateHeader.createDiv({ cls: "aos-panel-title", text: "灵感来源 · 未挂接" });
      inspirationCandidateHeader.createDiv({ cls: "aos-panel-note", text: "加入候选任务后会自动从这里移出；原始灵感笔记始终保留在灵感轨。" });
      const candidateFiles = this.getInspirationFiles()
        .filter(file => !["scheduled", "archived"].includes(this.frontmatterText(file, "status")))
        .filter(file => !linkedSourcePaths.has(file.path))
        .slice(0, 5);
      if (!candidateFiles.length) {
        inspirationCandidates.createDiv({ cls: "aos-empty-state", text: "暂无未挂接灵感 · 新捕获的高价值素材会出现在这里" });
      } else {
        for (const file of candidateFiles) {
          const row = inspirationCandidates.createDiv({ cls: "aos-schedule-inspiration-candidate" });
          const content = row.createDiv({ cls: "aos-schedule-inspiration-candidate-content" });
          content.createDiv({ cls: "aos-schedule-candidate-title", text: file.title });
          content.createDiv({ cls: "aos-schedule-candidate-meta", text: `${this.inspirationDate(file)} · ${this.inspirationValue(file)}` });
          const rowActions = row.createDiv({ cls: "aos-schedule-inspiration-candidate-actions" });
          const view = this.createScheduleButton(rowActions, "查看", "eye", "aos-inspiration-card-action", "打开灵感卡");
          view.addEventListener("click", event => { event.stopPropagation(); void this.openNode(file); });
          const attach = this.createScheduleButton(rowActions, "加入候选任务", "calendar-plus", "aos-inspiration-card-action is-primary", "加入候选任务");
          attach.addEventListener("click", event => {
            event.stopPropagation();
            attach.disabled = true;
            attach.setAttribute("aria-busy", "true");
            void this.attachInspirationToCandidate(file, snapshot.date).finally(() => {
              if (attach.isConnected) {
                attach.disabled = false;
                attach.removeAttribute("aria-busy");
              }
            });
          });
        }
      }

      const canvasHeader = canvas.createDiv({ cls: "aos-schedule-canvas-header" });
      canvasHeader.createDiv({ cls: "aos-panel-title", text: "本周时间轴" });
      canvasHeader.createDiv({ cls: "aos-panel-note", text: `${activeScheduledItems.length} 个计划中 · ${scheduledItems.length - activeScheduledItems.length} 个已完成 · 顶部拖动移动时间块，底部拖动调整时长；中间点击查看详情` });
      const shortcuts = this.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS;
      const keyboardHint = canvasHeader.createDiv({ cls: "aos-schedule-keyboard-hint" });
      keyboardHint.createSpan({ text: `快捷键：${formatShortcut(shortcuts.moveDayPrevious)}/${formatShortcut(shortcuts.moveDayNext)} 日期 · ${formatShortcut(shortcuts.moveTimeEarlier)}/${formatShortcut(shortcuts.moveTimeLater)} 时间 · ${formatShortcut(shortcuts.resizeShorter)}/${formatShortcut(shortcuts.resizeLonger)} 时长 · ${formatShortcut(shortcuts.openDetails)} 详情 · ${formatShortcut(shortcuts.toggleDone)} 完成` });
      const shortcutConfig = this.createScheduleButton(keyboardHint, "配置快捷键", "keyboard", "aos-schedule-shortcut-config", "查看说明并修改日程快捷键");
      shortcutConfig.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        new ScheduleShortcutModal(this.app, this.plugin, () => void this.renderSchedule()).open();
      });
      const weekHeader = canvas.createDiv({ cls: "aos-schedule-week-header" });
      weekHeader.createDiv({ cls: "aos-schedule-week-spacer" });
      const weekdayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      weekDates.forEach((date, index) => {
        const cell = weekHeader.createDiv({ cls: `aos-schedule-week-day ${date === snapshot.date ? "is-today" : ""}` });
        cell.createDiv({ cls: "aos-schedule-week-day-name", text: weekdayLabels[index] });
        cell.createDiv({ cls: "aos-schedule-week-day-date", text: date.slice(5) });
      });
      const timeline = canvas.createDiv({ cls: "aos-schedule-timeline" });
      const gridLayer = timeline.createDiv({ cls: "aos-schedule-grid-layer" });
      for (let hour = 6; hour <= 24; hour++) {
        const row = gridLayer.createDiv({ cls: "aos-schedule-hour-row" });
        row.createDiv({ cls: "aos-schedule-hour-label", text: `${String(hour).padStart(2, "0")}:00` });
        for (let day = 0; day < 7; day++) row.createDiv({ cls: `aos-schedule-hour-track ${weekDates[day] === snapshot.date ? "is-today" : ""}` });
      }
      const cardLayer = timeline.createDiv({ cls: "aos-schedule-card-layer" });
      const timelinePosition = (clientX: number, clientY: number): { date: string; start: number } => {
        const rect = timeline.getBoundingClientRect();
        const contentLeft = 66;
        const contentWidth = Math.max(1, rect.width - contentLeft - 10);
        const dayWidth = contentWidth / 7;
        const dayIndex = clampNumber(Math.floor((clientX - rect.left - contentLeft) / dayWidth), 0, 6);
        const rawMinutes = 360 + ((clientY - rect.top) / Math.max(1, rect.height)) * (18 * 60);
        return { date: weekDates[dayIndex], start: clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - SCHEDULE_STEP) };
      };
      timeline.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".aos-schedule-time-card")) return;
        const point = timelinePosition(event.clientX, event.clientY);
        const start = minutesToScheduleTime(point.start);
        const end = minutesToScheduleTime(Math.min(point.start + 60, SCHEDULE_DAY_END));
        this.openScheduleCreateModal({ date: point.date, scheduled: true, start, end });
      });
      timeline.addEventListener("dragover", event => {
        if (event.dataTransfer?.types.includes("application/x-aos-plan-item") || event.dataTransfer?.types.includes("text/plain")) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          timeline.classList.add("is-drop-target");
        }
      });
      timeline.addEventListener("dragleave", event => {
        if (!(event.relatedTarget instanceof Node) || !timeline.contains(event.relatedTarget)) timeline.classList.remove("is-drop-target");
      });
      timeline.addEventListener("drop", event => {
        event.preventDefault();
        timeline.classList.remove("is-drop-target");
        const itemId = event.dataTransfer?.getData("application/x-aos-plan-item") || event.dataTransfer?.getData("text/plain");
        const item = displayItems.find(candidate => candidate.item_id === itemId);
        if (!item || item.status === "done" || this.isActualSchedule(item)) return;
        const point = timelinePosition(event.clientX, event.clientY);
        void this.scheduleCandidateAt(item, point.date, point.start, 60);
      });
      for (const item of scheduledItems) {
        const override = this.schedulePreviewOverrides.get(item.item_id);
        const schedule = {
          date: override?.date ?? item.schedule?.date ?? snapshot.date,
          start: override?.start ?? item.schedule?.start ?? "06:00",
          end: override?.end ?? item.schedule?.end ?? item.schedule?.start ?? "06:30",
        };
        if (!weekDates.includes(schedule.date)) continue;
        const start = scheduleMinutes(schedule.start);
        const end = scheduleMinutes(schedule.end);
        const dayIndex = Math.max(0, weekDates.indexOf(schedule.date));
        const top = Math.max(0, ((start - 360) / (18 * 60)) * 100);
        const height = Math.max(4.5, ((Math.max(end, start + 15) - start) / (18 * 60)) * 100);
        const card = cardLayer.createDiv({ cls: `aos-schedule-time-card ${item.kind === "focus" ? "is-focus" : "is-micro"} ${item.status === "done" ? "is-done" : ""} ${item.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""}` });
        card.style.left = `calc(${(dayIndex * 100) / 7}% + 4px)`;
        card.style.width = `calc(${100 / 7}% - 8px)`;
        card.style.top = `${top}%`;
        card.style.height = `${height}%`;
        card.setAttribute("title", `${item.title || "未命名事项"}\n${schedule.start}-${schedule.end}`);
        card.dataset.scheduleItemId = item.item_id;
        card.setAttribute("tabindex", "0");
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `${item.title || "未命名事项"}，${schedule.start} 到 ${schedule.end}。聚焦后可用方向键调整`);
        card.classList.toggle("is-selected", this.selectedScheduleItemId === item.item_id);
        const dragHandle = card.createDiv({ cls: "aos-schedule-drag-handle", attr: { title: "拖动移动日期与开始时间", "aria-label": "拖动移动日期与开始时间" } });
        setIcon(dragHandle, "grip-horizontal");
        dragHandle.createSpan({ cls: "aos-schedule-drag-label", text: "移动时间块" });
        card.createDiv({ cls: "aos-schedule-time-card-title", text: item.title || "未命名事项" });
        const meta = card.createDiv({ cls: "aos-schedule-time-card-meta", text: `${schedule.start}-${schedule.end}${item.source_note ? " · 灵感挂接" : ""} · ${this.planExecutionMeta(item)}` });
        const cardActions = card.createDiv({ cls: "aos-schedule-time-card-actions" });
        if (item.execution.mode === "manual") {
          const doneButton = this.createScheduleButton(cardActions, item.status === "done" ? "恢复" : "完成", item.status === "done" ? "rotate-ccw" : "check", "aos-schedule-time-card-action", item.status === "done" ? "恢复计划" : "完成任务");
          doneButton.addEventListener("pointerdown", event => event.stopPropagation());
          doneButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.togglePlanDone(item); });
        } else {
          const agentAction = this.agentPlanAction(item);
          if (agentAction) {
            const actionButton = this.createScheduleButton(cardActions, agentAction.label, agentAction.icon, "aos-schedule-time-card-action", agentAction.title);
            actionButton.addEventListener("pointerdown", event => event.stopPropagation());
            actionButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.runAgentPlanAction(item); });
          }
        }
        const menuButton = this.createScheduleButton(cardActions, "", "more-horizontal", "aos-schedule-time-card-action", "更多操作");
        menuButton.addEventListener("pointerdown", event => event.stopPropagation());
        menuButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.openScheduleCardMenu(item, event); });
        const resizeHandle = card.createDiv({ cls: "aos-schedule-resize-handle", attr: { "aria-label": "拖动调整时长" } });
        card.addEventListener("click", event => {
          if (event.target instanceof Element && event.target.closest(".aos-schedule-drag-handle, .aos-schedule-resize-handle, .aos-schedule-time-card-actions")) return;
          this.selectedScheduleItemId = item.item_id;
          this.scheduleDetailOpen = true;
          void this.renderSchedule();
        });
        this.attachScheduleCardPreviewInteraction(card, meta, cardLayer, weekDates, item, schedule, dragHandle, resizeHandle, () => this.renderSchedule());
      }

      const focusList = canvas.createDiv({ cls: "aos-schedule-focus-strip" });
      const focusItems = snapshot.items.filter(item => item.kind === "focus");
      for (let index = 0; index < 3; index += 1) {
        const item = focusItems[index];
        const card = focusList.createDiv({ cls: `aos-schedule-card ${item?.status === "done" ? "is-done" : ""} ${item?.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""} ${item ? "" : "is-empty"}`, attr: { role: "button", tabindex: "0" } });
        card.createDiv({ cls: "aos-schedule-card-title", text: item?.title || "设置一件今日要事" });
        card.createDiv({
          cls: "aos-schedule-card-meta",
          text: item
            ? `${item.status === "done" ? "已完成" : this.isActualSchedule(item) ? `${item.schedule?.start}-${item.schedule?.end}` : "未排期"} · 今日要事 · ${this.planExecutionMeta(item)}`
            : "点击新增 · 今日要事",
        });
        const activate = (): void => {
          if (item) {
            this.selectedScheduleItemId = item.item_id;
            this.scheduleDetailOpen = true;
            void this.renderSchedule();
          } else this.openScheduleCreateModal({ kind: "focus", date: snapshot.date, scheduled: false });
        };
        card.addEventListener("click", activate);
        card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
      }

      const inspirationBridge = page.createDiv({ cls: "aos-panel aos-schedule-inspiration-bridge" });
      const bridgeHeader = inspirationBridge.createDiv({ cls: "aos-schedule-section-header" });
      const bridgeTitle = bridgeHeader.createDiv();
      bridgeTitle.createDiv({ cls: "aos-panel-title", text: "灵感生命周期" });
      bridgeTitle.createDiv({ cls: "aos-panel-note", text: "左侧只放未挂接来源；加入候选任务后，来源笔记仍可在灵感轨回看，但不会重复进入候选。" });
      const lifecycle = inspirationBridge.createDiv({ cls: "aos-schedule-lifecycle" });
      for (const [index, step] of [
        ["01", "灵感来源", "新捕获、尚未挂接"],
        ["02", "候选任务", "一键加入，等待安排"],
        ["03", "执行 / 验收 / 完成", "日历只投影时间；Agent 产物必须经过执行状态与验收"],
      ] as const) {
        const item = lifecycle.createDiv({ cls: "aos-schedule-lifecycle-step" });
        item.createSpan({ cls: "aos-schedule-lifecycle-index", text: index });
        const copy = item.createDiv({ cls: "aos-schedule-lifecycle-copy" });
        copy.createDiv({ cls: "aos-schedule-lifecycle-title", text: step[1] });
        copy.createDiv({ cls: "aos-schedule-lifecycle-note", text: step[2] });
      }

      const selectedItem = displayItems.find(item => item.item_id === this.selectedScheduleItemId);
      this.renderScheduleDetail(detail, selectedItem, displayItems.length, snapshot.generated_at, () => {
        this.scheduleDetailOpen = false;
        void this.renderSchedule();
      });
    };

    addCard.addEventListener("click", () => this.openScheduleCreateModal({ date: formatLocalDate(new Date()), scheduled: false }));
    refresh.addEventListener("click", () => void this.renderSchedule());
    detailToggle.addEventListener("click", () => { this.scheduleDetailOpen = !this.scheduleDetailOpen; void this.renderSchedule(); });
    await render(initialSnapshot);
    if (isCurrentSchedule()) {
      const visiblePage = this.mainPane.querySelector<HTMLDivElement>(".aos-schedule-page");
      if (visiblePage) visiblePage.replaceWith(page);
      else {
        this.mainPane.empty();
        this.mainPane.appendChild(page);
      }
      const restoreScroll = (): void => {
        if (!isCurrentSchedule()) return;
        this.mainPane.scrollTop = scrollState.mainTop;
        this.mainPane.scrollLeft = scrollState.mainLeft;
        const sidebar = this.mainPane.querySelector<HTMLElement>(".aos-schedule-sidebar");
        const detailPane = this.mainPane.querySelector<HTMLElement>(".aos-schedule-detail");
        if (sidebar) sidebar.scrollTop = scrollState.sidebarTop;
        if (detailPane) detailPane.scrollTop = scrollState.detailTop;
      };
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    }
  }

  private openScheduleCreateModal(defaults: Partial<CreatePlanItemInput> = {}): void {
    const today = formatLocalDate(new Date());
    new ScheduleCreateModal(this.app, {
      title: defaults.title ?? "",
      kind: defaults.kind ?? "micro_task",
      date: defaults.date ?? today,
      scheduled: defaults.scheduled ?? true,
      start: defaults.start ?? "09:00",
      end: defaults.end ?? "10:00",
      sourceNotePath: defaults.sourceNotePath,
    }, async input => {
      if (input.sourceNotePath) {
        const existing = await this.plugin.planLedger.findPlanItemBySource(input.sourceNotePath);
        if (existing) {
          this.selectedScheduleItemId = existing.item_id;
          this.scheduleDetailOpen = true;
          await this.renderSchedule();
          new Notice("这条灵感已经挂接到候选任务，未重复创建卡片");
          return;
        }
      }
      const item = await this.plugin.planLedger.createPlanItem(input);
      this.selectedScheduleItemId = item.item_id;
      this.schedulePreviewOverrides.delete(item.item_id);
      await this.renderSchedule();
      new Notice(input.scheduled ? "已加入时间轴；完成按钮只代表任务做完" : input.sourceNotePath ? "已加入候选任务；来源灵感已挂接" : "已加入候选任务池");
    }).open();
  }

  private renderScheduleDetail(
    detail: HTMLDivElement,
    selectedItem: PlanItem | undefined,
    itemCount: number,
    generatedAt: string,
    onClose: () => void,
  ): void {
    const header = detail.createDiv({ cls: "aos-schedule-detail-header" });
    header.createDiv({ cls: "aos-panel-title", text: "卡片详情" });
    const close = header.createEl("button", { cls: "aos-icon-button aos-schedule-detail-close", attr: { "aria-label": "收起详情" } });
    setIcon(close, "panel-right-close");
    close.addEventListener("click", onClose);

    if (selectedItem) {
      detail.createDiv({ cls: "aos-schedule-detail-title", text: selectedItem.title || "未命名事项" });
      const override = this.schedulePreviewOverrides.get(selectedItem.item_id);
      const schedule = selectedItem.schedule
        ? {
            date: override?.date ?? selectedItem.schedule.date,
            start: override?.start ?? selectedItem.schedule.start,
            end: override?.end ?? selectedItem.schedule.end,
          }
        : null;
      const stats = detail.createDiv({ cls: "aos-schedule-stats" });
      stats.createDiv({ text: selectedItem.kind === "focus" ? "今日三件事" : "小目标" });
      stats.createDiv({ text: selectedItem.execution.mode === "agent" ? `执行者 ${this.planExecutorLabel(selectedItem)} · ${this.planExecutionStatusLabel(selectedItem)}` : "执行者 用户 · 手动任务" });
      stats.createDiv({
        text: selectedItem.status === "done"
          ? selectedItem.source_note ? "已完成 · 来源灵感已收口" : "已完成 · 任务已做完"
          : this.isActualSchedule(selectedItem)
            ? selectedItem.source_note ? "计划中 · 来源灵感已挂接" : "已加入时间轴 · 任务未完成"
            : selectedItem.source_note ? "待安排 · 来源灵感已挂接" : "候选任务 · 尚未安排",
      });
      if (schedule) stats.createDiv({ text: `${schedule.date} ${schedule.start}-${schedule.end}` });
      detail.createDiv({
        cls: "aos-panel-note",
        text: selectedItem.execution.mode === "agent"
          ? selectedItem.execution.status === "review"
            ? "Agent 已提交产物，只有“验收通过”会完成任务；普通完成按钮不会越过状态机。"
            : selectedItem.execution.status === "queued" || selectedItem.execution.status === "running"
              ? "任务正在 Agent 队列中推进；时间块只是日历投影，不代表执行完成。"
              : selectedItem.execution.status === "failed"
                ? "上轮执行失败，可查看错误后重新排队；不会伪装成已完成。"
                : "这是 Agent 任务；先进入队列，再由执行器领取并产出结果。"
          : selectedItem.schedule?.preview
          ? "这是旧清单给出的建议时段，尚未算作真实时间块；拖入时间轴或点击“排今天”才会加入计划。"
          : this.isActualSchedule(selectedItem)
            ? "这张卡已经加入时间轴，但还没有完成。点击“完成”才表示任务执行完毕；来源灵感会继续保留在灵感轨，不再回到未挂接列表。"
            : selectedItem.source_note
              ? "这张卡已经接住一条灵感来源，目前只是待安排；排今天或拖入时间轴后才会进入计划中。"
              : "这张卡还在候选任务池；编辑、排今天或拖入时间轴都不会把它标记为完成。",
      });
      const actions = detail.createDiv({ cls: "aos-schedule-detail-actions" });
      const edit = this.createScheduleButton(actions, "编辑", "pencil", "aos-compact-button is-primary");
      edit.addEventListener("click", () => this.openScheduleEditModal(selectedItem));
      if (selectedItem.execution.mode === "manual") {
        const done = this.createScheduleButton(actions, selectedItem.status === "done" ? "恢复" : "完成", selectedItem.status === "done" ? "rotate-ccw" : "check", "aos-compact-button");
        done.addEventListener("click", () => void this.togglePlanDone(selectedItem));
      } else {
        const agentAction = this.agentPlanAction(selectedItem);
        if (agentAction) {
          const action = this.createScheduleButton(actions, agentAction.label, agentAction.icon, "aos-compact-button is-primary", agentAction.title);
          action.addEventListener("click", () => void this.runAgentPlanAction(selectedItem));
        }
      }
      if (this.isActualSchedule(selectedItem)) {
        const unschedule = this.createScheduleButton(actions, "退回待安排", "inbox", "aos-compact-button");
        unschedule.addEventListener("click", () => void this.updateScheduleItem(selectedItem, { schedule: null }, selectedItem.source_note ? "已退回待安排；来源灵感仍保持挂接" : "已退回待安排"));
      } else if (selectedItem.status !== "done") {
        const scheduleNow = this.createScheduleButton(actions, "排到今天", "calendar-plus", "aos-compact-button is-primary");
        scheduleNow.addEventListener("click", () => void this.scheduleCandidate(selectedItem, formatLocalDate(new Date())));
      }
      const remove = this.createScheduleButton(actions, "移除", "trash-2", "aos-compact-button is-danger");
      remove.addEventListener("click", () => void this.removePlanItem(selectedItem));
      if (selectedItem.execution.mode === "agent" && ["queued", "running", "review"].includes(selectedItem.execution.status)) {
        remove.disabled = true;
        remove.setAttribute("title", "任务仍在执行状态；接入可靠取消接口前不能移除");
      }
      if (selectedItem.execution.mode === "agent") {
        const execution = detail.createDiv({ cls: "aos-schedule-source-note aos-schedule-execution-detail" });
        execution.createDiv({ cls: "aos-schedule-event-title", text: "Agent 执行契约" });
        execution.createDiv({ cls: "aos-panel-note", text: `意图：${selectedItem.execution.intent}` });
        if (selectedItem.execution.expected_artifact) {
          execution.createDiv({ cls: "aos-panel-note", text: `预期产物：${selectedItem.execution.expected_artifact}` });
        }
        if (selectedItem.execution.error) {
          execution.createDiv({ cls: "aos-panel-note is-error", text: `失败原因：${selectedItem.execution.error}` });
        }
        const artifactPath = selectedItem.completion_receipt?.result_path || selectedItem.execution.artifact_path;
        if (selectedItem.completion_receipt?.summary) {
          execution.createDiv({ cls: "aos-panel-note", text: `结果：${selectedItem.completion_receipt.summary}` });
        }
        if (artifactPath) {
          execution.createDiv({ cls: "aos-panel-note", text: `产物：${artifactPath}` });
          const openArtifact = this.createScheduleButton(execution, "查看产物", "file-check", "aos-inspiration-card-action is-primary");
          openArtifact.addEventListener("click", () => this.openFileByPath(normalizePath(artifactPath)));
        }
      }
      if (selectedItem.source_note) {
        const source = detail.createDiv({ cls: "aos-schedule-source-note" });
        source.createDiv({ cls: "aos-schedule-event-title", text: "来源灵感" });
        source.createDiv({ cls: "aos-panel-note", text: selectedItem.source_note.path });
        const openSource = this.createScheduleButton(source, "打开灵感卡", "lightbulb", "aos-inspiration-card-action is-primary");
        openSource.addEventListener("click", () => {
          const node = this.toNode(selectedItem.source_note?.path ?? "");
          if (node) void this.openNode(node);
          else new Notice(`灵感笔记不存在：${selectedItem.source_note?.path ?? ""}`);
        });
      }
    } else {
      detail.createDiv({ cls: "aos-panel-note", text: "点击周历卡片后，这里显示标题、时间与当前状态。未排期卡片会留在左侧候选池。" });
    }

    const eventHint = detail.createDiv({ cls: "aos-schedule-event-hint" });
    eventHint.createDiv({ cls: "aos-schedule-event-title", text: "当前快照" });
    eventHint.createDiv({ text: `事项总数 ${itemCount}` });
    eventHint.createDiv({ text: `生成时间 ${new Date(generatedAt).toLocaleTimeString()}` });
  }

  private async nudgeScheduleItemByKeyboard(
    item: PlanItem,
    schedule: { date: string; start: string; end: string },
    weekDates: string[],
    axis: "day" | "time" | "resize",
    delta: number,
    render: () => Promise<void>,
  ): Promise<void> {
    if (this.scheduleKeyboardUpdates.has(item.item_id)) return;
    const current = this.schedulePreviewOverrides.get(item.item_id) ?? schedule;
    const startMinutes = scheduleMinutes(current.start);
    const endMinutes = scheduleMinutes(current.end);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) return;

    const duration = Math.max(SCHEDULE_STEP, endMinutes - startMinutes);
    let nextDate = current.date;
    let nextStart = startMinutes;
    let nextEnd = endMinutes;
    if (axis === "day") {
      const dayIndex = clampNumber(weekDates.indexOf(current.date), 0, weekDates.length - 1);
      nextDate = weekDates[clampNumber(dayIndex + delta, 0, weekDates.length - 1)];
    } else if (axis === "time") {
      nextStart = clampNumber(snapMinutes(startMinutes + delta, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - duration);
      nextEnd = nextStart + duration;
    } else {
      nextEnd = clampNumber(snapMinutes(endMinutes + delta, SCHEDULE_STEP), startMinutes + SCHEDULE_STEP, SCHEDULE_DAY_END);
    }
    if (nextDate === current.date && nextStart === startMinutes && nextEnd === endMinutes) return;

    this.scheduleKeyboardUpdates.add(item.item_id);
    this.schedulePreviewOverrides.set(item.item_id, {
      date: nextDate,
      start: minutesToScheduleTime(nextStart),
      end: minutesToScheduleTime(nextEnd),
    });
    try {
      await this.plugin.planLedger.updatePlanItem(item, {
        plan_date: nextDate,
        schedule: this.scheduleValue(nextDate, minutesToScheduleTime(nextStart), minutesToScheduleTime(nextEnd)),
      });
      this.schedulePreviewOverrides.delete(item.item_id);
      this.selectedScheduleItemId = item.item_id;
      await render();
      const direction = axis === "day" ? "日期" : axis === "time" ? "开始时间" : "时长";
      new Notice(`已调整${direction}：${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)}`);
      window.requestAnimationFrame(() => {
        const nextCard = Array.from(this.mainPane.querySelectorAll<HTMLElement>(".aos-schedule-time-card"))
          .find(candidate => candidate.dataset.scheduleItemId === item.item_id);
        nextCard?.focus({ preventScroll: true });
      });
    } catch (error) {
      this.schedulePreviewOverrides.delete(item.item_id);
      new Notice(`快捷调整失败：${error instanceof Error ? error.message : String(error)}`);
      await render();
    } finally {
      this.scheduleKeyboardUpdates.delete(item.item_id);
    }
  }

  private attachScheduleCardPreviewInteraction(
    card: HTMLDivElement,
    meta: HTMLDivElement,
    layer: HTMLDivElement,
    weekDates: string[],
    item: PlanItem,
    schedule: { date: string; start: string; end: string },
    dragHandle: HTMLDivElement,
    resizeHandle: HTMLDivElement,
    render: () => Promise<void>,
  ): void {
    card.addEventListener("keydown", event => {
      const shortcuts = this.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS;
      if (shortcutMatches(event, shortcuts.openDetails)) {
        event.preventDefault();
        this.selectedScheduleItemId = item.item_id;
        this.scheduleDetailOpen = true;
        void this.renderSchedule();
        return;
      }
      if (shortcutMatches(event, shortcuts.toggleDone)) {
        event.preventDefault();
        event.stopPropagation();
        this.selectedScheduleItemId = item.item_id;
        void this.togglePlanDone(item);
        return;
      }
      let axis: "day" | "time" | "resize" | null = null;
      let step = 0;
      if (shortcutMatches(event, shortcuts.moveDayPrevious)) { axis = "day"; step = -1; }
      else if (shortcutMatches(event, shortcuts.moveDayNext)) { axis = "day"; step = 1; }
      else if (shortcutMatches(event, shortcuts.moveTimeEarlier)) { axis = "time"; step = -SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.moveTimeLater)) { axis = "time"; step = SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.resizeShorter)) { axis = "resize"; step = -SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.resizeLonger)) { axis = "resize"; step = SCHEDULE_STEP; }
      if (!axis) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectedScheduleItemId = item.item_id;
      void this.nudgeScheduleItemByKeyboard(item, schedule, weekDates, axis, step, render);
    });
    card.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const resizing = target === resizeHandle || Boolean(target?.closest(".aos-schedule-resize-handle"));
      const dragging = target === dragHandle || Boolean(target?.closest(".aos-schedule-drag-handle"));
      if (!resizing && !dragging) return;
      event.stopPropagation();
      card.setPointerCapture(event.pointerId);

      const current = this.schedulePreviewOverrides.get(item.item_id) ?? schedule;
      const startMinutes = scheduleMinutes(current.start);
      const endMinutes = scheduleMinutes(current.end);
      const duration = Math.max(15, endMinutes - startMinutes);
      let nextDate = current.date;
      let nextStart = startMinutes;
      let nextEnd = endMinutes;
      let frame = 0;
      let hasChanged = false;
      let active = false;
      let overlay: HTMLDivElement | null = null;
      const startX = event.clientX;
      const startY = event.clientY;
      const activationDistance = resizing ? 3 : 8;
      const layerRect = layer.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const dayWidth = layerRect.width / 7;
      const pointerOffsetX = event.clientX - cardRect.left;
      const pointerOffsetY = event.clientY - cardRect.top;
      const initialHeight = cardRect.height;
      let targetDx = 0;
      let targetDy = 0;
      let targetHeight = initialHeight;
      let visualDx = 0;
      let visualDy = 0;
      let visualHeight = initialHeight;

      const ensureOverlay = (): HTMLDivElement => {
        if (overlay) return overlay;
        event.preventDefault();
        overlay = card.cloneNode(true) as HTMLDivElement;
        overlay.classList.add("is-overlay", resizing ? "is-resizing" : "is-dragging");
        overlay.classList.remove("is-selected");
        overlay.style.left = `${cardRect.left}px`;
        overlay.style.top = `${cardRect.top}px`;
        overlay.style.width = `${cardRect.width}px`;
        overlay.style.height = `${initialHeight}px`;
        overlay.style.transform = "translate3d(0, 0, 0)";
        document.body.appendChild(overlay);
        card.classList.add("is-interaction-source");
        card.classList.add(resizing ? "is-resizing" : "is-dragging");
        return overlay;
      };

      const applyPreview = (): void => {
        frame = 0;
        const preview = ensureOverlay();
        visualDx += (targetDx - visualDx) * 0.36;
        visualDy += (targetDy - visualDy) * 0.36;
        visualHeight += (targetHeight - visualHeight) * 0.36;
        if (Math.abs(targetDx - visualDx) < 0.35) visualDx = targetDx;
        if (Math.abs(targetDy - visualDy) < 0.35) visualDy = targetDy;
        if (Math.abs(targetHeight - visualHeight) < 0.35) visualHeight = targetHeight;
        preview.style.transform = `translate3d(${visualDx}px, ${visualDy}px, 0)`;
        preview.style.height = `${visualHeight}px`;
        const overlayMeta = preview.querySelector(".aos-schedule-time-card-meta");
        if (overlayMeta) overlayMeta.textContent = `${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)} · 本地预览`;
        if (active && overlay && (Math.abs(targetDx - visualDx) > 0.35 || Math.abs(targetDy - visualDy) > 0.35 || Math.abs(targetHeight - visualHeight) > 0.35)) {
          frame = requestAnimationFrame(applyPreview);
        }
      };

      const scheduleFrame = (): void => {
        if (!frame) frame = requestAnimationFrame(applyPreview);
      };

      const applyFinalToCard = (): void => {
        const dayIndex = clampNumber(weekDates.indexOf(nextDate), 0, 6);
        const top = Math.max(0, ((nextStart - 360) / (18 * 60)) * 100);
        const height = Math.max(4.5, ((nextEnd - nextStart) / (18 * 60)) * 100);
        card.style.left = `calc(${(dayIndex * 100) / 7}% + 4px)`;
        card.style.width = `calc(${100 / 7}% - 8px)`;
        card.style.top = `${top}%`;
        card.style.height = `${height}%`;
        meta.textContent = `${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)} · 本地预览`;
      };

      const onMove = (moveEvent: PointerEvent): void => {
        const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!active && moved < activationDistance) return;
        active = true;
        moveEvent.preventDefault();
        if (resizing) {
          const rawMinutes = 360 + ((moveEvent.clientY - layerRect.top) / layerRect.height) * (18 * 60);
          nextEnd = clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), nextStart + SCHEDULE_STEP, SCHEDULE_DAY_END);
        } else {
          const rawLeft = moveEvent.clientX - layerRect.left - pointerOffsetX;
          const rawTop = moveEvent.clientY - layerRect.top - pointerOffsetY;
          const dayIndex = clampNumber(Math.round(rawLeft / dayWidth), 0, 6);
          nextDate = weekDates[dayIndex];
          const rawMinutes = 360 + (rawTop / layerRect.height) * (18 * 60);
          nextStart = clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - duration);
          nextEnd = nextStart + duration;
        }
        const dayIndex = clampNumber(weekDates.indexOf(nextDate), 0, 6);
        const topPx = ((nextStart - 360) / (18 * 60)) * layerRect.height;
        const heightPx = ((nextEnd - nextStart) / (18 * 60)) * layerRect.height;
        const targetViewportLeft = layerRect.left + dayIndex * dayWidth + 4;
        const targetViewportTop = layerRect.top + Math.max(0, topPx);
        targetDx = targetViewportLeft - cardRect.left;
        targetDy = targetViewportTop - cardRect.top;
        targetHeight = Math.max(34, heightPx);
        hasChanged = nextDate !== current.date || nextStart !== startMinutes || nextEnd !== endMinutes;
        scheduleFrame();
      };

      const onUp = (): void => {
        if (frame) cancelAnimationFrame(frame);
        this.selectedScheduleItemId = item.item_id;
        this.scheduleDetailOpen = !active && !hasChanged ? true : false;
        if (hasChanged) {
          applyFinalToCard();
          this.schedulePreviewOverrides.set(item.item_id, {
            date: nextDate,
            start: minutesToScheduleTime(nextStart),
            end: minutesToScheduleTime(nextEnd),
          });
        }
        overlay?.remove();
        card.classList.remove("is-dragging", "is-resizing", "is-interaction-source");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (hasChanged) {
          void this.plugin.planLedger.updatePlanItem(item, {
            plan_date: nextDate,
            schedule: this.scheduleValue(nextDate, minutesToScheduleTime(nextStart), minutesToScheduleTime(nextEnd)),
          }).then(() => {
            this.schedulePreviewOverrides.delete(item.item_id);
            return render();
          }).catch(error => {
            this.schedulePreviewOverrides.delete(item.item_id);
            new Notice(`保存排期失败：${error instanceof Error ? error.message : String(error)}`);
            void render();
          });
        } else {
          void render();
        }
      };

      const onCancel = (): void => {
        if (frame) cancelAnimationFrame(frame);
        overlay?.remove();
        card.classList.remove("is-dragging", "is-resizing", "is-interaction-source");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onCancel, { once: true });
    });
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

  private actionButton(parent: HTMLElement, label: string, action: () => void | Promise<void>): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "aos-action-button", text: label });
    button.type = "button";
    button.addEventListener("click", () => {
      if (button.disabled) return;
      let result: void | Promise<void>;
      try {
        result = action();
      } catch (error) {
        this.reportActionError(label, error);
        return;
      }
      if (!result || typeof (result as Promise<void>).then !== "function") return;
      button.disabled = true;
      button.classList.add("is-running");
      button.setAttribute("aria-busy", "true");
      button.textContent = `${label}…`;
      void Promise.resolve(result)
        .catch(error => this.reportActionError(label, error))
        .finally(() => {
          button.disabled = false;
          button.classList.remove("is-running");
          button.removeAttribute("aria-busy");
          if (button.isConnected) button.textContent = label;
        });
    });
    return button;
  }

  private reportActionError(label: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.plugin.logBus.append("error", "shell.action", `${label}失败：${message}`);
    new Notice(`${label}失败：${message}`);
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  private async openCloudAssetPreview(assetId: string): Promise<void> {
    try {
      const receipt = await this.plugin.hamasxiangAdapter.issueAssetLink(assetId, "display");
      new CloudAssetPreviewModal(this.app, receipt, () => this.plugin.hamasxiangAdapter.issueAssetLink(assetId, "display")).open();
    } catch (error) {
      new Notice(`云端预览暂不可用：${error instanceof Error ? error.message : String(error)}`);
    }
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

  private async loadTodoItems(): Promise<PlanItem[]> {
    const snapshot = await this.plugin.planLedger.refreshTodaySnapshot();
    return snapshot.items.filter(item => item.kind === "micro_task");
  }

  private async toggleTodoItem(item: PlanItem): Promise<void> {
    await this.plugin.planLedger.updatePlanItem(item, {
      status: item.status === "done" ? "proposed" : "done",
    });
    this.refreshLifeDashboard();
  }

  private async addTodoItem(text: string): Promise<void> {
    const title = text.trim();
    if (!title) return;
    await this.plugin.planLedger.createPlanItem({
      title,
      kind: "micro_task",
      date: formatLocalDate(new Date()),
      scheduled: false,
      start: "09:00",
      end: "10:00",
    });
    this.refreshLifeDashboard();
  }

  private openLifeTodoEditModal(item: PlanItem): void {
    const schedule = item.schedule && !item.schedule.preview ? item.schedule : undefined;
    new ScheduleCreateModal(this.app, {
      title: item.title,
      kind: item.kind,
      date: schedule?.date ?? item.plan_date,
      scheduled: Boolean(schedule),
      start: schedule?.start ?? "09:00",
      end: schedule?.end ?? "10:00",
      sourceNotePath: item.source_note?.path,
    }, async input => {
      await this.plugin.planLedger.updatePlanItem(item, {
        title: input.title,
        kind: input.kind,
        plan_date: input.date,
        schedule: input.scheduled ? this.scheduleValue(input.date, input.start, input.end) : null,
      });
      this.refreshLifeDashboard();
      new Notice(input.scheduled ? "小目标已更新并排入日程" : "小目标已更新");
    }, { heading: "编辑今日小目标", submit: "保存小目标" }).open();
  }

  private async deleteLifeTodo(item: PlanItem): Promise<void> {
    await this.plugin.planLedger.deletePlanItem(item);
    this.refreshLifeDashboard();
    new Notice(item.source_note ? "小目标已移除；来源灵感回到待挂接状态" : "小目标已移除");
  }

  private buildLifeGoalResearchPrompt(item: PlanItem): string {
    const workspace = this.getWorkspace()?.name ?? "当前工作域";
    const schedule = item.schedule && !item.schedule.preview
      ? `${item.schedule.date} ${item.schedule.start}-${item.schedule.end}`
      : "尚未排入时间轴";
    return [
      "请围绕当前小目标完成一次研究型产出，不要把它当成闲聊。",
      `小目标：${item.title}`,
      `工作域：${workspace}`,
      `当前排期：${schedule}`,
      "请先在当前对话中交付：",
      "1. 将目标改写为可验证的问题与完成标准；",
      "2. 基于当前可用上下文列出需要查证的事实、假设与风险；",
      "3. 给出一份可直接执行的研究/制作步骤；",
      "4. 产出一个最小可用的成果草案（提纲、清单、结构或文本，按目标选择）；",
      "5. 明确建议保存到哪个工作域目录，但不要自动创建、移动、覆盖或删除文件。",
      "证据不足时请明确说明缺口，不要编造来源；等我确认“落库”后才写入 Vault。",
    ].join("\n");
  }

  private runLifeGoalResearch(item: PlanItem): void {
    void this.openGlobalAgentDock(this.buildLifeGoalResearchPrompt(item), null)
      .then(sent => {
        new Notice(sent
          ? `已将「${item.title}」交给 Copilot 研产；产物先留在对话中，待你确认后再落库。`
          : "已打开 Copilot；请确认它已启用后再进行研产。");
      })
      .catch(error => new Notice(`打开研产对话失败：${error instanceof Error ? error.message : String(error)}`));
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`目标路径不是目录：${current}`);
    }
  }

  private async addInspiration(text: string, metadata: { sourceNotePath?: string; area?: string } = {}): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`;
    const safeTitle = trimmed.replace(/[\\/:*?"<>|\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "未命名灵感";
    const folderPath = `${INSPIRATION_INBOX_PATH}/${yearMonth}`;
    await this.ensureVaultFolder(folderPath);
    const filePath = normalizePath(`${folderPath}/${dateStamp}_${safeTitle}.md`);
    const content = [
      "---",
      `title: ${JSON.stringify(safeTitle)}`,
      "source: aetheric-dashboard",
      "type: inspiration_card",
      "rail: inspiration",
      "inbox_channel: local_capture",
      `source_note_path: ${JSON.stringify(metadata.sourceNotePath ?? "")}`,
      `area: ${JSON.stringify(metadata.area ?? "life")}`,
      "status: captured",
      "tags: [灵感, 天工台]",
      `captured_at: ${JSON.stringify(now.toISOString())}`,
      "---",
      "",
      `# ${safeTitle}`,
      "",
      trimmed,
      "",
    ].join("\n");
    await this.app.vault.create(filePath, content);
    new Notice("💡 灵感已记入微信想法收件箱");
    this.refreshLifeDashboard();
    if (this.plugin.store.getSnapshot().activeModule === "inspiration") this.renderMain();
  }

  private async loadLifeInspirations(): Promise<Array<{ completed: boolean; text: string; path: string }>> {
    return this.getInspirationFiles().slice(0, 3).map(file => ({
      completed: false,
      text: file.title,
      path: file.path,
    }));
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
    const statusCard = grid.createDiv({ cls: "aos-panel aos-life-status-card is-loading" });
    const todoCard = grid.createDiv({ cls: "aos-panel aos-life-todo-card is-loading" });

    statusCard.createDiv({ cls: "aos-spinner-small" });
    todoCard.createDiv({ cls: "aos-spinner-small" });

    this.lifeDashboard = { statusCard, todoCard };
    this.refreshLifeDashboard();
  }

  private refreshLifeDashboard(): void {
    const dashboard = this.lifeDashboard;
    if (!dashboard || !dashboard.statusCard.isConnected || !dashboard.todoCard.isConnected) return;
    const tx = ++this.lifeRefreshTx;

    Promise.all([
      this.fetchWeather(),
      this.loadLifeInspirations(),
      this.getRandomFoodChoice(),
      this.loadTodoItems(),
    ]).then(([weather, focusItems, foodChoice, todos]) => {
      if (tx !== this.lifeRefreshTx || !dashboard.statusCard.isConnected || !dashboard.todoCard.isConnected) return;
      this.populateLifeStatus(dashboard.statusCard, weather, focusItems, foodChoice);
      this.populateLifeTodo(dashboard.todoCard, todos);
    }).catch(err => {
      if (tx !== this.lifeRefreshTx || !dashboard.statusCard.isConnected || !dashboard.todoCard.isConnected) return;
      console.error("Failed to load life dashboard data", err);
      dashboard.statusCard.classList.remove("is-loading");
      dashboard.statusCard.empty();
      dashboard.statusCard.createDiv({ text: "生活数据加载失败", cls: "aos-panel-note" });
      dashboard.todoCard.classList.remove("is-loading");
      dashboard.todoCard.empty();
      dashboard.todoCard.createDiv({ text: "待办数据加载失败", cls: "aos-panel-note" });
    });
  }

  private localizeWeatherDescription(description: string): string {
    const normalized = description.trim().toLowerCase();
    const mappings: Array<[RegExp, string]> = [
      [/patchy rain|light rain|drizzle|rain shower/, "零星阵雨"],
      [/heavy rain|torrential rain|thunder/, "强降雨"],
      [/clear|sunny/, "晴朗"],
      [/partly cloudy/, "多云间晴"],
      [/overcast/, "阴天"],
      [/cloudy|mist|fog/, "多云"],
      [/snow|sleet|ice/, "雨雪天气"]
    ];
    return mappings.find(([pattern]) => pattern.test(normalized))?.[1] ?? description;
  }

  private buildWeatherGuidance(weather: any): string[] {
    const current = weather?.current_condition?.[0] ?? {};
    const today = weather?.weather?.[0] ?? {};
    const hourly = Array.isArray(today.hourly) ? today.hourly : [];
    const maxRainChance = hourly.reduce((max: number, hour: any) => {
      const value = Number(hour?.chanceofrain ?? 0);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0);
    const feels = Number(current.FeelsLikeC ?? current.temp_C);
    const humidity = Number(current.humidity);
    const wind = Number(current.windspeedKmph);
    const uv = Number(current.uvIndex ?? today.uvIndex);
    const description = String(current.weatherDesc?.[0]?.value ?? "").toLowerCase();
    const guidance: string[] = [];

    if (maxRainChance >= 50 || /rain|shower|drizzle|thunder/.test(description)) {
      guidance.push(`带伞出门，今日降雨概率最高约 ${maxRainChance || "较高"}%`);
    }
    if (Number.isFinite(feels) && feels >= 35) {
      guidance.push(`体感 ${feels}°C，少在正午久晒，记得补水`);
    } else if (Number.isFinite(feels) && feels <= 10) {
      guidance.push(`体感 ${feels}°C，外出添一件防风外套`);
    }
    if (Number.isFinite(uv) && uv >= 6) {
      guidance.push(`紫外线 ${uv} 级，长时间外出建议遮阳防晒`);
    }
    if (Number.isFinite(wind) && wind >= 25) {
      guidance.push(`风速约 ${wind} km/h，骑行留意侧风`);
    }
    if (guidance.length === 0 && Number.isFinite(humidity) && humidity >= 80) {
      guidance.push(`湿度 ${humidity}%，体感偏闷，室内注意通风`);
    }
    if (guidance.length === 0) {
      guidance.push("天气整体平稳，适合安排短途散步或通勤");
    }
    return guidance.slice(0, 2);
  }

  private populateLifeStatus(card: HTMLDivElement, weather: any, focusItems: Array<{ completed: boolean; text: string; path?: string }>, foodChoice: string): void {
    card.classList.remove("is-loading");
    card.empty();
    const statusTitle = card.createDiv({ cls: "aos-panel-title aos-life-icon-title" });
    const statusTitleIcon = statusTitle.createSpan({ cls: "aos-life-title-icon" });
    setIcon(statusTitleIcon, "house");
    statusTitle.createSpan({ text: "林下今日状态" });

    const dateObj = new Date();
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const month = String(dateObj.getMonth() + 1);
    const dateNum = String(dateObj.getDate());
    const weekdayStr = weekdays[dateObj.getDay()];
    const yearStr = String(dateObj.getFullYear());

    const dateRow = card.createDiv({ cls: "aos-life-date-row" });
    dateRow.createDiv({ cls: "aos-life-date-number", text: dateNum });

    const dateText = dateRow.createDiv({ cls: "aos-life-date-text" });
    dateText.createDiv({ cls: "month-year", text: `${month}月 · ${yearStr}` });
    dateText.createDiv({ cls: "weekday", text: weekdayStr });

    // Weather widget
    if (weather && weather.current_condition && weather.current_condition[0]) {
      const current = weather.current_condition[0];
      const temp = current.temp_C || "--";
      const rawDescription = current.weatherDesc?.[0]?.value || "未知天气";
      const desc = this.localizeWeatherDescription(rawDescription);
      const feels = current.FeelsLikeC || "--";
      const humidity = current.humidity || "--";
      const wind = current.windspeedKmph || "--";
      const todayHourly = weather.weather?.[0]?.hourly ?? [];
      const rainChance = todayHourly.reduce((max: number, hour: any) => Math.max(max, Number(hour?.chanceofrain ?? 0)), 0);
      const uv = current.uvIndex ?? weather.weather?.[0]?.uvIndex ?? "--";

      const descLower = rawDescription.toLowerCase();
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
      const weatherSymbol = currentEl.createSpan({ cls: "weather-symbol" });
      setIcon(weatherSymbol, weatherClass === "is-sunny" ? "sun" : weatherClass === "is-rainy" ? "cloud-rain" : weatherClass === "is-snowy" ? "snowflake" : "cloud");
      const temperatureBlock = currentEl.createDiv({ cls: "temperature-block" });
      temperatureBlock.createDiv({ cls: "temp-val", text: `${temp}°` });
      temperatureBlock.createDiv({ cls: "desc-val", text: desc });

      const detailsEl = weatherWidget.createDiv({ cls: "aos-weather-details" });
      detailsEl.createSpan({ text: `体感 ${feels}°` });
      detailsEl.createSpan({ text: `湿度 ${humidity}%` });
      detailsEl.createSpan({ text: `风 ${wind} km/h` });
      detailsEl.createSpan({ text: `降雨 ${rainChance}%` });
      detailsEl.createSpan({ text: `UV ${uv}` });

      const adviceEl = weatherWidget.createDiv({ cls: "aos-weather-advice" });
      adviceEl.createSpan({ cls: "advice-label", text: "今日提醒" });
      adviceEl.createSpan({ cls: "advice-text", text: this.buildWeatherGuidance(weather).join(" · ") });

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

    // Inspiration shelf — keep the established three-row visual, but make it
    // reflect the real微信想法 inbox instead of duplicating today's todo list.
    const focusTitle = card.createDiv({ cls: "aos-life-sub-title aos-life-icon-title" });
    const focusTitleIcon = focusTitle.createSpan({ cls: "aos-life-title-icon" });
    setIcon(focusTitleIcon, "lightbulb");
    focusTitle.createSpan({ text: "灵感集" });
    const focusContainer = card.createDiv({ cls: "aos-life-focus-list" });
    for (let index = 0; index < 3; index += 1) {
      const item = focusItems[index] ?? { completed: false, text: "" };
      const itemEl = focusContainer.createDiv({ cls: "aos-life-focus-item" });
      if (!item.text) {
        itemEl.classList.add("is-empty");
        itemEl.textContent = `0${index + 1}  ·  灵感收件箱暂无条目`;
      } else {
        itemEl.textContent = `💡 ${item.text}`;
      }
      itemEl.addEventListener("click", () => {
        if (item.path) {
          const node = this.toNode(item.path);
          if (node) void this.openNode(node);
          else new Notice(`灵感笔记不存在：${item.path}`);
        } else {
          this.switchModule("inspiration");
        }
      });
    }

    // Food choice
    const foodRow = card.createDiv({ cls: "aos-life-food-recommend" });
    const frogFile = this.app.vault.getAbstractFileByPath("08_密室/生活计划/frog.png");
    if (frogFile instanceof TFile) {
      const frogImg = foodRow.createEl("img", { cls: "aos-life-food-frog-icon" });
      frogImg.src = this.app.vault.getResourcePath(frogFile);
    } else {
      foodRow.createSpan({ cls: "food-label", text: "🐸 " });
    }
    foodRow.createSpan({ cls: "food-label", text: "今日食路推荐：" });
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

  private populateLifeTodo(card: HTMLDivElement, todos: PlanItem[]): void {
    card.classList.remove("is-loading");
    card.empty();
    const heading = card.createDiv({ cls: "aos-life-todo-heading" });
    const todoTitle = heading.createDiv({ cls: "aos-panel-title aos-life-icon-title" });
    const todoTitleIcon = todoTitle.createSpan({ cls: "aos-life-title-icon" });
    setIcon(todoTitleIcon, "list-checks");
    todoTitle.createSpan({ text: "密室今日小目标" });

    let completedCount = todos.filter(todo => todo.status === "done").length;
    const progressText = heading.createDiv({
      cls: "aos-life-todo-progress-text",
      text: todos.length > 0 ? `${completedCount} / ${todos.length} 已完成` : "今日尚未开张"
    });
    const progressTrack = card.createDiv({ cls: "aos-life-todo-progress-track" });
    const progressBar = progressTrack.createDiv({ cls: "aos-life-todo-progress-bar" });

    const updateProgress = (): void => {
      const percent = todos.length > 0 ? Math.round((completedCount / todos.length) * 100) : 0;
      progressText.textContent = todos.length > 0 ? `${completedCount} / ${todos.length} 已完成` : "今日尚未开张";
      progressBar.style.width = `${percent}%`;
      progressTrack.setAttribute("aria-label", `今日小目标完成度 ${percent}%`);
    };
    updateProgress();

    const listContainer = card.createDiv({ cls: "aos-life-todo-list" });
    if (todos.length === 0) {
      listContainer.createDiv({ cls: "aos-empty-state", text: "今日暂无目标，在下方极速记录一个吧！" });
    } else {
      const orderedTodos = [...todos].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
      for (const todo of orderedTodos) {
        const row = listContainer.createDiv({ cls: "aos-life-todo-row" });
        const isCompleted = todo.status === "done";
        row.classList.toggle("is-completed", isCompleted);
        const cb = row.createEl("input", { attr: { type: "checkbox" }, cls: "aos-life-todo-cb" });
        cb.checked = isCompleted;

        const label = row.createSpan({ text: todo.title, cls: "aos-life-todo-label" });
        if (isCompleted) label.classList.add("is-completed");
        label.setAttribute("title", "点击编辑小目标");
        label.addEventListener("click", () => this.openLifeTodoEditModal(todo));

        const rowActions = row.createDiv({ cls: "aos-life-todo-actions" });
        const action = (labelText: string, icon: string, title: string, handler: () => void): HTMLButtonElement => {
          const button = rowActions.createEl("button", { cls: "aos-life-todo-action", attr: { type: "button", title, "aria-label": title } });
          setIcon(button, icon);
          button.createSpan({ text: labelText });
          button.addEventListener("click", event => {
            event.stopPropagation();
            handler();
          });
          return button;
        };
        action("编辑", "pencil", "编辑小目标并调整日期或时段", () => this.openLifeTodoEditModal(todo));
        if (todo.source_note?.path) {
          action("查看来源", "lightbulb", "打开关联的来源灵感笔记；不会切换左侧灵感区", () => this.openFileByPath(todo.source_note!.path));
        } else {
          action("AI研产", "sparkles", "让 Copilot 围绕当前小目标研究并交付草案；不会自动落库", () => this.runLifeGoalResearch(todo));
        }
        action("移除", "trash-2", "从计划账本移除这条小目标", () => {
          void this.deleteLifeTodo(todo).catch(error => new Notice(`移除小目标失败：${error instanceof Error ? error.message : String(error)}`));
        });

        cb.addEventListener("change", async () => {
          const wasCompleted = todo.status === "done";
          const previousStatus = todo.status;
          todo.status = cb.checked ? "done" : "proposed";
          completedCount += cb.checked && !wasCompleted ? 1 : !cb.checked && wasCompleted ? -1 : 0;
          label.classList.toggle("is-completed", cb.checked);
          row.classList.toggle("is-completed", cb.checked);
          updateProgress();

          if (cb.checked) {
            listContainer.appendChild(row);
          } else {
            const firstCompleted = listContainer.querySelector(".aos-life-todo-row.is-completed");
            listContainer.insertBefore(row, firstCompleted);
          }
          try {
            await this.toggleTodoItem({ ...todo, status: previousStatus });
          } catch (error) {
            todo.status = wasCompleted ? "done" : "proposed";
            cb.checked = wasCompleted;
            label.classList.toggle("is-completed", wasCompleted);
            row.classList.toggle("is-completed", wasCompleted);
            completedCount += wasCompleted ? 1 : -1;
            updateProgress();
            new Notice(`更新小目标失败：${error instanceof Error ? error.message : String(error)}`);
          }
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

  private normalizeHandlesStr(str: string | undefined): string {
    return (str || "")
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(",");
  }

  private getDriftWarningText(diskHandles: string, memHandles: string, activeJobs: number, owner: string): string {
    const base = `配置漂移提示：天工台上的 X 巡逻账号配置已更改。当前内存中已运行的为 [${memHandles || "无"}]，磁盘最新配置为 [${diskHandles || "无"}]。`;
    if (activeJobs > 0) {
      return `⚠️ ${base}配置已保存；当前有活跃任务运行中，请等待任务结束后再重启。`;
    } else if (owner === "managed") {
      return `⚠️ ${base}配置已保存；可由天工台安全重启。`;
    } else if (owner === "external") {
      return `⚠️ ${base}配置已保存；当前 Daemon 由外部进程管理，请到原启动位置手动重启。`;
    }
    return `⚠️ ${base}保存配置并重启 Daemon 生效。`;
  }
}

class NoteEditorModal extends Modal {
  constructor(
    app: App,
    private initial: { mode: "create" | "edit"; path: string; content: string; onSubmit: (draft: NoteEditorDraft) => Promise<void> },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-note-editor-modal");
    contentEl.createEl("h2", { text: this.initial.mode === "create" ? "新建 Markdown 笔记" : "编辑 Markdown 笔记" });
    contentEl.createDiv({
      cls: "aos-note-editor-note",
      text: this.initial.mode === "create"
        ? "写入当前 Vault 的相对路径；目标已存在时会拒绝覆盖。"
        : "直接编辑完整 Markdown；保存会写回当前笔记，不移动附件。",
    });
    const form = contentEl.createEl("form", { cls: "aos-note-editor-form" });
    const pathLabel = form.createEl("label", { cls: "aos-note-editor-field" });
    pathLabel.createSpan({ text: "Vault 相对路径" });
    const pathInput = pathLabel.createEl("input", { attr: { type: "text", required: "true" } });
    pathInput.value = this.initial.path;
    pathInput.disabled = this.initial.mode === "edit";
    const contentLabel = form.createEl("label", { cls: "aos-note-editor-field aos-note-editor-content-field" });
    contentLabel.createSpan({ text: "Markdown 正文" });
    const contentInput = contentLabel.createEl("textarea", { attr: { required: "true", spellcheck: "false" } });
    contentInput.value = this.initial.content;
    const actions = form.createDiv({ cls: "aos-note-editor-actions" });
    const cancel = actions.createEl("button", { type: "button", text: "取消" });
    const submit = actions.createEl("button", { type: "submit", cls: "mod-cta", text: this.initial.mode === "create" ? "写入笔记" : "保存修改" });
    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", event => {
      event.preventDefault();
      const pathValue = pathInput.value.trim();
      const contentValue = contentInput.value;
      submit.disabled = true;
      void this.initial.onSubmit({ path: pathValue, content: contentValue })
        .then(() => this.close())
        .catch(error => {
          submit.disabled = false;
          new Notice(`笔记保存失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
    window.setTimeout(() => (this.initial.mode === "create" ? pathInput : contentInput).focus(), 0);
  }
}

type NoteDeleteModalOptions = {
  heading?: string;
  warning?: string;
  confirmLabel?: string;
};

class NoteDeleteModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private onConfirm: () => Promise<void>,
    private options: NoteDeleteModalOptions = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const heading = this.options.heading ?? "移入系统回收站";
    const confirmLabel = this.options.confirmLabel ?? "移入回收站";
    const warning = this.options.warning ?? `确定将「${this.title}」移入 Obsidian 系统回收站吗？原文不会被永久删除。`;
    contentEl.empty();
    contentEl.addClass("aos-note-delete-modal");
    contentEl.createEl("h2", { text: heading });
    contentEl.createDiv({ cls: "aos-note-delete-warning", text: warning });
    const actions = contentEl.createDiv({ cls: "aos-note-editor-actions" });
    const cancel = actions.createEl("button", { type: "button", text: "取消" });
    const confirm = actions.createEl("button", { type: "button", cls: "mod-warning", text: confirmLabel });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.onConfirm()
        .then(() => this.close())
        .catch(error => {
          confirm.disabled = false;
          new Notice(`${heading}失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }
}

class PermanentNoteDeleteModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private preflight: PermanentDeletionPreflight,
    private onConfirm: (attachmentPaths: string[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-note-delete-modal", "aos-permanent-delete-modal");
    contentEl.createEl("h2", { text: "彻底删除笔记" });
    contentEl.createDiv({
      cls: "aos-note-delete-warning",
      text: `「${this.title}」将从 Vault 中不可逆删除，不能恢复。系统不会改写其他笔记；仍指向它的双链会保留为断链。`,
    });

    const backlinks = contentEl.createDiv({ cls: "aos-permanent-delete-section" });
    backlinks.createEl("h3", { text: `仍有 ${this.preflight.backlinks.length} 条已解析反链` });
    if (this.preflight.backlinks.length) {
      const list = backlinks.createEl("ul", { cls: "aos-permanent-delete-list" });
      for (const backlink of this.preflight.backlinks) list.createEl("li", { text: backlink });
    } else {
      backlinks.createDiv({ cls: "aos-permanent-delete-note", text: "当前 Metadata Cache 未发现其他笔记指向这篇笔记。未解析或尚未索引的链接无法保证被发现。" });
    }

    const attachmentSection = contentEl.createDiv({ cls: "aos-permanent-delete-section" });
    attachmentSection.createEl("h3", { text: "附件预检" });
    attachmentSection.createDiv({
      cls: "aos-permanent-delete-note",
      text: "回收和恢复都不会移动附件。以下仅列出本笔记嵌入或前置属性引用的非 Markdown 文件；默认一律保留。",
    });
    const selectedAttachments = new Set<string>();
    if (this.preflight.exclusiveAttachments.length) {
      attachmentSection.createDiv({ cls: "aos-permanent-delete-subheading", text: "可选清理：当前只有这篇待删笔记引用" });
      const exclusiveList = attachmentSection.createDiv({ cls: "aos-permanent-delete-attachments" });
      for (const attachment of this.preflight.exclusiveAttachments) {
        const label = exclusiveList.createEl("label", { cls: "aos-permanent-delete-attachment" });
        const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedAttachments.add(attachment.path);
          else selectedAttachments.delete(attachment.path);
        });
        label.createSpan({ text: attachment.path });
      }
    } else {
      attachmentSection.createDiv({ cls: "aos-permanent-delete-note", text: "未发现可安全自动判定为独占的附件。" });
    }
    if (this.preflight.sharedAttachments.length) {
      attachmentSection.createDiv({ cls: "aos-permanent-delete-subheading", text: "共享附件：将保留" });
      const sharedList = attachmentSection.createEl("ul", { cls: "aos-permanent-delete-list" });
      for (const attachment of this.preflight.sharedAttachments) {
        sharedList.createEl("li", { text: `${attachment.path}（另有至少 ${Math.max(1, attachment.backlinks.length - 1)} 条已解析引用）` });
      }
    }

    const confirmation = contentEl.createEl("label", { cls: "aos-note-editor-field" });
    confirmation.createSpan({ text: "输入「彻底删除」以确认不可逆操作" });
    const input = confirmation.createEl("input", { attr: { type: "text", autocomplete: "off" } });
    const actions = contentEl.createDiv({ cls: "aos-note-editor-actions" });
    const cancel = actions.createEl("button", { type: "button", text: "取消" });
    const confirm = actions.createEl("button", { type: "button", cls: "mod-warning", text: "彻底删除" });
    confirm.disabled = true;
    input.addEventListener("input", () => { confirm.disabled = input.value.trim() !== "彻底删除"; });
    cancel.addEventListener("click", () => this.close());
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void this.onConfirm([...selectedAttachments])
        .then(() => this.close())
        .catch(error => {
          confirm.disabled = false;
          new Notice(`彻底删除失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
    window.setTimeout(() => input.focus(), 0);
  }
}

class CloudAssetPreviewModal extends Modal {
  private image: HTMLImageElement | null = null;
  private expiry: HTMLElement | null = null;

  constructor(
    app: App,
    private receipt: HamasxiangAssetLinkReceipt,
    private refreshLink: () => Promise<HamasxiangAssetLinkReceipt>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-cloud-asset-preview-modal");
    contentEl.createEl("h2", { text: "云端图片预览" });
    contentEl.createDiv({
      cls: "aos-cloud-asset-preview-note",
      text: "当前预览只在此窗口临时使用；访问链接不会写入笔记、设置或资产账本。",
    });
    const image = contentEl.createEl("img", {
      cls: "aos-cloud-asset-preview-image",
      attr: { alt: `云端图片 ${this.receipt.assetId}` },
    });
    this.image = image;
    const expiry = contentEl.createDiv({ cls: "aos-cloud-asset-preview-expiry" });
    this.expiry = expiry;
    this.applyReceipt(this.receipt);

    const actions = contentEl.createDiv({ cls: "aos-cloud-asset-preview-actions" });
    const refresh = actions.createEl("button", { type: "button", text: "刷新当前访问" });
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      void this.refreshLink()
        .then(receipt => this.applyReceipt(receipt))
        .catch(error => new Notice(`刷新云端图片访问失败：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { refresh.disabled = false; });
    });
    const close = actions.createEl("button", { type: "button", text: "关闭" });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    // A signed URL is an ephemeral bearer capability. Do not leave it in the
    // detached DOM after the preview is closed.
    if (this.image) this.image.removeAttribute("src");
    this.image = null;
    this.expiry = null;
    this.contentEl.empty();
  }

  private applyReceipt(receipt: HamasxiangAssetLinkReceipt): void {
    this.receipt = receipt;
    if (this.image) this.image.src = receipt.url;
    if (this.expiry) {
      const parsed = Date.parse(receipt.expiresAt);
      const deadline = Number.isFinite(parsed)
        ? new Date(parsed).toLocaleString("zh-CN", { hour12: false })
        : "时间未知";
      this.expiry.textContent = `${receipt.role === "display" ? "展示图" : "原图"} · 当前访问至 ${deadline}`;
    }
  }
}

class ScheduleCreateModal extends Modal {
  constructor(
    app: App,
    private initial: CreatePlanItemInput,
    private onSubmit: (input: CreatePlanItemInput) => Promise<void>,
    private labels: { heading?: string; submit?: string } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-schedule-create-modal");
    contentEl.createEl("h2", { text: this.labels.heading ?? "新增计划卡片" });
    contentEl.createDiv({ cls: "aos-schedule-create-note", text: "卡片会写入本地计划事件流，之后刷新页面仍会保留。" });
    if (this.initial.sourceNotePath) {
      contentEl.createDiv({ cls: "aos-schedule-create-source", text: `来源灵感：${this.initial.sourceNotePath}` });
    }

    const form = contentEl.createEl("form", { cls: "aos-schedule-create-form" });
    const titleLabel = form.createEl("label", { cls: "aos-schedule-create-field" });
    titleLabel.createSpan({ text: "标题" });
    const titleInput = titleLabel.createEl("input", {
      attr: { type: "text", placeholder: "例如：整理松果天工台的前沿情报与架构笔记", required: "true", autofocus: "true" },
    });
    titleInput.value = this.initial.title;

    const basics = form.createDiv({ cls: "aos-schedule-create-grid" });
    const kindLabel = basics.createEl("label", { cls: "aos-schedule-create-field" });
    kindLabel.createSpan({ text: "卡片类型" });
    const kindSelect = kindLabel.createEl("select");
    kindSelect.createEl("option", { value: "micro_task", text: "小目标" });
    kindSelect.createEl("option", { value: "focus", text: "今日要事" });
    kindSelect.value = this.initial.kind;

    const dateLabel = basics.createEl("label", { cls: "aos-schedule-create-field" });
    dateLabel.createSpan({ text: "日期" });
    const dateInput = dateLabel.createEl("input", { attr: { type: "date", required: "true" } });
    dateInput.value = this.initial.date;

    const scheduleLabel = form.createEl("label", { cls: "aos-schedule-create-toggle" });
    const scheduleInput = scheduleLabel.createEl("input", { attr: { type: "checkbox" } });
    scheduleInput.checked = this.initial.scheduled;
    scheduleLabel.createSpan({ text: "安排到时间轴" });

    const timeGrid = form.createDiv({ cls: "aos-schedule-create-grid aos-schedule-time-fields" });
    const startLabel = timeGrid.createEl("label", { cls: "aos-schedule-create-field" });
    startLabel.createSpan({ text: "开始" });
    const startInput = startLabel.createEl("input", { attr: { type: "time", required: "true" } });
    startInput.value = this.initial.start;

    const endLabel = timeGrid.createEl("label", { cls: "aos-schedule-create-field" });
    endLabel.createSpan({ text: "结束" });
    const endInput = endLabel.createEl("input", { attr: { type: "time", required: "true" } });
    endInput.value = this.initial.end;

    const updateTimeState = (): void => {
      startInput.disabled = !scheduleInput.checked;
      endInput.disabled = !scheduleInput.checked;
      timeGrid.classList.toggle("is-disabled", !scheduleInput.checked);
    };
    scheduleInput.addEventListener("change", updateTimeState);
    updateTimeState();

    const actions = form.createDiv({ cls: "aos-schedule-create-actions" });
    const cancel = actions.createEl("button", { type: "button", text: "取消" });
    const submit = actions.createEl("button", { type: "submit", cls: "mod-cta", text: this.labels.submit ?? "加入计划" });
    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = titleInput.value.trim();
      if (!title || !dateInput.value) {
        new Notice("请填写标题和日期");
        return;
      }
      const input: CreatePlanItemInput = {
        title,
        kind: kindSelect.value as PlanItemKind,
        date: dateInput.value,
        scheduled: scheduleInput.checked,
        start: startInput.value,
        end: endInput.value,
        sourceNotePath: this.initial.sourceNotePath,
      };
      submit.disabled = true;
      void this.onSubmit(input)
        .then(() => this.close())
        .catch(error => {
          submit.disabled = false;
          new Notice(`新增卡片失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }
}

class WorkspaceShortcutModal extends Modal {
  constructor(
    app: App,
    private plugin: ScriptoriumPlugin,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass("aos-workspace-shortcut-shell");
    contentEl.empty();
    contentEl.addClass("aos-workspace-shortcut-modal");
    contentEl.createEl("h2", { text: "工作台快捷键" });
    contentEl.createDiv({
      cls: "aos-workspace-shortcut-note",
      text: "Alt + QWE / ASD / ZXC 切换模块；图谱内使用 A/D 与 Q/W/E/R。点击键位即可改键，鼠标侧键继续负责前进/后退。",
    });

    let draft: WorkspaceShortcutSettings = normalizeWorkspaceShortcuts(this.plugin.settings.workspaceShortcuts);
    let capturing: WorkspaceShortcutId | null = null;
    const captureButtons = new Map<WorkspaceShortcutId, HTMLButtonElement>();
    const setCaptureText = (id: WorkspaceShortcutId, text?: string): void => {
      const button = captureButtons.get(id);
      if (!button) return;
      button.empty();
      button.createSpan({ text: text ?? formatShortcut(draft[id]) });
    };
    const stopCapturing = (): void => {
      if (capturing) setCaptureText(capturing);
      capturing = null;
    };

    const groups = new Map<string, typeof WORKSPACE_SHORTCUT_DEFINITIONS[number][]>();
    for (const definition of WORKSPACE_SHORTCUT_DEFINITIONS) {
      const definitions = groups.get(definition.group) ?? [];
      definitions.push(definition);
      groups.set(definition.group, definitions);
    }
    const list = contentEl.createDiv({ cls: "aos-workspace-shortcut-list" });
    for (const [group, definitions] of groups) {
      const isModuleGroup = group === "模块切换";
      const section = list.createDiv({
        cls: `aos-workspace-shortcut-group ${isModuleGroup ? "is-modules" : "is-graph"}`,
      });
      section.createDiv({ cls: "aos-workspace-shortcut-group-title", text: group });
      const grid = section.createDiv({ cls: "aos-workspace-shortcut-grid" });
      for (const definition of definitions) {
        const item = grid.createDiv({ cls: "aos-workspace-shortcut-row" });
        item.dataset.shortcutId = definition.id;
        const copy = item.createDiv({ cls: "aos-workspace-shortcut-description" });
        copy.createDiv({ cls: "aos-workspace-shortcut-label", text: definition.label });
        copy.createDiv({ cls: "aos-workspace-shortcut-help", text: definition.description });
        const capture = item.createEl("button", {
          cls: "aos-workspace-shortcut-key aos-workspace-shortcut-capture",
          attr: { type: "button", "aria-label": `设置${definition.label}快捷键` },
        });
        captureButtons.set(definition.id, capture);
        setCaptureText(definition.id);
        capture.addEventListener("click", () => {
          if (capturing && capturing !== definition.id) setCaptureText(capturing);
          capturing = definition.id;
          capture.empty();
          capture.createSpan({ cls: "is-capturing", text: "按下组合键…" });
          capture.focus();
        });
        capture.addEventListener("keydown", event => {
          if (capturing !== definition.id) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            stopCapturing();
            return;
          }
          const next = serializeShortcutEvent(event);
          if (!next) return;
          draft[definition.id] = next;
          setCaptureText(definition.id);
          capturing = null;
        });
      }
    }

    const footer = contentEl.createDiv({ cls: "aos-workspace-shortcut-actions" });
    const reset = footer.createEl("button", { type: "button", text: "恢复默认" });
    reset.addEventListener("click", () => {
      stopCapturing();
      draft = { ...DEFAULT_WORKSPACE_SHORTCUTS };
      for (const definition of WORKSPACE_SHORTCUT_DEFINITIONS) setCaptureText(definition.id);
    });
    const cancel = footer.createEl("button", { type: "button", text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { type: "button", cls: "mod-cta", text: "保存快捷键" });
    save.addEventListener("click", () => {
      stopCapturing();
      const duplicates = new Map<string, string>();
      for (const definition of WORKSPACE_SHORTCUT_DEFINITIONS) {
        const binding = draft[definition.id];
        const previous = duplicates.get(binding);
        if (previous) {
          new Notice(`快捷键冲突：${previous} 与 ${definition.label} 都是 ${formatShortcut(binding)}`);
          return;
        }
        duplicates.set(binding, definition.label);
      }
      this.plugin.settings.workspaceShortcuts = normalizeWorkspaceShortcuts(draft);
      void this.plugin.saveSettings().then(() => {
        new Notice("工作台快捷键已保存");
        this.onSaved();
        this.close();
      });
    });
  }
}

class ScheduleShortcutModal extends Modal {
  constructor(
    app: App,
    private plugin: ScriptoriumPlugin,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-schedule-shortcut-modal");
    contentEl.createEl("h2", { text: "日程快捷键" });
    contentEl.createDiv({
      cls: "aos-schedule-shortcut-note",
      text: "先点击右侧按键框，再按下想要的组合键。快捷键只在时间轴卡片获得焦点时生效，不会覆盖 Obsidian 的全局命令。",
    });

    let draft: ScheduleShortcutSettings = structuredClone(this.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS);
    let capturing: ScheduleShortcutName | null = null;
    const captureButtons = new Map<ScheduleShortcutName, HTMLButtonElement>();

    const setCaptureText = (key: ScheduleShortcutName, text?: string): void => {
      const button = captureButtons.get(key);
      if (!button) return;
      button.empty();
      button.createSpan({ text: text ?? formatShortcut(draft[key]) });
    };
    const stopCapturing = (): void => {
      if (capturing) setCaptureText(capturing);
      capturing = null;
    };

    const list = contentEl.createDiv({ cls: "aos-schedule-shortcut-list" });
    for (const action of SCHEDULE_SHORTCUT_LABELS) {
      const row = list.createDiv({ cls: "aos-schedule-shortcut-row" });
      const description = row.createDiv({ cls: "aos-schedule-shortcut-description" });
      description.createDiv({ cls: "aos-schedule-shortcut-label", text: action.label });
      description.createDiv({ cls: "aos-schedule-shortcut-help", text: action.description });
      const capture = row.createEl("button", {
        cls: "aos-schedule-shortcut-capture",
        attr: { type: "button", "aria-label": `设置${action.label}快捷键` },
      });
      captureButtons.set(action.key, capture);
      setCaptureText(action.key);
      capture.addEventListener("click", () => {
        if (capturing && capturing !== action.key) setCaptureText(capturing);
        capturing = action.key;
        capture.empty();
        capture.createSpan({ cls: "is-capturing", text: "按下组合键…" });
        capture.focus();
      });
      capture.addEventListener("keydown", event => {
        if (capturing !== action.key) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          stopCapturing();
          return;
        }
        const next = serializeShortcutEvent(event);
        if (!next) return;
        draft[action.key] = next;
        setCaptureText(action.key);
        capturing = null;
      });
    }

    const footer = contentEl.createDiv({ cls: "aos-schedule-shortcut-actions" });
    const reset = footer.createEl("button", { type: "button", text: "恢复默认" });
    reset.addEventListener("click", () => {
      stopCapturing();
      draft = structuredClone(DEFAULT_SCHEDULE_SHORTCUTS);
      for (const action of SCHEDULE_SHORTCUT_LABELS) setCaptureText(action.key);
    });
    const cancel = footer.createEl("button", { type: "button", text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { type: "button", cls: "mod-cta", text: "保存快捷键" });
    save.addEventListener("click", () => {
      stopCapturing();
      const duplicates = new Map<string, string>();
      for (const action of SCHEDULE_SHORTCUT_LABELS) {
        const previous = duplicates.get(draft[action.key]);
        if (previous) {
          new Notice(`快捷键冲突：${previous} 与 ${action.label} 都是 ${formatShortcut(draft[action.key])}`);
          return;
        }
        duplicates.set(draft[action.key], action.label);
      }
      this.plugin.settings.scheduleShortcuts = { ...draft };
      void this.plugin.saveSettings().then(() => {
        new Notice("日程快捷键已保存");
        this.onSaved();
        this.close();
      });
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
