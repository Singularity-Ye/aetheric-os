import { LogBus } from "./LogBus";
import {
  IntelligenceItem,
  LogLevel,
  OperationArtifact,
  OperationTask,
  OperationTaskStatus,
} from "./types";

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

interface DaemonTaskRecord {
  id?: string;
  kind?: string;
  status?: string;
  title?: string;
  url?: string;
  error?: string;
  evidence_level?: string;
  delivered?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface DaemonArtifactRecord {
  id?: string;
  kind?: string;
  title?: string;
  status?: string;
  summary?: string;
  source_url?: string;
  created_at?: string;
  path?: string;
}

interface DaemonIntelligenceRecord {
  id?: string;
  platform?: string;
  title?: string;
  summary?: string;
  url?: string;
  author?: string;
  signal_level?: string;
  confidence?: number;
  is_relevant?: boolean;
  should_notify?: boolean;
  tags?: unknown[];
  captured_at?: string;
  result_path?: string;
}

interface DaemonLogRecord {
  id?: number;
  timestamp?: number;
  level?: string;
  source?: string;
  message?: string;
  detail?: string;
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
  private daemonTasks: OperationTask[] = [];
  private artifacts: OperationArtifact[] = [];
  private intelligence: IntelligenceItem[] = [];
  private logCursor = 0;
  private resourceErrors = new Set<string>();
  private listeners = new Set<(snapshot: Readonly<HamasxiangSnapshot>) => void>();
  private refreshing: Promise<HamasxiangSnapshot> | null = null;

  constructor(
    private logBus: LogBus,
    private baseUrl = "http://127.0.0.1:8765",
    private authToken = "",
  ) {}

