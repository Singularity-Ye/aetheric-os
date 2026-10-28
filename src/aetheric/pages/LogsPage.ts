export interface LogsPageContext {
  plugin: any;
  metric: (parent: HTMLElement, label: string, value: string, detail: string) => HTMLDivElement;
}

/**
 * LogsPage: Unified system & daemon log observatory.
 * Decoupled from AethericShellView monolith.
 */
export class LogsPage {
  constructor(private context: LogsPageContext) {}

  mount(parent: HTMLElement): void {
    const entries = this.context.plugin.logBus.getEntries();
    const daemonEntries = entries.filter((entry: any) => entry.source.startsWith("hamaxiang."));
    const page = parent.createDiv({ cls: "aos-page" });
    page.createDiv({ cls: "aos-page-title", text: "日志 Logs" });
    page.createDiv({ cls: "aos-page-subtitle", text: "统一日志坞站已在底部运行；可拖动、筛选、暂停跟随和最大化。" });

    const metrics = page.createDiv({ cls: "aos-metric-grid" });
    this.context.metric(metrics, "日志总数", `${entries.length}`, "当前内存窗口");
    this.context.metric(metrics, "Daemon 日志", `${daemonEntries.length}`, "GET /logs 增量同步");
    this.context.metric(metrics, "异常", `${entries.filter((entry: any) => entry.level === "error").length}`, "error");
    this.context.metric(metrics, "警告", `${entries.filter((entry: any) => entry.level === "warn").length}`, "warn");

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
}
