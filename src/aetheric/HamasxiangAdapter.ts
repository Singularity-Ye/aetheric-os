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
  handles?: string;
}

export interface HamasxiangPlatformHealthItem {
  status?: string;
  login?: string;
  media_extension?: string;
  clipper_installed?: boolean;
  legacy_fallback?: boolean;
  direct_core_installed?: boolean;
  sidecar_installed?: boolean;
  mode?: string;
  audio_strategy?: string;
  asr_fallback?: boolean;
}

export interface HamasxiangPlatformHealthSnapshot {
  checkedAt: number;
  probeMode?: string;
  platforms: Record<string, HamasxiangPlatformHealthItem>;
  dependencies: Record<string, { available?: boolean; configured?: boolean; enabled?: boolean }>;
  authentication: Record<string, {
    profile_present?: boolean;
    snapshot_present?: boolean;
    authenticated?: boolean;
    status?: string;
    updated_at?: string;
  }>;
  evidenceCache?: {
    enabled?: boolean;
    present?: boolean;
    entries?: number;
    bytes?: number;
    ttl_seconds?: number;
    max_entries?: number;
  };
  daemon?: {
    capture_busy?: boolean;
    active_capture_jobs?: number;
    resume_max_attempts?: number;
  };
}

export interface HamasxiangSnapshot {
  online: boolean;
  service: string;
  version?: string;
  asr?: string;
  activeJobs: number;
  xWatch: HamasxiangXWatchSnapshot;
  platformHealth?: HamasxiangPlatformHealthSnapshot;
  checkedAt: number;
  error?: string;
}

export interface HamasxiangCaptureReceipt {
  jobId: string;
  status: string;
  sourceUrls: string[];
  platform?: string;
  submittedAt: number;
  updatedAt?: number;
}

export interface HamasxiangRefinementReceipt {
  protocolVersion: "aos-refinement/v1";
  jobId: string;
  status: string;
  sourceNotePath: string;
  requestId: string;
  submittedAt: number;
}

export interface HamasxiangAssetRegistryRecord {
  asset_id: string;
  status: string;
  last_good_status?: string;
  original_sha256?: string;
  display_sha256?: string;
  note_ref_count: number;
}

export interface HamasxiangAssetRegistrySummary {
  schema_version: number;
  total: number;
  by_status: Record<string, number>;
  bytes_original: number;
  bytes_display: number;
  upload_outbox?: {
    total: number;
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
  };
  remote_objects?: {
    total: number;
    by_status: Record<string, number>;
    by_provider: Record<string, number>;
  };
}

export interface HamasxiangAssetUploadReceipt {
  upload_id: string;
  asset_id: string;
  provider: string;
  status: string;
  reused: boolean;
}

/** A short-lived, in-memory-only URL for one verified private cloud asset. */
export interface HamasxiangAssetLinkReceipt {
  assetId: string;
  role: "original" | "display";
  expiresAt: string;
  url: string;
}

export interface HamasxiangMirrorLinkRefreshReceipt {
  queued: boolean;
  taskStarted: boolean;
}

export interface HamasxiangAssetUploadError {
  layer?: string;
  code?: string;
  message: string;
  retryable?: boolean;
  updated_at?: string;
}

export interface HamasxiangAssetUploadStatus {
  checkedAt: number;
  provider: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  activeJobId?: string;
  state: string;
  lastSuccessAt?: string;
  queued: number;
  leased: number;
  failed: number;
  succeeded: number;
  due: number;
  retryableFailed: number;
  terminalFailed: number;
  expiredLeases: number;
  nextAttemptAt?: string;
  remoteTotal: number;
  remotePending: number;
  remoteUploaded: number;
  remoteVerified: number;
  remoteVerifiedAssets?: number;
  remoteFailed: number;
  lastError?: HamasxiangAssetUploadError;
  restore: {
    running: boolean;
    lastSuccessAt?: string;
    lastRole?: string;
    lastError?: HamasxiangAssetUploadError;
  };
}

export interface HamasxiangAssetUploadRunReceipt {
  jobId: string;
  status: string;
  provider: string;
  limit: number;
}

export interface HamasxiangAssetRestoreDrillReceipt {
  jobId: string;
  status: string;
  provider: string;
  role: "display" | "original";
}

export interface HamasxiangAssetRestoreSamplerStatus {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  intervalSeconds: number;
  nextRunAt?: string;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastAssetId?: string;
  lastRole?: "display" | "original";
  lastJobId?: string;
  lastResult?: {
    jobId?: string;
    assetId?: string;
    role?: string;
    status?: string;
    stage?: string;
    finishedAt?: string;
    error?: HamasxiangAssetUploadError;
  };
  lastError?: HamasxiangAssetUploadError;
  deleteActionsAvailable: false;
}

export interface HamasxiangAssetRestoreSamplerReceipt {
  jobId: string;
  status: string;
  provider: string;
  limit: number;
  queued: boolean;
  candidate?: {
    asset_id?: string;
    role?: string;
    state?: string;
  };
}

