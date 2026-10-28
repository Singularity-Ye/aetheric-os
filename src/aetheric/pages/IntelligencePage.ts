export interface IntelligencePageContext {
  plugin: any;
  metric: (parent: HTMLElement, label: string, value: string, detail: string) => HTMLElement;
  actionButton: (parent: HTMLElement, text: string, onClick: () => void) => HTMLElement;
  formatSnapshotTime: (timestamp: number) => string;
  xWatchLabel: (xWatch?: any) => string;
  refreshIntelligence: () => void;
  runXWatch: () => void;
  openFileByPath: (path: string) => void;
  filter: "attention" | "relevant" | "all";
  setFilter: (f: "attention" | "relevant" | "all") => void;
  platformFilter: string;
  setPlatformFilter: (p: string) => void;
  rerender: () => void;
}

/**
 * IntelligencePage: Decoupled X Watch and intelligence signal observatory.
 */
export class IntelligencePage {
  constructor(private context: IntelligencePageContext) {}

  mount(parent: HTMLElement): void {
    const snapshot = this.context.plugin.hamasxiangAdapter.getSnapshot();
    const items = this.context.plugin.hamasxiangAdapter.getIntelligence();
    const orderedItems = [...items].sort((a: any, b: any) => {
      const attentionDelta = Number(b.shouldNotify) - Number(a.shouldNotify);
      if (attentionDelta) return attentionDelta;
      const relevanceDelta = Number(b.relevant) - Number(a.relevant);
      if (relevanceDelta) return relevanceDelta;
      return b.capturedAt - a.capturedAt;
    });

    const platformCounts = new Map<string, number>();
    for (const item of items) {
      platformCounts.set(item.platform, (platformCounts.get(item.platform) || 0) + 1);
    }

    const visibleItems = orderedItems.filter((item: any) => {
      if (this.context.platformFilter !== "all" && item.platform !== this.context.platformFilter) return false;
      if (this.context.filter === "attention") return item.shouldNotify;
      if (this.context.filter === "relevant") return item.relevant;
      return true;
    });

    const page = parent.createDiv({ cls: "aos-page aos-intelligence-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "情报 Intelligence" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "读取 X Watch 情报流与抓取状态，事实投影到 Shell，不重复造假。" });

    const freshness = page.createDiv({ cls: `aos-intelligence-freshness ${snapshot.online ? "is-online" : "is-offline"}` });
    freshness.createSpan({ cls: "aos-capture-health-dot" });
    freshness.createSpan({
      text: snapshot.online
        ? `Daemon 在线${snapshot.checkedAt ? ` · 刷新于 ${this.context.formatSnapshotTime(snapshot.checkedAt)}` : " · 已建立连接"}`
        : "Daemon 离线，内容为最后一次成功快照",
    });

    const resourceErrors = this.context.plugin.hamasxiangAdapter.getResourceErrors();
    if (resourceErrors.length) {
      freshness.createSpan({
        cls: "aos-capture-health-warning",
        text: `${resourceErrors.length} 个资源刷新失败`,
        attr: { title: resourceErrors.map((error: any) => `${error.resource}: ${error.message}`).join("\n") },
      });
    }

    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    this.context.metric(metrics, "情报条目", `${items.length}`, "GET /intelligence");
    this.context.metric(metrics, "高相关", `${items.filter((item: any) => item.relevant).length}`, "classifier relevant");
    this.context.metric(metrics, "需通知", `${items.filter((item: any) => item.shouldNotify).length}`, "should_notify");
    this.context.metric(metrics, "巡检状态", this.context.xWatchLabel(snapshot.xWatch), snapshot.online ? "Daemon 正常" : "离线回退");

    const actions = page.createDiv({ cls: "aos-action-row" });
    this.context.actionButton(actions, "刷新情报", () => this.context.refreshIntelligence());
    this.context.actionButton(actions, "立即巡检 X", () => this.context.runXWatch());

    const filters = page.createDiv({ cls: "aos-intelligence-filters" });
    filters.createSpan({ cls: "aos-filter-label", text: "查看范围" });

    const addFilter = (filter: "attention" | "relevant" | "all", label: string, count: number) => {
      const button = filters.createEl("button", {
        cls: "aos-intelligence-filter",
        text: `${label} ${count}`,
        attr: { type: "button", "aria-pressed": String(this.context.filter === filter) },
      });
      button.classList.toggle("is-active", this.context.filter === filter);
      button.addEventListener("click", () => {
        this.context.setFilter(filter);
        this.context.rerender();
      });
    };

    addFilter("attention", "需处理", items.filter((item: any) => item.shouldNotify).length);
    addFilter("relevant", "高相关", items.filter((item: any) => item.relevant).length);
    addFilter("all", "全部", items.length);

    const platformFilters = page.createDiv({ cls: "aos-intelligence-filters aos-intelligence-platform-filters" });
    platformFilters.createSpan({ cls: "aos-filter-label", text: "来源平台" });
    const platformFilterEntries = ["all", ...[...platformCounts.keys()].sort()];
    for (const platform of platformFilterEntries) {
      const button = platformFilters.createEl("button", {
        cls: "aos-intelligence-filter aos-intel-platform-filter",
        text: `${platform === "all" ? "全部" : platform} ${platform === "all" ? items.length : platformCounts.get(platform) || 0}`,
        attr: { type: "button", "aria-pressed": String(this.context.platformFilter === platform) },
      });
      button.classList.toggle("is-active", this.context.platformFilter === platform);
      button.addEventListener("click", () => {
        this.context.setPlatformFilter(platform);
        this.context.rerender();
      });
    }

    const panel = page.createDiv({ cls: "aos-panel" });
    panel.createDiv({ cls: "aos-panel-title", text: "情报条目流" });
    panel.createDiv({
      cls: "aos-panel-note aos-intelligence-evidence-note",
      text: "“需处理”继承自 Daemon 的 should_notify 标记；“高相关”由大模型分类判断。信号等级用于排序参考，同步状态请等待实际确认，通知通过原生通知中心或飞书发送。",
    });

    if (visibleItems.length === 0 && items.length > 0) {
      panel.createDiv({ cls: "aos-empty-state", text: "当前筛选下没有匹配条目，可切换关注范围或来源平台。" });
    } else {
      this.renderIntelligenceList(panel, visibleItems);
    }
  }

  private renderIntelligenceList(parent: HTMLElement, items: readonly any[]): void {
    if (!items.length) {
      parent.createDiv({ cls: "aos-empty-state", text: "尚无情报分类结果。Daemon 运行时每小时自动抓取一次或立即巡检。" });
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
        item.capturedAt ? `抓取 ${this.context.formatSnapshotTime(item.capturedAt)}` : "",
      ].filter(Boolean);

      detailContainer.createSpan({ cls: "aos-task-detail", text: metadataParts.join(" · ") || "无详情" });
      if (item.summary) {
        const summary = item.summary.replace(/\s+/g, " ").trim();
        detailContainer.createDiv({
          cls: "aos-intelligence-summary",
          text: summary.length > 260 ? `${summary.slice(0, 257)}…` : summary,
        });
      }

      if (item.tags && item.tags.length > 0) {
        const tagContainer = detailContainer.createDiv({ cls: "aos-intel-tag-container" });
        item.tags.slice(0, 5).forEach((tag: string) => {
          tagContainer.createSpan({ cls: "aos-intel-tag", text: `#${tag}` });
        });
      }

      if (item.resultPath || item.url) {
        const actions = row.createDiv({ cls: "aos-task-actions" });
        if (item.resultPath) {
          const resultButton = actions.createEl("button", { cls: "aos-task-action-btn", text: "打开结果" });
          resultButton.addEventListener("click", () => this.context.openFileByPath(item.resultPath!));
        }
        if (item.url) {
          const sourceButton = actions.createEl("button", { cls: "aos-task-action-btn", text: "查看原文" });
          sourceButton.addEventListener("click", () => window.open(item.url, "_blank", "noopener"));
        }
      }
    }
  }
}
