import { LogBus } from "./LogBus";
import { OperationTask } from "./types";

export interface HamasxiangXWatchSnapshot {
  enabled?: boolean;
  running?: boolean;
  status?: string;
  last_new_count?: number;
  last_success_at?: string;
  next_run_at?: string;
}

export interface HamasxiangSnapshot {
  online: boolean;
  service: string;
  version?: string;
  asr?: string;
  activeJobs: number;
  xWatch: HamasxiangXWatchSnapshot;
  checkedAt: number;
  error?: string;
}

const OFFLINE: HamasxiangSnapshot = {
  online: false,
  service: "hamaxiang-daemon",
  activeJobs: 0,
  xWatch: {},
  checkedAt: 0,
};

export class HamasxiangAdapter {
  private snapshot: HamasxiangSnapshot = { ...OFFLINE };
  private listeners = new Set<(snapshot: Readonly<HamasxiangSnapshot>) => void>();
  private refreshing: Promise<HamasxiangSnapshot> | null = null;

  constructor(private logBus: LogBus, private baseUrl = "http://127.0.0.1:8765") {}

  getSnapshot(): Readonly<HamasxiangSnapshot> {
    return this.snapshot;
  }

  getTasks(): OperationTask[] {
    const snapshot = this.snapshot;
    const checkedAt = snapshot.checkedAt || Date.now();
    const tasks: OperationTask[] = [
      {
        id: "hamaxiang-daemon-health",
        title: "蛤蟆祥 Daemon",
        source: "hamaxiang",
        status: snapshot.online ? "online" : "offline",
        detail: snapshot.online
          ? `${snapshot.service}${snapshot.version ? ` v${snapshot.version}` : ""} · 活跃任务 ${snapshot.activeJobs}`
          : snapshot.error ?? "本地服务未连接",
        progress: snapshot.online ? 100 : 0,
        updatedAt: checkedAt,
        action: { label: "刷新", command: "refresh-hamasxiang" },
      },
    ];

    const xWatchStatus = this.mapXWatchStatus(snapshot.xWatch);
    tasks.push({
      id: "hamaxiang-x-watch",
      title: "X Watch 巡逻",
      source: "hamaxiang",
      status: snapshot.online ? xWatchStatus : "offline",
      detail: this.describeXWatch(snapshot.xWatch),
      progress: xWatchStatus === "running" ? 55 : snapshot.xWatch.last_success_at ? 100 : 0,
      updatedAt: checkedAt,
      nextRunAt: this.parseTime(snapshot.xWatch.next_run_at),
      action: { label: snapshot.xWatch.running ? "查看来源" : "立即巡逻", command: snapshot.xWatch.running ? "open-hamasxiang-console" : "run-x-watch" },
    });

    if (snapshot.activeJobs > 0 && !snapshot.xWatch.running) {
      tasks.push({
        id: "hamaxiang-active-jobs",
        title: "后台采集任务",
        source: "hamaxiang",
        status: "running",
        detail: `Daemon 报告 ${snapshot.activeJobs} 个活跃任务`,
        progress: 35,
        updatedAt: checkedAt,
        action: { label: "打开来源", command: "open-hamasxiang-console" },
      });
    }

    return tasks;
  }

  subscribe(listener: (snapshot: Readonly<HamasxiangSnapshot>) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  refresh(verbose = false): Promise<HamasxiangSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchHealth(verbose).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async runXWatch(): Promise<void> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}/x-watch/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? data.status ?? `HTTP ${response.status}`));
    this.logBus.append("success", "hamaxiang.x-watch", "已通过本地 Daemon 唤醒 X Watch");
    await this.refresh(false);
  }

  private async fetchHealth(verbose: boolean): Promise<HamasxiangSnapshot> {
    const previousOnline = this.snapshot.online;
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/health`, { method: "GET" }, 4000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as Record<string, unknown>;
      const xWatch = (data.x_watch && typeof data.x_watch === "object" ? data.x_watch : {}) as HamasxiangXWatchSnapshot;
      this.snapshot = {
        online: true,
        service: typeof data.service === "string" ? data.service : "hamaxiang-daemon",
        version: typeof data.version === "string" ? data.version : undefined,
        asr: typeof data.asr === "string" ? data.asr : undefined,
        activeJobs: typeof data.active_jobs === "number" ? data.active_jobs : 0,
        xWatch,
        checkedAt: Date.now(),
      };
      if (verbose || !previousOnline) this.logBus.append("success", "hamaxiang.health", `本地炉火在线 · 活跃任务 ${this.snapshot.activeJobs}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = { ...OFFLINE, checkedAt: Date.now(), error: message };
      if (verbose || previousOnline) this.logBus.append("warn", "hamaxiang.health", `本地炉火离线：${message}`);
    }
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }

  private mapXWatchStatus(xWatch: HamasxiangXWatchSnapshot): OperationTask["status"] {
    if (xWatch.running) return "running";
    if (xWatch.enabled === false) return "idle";
    if (xWatch.status === "failed" || xWatch.status === "error") return "failed";
    if (xWatch.last_success_at) return "success";
    if (xWatch.enabled) return "idle";
    return "unknown";
  }

  private describeXWatch(xWatch: HamasxiangXWatchSnapshot): string {
    const parts: string[] = [];
    if (xWatch.running) parts.push("正在巡逻");
    else if (xWatch.enabled === false) parts.push("未启用");
    else parts.push(xWatch.status ?? "待命");
    parts.push(`上轮新增 ${xWatch.last_new_count ?? 0}`);
    if (xWatch.next_run_at) parts.push(`下次 ${xWatch.next_run_at}`);
    return parts.join(" · ");
  }

  private parseTime(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }
}