export type HamasxiangAssetRetentionState =
  | "retained"
  | "verification_pending"
  | "restore_evidence_missing"
  | "restore_evidence_stale"
  | "grace_period"
  | "eligible_for_review"
  | "blocked";

export interface HamasxiangAssetRetentionItem {
  assetId: string;
  state: HamasxiangAssetRetentionState;
  reasons: string[];
  retentionStartedAt?: string;
  eligibleAt?: string;
  originalPath?: string;
  displayPath?: string;
  activeNoteRefCount: number;
  restoreOriginal?: { status: string; finishedAt?: string; elapsedMs?: number };
  restoreDisplay?: { status: string; finishedAt?: string; elapsedMs?: number };
}

export interface HamasxiangAssetRetentionStatus {
  checkedAt: number;
  total: number;
  byState: Record<string, number>;
  eligibleForReview: number;
  minimumLocalRetentionDays: number;
  restoreSlaMaxAgeDays: number;
  deleteActionsAvailable: false;
  items: HamasxiangAssetRetentionItem[];
}

interface DaemonTaskRecord {
  id?: string;
  kind?: string;
  platform?: string;
  intent?: string;
  status?: string;
  stage?: string;
  title?: string;
  url?: string;
  source_urls?: string[];
  error?: unknown;
  errors?: unknown[];
  error_layer?: string;
  evidence_level?: string;
  returncode?: number;
  vault_written?: boolean;
  vault_path?: string;
  item_count?: number;
  completed_count?: number;
  delivered?: boolean;
  provider?: string;
  processed_count?: number;
  succeeded_count?: number;
  failed_count?: number;
  created_at?: string;
  updated_at?: string;
}

interface DaemonArtifactRecord {
  id?: string;
  kind?: string;
  title?: string;
  status?: string;
  summary?: string;
  original_text?: string;
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
  private resourceErrors = new Map<string, string>();
  private capturePollers = new Map<string, number>();
  private lastCaptureReceipt: HamasxiangCaptureReceipt | null = null;
  private listeners = new Set<(snapshot: Readonly<HamasxiangSnapshot>) => void>();
  private refreshing: Promise<HamasxiangSnapshot> | null = null;
  private lastPublishedSignature: string | null = null;

  constructor(
    private logBus: LogBus,
    private baseUrl = "http://127.0.0.1:8765",
    private authToken = "",
  ) {}

