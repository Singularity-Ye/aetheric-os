import { Notice, setIcon, requestUrl, TFile } from "obsidian";
import type { HamasxiangCaptureReceipt, HamasxiangPlatformHealthSnapshot } from "../HamasxiangAdapter";
import { GitStatusItem } from "../operations/HamasxiangOperationsService";
import { ProcessRegistryEntry } from "../operations/ProcessRegistry";
import { dedupeCaptureUrls, capturePlatformLabel } from "../CaptureUrlUtils";
import { AosUI } from "../ui/AosUI";

export interface CollectionPageContext {
  plugin: any;
  app: any;
  mainPane: HTMLElement;
  isShellActive: () => boolean;
  getCurrentRenderId: () => number;
  metric: (parent: HTMLElement, label: string, value: string, detail: string) => HTMLElement;
  actionButton: (parent: HTMLElement, text: string, onClick: () => void) => HTMLElement;
  formatSnapshotTime: (timestamp?: number) => string;
  formatNextRun: (isoStr?: string | null) => string;
  xWatchLabel: (xWatch?: any) => string;
  getDriftWarningText: (diskHandles: string, memHandles: string, activeJobs: number, owner: string) => string;
  normalizeHandlesStr: (input?: string) => string;
  loadEnvConfig: () => Promise<void>;
  saveEnvConfig: (updates: Record<string, string>) => Promise<void>;
  getEnvConfig: () => Record<string, string>;
  isEnvLoading: () => boolean;
  isEnvLoaded: () => boolean;
  setEnvLoaded: (v: boolean) => void;
  renderTaskList: (parent: HTMLElement, tasks: any[], mini: boolean) => void;
  renderArtifactList: (parent: HTMLElement, artifacts: readonly any[]) => void;
  renderPlatformHealth: (parent: HTMLElement, health: any) => void;
  renderCaptureReceipt: (parent: HTMLElement, receipt: any) => void;
  runXWatch: () => void;
}

/**
 * CollectionPage: Decoupled Collection, Daemon control, analytics, and crawler workbench.
 */
export class CollectionPage {
  private collectionTab: string = "dashboard";
  private collectionRenderToken = 0;
  private collectionTabToken = 0;
  private analyticsSearchQuery = "";
  private ledgerDisplayLimit = 50;
  private isScanningGit = false;
  private gitChanges: GitStatusItem[] | null = [];
  private gitCommitMsg = "";
  private gitAcknowledgement = false;
  private isDedupEnabled: boolean | null = null;
  private isTogglingDedup = false;
  private unsubscribeAnalytics?: () => void;

  constructor(private context: CollectionPageContext) {}

  dispose(): void {
    if (this.unsubscribeAnalytics) {
      this.unsubscribeAnalytics();
      this.unsubscribeAnalytics = undefined;
    }
  }

  mount(): void {
    this.renderCollection();
  }

  private renderCollection(): void {
    if (this.context.plugin.store.getSnapshot().activeModule !== "collection") return;
    const renderToken = ++this.collectionRenderToken;
    const pageRenderId = this.context.getCurrentRenderId();
    const isCurrentCollection = (): boolean =>
      this.context.isShellActive()
      && this.context.plugin.store.getSnapshot().activeModule === "collection"
      && this.collectionRenderToken === renderToken
      && this.context.getCurrentRenderId() === pageRenderId;
    this.context.mainPane.empty();
    const snapshot = this.context.plugin.hamasxiangAdapter.getSnapshot();
    const page = this.context.mainPane.createDiv({ cls: "aos-page aos-hamasxiang-page" });
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
          this.context.plugin.analyticsService.setActive(true);
          // Subscribe if not subscribed
          if (!this.unsubscribeAnalytics) {
            this.unsubscribeAnalytics = this.context.plugin.analyticsService.subscribe(() => {
              if (isCurrentCollection() && this.collectionTab === "analytics") {
                this.renderCollection();
              }
            });
          }
        } else {
          this.context.plugin.analyticsService.setActive(false);
        }

