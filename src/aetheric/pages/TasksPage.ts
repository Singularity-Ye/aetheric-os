import { AosUI } from "../ui/AosUI";

export interface TasksPageContext {
  plugin: any;
  metric: (parent: HTMLElement, label: string, value: string, detail: string) => HTMLElement;
  renderTaskList: (parent: HTMLElement, tasks: any[], mini: boolean) => void;
  renderArtifactList: (parent: HTMLElement, artifacts: readonly any[]) => void;
}

/**
 * TasksPage: Decoupled OperationTask and Daemon Job observatory.
 */
export class TasksPage {
  constructor(private context: TasksPageContext) {}

  mount(parent: HTMLElement): void {
    const tasks = this.context.plugin.hamasxiangAdapter.getTasks();
    const page = parent.createDiv({ cls: "aos-page" });
    const heading = page.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "任务 Tasks" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "统一 OperationTask 契约；只展示真实的观察流。" });

    const summary = page.createDiv({ cls: "aos-metric-grid aos-task-summary" });
    this.context.metric(summary, "任务总数", `${tasks.length}`, "已接入 adapter");
    this.context.metric(
      summary,
      "进行中",
      `${tasks.filter((t: any) => t.status === "running" || t.status === "awaiting_sync").length}`,
      "running / sync"
    );
    this.context.metric(
      summary,
      "异常",
      `${tasks.filter((t: any) => t.status === "failed" || t.status === "interrupted" || t.status === "offline").length}`,
      "failed"
    );
    this.context.metric(
      summary,
      "可操作",
      `${tasks.filter((t: any) => t.action).length}`,
      "支持直接重试"
    );
    this.context.metric(summary, "来源", "1", "Hamasxiang Daemon");

    const active = page.createDiv({ cls: "aos-panel aos-task-adapter" });
    active.createDiv({ cls: "aos-panel-title", text: "真实任务列表" });
    this.context.renderTaskList(active, tasks, false);

    const honest = page.createDiv({ cls: "aos-panel" });
    honest.createDiv({ cls: "aos-panel-title", text: "协议边界说明" });
    honest.createDiv({
      cls: "aos-panel-note",
      text: "当前通过 Daemon 真实 JOBS 与 X Watch 状态投影。Agent 队列与精炼链路共享此观察流，不虚构未连接的本地模拟器。",
    });

    const artifacts = page.createDiv({ cls: "aos-panel" });
    artifacts.createDiv({ cls: "aos-panel-title", text: "交付产物" });
    this.context.renderArtifactList(artifacts, this.context.plugin.hamasxiangAdapter.getArtifacts());
  }
}