  setAuthToken(token: string): void {
    this.authToken = token.trim();
    this.lastPublishedSignature = null;
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

  getResourceErrors(): ReadonlyArray<{ resource: string; message: string }> {
    return [...this.resourceErrors.entries()].map(([resource, message]) => ({ resource, message }));
  }

  getLastCaptureReceipt(): HamasxiangCaptureReceipt | null {
    return this.lastCaptureReceipt;
  }

  async discoverImageAsset(
    originalPath: string,
    noteRefs: string[],
  ): Promise<HamasxiangAssetRegistryRecord> {
    return this.postAssetRegistry("/asset-registry/discover", {
      original_path: originalPath,
      note_refs: noteRefs,
    });
  }

  async registerImageInPlace(originalPath: string, noteRefs: string[]): Promise<HamasxiangAssetRegistryRecord> {
    return this.postAssetRegistry("/asset-registry/register-in-place", {
      original_path: originalPath,
      note_refs: noteRefs,
    });
  }

  async registerImageDerivative(
    assetId: string,
    displayPath: string,
  ): Promise<HamasxiangAssetRegistryRecord> {
    return this.postAssetRegistry("/asset-registry/register-derivative", {
      asset_id: assetId,
      display_path: displayPath,
    });
  }

  async getAssetRegistrySummary(): Promise<HamasxiangAssetRegistrySummary> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-registry/summary`, {
      method: "GET",
    }, 8000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) {
      throw new Error(String(data.error ?? `HTTP ${response.status}`));
    }
    const byStatus = data.by_status && typeof data.by_status === "object"
      ? data.by_status as Record<string, number>
      : {};
    return {
      schema_version: Number(data.schema_version ?? 0),
      total: Number(data.total ?? 0),
      by_status: byStatus,
      bytes_original: Number(data.bytes_original ?? 0),
      bytes_display: Number(data.bytes_display ?? 0),
      upload_outbox: this.parseAssetCountGroup(data.upload_outbox, true),
      remote_objects: this.parseAssetCountGroup(data.remote_objects, true),
    };
  }

  async enqueueImageAssetUpload(
    assetId: string,
    originalPath: string,
    displayPath: string,
  ): Promise<HamasxiangAssetUploadReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-registry/enqueue-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_id: assetId,
        original_path: originalPath,
        display_path: displayPath,
      }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const upload = data.upload as Record<string, unknown> | undefined;
    const uploadId = String(upload?.upload_id ?? "").trim();
    if (!uploadId) throw new Error("图片云仓排队没有返回 upload_id");
    return {
      upload_id: uploadId,
      asset_id: String(upload?.asset_id ?? assetId),
      provider: String(upload?.provider ?? "tencent_cos"),
      status: String(upload?.status ?? "queued"),
      reused: upload?.reused === true,
    };
  }

  async getAssetUploadStatus(): Promise<HamasxiangAssetUploadStatus> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-upload/status`, {
      method: "GET",
    }, 8000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const outbox = this.objectRecord(data.outbox ?? data.upload_outbox);
    const outboxStatus = this.objectRecord(outbox.by_status);
    const remotes = this.objectRecord(data.remote_objects);
    const remoteStatus = this.objectRecord(remotes.by_status);
    const credentials = this.objectRecord(data.credentials);
    const restore = this.objectRecord(data.restore);
    const lastError = this.parseAssetUploadError(data.last_error ?? credentials.error);
    return {
      checkedAt: this.parseTimestamp(data.checked_at) ?? Date.now(),
      provider: String(data.provider ?? credentials.provider ?? "tencent_cos"),
      enabled: data.enabled !== false,
      configured: typeof data.configured === "boolean"
        ? data.configured
        : credentials.configured === true,
      running: data.running === true,
      activeJobId: typeof data.active_job_id === "string" && data.active_job_id.trim()
        ? data.active_job_id.trim()
        : undefined,
      state: String(data.state ?? "unknown"),
      lastSuccessAt: typeof (data.last_success_at ?? data.last_verified_at) === "string"
        && String(data.last_success_at ?? data.last_verified_at).trim()
        ? String(data.last_success_at ?? data.last_verified_at).trim()
        : undefined,
      queued: this.nonNegativeCount(outboxStatus.queued),
      leased: this.nonNegativeCount(outboxStatus.leased),
      failed: this.nonNegativeCount(outboxStatus.failed),
      succeeded: this.nonNegativeCount(outboxStatus.succeeded),
      due: this.nonNegativeCount(outbox.due),
      retryableFailed: this.nonNegativeCount(outbox.retryable_failed),
      terminalFailed: this.nonNegativeCount(outbox.terminal_failed),
      expiredLeases: this.nonNegativeCount(outbox.expired_leases),
      nextAttemptAt: typeof outbox.next_attempt_at === "string" && outbox.next_attempt_at.trim()
        ? outbox.next_attempt_at.trim()
        : undefined,
      remoteTotal: this.nonNegativeCount(remotes.total),
      remotePending: this.nonNegativeCount(remoteStatus.pending),
      remoteUploaded: this.nonNegativeCount(remoteStatus.uploaded),
      remoteVerified: this.nonNegativeCount(remoteStatus.verified),
      remoteVerifiedAssets: Object.prototype.hasOwnProperty.call(remotes, "verified_assets")
        ? this.nonNegativeCount(remotes.verified_assets)
        : undefined,
      remoteFailed: this.nonNegativeCount(remoteStatus.failed),
      lastError,
      restore: {
        running: restore.running === true,
        lastSuccessAt: typeof restore.last_success_at === "string" && restore.last_success_at.trim()
          ? restore.last_success_at.trim()
          : undefined,
        lastRole: typeof restore.last_role === "string" && restore.last_role.trim()
          ? restore.last_role.trim()
          : undefined,
        lastError: this.parseAssetUploadError(restore.last_error),
      },
    };
  }