        if (tab.id === "config" || tab.id === "sources") {
          await this.context.loadEnvConfig();
        }
        if (tabToken === this.collectionTabToken && isCurrentCollection()) this.renderCollection();
      });
    });

    if (!this.context.isEnvLoading() && !this.context.isEnvLoaded()) {
      this.context.setEnvLoaded(true);
      void this.context.loadEnvConfig().then(() => {
        if (isCurrentCollection()) this.renderCollection();
      });
    }

    // Auto-polling re-render if background tasks are running
    const activeProcs = this.context.plugin.processRegistry.list();
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
      if (this.context.isEnvLoading()) {
        page.createDiv({ cls: "aos-spinner-small" });
      } else {
        this.renderCollectionSources(page, snapshot);
      }
    } else if (this.collectionTab === "operations") {
      this.renderCollectionOperations(page);
    } else if (this.collectionTab === "analytics") {
      this.renderCollectionAnalytics(page);
    } else {
      if (this.context.isEnvLoading()) {
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

    const owner = this.context.plugin.daemonOwnership;
    let daemonDetailText = "服务离线";
    if (owner === "managed") daemonDetailText = "天工台单实例进程守护中";
    else if (owner === "external") daemonDetailText = "复用外部活动进程运行中";

    intro.createDiv({ cls: "aos-panel-note", text: `Daemon 状态: ${daemonDetailText}` });

    const badge = hero.createSpan({ cls: `aos-service-badge ${snapshot.online ? "is-online" : "is-offline"}` });
    badge.createSpan({ cls: "aos-badge-dot" });
    badge.createSpan({ text: snapshot.online ? "本地 Daemon 在线" : "本地 Daemon 离线" });

    const resourceErrors = this.context.plugin.hamasxiangAdapter.getResourceErrors();
    const health = page.createDiv({ cls: `aos-capture-health ${snapshot.online ? "is-online" : "is-offline"}` });
    health.createSpan({ cls: "aos-capture-health-dot" });
    health.createSpan({
      cls: "aos-capture-health-main",
      text: snapshot.online ? "采集入口可用" : "采集入口暂不可用",
    });
    health.createSpan({
      cls: "aos-capture-health-detail",
      text: snapshot.checkedAt ? `最近检查 ${this.context.formatSnapshotTime(snapshot.checkedAt)}` : "尚未完成健康检查",
    });
    if (resourceErrors.length) {
      health.createSpan({
        cls: "aos-capture-health-warning",
        text: `${resourceErrors.length} 个附属数据源暂时不可读`,
        attr: { title: resourceErrors.map((error: any) => `${error.resource}: ${error.message}`).join("\n") },
      });
    }
    if (snapshot.online && snapshot.platformHealth) {
      this.context.renderPlatformHealth(page, snapshot.platformHealth);
    }

    // Configuration drift detection warning banner
    const diskHandles = this.context.normalizeHandlesStr(this.context.getEnvConfig()["X_WATCH_HANDLES"]);
    const memHandles = this.context.normalizeHandlesStr(snapshot.xWatch?.handles);
    if (snapshot.online && diskHandles !== memHandles) {
      const alertDiv = page.createDiv({ cls: "aos-confirm-block aos-drift-warning" });
      alertDiv.createDiv({
        cls: "confirm-message",
        text: this.context.getDriftWarningText(diskHandles, memHandles, snapshot.activeJobs, owner)
      });
    }

    const controlRow = page.createDiv({ cls: "aos-action-row aos-daemon-controls" });
    this.context.actionButton(controlRow, "刷新炉火", () => void this.context.plugin.hamasxiangAdapter.refresh(true));
    this.context.actionButton(controlRow, "立即巡逻 X", () => void this.context.runXWatch());

    if (!snapshot.online) {
      this.context.actionButton(controlRow, "🚀 启动 Daemon", () => void this.context.plugin.startDaemon());
    } else if (owner === "managed") {
      this.context.actionButton(controlRow, "🛑 停止 Daemon", () => void this.context.plugin.stopDaemon());
    }

    // Dedup Lock Status loading
    if (this.isDedupEnabled === null && !this.isTogglingDedup && snapshot.online) {
      this.isTogglingDedup = true;
      this.context.plugin.workerControl.fetchStatus()
        .then((enabled: any) => {
          this.isDedupEnabled = enabled;
          this.isTogglingDedup = false;
          this.renderCollection();
        })
        .catch((err: any) => {
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
        const newEnabled = await this.context.plugin.workerControl.toggleStatus(originalState);
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
    this.context.metric(metrics, "端口", snapshot.online ? "8765" : "未连接", snapshot.online ? "127.0.0.1 · hamaxiang-daemon" : "服务离线");
    this.context.metric(metrics, "服务版本", snapshot.version ? `v${snapshot.version}` : "--", "GET /health");
    this.context.metric(metrics, "活跃任务数", `${snapshot.activeJobs}`, "排队或抓取中");
    this.context.metric(metrics, "X Watch 状态", this.context.xWatchLabel(snapshot.xWatch), "定时任务循环");
    this.context.metric(metrics, "下次巡逻时间", this.context.formatNextRun(snapshot.xWatch.next_run_at), "X Watch");

    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });

    // Top-row: Left card Tasks
    const taskPanel = leftPane.createDiv({ cls: "aos-panel" });
    taskPanel.createDiv({ cls: "aos-panel-title", text: "采集任务快照" });
    this.context.renderTaskList(taskPanel, this.context.plugin.hamasxiangAdapter.getTasks(), false);

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
    const previousReceipt = this.context.plugin.hamasxiangAdapter.getLastCaptureReceipt();
    if (previousReceipt) this.context.renderCaptureReceipt(receiptHost, previousReceipt);
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
        this.context.renderCaptureReceipt(receiptHost, receipt);
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
      const state = this.context.plugin.store.getSnapshot();
      this.context.plugin.store.patch({ logDock: { ...state.logDock, open: true } });
    });

    const logsContainer = logPanel.createDiv({ cls: "aos-daemon-logs-console" });
    const allLogs = this.context.plugin.logBus.getEntries();
    const daemonLogs = allLogs.filter((entry: any) => entry.source.startsWith("hamaxiang") || entry.source.startsWith("hamasxiang"));

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
    return await this.context.plugin.hamasxiangAdapter.submitCaptureJob({
      source_urls: urls,
      intent: "save",
      title: urls.length > 1 ? `统一采集 · ${urls.length} 条链接` : "手动采集任务",
      source: "aetheric-workbench",
    });
  }

  private renderCollectionSources(page: HTMLDivElement, snapshot: any): void {
    const env = this.context.getEnvConfig();
    const grid = page.createDiv({ cls: "aos-collection-grid" });
    const leftPane = grid.createDiv({ cls: "aos-collection-left-pane" });

    const xPanel = leftPane.createDiv({ cls: "aos-panel" });
    xPanel.createDiv({ cls: "aos-panel-title", text: "📡 Twitter/X 情报数据源" });
    xPanel.createDiv({ cls: "aos-panel-note", text: "配置要巡逻的 X 账号句柄列表（从 Daemon .env 读取）" });

    // Add config drift alert warning
    const diskHandles = this.context.normalizeHandlesStr(env["X_WATCH_HANDLES"]);
    const memHandles = this.context.normalizeHandlesStr(snapshot.xWatch?.handles);
    if (snapshot.online && diskHandles !== memHandles) {
      const alertDiv = xPanel.createDiv({ cls: "aos-confirm-block aos-drift-warning" });
      alertDiv.style.cssText = "margin: 10px 0 15px 0; padding: 10px;";
      alertDiv.createDiv({
        cls: "confirm-message",
        text: this.context.getDriftWarningText(diskHandles, memHandles, snapshot.activeJobs, this.context.plugin.daemonOwnership)
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
            await this.context.plugin.hamasxiangAdapter.runXWatch(handle);
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
          await this.context.saveEnvConfig(env);
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
      await this.context.saveEnvConfig(env);
      addInput.value = "";
      new Notice(`已添加巡逻账号 @${handle} 到 .env 配置`);
      this.renderCollection();
    });

    const artPanel = leftPane.createDiv({ cls: "aos-panel" });
    artPanel.createDiv({ cls: "aos-panel-title", text: "最近情报与采集产物" });
    this.context.renderArtifactList(artPanel, this.context.plugin.hamasxiangAdapter.getArtifacts().slice(0, 10));

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
      void this.context.plugin.hamasxiangOperations.runManualGrab(url, forceCheck.checked).then(() => {
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
        this.context.plugin.hamasxiangOperations.runSync();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const knowledgeExportBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "导出知识镜像" });
    knowledgeExportBtn.title = "只导出允许的收件箱与松果天工台笔记，不自动 Git 推送";
    knowledgeExportBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runKnowledgeExport();
        new Notice("知识镜像已开始生成，完成后可在 hamaxiang-system/data/knowledge/export 检查。", 5000);
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const repairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "全库 ASR 精修" });
    repairBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runRepair();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const biliRepairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "B站 ASR 修复" });
    biliRepairBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runPlatformRepair("bilibili");
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const dyRepairBtn = btnGrid.createEl("button", { cls: "aos-btn", text: "抖音 ASR 修复" });
    dyRepairBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runPlatformRepair("douyin");
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const quarantineBtn = btnGrid.createEl("button", { cls: "aos-btn aos-ops-caution", text: "隔离异常卷宗" });
    quarantineBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runQuarantine();
        this.renderCollection();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const restoreBtn = btnGrid.createEl("button", { cls: "aos-btn aos-ops-caution", text: "还原隔离卷宗" });
    restoreBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.runRestore();
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
        this.context.plugin.hamasxiangOperations.runPublish();
      } catch (err: any) {
        new Notice(err.message);
      }
    });

    const isPreviewRunning = this.context.plugin.processRegistry.isRunning("preview");
    const previewToggleBtn = previewGrid.createEl("button", {
      cls: `aos-btn aos-preview-action ${isPreviewRunning ? "is-danger" : ""}`,
      text: isPreviewRunning ? "关闭本地预览" : "开启本地预览"
    });
    if (isPreviewRunning) {
      previewToggleBtn.style.cssText = "background: rgba(239, 68, 68, 0.1) !important; border: 1px solid rgba(239, 68, 68, 0.4) !important; color: #ef4444 !important;";
    }
    previewToggleBtn.addEventListener("click", () => {
      try {
        this.context.plugin.hamasxiangOperations.toggleDevServer();
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
        this.gitChanges = await this.context.plugin.hamasxiangOperations.checkGitStatus();
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

    const isRunningGit = this.context.plugin.processRegistry.isRunning("git");
    const remoteSyncBtn = gitActionsRow.createEl("button", {
      cls: "aos-btn aos-git-action aos-git-remote",
      text: "同步远端"
    });
    if (isRunningGit) remoteSyncBtn.setAttribute("disabled", "true");
    remoteSyncBtn.addEventListener("click", async () => {
      try {
        new Notice("开始远端 Git 同步 (pull & push)...");
        await this.context.plugin.hamasxiangOperations.runGitSyncRemote();
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
            const ok = await this.context.plugin.hamasxiangOperations.runGitBackup(files, this.gitCommitMsg);
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

    const activeProcesses = this.context.plugin.processRegistry.list();
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
        const prog = this.context.plugin.hamasxiangOperations.getLastProgress(proc.taskType);
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
          await this.context.plugin.processRegistry.kill(proc.taskType);
          this.renderCollection();
        });
      });
    }
  }

  private renderCollectionAnalytics(page: HTMLDivElement): void {
    const snap = this.context.plugin.analyticsService.getSnapshot();

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
    const filteredScrolls = snap.scrollsList.filter((s: any) => {
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
      visibleScrolls.forEach((item: any) => {
        const tr = tbody.createEl("tr");
        tr.style.cssText = "border-bottom: 1px solid rgba(0,0,0,0.02); cursor: pointer; transition: background 0.1s ease;";
        tr.addEventListener("mouseenter", () => { tr.style.background = "rgba(119,157,116,0.05)"; });
        tr.addEventListener("mouseleave", () => { tr.style.background = "transparent"; });
        tr.addEventListener("click", () => {
          const file = this.context.app.vault.getAbstractFileByPath(item.filePath);
          if (file instanceof TFile) {
            void this.context.app.workspace.getLeaf(false).openFile(file);
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
    const env = this.context.getEnvConfig();
    const configPanel = page.createDiv({ cls: "aos-panel aos-daemon-config-panel" });
    configPanel.createDiv({ cls: "aos-panel-title", text: "⚙️ 蛤蟆祥 Daemon 环境配置编辑器" });

    const owner = this.context.plugin.daemonOwnership;
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
          await this.context.saveEnvConfig(updates);
          new Notice("配置已成功写入 .env 文件！");

          if (this.context.plugin.daemonOwnership === "managed") {
            const stopped = await this.context.plugin.stopDaemon();
            if (stopped) {
              await this.context.plugin.startDaemon();
              new Notice("蛤蟆祥 Daemon 进程已成功重新拉起生效！");
            } else {
              new Notice("配置已保存；但 Daemon 停止失败，请手动重启进程。");
            }
          } else if (this.context.plugin.daemonOwnership === "external") {
            new Notice("配置已保存；当前 Daemon 由外部进程管理，请在原启动位置重启。");
          } else {
            // offline, try start
            await this.context.plugin.startDaemon();
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
      const snapshot = this.context.plugin.hamasxiangAdapter.getSnapshot();
      const activeJobs = snapshot.activeJobs || 0;
      if (activeJobs > 0 && this.context.plugin.daemonOwnership === "managed") {
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


}