  setAuthToken(token: string): void {
    this.authToken = token.trim();
  }

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
      action: {
        label: snapshot.xWatch.running ? "查看来源" : "立即巡逻",
        command: snapshot.xWatch.running ? "open-hamasxiang-console" : "run-x-watch",
      },
    });

    return [...tasks, ...this.daemonTasks];
  }

  getArtifacts(): readonly OperationArtifact[] {
    return this.artifacts;
  }

  getIntelligence(): readonly IntelligenceItem[] {
    return this.intelligence;
  }

  subscribe(listener: (snapshot: Readonly<HamasxiangSnapshot>) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  refresh(verbose = false): Promise<HamasxiangSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshAll(verbose).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async runXWatch(): Promise<void> {
    if (!this.authToken) {
      throw new Error("请先在天工台设置中配置蛤蟆祥 Daemon Token");
    }
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

  private async refreshAll(verbose: boolean): Promise<HamasxiangSnapshot> {
    const previousOnline = this.snapshot.online;
    try {
      const data = await this.fetchJson<Record<string, unknown>>("/health", 4000);
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
      if (verbose || !previousOnline) {
        this.logBus.append("success", "hamaxiang.health", `本地炉火在线 · 活跃任务 ${this.snapshot.activeJobs}`);
      }
      await Promise.all([
        this.refreshTasks(),
        this.refreshArtifacts(),
        this.refreshIntelligence(),
        this.refreshLogs(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = { ...OFFLINE, checkedAt: Date.now(), error: message };
      this.daemonTasks = [];
      if (verbose || previousOnline) this.logBus.append("warn", "hamaxiang.health", `本地炉火离线：${message}`);
    }
    this.emit();
    return this.snapshot;
  }

  private async refreshTasks(): Promise<void> {
    try {
      const data = await this.fetchJson<{ items?: DaemonTaskRecord[] }>("/tasks?limit=80", 4000);
      const items = Array.isArray(data.items) ? data.items : [];
      this.daemonTasks = items.map((item, index) => this.mapDaemonTask(item, index));
      this.resourceErrors.delete("tasks");
    } catch (error) {
      this.logResourceError("tasks", error);
    }
  }

  private async refreshArtifacts(): Promise<void> {
    try {
      const data = await this.fetchJson<{ items?: DaemonArtifactRecord[] }>("/artifacts?limit=50", 4000);
      const items = Array.isArray(data.items) ? data.items : [];
      this.artifacts = items.map((item, index) => ({
        id: String(item.id ?? `artifact-${index}`),
        kind: this.mapArtifactKind(item.kind),
        title: String(item.title ?? "未命名产物"),
        status: String(item.status ?? "unknown"),
        summary: item.summary ? String(item.summary) : undefined,
        sourceUrl: item.source_url ? String(item.source_url) : undefined,
        createdAt: this.parseTime(item.created_at) ?? Date.now(),
        path: item.path ? String(item.path) : undefined,
      }));
      this.resourceErrors.delete("artifacts");
    } catch (error) {
      this.logResourceError("artifacts", error);
    }
  }

  private async refreshIntelligence(): Promise<void> {
    try {
      const data = await this.fetchJson<{ items?: DaemonIntelligenceRecord[] }>("/intelligence?limit=60", 4000);
      const items = Array.isArray(data.items) ? data.items : [];
      this.intelligence = items.map((item, index) => ({
        id: String(item.id ?? `intel-${index}`),
        platform: String(item.platform ?? "unknown"),
        title: String(item.title ?? "未命名情报"),
        summary: item.summary ? String(item.summary) : undefined,
        url: item.url ? String(item.url) : undefined,
        author: item.author ? String(item.author) : undefined,
        signalLevel: String(item.signal_level ?? "unknown"),
        confidence: typeof item.confidence === "number" ? item.confidence : undefined,
        relevant: item.is_relevant === true,
        shouldNotify: item.should_notify === true,
        tags: Array.isArray(item.tags) ? item.tags.map(tag => String(tag)) : [],
        capturedAt: this.parseTime(item.captured_at) ?? Date.now(),
        resultPath: item.result_path ? String(item.result_path) : undefined,
      }));
      this.resourceErrors.delete("intelligence");
    } catch (error) {
      this.logResourceError("intelligence", error);
    }
  }

  private async refreshLogs(): Promise<void> {
    try {
      const data = await this.fetchJson<{ items?: DaemonLogRecord[]; cursor?: number }>(
        `/logs?after=${this.logCursor}&limit=200`,
        4000,
      );
      const items = Array.isArray(data.items) ? data.items : [];
      for (const item of items) {
        const message = [item.message, item.detail].filter(Boolean).join(" · ");
        if (!message) continue;
        this.logBus.append(this.mapLogLevel(item.level), String(item.source ?? "hamaxiang.daemon"), message);
      }
      if (typeof data.cursor === "number" && Number.isFinite(data.cursor)) this.logCursor = data.cursor;
      this.resourceErrors.delete("logs");
    } catch (error) {
      this.logResourceError("logs", error);
    }
  }

  private mapDaemonTask(item: DaemonTaskRecord, index: number): OperationTask {
    const status = this.mapDaemonTaskStatus(item.status);
    const parts = [item.kind ?? "capture-douyin"];
    if (item.evidence_level) parts.push(item.evidence_level);
    if (item.error) parts.push(item.error);
    else if (item.url) parts.push(item.url);
    return {
      id: `hamaxiang-job-${item.id ?? index}`,
      title: String(item.title || item.url || item.id || "Daemon 任务"),
      source: "hamaxiang",
      status,
      detail: parts.join(" · "),
      progress: status === "queued" ? 10 : status === "running" ? 55 : status === "success" ? 100 : 0,
      updatedAt: this.parseTime(item.updated_at) ?? this.parseTime(item.created_at) ?? Date.now(),
      action: { label: "打开来源", command: "open-hamasxiang-console" },
    };
  }

  private mapDaemonTaskStatus(status: string | undefined): OperationTaskStatus {
    if (status === "queued" || status === "running") return status;
    if (status === "completed") return "success";
    if (status === "failed" || status === "delivery_failed") return "failed";
    return "unknown";
  }

  private mapArtifactKind(kind: string | undefined): OperationArtifact["kind"] {
    if (kind === "capture" || kind === "intelligence" || kind === "note" || kind === "report") return kind;
    return "other";
  }

  private mapLogLevel(level: string | undefined): LogLevel {
    if (level === "success" || level === "warn" || level === "error") return level;
    return "info";
  }

  private logResourceError(resource: string, error: unknown): void {
    if (this.resourceErrors.has(resource)) return;
    this.resourceErrors.add(resource);
    const message = error instanceof Error ? error.message : String(error);
    this.logBus.append("warn", `hamaxiang.${resource}`, `附属数据刷新失败：${message}`);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
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

  private async fetchJson<T>(path: string, timeoutMs: number): Promise<T> {
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { method: "GET" }, timeoutMs);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return await response.json() as T;
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    if (this.authToken) headers.set("Authorization", `Bearer ${this.authToken}`);
    try {
      return await fetch(url, { ...init, headers, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
    }
  }
}