  async runAssetUpload(limit = 20): Promise<HamasxiangAssetUploadRunReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const boundedLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 20)));
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-upload/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: boundedLimit }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const jobId = String(data.job_id ?? "").trim();
    if (!jobId) throw new Error("图片云仓任务没有返回 job_id");
    return {
      jobId,
      status: String(data.status ?? "queued"),
      provider: String(data.provider ?? "tencent_cos"),
      limit: this.nonNegativeCount(data.limit) || boundedLimit,
    };
  }

  async runAssetRestoreDrill(
    role: "display" | "original" = "display",
    assetId?: string,
  ): Promise<HamasxiangAssetRestoreDrillReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-restore/drill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assetId ? { role, asset_id: assetId } : { role }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const jobId = String(data.job_id ?? "").trim();
    if (!jobId) throw new Error("图片恢复抽检没有返回 job_id");
    const returnedRole = String(data.role ?? role);
    if (returnedRole !== "display" && returnedRole !== "original") {
      throw new Error("图片恢复抽检返回了无效 role");
    }
    return {
      jobId,
      status: String(data.status ?? "queued"),
      provider: String(data.provider ?? "tencent_cos"),
      role: returnedRole,
    };
  }

  async getAssetRestoreSamplerStatus(): Promise<HamasxiangAssetRestoreSamplerStatus> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/asset-restore-sampler/status`,
      { method: "GET" },
      12000,
    );
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const sampler = this.objectRecord(data.sampler);
    const lastRole = String(sampler.last_role ?? "").trim();
    const result = this.objectRecord(sampler.last_result);
    const parsedResult = Object.keys(result).length > 0
      ? {
          jobId: String(result.job_id ?? "").trim() || undefined,
          assetId: String(result.asset_id ?? "").trim() || undefined,
          role: String(result.role ?? "").trim() || undefined,
          status: String(result.status ?? "").trim() || undefined,
          stage: String(result.stage ?? "").trim() || undefined,
          finishedAt: typeof result.finished_at === "string" ? result.finished_at : undefined,
          error: this.parseAssetUploadError(result.error),
        }
      : undefined;
    return {
      enabled: sampler.enabled === true,
      paused: sampler.paused === true,
      running: sampler.running === true,
      intervalSeconds: this.nonNegativeCount(sampler.interval_seconds),
      nextRunAt: typeof sampler.next_run_at === "string" ? sampler.next_run_at : undefined,
      lastCheckedAt: typeof sampler.last_checked_at === "string" ? sampler.last_checked_at : undefined,
      lastStartedAt: typeof sampler.last_started_at === "string" ? sampler.last_started_at : undefined,
      lastAssetId: typeof sampler.last_asset_id === "string" ? sampler.last_asset_id : undefined,
      lastRole: lastRole === "display" || lastRole === "original" ? lastRole : undefined,
      lastJobId: typeof sampler.last_job_id === "string" ? sampler.last_job_id : undefined,
      lastResult: parsedResult,
      lastError: this.parseAssetUploadError(sampler.last_error),
      deleteActionsAvailable: false,
    };
  }

  async runAssetRestoreSampler(limit = 1): Promise<HamasxiangAssetRestoreSamplerReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-restore-sampler/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const candidate = this.objectRecord(data.candidate);
    return {
      jobId: String(data.job_id ?? "").trim(),
      status: String(data.status ?? data.reason ?? "idle"),
      provider: String(data.provider ?? "tencent_cos"),
      limit: 1,
      queued: data.queued === true,
      candidate: Object.keys(candidate).length > 0
        ? {
            asset_id: String(candidate.asset_id ?? "").trim() || undefined,
            role: String(candidate.role ?? "").trim() || undefined,
            state: String(candidate.state ?? "").trim() || undefined,
          }
        : undefined,
    };
  }

  async pauseAssetRestoreSampler(paused: boolean): Promise<HamasxiangAssetRestoreSamplerStatus> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-restore-sampler/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: Boolean(paused) }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    return this.getAssetRestoreSamplerStatus();
  }

  async getAssetRetentionStatus(limit = 50): Promise<HamasxiangAssetRetentionStatus> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/asset-retention/status?limit=${boundedLimit}`,
      { method: "GET" },
      20000,
    );
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    const policy = this.objectRecord(data.policy);
    const byState = this.objectRecord(data.by_state);
    const rawItems = Array.isArray(data.items) ? data.items : [];
    const allowedStates = new Set([
      "retained", "verification_pending", "restore_evidence_missing",
      "restore_evidence_stale", "grace_period", "eligible_for_review", "blocked",
    ]);
    const items = rawItems.flatMap(value => {
      const item = this.objectRecord(value);
      const assetId = String(item.asset_id ?? "").trim();
      const state = String(item.state ?? "").trim();
      if (!assetId || !allowedStates.has(state)) return [];
      const local = this.objectRecord(item.local);
      const receipts = this.objectRecord(item.restore_receipts);
      const parseReceipt = (value: unknown) => {
        const receipt = this.objectRecord(value);
        const status = String(receipt.status ?? "").trim();
        if (!status) return undefined;
        return {
          status,
          finishedAt: typeof receipt.finished_at === "string" ? receipt.finished_at : undefined,
          elapsedMs: Number.isFinite(Number(receipt.elapsed_ms))
            ? Math.max(0, Math.floor(Number(receipt.elapsed_ms)))
            : undefined,
        };
      };
      return [{
        assetId,
        state: state as HamasxiangAssetRetentionState,
        reasons: Array.isArray(item.reasons)
          ? item.reasons.filter(reason => typeof reason === "string").map(reason => String(reason))
          : [],
        retentionStartedAt: typeof item.retention_started_at === "string"
          ? item.retention_started_at
          : undefined,
        eligibleAt: typeof item.eligible_at === "string" ? item.eligible_at : undefined,
        originalPath: typeof local.original_path === "string" ? local.original_path : undefined,
        displayPath: typeof local.display_path === "string" ? local.display_path : undefined,
        activeNoteRefCount: this.nonNegativeCount(local.active_note_ref_count),
        restoreOriginal: parseReceipt(receipts.original),
        restoreDisplay: parseReceipt(receipts.display),
      }];
    });
    return {
      checkedAt: this.parseTimestamp(data.checked_at) ?? Date.now(),
      total: this.nonNegativeCount(data.total),
      byState: Object.fromEntries(
        Object.entries(byState).map(([key, count]) => [key, this.nonNegativeCount(count)]),
      ),
      eligibleForReview: this.nonNegativeCount(data.eligible_for_review),
      minimumLocalRetentionDays: this.nonNegativeCount(policy.minimum_local_retention_days),
      restoreSlaMaxAgeDays: this.nonNegativeCount(policy.restore_sla_max_age_days),
      deleteActionsAvailable: false,
      items,
    };
  }

  async getAssetRetentionManifest(assetIds?: string[]): Promise<Record<string, unknown>> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/asset-retention/manifest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assetIds ? { asset_ids: assetIds } : {}),
    }, 20000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) throw this.assetUploadApiError(data, response.status);
    return this.objectRecord(data.manifest);
  }

  /**
   * Ask the loopback-only asset gateway for a fresh COS URL when the user
   * explicitly opens an asset. The URL is intentionally never persisted in
   * plugin settings, the asset ledger, or a Vault note.
   */
  async issueAssetLink(
    assetId: string,
    role: "original" | "display" = "display",
    ttlSeconds = 600,
  ): Promise<HamasxiangAssetLinkReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const cleanAssetId = String(assetId ?? "").trim();
    if (!/^ast_[0-9a-f]{24}$/.test(cleanAssetId)) throw new Error("图片资产标识无效");
    const boundedTtl = Math.max(60, Math.min(3600, Math.floor(Number(ttlSeconds) || 600)));
    const response = await this.fetchWithTimeout(
      `http://127.0.0.1:8766/asset-link/v1/${encodeURIComponent(cleanAssetId)}/${role}?ttl_seconds=${boundedTtl}`,
      { method: "GET" },
      10000,
    );
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) {
      const error = this.objectRecord(data.error);
      throw new Error(String(error.message ?? `图片访问网关请求失败（HTTP ${response.status}）`));
    }
    const asset = this.objectRecord(data.asset);
    const url = String(asset.url ?? "").trim();
    const expiresAt = String(asset.expires_at ?? "").trim();
    const returnedRole = String(asset.role ?? role).trim();
    if (!url.startsWith("https://") || !expiresAt || !["original", "display"].includes(returnedRole)) {
      throw new Error("图片访问网关返回无效回执");
    }
    return {
      assetId: String(asset.asset_id ?? cleanAssetId),
      role: returnedRole as "original" | "display",
      expiresAt,
      url,
    };
  }

  async requestCloudImageLinkRefresh(): Promise<HamasxiangMirrorLinkRefreshReceipt> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}/mirror/image-links/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }, 10000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) {
      throw new Error(String(data.message ?? data.error ?? `HTTP ${response.status}`));
    }
    return {
      queued: data.queued === true,
      taskStarted: data.task_started === true,
    };
  }

  dispose(): void {
    for (const timer of this.capturePollers.values()) window.clearTimeout(timer);
    this.capturePollers.clear();
    this.listeners.clear();
  }

  private async postAssetRegistry(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<HamasxiangAssetRegistryRecord> {
    if (!this.authToken) throw new Error("请先配置蛤蟆祥 Daemon Token");
    const response = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || data.ok !== true) {
      throw new Error(String(data.message ?? data.error ?? `HTTP ${response.status}`));
    }
    const asset = data.asset as Record<string, unknown> | undefined;
    const assetId = String(asset?.asset_id ?? "");
    if (!assetId) throw new Error("Asset Registry 没有返回 asset_id");
    return {
      asset_id: assetId,
      status: String(asset?.status ?? ""),
      last_good_status: typeof asset?.last_good_status === "string" ? asset.last_good_status : undefined,
      original_sha256: typeof asset?.original_sha256 === "string" ? asset.original_sha256 : undefined,
      display_sha256: typeof asset?.display_sha256 === "string" ? asset.display_sha256 : undefined,
      note_ref_count: Number(asset?.note_ref_count ?? 0),
    };
  }

  private objectRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private nonNegativeCount(value: unknown): number {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  private parseAssetCountGroup(
    value: unknown,
    includeProviders: true,
  ): { total: number; by_status: Record<string, number>; by_provider: Record<string, number> } | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const statuses = this.objectRecord(record.by_status);
    const providers = includeProviders ? this.objectRecord(record.by_provider) : {};
    return {
      total: this.nonNegativeCount(record.total),
      by_status: Object.fromEntries(Object.entries(statuses).map(([key, count]) => [key, this.nonNegativeCount(count)])),
      by_provider: Object.fromEntries(Object.entries(providers).map(([key, count]) => [key, this.nonNegativeCount(count)])),
    };
  }

  private parseAssetUploadError(value: unknown): HamasxiangAssetUploadError | undefined {
    if (!value) return undefined;
    if (typeof value === "string") return value.trim() ? { message: value.trim() } : undefined;
    const record = this.objectRecord(value);
    const message = String(record.message ?? record.error ?? "").trim();
    if (!message) return undefined;
    return {
      layer: typeof record.layer === "string" ? record.layer : undefined,
      code: typeof record.code === "string" ? record.code : undefined,
      message,
      retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
      updated_at: typeof record.updated_at === "string" ? record.updated_at : undefined,
    };
  }

  private assetUploadApiError(data: Record<string, unknown>, status: number): Error {
    if (typeof data.error === "string" && data.error.trim()) {
      const detail = typeof data.message === "string" ? data.message.trim() : "";
      return new Error(`${data.error.trim()}${detail ? `：${detail}` : ""}`);
    }
    const parsed = this.parseAssetUploadError(data.error);
    if (parsed) return new Error(`${parsed.code ? `${parsed.code}：` : ""}${parsed.message}`);
    const message = typeof data.message === "string" ? data.message.trim() : "";
    return new Error(message || `HTTP ${status}`);
  }

  private parseTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : value * 1000;
    }
    if (typeof value !== "string" || !value.trim()) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  subscribe(listener: (snapshot: Readonly<HamasxiangSnapshot>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(verbose = false): Promise<HamasxiangSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshAll(verbose).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async runXWatch(handles?: string): Promise<void> {
    if (!this.authToken) {
      throw new Error("请先在天工台设置中配置蛤蟆祥 Daemon Token");
    }
    const bodyObj: Record<string, string> = {};
    if (handles) bodyObj.handles = handles;
    const response = await this.fetchWithTimeout(`${this.baseUrl}/x-watch/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(bodyObj),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? data.status ?? `HTTP ${response.status}`));
    const msg = handles ? `已通过本地 Daemon 唤醒针对 ${handles} 的单源巡逻测试` : "已通过本地 Daemon 唤醒 X Watch";
    this.logBus.append("success", "hamaxiang.x-watch", msg);
    await this.refresh(false);
  }

  async submitCaptureJob(request: {
    source_url?: string;
    source_urls?: string[];
    platform?: string;
    intent?: "analyze" | "save";
    title?: string;
    project_id?: string;
    force?: boolean;
    source?: string;
    raw_content?: string;
    images?: unknown[];
    cover_image?: unknown;
  }): Promise<HamasxiangCaptureReceipt> {
    if (!this.authToken) {
      throw new Error("请先在天工台设置中配置蛤蟆祥 Daemon Token");
    }
    const response = await this.fetchWithTimeout(`${this.baseUrl}/capture-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "save", ...request }),
    }, 12000);
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.message ?? data.error ?? `HTTP ${response.status}`));
    const jobId = String(data.job_id ?? data.request_id ?? "");
    if (!jobId) throw new Error("统一采集入口没有返回 job_id");
    const receipt: HamasxiangCaptureReceipt = {
      jobId,
      status: String(data.status ?? "queued"),
      sourceUrls: Array.isArray(data.source_urls)
        ? data.source_urls.map(value => String(value))
        : request.source_urls?.map(value => String(value)) ?? (request.source_url ? [request.source_url] : []),
      platform: typeof data.platform === "string" ? data.platform : undefined,
      submittedAt: Date.now(),
    };
    this.lastCaptureReceipt = receipt;
    this.logBus.append("info", "hamaxiang.capture-job", `统一采集任务已入队：${jobId}`);
    await this.refresh(false);
    this.watchCaptureJob(jobId);
    return receipt;
  }

  async submitRefinement(sourceNotePath: string, requestId?: string): Promise<HamasxiangRefinementReceipt> {
    const normalizedPath = sourceNotePath.trim();
    if (!normalizedPath) throw new Error("没有可整理的来源笔记");
    if (!this.authToken) {
      throw new Error("请先在天工台设置中配置蛤蟆祥 Daemon Token");
    }

    const normalizedRequestId = requestId?.trim()
      || `refinement-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.baseUrl}/refinement-jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol_version: "aos-refinement/v1",
          source_note_path: normalizedPath,
          request_id: normalizedRequestId,
          mode: "draft",
        }),
      }, 12000);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("本机整理服务响应超时，请确认 Daemon 正常运行后重试");
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        /failed to fetch|networkerror/i.test(detail)
          ? "本机 Daemon 未响应，请确认服务已经启动"
          : `无法连接本机整理服务：${detail}`,
      );
    }

    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (![200, 202].includes(response.status) || data.ok !== true) {
      const rawError = data.message ?? data.error;
      const errorRecord = rawError && typeof rawError === "object" && !Array.isArray(rawError)
        ? rawError as Record<string, unknown>
        : null;
      const detail = typeof rawError === "string" || typeof rawError === "number"
        ? String(rawError)
        : typeof errorRecord?.message === "string"
        ? errorRecord.message
        : typeof errorRecord?.detail === "string"
        ? errorRecord.detail
        : `服务返回 HTTP ${response.status}`;
      throw new Error(`整理任务未能入队：${detail}`);
    }
    const jobId = typeof data.job_id === "string" ? data.job_id.trim() : "";
    const status = typeof data.status === "string" ? data.status.trim() : "";
    if (!jobId || !status) {
      throw new Error("整理服务没有返回完整的任务回执");
    }

    const receipt: HamasxiangRefinementReceipt = {
      protocolVersion: "aos-refinement/v1",
      jobId,
      status,
      sourceNotePath: normalizedPath,
      requestId: normalizedRequestId,
      submittedAt: Date.now(),
    };
    this.logBus.append("info", "hamaxiang.refinement-job", `整理任务已入队：${jobId}`);
    return receipt;
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
        this.refreshPlatformHealth(),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot = { ...OFFLINE, checkedAt: Date.now(), error: message };
      this.daemonTasks = [];
      if (verbose || previousOnline) this.logBus.append("warn", "hamaxiang.health", `本地炉火离线：${message}`);
    }
    this.emitIfChanged();
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
        originalText: item.original_text ? String(item.original_text) : undefined,
        sourceUrl: item.source_url ? String(item.source_url) : undefined,
        createdAt: this.parseTime(item.created_at) ?? 0,
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
        tags: Array.isArray(item.tags) ? item.tags.map(tag => String(tag)).sort() : [],
        capturedAt: this.parseTime(item.captured_at) ?? 0,
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

  private async refreshPlatformHealth(): Promise<void> {
    try {
      const data = await this.fetchJson<Record<string, unknown>>("/platform-health", 4000);
      this.snapshot = {
        ...this.snapshot,
        platformHealth: {
          checkedAt: this.parseTime(typeof data.checked_at === "string" ? data.checked_at : undefined) ?? Date.now(),
          probeMode: typeof data.probe_mode === "string" ? data.probe_mode : undefined,
          platforms: data.platforms && typeof data.platforms === "object"
            ? data.platforms as Record<string, HamasxiangPlatformHealthItem>
            : {},
          dependencies: data.dependencies && typeof data.dependencies === "object"
            ? data.dependencies as HamasxiangPlatformHealthSnapshot["dependencies"]
            : {},
          authentication: data.authentication && typeof data.authentication === "object"
            ? data.authentication as HamasxiangPlatformHealthSnapshot["authentication"]
            : {},
          evidenceCache: data.evidence_cache && typeof data.evidence_cache === "object"
            ? data.evidence_cache as HamasxiangPlatformHealthSnapshot["evidenceCache"]
            : undefined,
          daemon: data.daemon && typeof data.daemon === "object"
            ? data.daemon as HamasxiangPlatformHealthSnapshot["daemon"]
            : undefined,
        },
      };
      this.resourceErrors.delete("platform-health");
    } catch (error) {
      this.logResourceError("platform-health", error);
    }
  }

  private mapDaemonTask(item: DaemonTaskRecord, index: number): OperationTask {
    const status = this.mapDaemonTaskStatus(item.status);
    const parts: string[] = [];
    if (item.platform) parts.push(`来源 ${this.platformLabel(item.platform)}`);
    if (item.stage) parts.push(this.stageLabel(item.stage));
    if (item.evidence_level) parts.push(this.evidenceLabel(item.evidence_level));
    if (typeof item.item_count === "number") parts.push(`${item.completed_count ?? 0}/${item.item_count} 条已完成`);
    if (typeof item.processed_count === "number") {
      parts.push(`已处理 ${item.processed_count} · 成功 ${item.succeeded_count ?? 0} · 失败 ${item.failed_count ?? 0}`);
    }
    if (item.provider) parts.push(`云仓 ${item.provider}`);
    if (item.vault_written) parts.push("已写入 Vault");
    else if (status === "awaiting_sync") parts.push("内容已抓取，等待同步");
    else if (status === "insufficient_evidence") parts.push("未达到正文/字幕证据门槛");
    if (item.vault_path) parts.push(`落点 ${this.shortPath(item.vault_path)}`);
    const errorText = this.describeDaemonError(item.error, item.error_layer);
    if (errorText) parts.push(`问题：${errorText}`);
    if (typeof item.returncode === "number" && item.returncode !== 0) parts.push(`可重试`);
    if (!parts.length && item.url) parts.push(`来源 ${item.url}`);
    return {
      id: `hamaxiang-job-${item.id ?? index}`,
      title: String(item.title || (item.kind === "asset-upload-job" ? "图片云仓上传" : "") || item.url || item.id || "Daemon 任务"),
      source: "hamaxiang",
      status,
      detail: parts.join(" · "),
      progress: status === "queued" ? 10 : status === "running" ? 55 : status === "awaiting_sync" ? 82 : status === "success" ? 100 : 0,
      updatedAt: this.parseTime(item.updated_at) ?? this.parseTime(item.created_at) ?? 0,
      action: { label: "打开来源", command: "open-hamasxiang-console" },
    };
  }

  private platformLabel(platform: string): string {
    const labels: Record<string, string> = {
      bilibili: "B站",
      douyin: "抖音",
      xiaohongshu: "小红书",
      x: "X",
      youtube: "YouTube",
      dianping: "大众点评",
      web: "网页",
      mixed: "多平台",
    };
    return labels[platform] ?? platform;
  }

  private stageLabel(stage: string): string {
    const labels: Record<string, string> = {
      capture: "正在抓取",
      analyze: "正在整理",
      analyzed: "已完成分析",
      evidence_gate: "正在核验证据",
      vault_sync: "正在同步 Vault",
      resume_cache: "复用本地证据",
      resume_after_restart: "等待断点续跑",
      restart_resume_queued: "断点续跑已排队",
      resume_sync_probe: "核对既有同步回执",
      daemon_restart: "Daemon 重启恢复检查",
      preflight: "检查云仓配置",
      recover_leases: "恢复上传租约",
      uploading: "正在上传并验签",
      complete: "采集完成",
      awaiting_sync: "等待同步",
      failed: "采集失败",
    };
    return labels[stage] ?? `阶段 ${stage}`;
  }

  private evidenceLabel(level: string): string {
    const labels: Record<string, string> = {
      rich_dom: "页面正文证据",
      subtitle_full: "完整字幕",
      asr_full: "完整 ASR",
      metadata_only: "仅有页面线索",
      failed: "未取得证据",
    };
    return labels[level] ?? level;
  }

  private shortPath(value: string): string {
    const normalized = value.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : normalized;
  }

  private mapDaemonTaskStatus(status: string | undefined): OperationTaskStatus {
    if (status === "queued" || status === "running" || status === "accepted") return status === "accepted" ? "queued" : status;
    if (status === "awaiting_sync") return "awaiting_sync";
    if (status === "insufficient_evidence") return "insufficient_evidence";
    if (status === "blocked") return "blocked";
    if (status === "completed" || status === "succeeded") return "success";
    if (status === "already_saved" || status === "deduplicated") return "success";
    if (status === "failed" || status === "delivery_failed" || status === "partial_failure") return "failed";
    if (status === "interrupted" || status === "cancelled") return "interrupted";
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
    const message = error instanceof Error ? error.message : String(error);
    if (this.resourceErrors.has(resource)) return;
    this.resourceErrors.set(resource, message);
    this.logBus.append("warn", `hamaxiang.${resource}`, `附属数据刷新失败：${message}`);
  }

  private describeDaemonError(error: unknown, fallbackLayer?: string): string {
    if (!error) return "";
    if (typeof error === "object") {
      const value = error as Record<string, unknown>;
      const layer = String(value.layer ?? fallbackLayer ?? "").trim();
      const code = String(value.code ?? "").trim();
      const message = String(value.message ?? "").trim();
      const layerLabel = this.errorLayerLabel(layer);
      return [`层级：${layerLabel}`, message || code].filter(Boolean).join(" · ").slice(0, 320);
    }
    return String(error).replace(/[\r\n]+/g, " ").slice(0, 320);
  }

  private errorLayerLabel(layer: string): string {
    const labels: Record<string, string> = {
      "request.validate": "请求校验",
      "capture.adapter": "平台采集适配器",
      "platform.x.navigation": "X 页面导航",
      "platform.x": "X 平台",
      "platform.bilibili": "B站适配器",
      "platform.douyin": "抖音适配器",
      "platform.xiaohongshu": "小红书适配器",
      "vault.worker_delivery": "收件箱投递",
      "vault.sync": "Vault 同步",
      "vault.inspiration": "灵感卡写入",
      "daemon.lifecycle": "Daemon 生命周期",
      "cache.evidence": "本地证据缓存",
    };
    return labels[layer] ?? (layer || "未知层级");
  }

  private watchCaptureJob(jobId: string): void {
    if (this.capturePollers.has(jobId)) return;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      this.capturePollers.delete(jobId);
      attempts += 1;
      try {
        await this.refresh(false);
      } catch {
        // The normal daemon poll will retry; do not turn a temporary refresh
        // outage into a second capture request.
      }
      const task = this.daemonTasks.find(item => item.id === `hamaxiang-job-${jobId}`);
      if (task && ["success", "failed", "interrupted", "blocked", "insufficient_evidence", "unknown"].includes(task.status)) {
        if (this.lastCaptureReceipt?.jobId === jobId) {
          this.lastCaptureReceipt = {
            ...this.lastCaptureReceipt,
            status: task.status,
            updatedAt: task.updatedAt,
          };
          this.emitIfChanged();
        }
        return;
      }
      if (attempts >= 24) return;
      this.capturePollers.set(jobId, window.setTimeout(() => void tick(), 1500));
    };
    this.capturePollers.set(jobId, window.setTimeout(() => void tick(), 600));
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private emitIfChanged(): void {
    const signature = JSON.stringify({
      snapshot: {
        activeJobs: this.snapshot.activeJobs,
        asr: this.snapshot.asr,
        error: this.snapshot.error,
        online: this.snapshot.online,
        service: this.snapshot.service,
        version: this.snapshot.version,
        xWatch: {
          enabled: this.snapshot.xWatch.enabled,
          handles: this.snapshot.xWatch.handles,
          last_new_count: this.snapshot.xWatch.last_new_count,
          last_success_at: this.snapshot.xWatch.last_success_at,
          next_run_at: this.snapshot.xWatch.next_run_at,
          running: this.snapshot.xWatch.running,
          status: this.snapshot.xWatch.status,
        },
        platformHealth: this.snapshot.platformHealth,
      },
      tasks: this.daemonTasks,
      artifacts: this.artifacts,
      intelligence: this.intelligence,
      resourceErrors: [...this.resourceErrors.entries()],
      lastCaptureReceipt: this.lastCaptureReceipt,
    });
    if (signature === this.lastPublishedSignature) return;
    this.lastPublishedSignature = signature;
    this.emit();
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
