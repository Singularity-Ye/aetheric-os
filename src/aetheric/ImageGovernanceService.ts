import { App, Plugin, TFile } from "obsidian";
import { LogBus } from "./LogBus";
import type {
  ImageGovernanceSettings,
  PersistedImageGovernanceBatch,
} from "../settings";

export interface ImageGovernanceSnapshot {
  enabled: boolean;
  autoCompress: boolean;
  running: boolean;
  pending: number;
  scanned: number;
  candidates: number;
  converted: number;
  skipped: number;
  failures: number;
  bytesBefore: number;
  bytesAfter: number;
  lastRunAt: number | null;
  lastError: string | null;
  registry: ImageAssetRegistrySnapshot;
  cloud: ImageCloudStoreSnapshot;
  retention: ImageAssetRetentionSnapshot;
}

export interface ImageRegistrationReceipt {
  total: number;
  registered: number;
  failed: number;
  items: Array<{ path: string; assetId?: string; error?: string }>;
}

export type ImageGovernanceCandidateKind =
  | "recommended"
  | "unreferenced"
  | "retired_source"
  | "operational_evidence";

export type ImageGovernanceCandidateSort = "largest" | "newest" | "most-referenced";

export interface ImageGovernanceCandidate {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
  displayPath: string;
  referenceCount: number;
  area: string;
  kind: ImageGovernanceCandidateKind;
  selectableByDefault: boolean;
  reason: string;
}

export function classifyImageGovernanceCandidate(
  path: string,
  referenceCount: number,
): Pick<ImageGovernanceCandidate, "area" | "kind" | "selectableByDefault" | "reason"> {
  const normalized = path.replace(/\\/g, "/");
  const area = normalized.split("/")[0] || "根目录";
  if (normalized.startsWith("02_丹炉间（项目区）/松果天工台（Aetheric OS）/91_笔记内嵌图片/")) {
    return {
      area,
      kind: "operational_evidence",
      selectableByDefault: false,
      reason: "AOS 运维或验收截图，可能包含账户、服务器或会话证据",
    };
  }
  if (normalized.startsWith("00_松果池（收件箱）/小红书/")) {
    return {
      area,
      kind: "retired_source",
      selectableByDefault: false,
      reason: "退役小红书来源，默认不进入历史图片批次",
    };
  }
  if (referenceCount <= 0) {
    return {
      area,
      kind: "unreferenced",
      selectableByDefault: false,
      reason: "当前没有已解析的 Markdown 引用，先核验用途再处理",
    };
  }
  return {
    area,
    kind: "recommended",
    selectableByDefault: true,
    reason: `已有 ${referenceCount} 条明确引用，适合优先生成轻量显示版本`,
  };
}

export function sortImageGovernanceCandidates(
  candidates: ImageGovernanceCandidate[],
  sort: ImageGovernanceCandidateSort,
): ImageGovernanceCandidate[] {
  return [...candidates].sort((left, right) => {
    if (sort === "newest") {
      return right.modifiedAt - left.modifiedAt
        || right.bytes - left.bytes
        || left.path.localeCompare(right.path);
    }
    if (sort === "most-referenced") {
      return right.referenceCount - left.referenceCount
        || right.bytes - left.bytes
        || right.modifiedAt - left.modifiedAt
        || left.path.localeCompare(right.path);
    }
    return right.bytes - left.bytes
      || right.modifiedAt - left.modifiedAt
      || left.path.localeCompare(right.path);
  });
}

export interface ImageGovernanceBatchManifest {
  manifestId: string;
  createdAt: number;
  paths: string[];
  totalBytes: number;
}

export interface ImageGovernanceBatchItemResult {
  path: string;
  status: "converted" | "skipped" | "failed";
  beforeBytes: number;
  afterBytes?: number;
  rewrittenNoteCount?: number;
  rewrittenTokenCount?: number;
  error?: string;
}

export interface ImageGovernanceBatchReceipt {
  manifest: ImageGovernanceBatchManifest;
  results: ImageGovernanceBatchItemResult[];
  snapshot: ImageGovernanceSnapshot;
}

export interface ImageAssetRegistrySnapshot {
  available: boolean;
  discovered: number;
  derivativeReady: number;
  failed: number;
  uploaded: number;
  verified: number;
  total: number;
  checkedAt: number | null;
  lastError: string | null;
}

export interface ImageCloudStoreError {
  layer?: string;
  code?: string;
  message: string;
  retryable?: boolean;
  updatedAt?: string;
}

export interface ImageCloudStoreSnapshot {
  available: boolean;
  provider: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  activeJobId: string | null;
  state: string;
  lastSuccessAt: string | null;
  queued: number;
  leased: number;
  failed: number;
  succeeded: number;
  due: number;
  retryableFailed: number;
  terminalFailed: number;
  expiredLeases: number;
  nextAttemptAt: string | null;
  remoteTotal: number;
  remotePending: number;
  remoteUploaded: number;
  remoteVerified: number;
  remoteVerifiedAssets: number | null;
  remoteFailed: number;
  checkedAt: number | null;
  lastError: ImageCloudStoreError | null;
  restore: {
    running: boolean;
    lastSuccessAt: string | null;
    lastRole: string | null;
    lastError: ImageCloudStoreError | null;
  };
  restoreSampler: ImageRestoreSamplerSnapshot;
}

export interface ImageRestoreSamplerSnapshot {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  intervalSeconds: number;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastStartedAt: string | null;
  lastAssetId: string | null;
  lastRole: "display" | "original" | null;
  lastJobId: string | null;
  lastResult: {
    jobId?: string;
    assetId?: string;
    role?: string;
    status?: string;
    stage?: string;
    finishedAt?: string;
    error?: ImageCloudStoreError | null;
  } | null;
  lastError: ImageCloudStoreError | null;
  deleteActionsAvailable: false;
}

export type ImageAssetRetentionState =
  | "retained"
  | "verification_pending"
  | "restore_evidence_missing"
  | "restore_evidence_stale"
  | "grace_period"
  | "eligible_for_review"
  | "blocked";

export interface ImageAssetRetentionItem {
  assetId: string;
  state: ImageAssetRetentionState;
  reasons: string[];
  retentionStartedAt?: string;
  eligibleAt?: string;
  originalPath?: string;
  displayPath?: string;
  activeNoteRefCount: number;
  restoreOriginal?: { status: string; finishedAt?: string; elapsedMs?: number };
  restoreDisplay?: { status: string; finishedAt?: string; elapsedMs?: number };
}

export interface ImageAssetRetentionSnapshot {
  available: boolean;
  checkedAt: number | null;
  total: number;
  byState: Record<string, number>;
  eligibleForReview: number;
  minimumLocalRetentionDays: number;
  restoreSlaMaxAgeDays: number;
  deleteActionsAvailable: false;
  items: ImageAssetRetentionItem[];
  lastError: string | null;
}

export interface ImageAssetRetentionStatusContract {
  checkedAt: number;
  total: number;
  byState: Record<string, number>;
  eligibleForReview: number;
  minimumLocalRetentionDays: number;
  restoreSlaMaxAgeDays: number;
  deleteActionsAvailable: false;
  items: ImageAssetRetentionItem[];
}

export interface ImageAssetUploadStatusContract {
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
  lastError?: {
    layer?: string;
    code?: string;
    message: string;
    retryable?: boolean;
    updated_at?: string;
  };
  restore: {
    running: boolean;
    lastSuccessAt?: string;
    lastRole?: string;
    lastError?: {
      layer?: string;
      code?: string;
      message: string;
      retryable?: boolean;
      updated_at?: string;
    };
  };
}

export interface ImageAssetRegistryClient {
  registerImageInPlace?(
    path: string,
    noteRefs: string[],
  ): Promise<{ asset_id: string; status: string; note_ref_count: number }>;
  discoverImageAsset(
    originalPath: string,
    noteRefs: string[],
  ): Promise<{ asset_id: string; status: string; note_ref_count: number }>;
  registerImageDerivative(
    assetId: string,
    displayPath: string,
  ): Promise<{ asset_id: string; status: string; note_ref_count: number }>;
  getAssetRegistrySummary(): Promise<{
    total: number;
    by_status: Record<string, number>;
  }>;
  enqueueImageAssetUpload?(
    assetId: string,
    originalPath: string,
    displayPath: string,
  ): Promise<{ upload_id: string; asset_id: string; provider: string; status: string; reused: boolean }>;
  getAssetUploadStatus?(): Promise<ImageAssetUploadStatusContract>;
  runAssetUpload?(limit?: number): Promise<{ jobId: string; status: string; provider: string; limit: number }>;
  runAssetRestoreDrill?(
    role?: "display" | "original",
    assetId?: string,
  ): Promise<{ jobId: string; status: string; provider: string; role: "display" | "original" }>;
  getAssetRestoreSamplerStatus?(): Promise<{
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
    lastResult?: ImageRestoreSamplerSnapshot["lastResult"];
    lastError?: ImageCloudStoreError | null;
    deleteActionsAvailable: false;
  }>;
  runAssetRestoreSampler?(limit?: number): Promise<{
    jobId: string;
    status: string;
    provider: string;
    limit: number;
    queued: boolean;
    candidate?: { asset_id?: string; role?: string; state?: string };
  }>;
  pauseAssetRestoreSampler?(paused: boolean): Promise<{
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
    lastResult?: ImageRestoreSamplerSnapshot["lastResult"];
    lastError?: ImageCloudStoreError | null;
    deleteActionsAvailable: false;
  }>;
  getAssetRetentionStatus?(limit?: number): Promise<ImageAssetRetentionStatusContract>;
  getAssetRetentionManifest?(assetIds?: string[]): Promise<Record<string, unknown>>;
}

interface ReferenceUpdate {
  file: TFile;
  before: string;
  rewrittenTokens: number;
}

interface ImageOptimizationOutcome {
  status: "converted" | "skipped";
  rewrittenNoteCount: number;
  rewrittenTokenCount: number;
}

interface EncodedImage {
  data: ArrayBuffer;
  mime: "image/webp";
  width: number;
  height: number;
}

interface ImageFileIdentity {
  size: number;
  mtime: number;
}

interface QueuedImage {
  identity: ImageFileIdentity;
  readyAt: number;
}

export interface GovernSingleImageOptions {
  /**
   * A deliberate one-file action may ignore the global size threshold.
   * The encoded file must still pass the configured savings ratio, and every
   * other safety gate remains active.
   */
  ignoreMinBytes?: boolean;
}

class ImageSourceChangedError extends Error {
  constructor(readonly sourcePath: string) {
    super(`图片在压缩期间仍被写入：${sourcePath}`);
    this.name = "ImageSourceChangedError";
  }
}

class ReferenceRewriteError extends Error {
  constructor(message: string, readonly rollbackIncomplete: boolean) {
    super(message);
    this.name = "ReferenceRewriteError";
  }
}

const SUPPORTED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
export const MAX_NEW_CONVERSIONS_PER_PASS = 10;
export const MAX_RECONCILIATIONS_PER_PASS = 20;
const AUTO_BATCH_PAUSE_MS = 1000;
const STARTUP_SCAN_IDLE_TIMEOUT_MS = 2500;
const READ_ONLY_SCAN_YIELD_INTERVAL = 128;

function replaceLiteral(value: string, from: string, to: string): string {
  return from ? value.split(from).join(to) : value;
}

function parentPath(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "" : filePath.slice(0, index);
}

function relativePath(fromFolder: string, toPath: string): string {
  const from = fromFolder.split("/").filter(Boolean);
  const to = toPath.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  const prefix = Array.from({ length: from.length - common }, () => "..");
  return [...prefix, ...to.slice(common)].join("/") || toPath;
}

function sameIdentity(left: ImageFileIdentity, right: ImageFileIdentity): boolean {
  return left.size === right.size && left.mtime === right.mtime;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

/**
 * Persistent, conservative image hygiene for the Vault.
 *
 * The service deliberately creates the compressed file first, rewrites all
 * known references, and retains the source image until a future Asset Registry
 * can attest its cloud backup. A failed conversion restores every note it
 * already touched and removes only the newly generated WebP.
 */
export class ImageGovernanceService {
  private timer: number | null = null;
  private startupScanHandle: number | null = null;
  private startupScanUsesIdleCallback = false;
  private queue = new Map<string, QueuedImage>();
  private running = false;
  private drainRequested = false;
  private reconciliationBudget = 0;
  private reconciliationSeen = new Set<string>();
  private reconciliationResumeAfter: string | null = null;
  private reconciliationRetryPaths = new Set<string>();
  private reconciliationRetryAttempts = new Map<string, number>();
  private listeners = new Set<(snapshot: ImageGovernanceSnapshot) => void>();
  private snapshot: ImageGovernanceSnapshot = {
    enabled: false,
    autoCompress: false,
    running: false,
    pending: 0,
    scanned: 0,
    candidates: 0,
    converted: 0,
    skipped: 0,
    failures: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    lastRunAt: null,
    lastError: null,
    registry: {
      available: false,
      discovered: 0,
      derivativeReady: 0,
      failed: 0,
      uploaded: 0,
      verified: 0,
      total: 0,
      checkedAt: null,
      lastError: null,
    },
    cloud: {
      available: false,
      provider: "tencent_cos",
      enabled: false,
      configured: false,
      running: false,
      activeJobId: null,
      state: "unknown",
      lastSuccessAt: null,
      queued: 0,
      leased: 0,
      failed: 0,
      succeeded: 0,
      due: 0,
      retryableFailed: 0,
      terminalFailed: 0,
      expiredLeases: 0,
      nextAttemptAt: null,
      remoteTotal: 0,
      remotePending: 0,
      remoteUploaded: 0,
      remoteVerified: 0,
      remoteVerifiedAssets: null,
      remoteFailed: 0,
      checkedAt: null,
      lastError: null,
      restore: {
        running: false,
        lastSuccessAt: null,
        lastRole: null,
        lastError: null,
      },
      restoreSampler: {
        enabled: false,
        paused: false,
        running: false,
        intervalSeconds: 604800,
        nextRunAt: null,
        lastCheckedAt: null,
        lastStartedAt: null,
        lastAssetId: null,
        lastRole: null,
        lastJobId: null,
        lastResult: null,
        lastError: null,
        deleteActionsAvailable: false,
      },
    },
    retention: {
      available: false,
      checkedAt: null,
      total: 0,
      byState: {},
      eligibleForReview: 0,
      minimumLocalRetentionDays: 30,
      restoreSlaMaxAgeDays: 7,
      deleteActionsAvailable: false,
      items: [],
      lastError: null,
    },
  };

  constructor(
    private app: App,
    private owner: Plugin,
    private logBus: LogBus,
    private getSettings: () => ImageGovernanceSettings,
    private assetRegistry?: ImageAssetRegistryClient,
    private readBatchHistory: () => PersistedImageGovernanceBatch[] = () => [],
    private writeBatchHistory: (history: PersistedImageGovernanceBatch[]) => Promise<void> = async () => {},
  ) {}

  getBatchHistory(): PersistedImageGovernanceBatch[] {
    return this.readBatchHistory().map(batch => ({
      ...batch,
      paths: [...batch.paths],
      results: batch.results.map(item => ({ ...item })),
    }));
  }

  start(): void {
    this.syncSettings();
    this.owner.registerEvent(this.app.vault.on("create", file => this.handleVaultFile(file)));
    this.owner.registerEvent(this.app.vault.on("modify", file => this.handleVaultFile(file)));
    // The initial metadata-only scan still enumerates the whole Vault. Keep it
    // away from Obsidian's startup/layout critical path and process it in
    // bounded chunks once the renderer has an idle slot.
    this.scheduleStartupScan();
  }

  stop(): void {
    this.cancelStartupScan();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.queue.clear();
    this.drainRequested = false;
    this.emit();
  }

  subscribe(listener: (snapshot: ImageGovernanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ImageGovernanceSnapshot {
    this.syncSettings();
    return {
      ...this.snapshot,
      pending: this.queue.size,
      registry: { ...this.snapshot.registry },
      cloud: {
        ...this.snapshot.cloud,
        lastError: this.snapshot.cloud.lastError ? { ...this.snapshot.cloud.lastError } : null,
        restore: {
          ...this.snapshot.cloud.restore,
          lastError: this.snapshot.cloud.restore.lastError
            ? { ...this.snapshot.cloud.restore.lastError }
            : null,
        },
        restoreSampler: {
          ...this.snapshot.cloud.restoreSampler,
          lastResult: this.snapshot.cloud.restoreSampler.lastResult
            ? {
                ...this.snapshot.cloud.restoreSampler.lastResult,
                error: this.snapshot.cloud.restoreSampler.lastResult.error
                  ? { ...this.snapshot.cloud.restoreSampler.lastResult.error }
                  : null,
              }
            : null,
          lastError: this.snapshot.cloud.restoreSampler.lastError
            ? { ...this.snapshot.cloud.restoreSampler.lastError }
            : null,
        },
      },
      retention: {
        ...this.snapshot.retention,
        byState: { ...this.snapshot.retention.byState },
        items: this.snapshot.retention.items.map(item => ({
          ...item,
          reasons: [...item.reasons],
          restoreOriginal: item.restoreOriginal ? { ...item.restoreOriginal } : undefined,
          restoreDisplay: item.restoreDisplay ? { ...item.restoreDisplay } : undefined,
        })),
      },
    };
  }

  async refreshRegistrySummary(): Promise<ImageAssetRegistrySnapshot> {
    if (!this.assetRegistry) return { ...this.snapshot.registry };
    const registryResult = await Promise.allSettled([
      this.assetRegistry.getAssetRegistrySummary(),
      this.assetRegistry.getAssetUploadStatus
        ? this.assetRegistry.getAssetUploadStatus()
        : Promise.reject(new Error("当前 Daemon 尚未提供图片云仓状态接口")),
      this.assetRegistry.getAssetRetentionStatus
        ? this.assetRegistry.getAssetRetentionStatus(50)
        : Promise.reject(new Error("当前 Daemon 尚未提供原图保留与恢复 SLA 状态接口")),
      this.assetRegistry.getAssetRestoreSamplerStatus
        ? this.assetRegistry.getAssetRestoreSamplerStatus()
        : Promise.reject(new Error("当前 Daemon 尚未提供定期恢复抽样状态接口")),
    ]);
    const registrySummary = registryResult[0];
    if (registrySummary.status === "fulfilled") {
      const summary = registrySummary.value;
      const count = (status: string): number => Math.max(0, Number(summary.by_status?.[status] ?? 0));
      this.snapshot.registry = {
        available: true,
        discovered: count("discovered"),
        derivativeReady: count("derivative_ready"),
        failed: count("failed"),
        uploaded: count("uploaded"),
        verified: count("verified"),
        total: Math.max(0, Number(summary.total ?? 0)),
        checkedAt: Date.now(),
        lastError: null,
      };
    } else {
      const error = registrySummary.reason;
      this.snapshot.registry = {
        ...this.snapshot.registry,
        available: false,
        checkedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    const cloudStatus = registryResult[1];
    if (cloudStatus.status === "fulfilled") {
      const status = cloudStatus.value;
      const restore = status.restore ?? { running: false };
      this.snapshot.cloud = {
        available: true,
        provider: status.provider || "tencent_cos",
        enabled: status.enabled,
        configured: status.configured,
        running: status.running,
        activeJobId: status.activeJobId ?? null,
        state: status.state || "unknown",
        lastSuccessAt: status.lastSuccessAt ?? null,
        queued: Math.max(0, status.queued),
        leased: Math.max(0, status.leased),
        failed: Math.max(0, status.failed),
        succeeded: Math.max(0, status.succeeded),
        due: Math.max(0, status.due),
        retryableFailed: Math.max(0, status.retryableFailed),
        terminalFailed: Math.max(0, status.terminalFailed),
        expiredLeases: Math.max(0, status.expiredLeases),
        nextAttemptAt: status.nextAttemptAt ?? null,
        remoteTotal: Math.max(0, status.remoteTotal),
        remotePending: Math.max(0, status.remotePending),
        remoteUploaded: Math.max(0, status.remoteUploaded),
        remoteVerified: Math.max(0, status.remoteVerified),
        remoteVerifiedAssets: typeof status.remoteVerifiedAssets === "number"
          ? Math.max(0, status.remoteVerifiedAssets)
          : null,
        remoteFailed: Math.max(0, status.remoteFailed),
        checkedAt: status.checkedAt || Date.now(),
        lastError: status.lastError
          ? {
              layer: status.lastError.layer,
              code: status.lastError.code,
              message: status.lastError.message,
              retryable: status.lastError.retryable,
              updatedAt: status.lastError.updated_at,
            }
          : null,
        restore: {
          running: restore.running,
          lastSuccessAt: restore.lastSuccessAt ?? null,
          lastRole: restore.lastRole ?? null,
          lastError: restore.lastError
            ? {
                layer: restore.lastError.layer,
                code: restore.lastError.code,
                message: restore.lastError.message,
                retryable: restore.lastError.retryable,
                updatedAt: restore.lastError.updated_at,
              }
            : null,
        },
        restoreSampler: this.snapshot.cloud.restoreSampler,
      };
    } else {
      const error = cloudStatus.reason;
      this.snapshot.cloud = {
        ...this.snapshot.cloud,
        available: false,
        checkedAt: Date.now(),
        lastError: {
          layer: "asset.upload.status",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const retentionStatus = registryResult[2];
    if (retentionStatus.status === "fulfilled") {
      const status = retentionStatus.value;
      this.snapshot.retention = {
        available: true,
        checkedAt: status.checkedAt || Date.now(),
        total: Math.max(0, status.total),
        byState: { ...status.byState },
        eligibleForReview: Math.max(0, status.eligibleForReview),
        minimumLocalRetentionDays: Math.max(1, status.minimumLocalRetentionDays || 30),
        restoreSlaMaxAgeDays: Math.max(1, status.restoreSlaMaxAgeDays || 7),
        deleteActionsAvailable: false,
        items: status.items.map(item => ({
          ...item,
          reasons: [...item.reasons],
          restoreOriginal: item.restoreOriginal ? { ...item.restoreOriginal } : undefined,
          restoreDisplay: item.restoreDisplay ? { ...item.restoreDisplay } : undefined,
        })),
        lastError: null,
      };
    } else {
      const error = retentionStatus.reason;
      this.snapshot.retention = {
        ...this.snapshot.retention,
        available: false,
        checkedAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
    const samplerStatus = registryResult[3];
    if (samplerStatus.status === "fulfilled") {
      const sampler = samplerStatus.value;
      const lastResult = sampler.lastResult;
      this.snapshot.cloud.restoreSampler = {
        enabled: sampler.enabled === true,
        paused: sampler.paused === true,
        running: sampler.running === true,
        intervalSeconds: Math.max(60, Number(sampler.intervalSeconds) || 604800),
        nextRunAt: sampler.nextRunAt ?? null,
        lastCheckedAt: sampler.lastCheckedAt ?? null,
        lastStartedAt: sampler.lastStartedAt ?? null,
        lastAssetId: sampler.lastAssetId ?? null,
        lastRole: sampler.lastRole ?? null,
        lastJobId: sampler.lastJobId ?? null,
        lastResult: lastResult
          ? { ...lastResult, error: lastResult.error ? { ...lastResult.error } : null }
          : null,
        lastError: sampler.lastError ? { ...sampler.lastError } : null,
        deleteActionsAvailable: false,
      };
    } else {
      const error = samplerStatus.reason;
      this.snapshot.cloud.restoreSampler = {
        ...this.snapshot.cloud.restoreSampler,
        lastError: {
          layer: "asset.restore.sampler.status",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.emit();
    return { ...this.snapshot.registry };
  }

  async runPendingUploads(limit = 20): Promise<ImageCloudStoreSnapshot> {
    if (!this.assetRegistry?.runAssetUpload) throw new Error("当前 Daemon 尚未提供图片上传动作");
    const cloud = this.snapshot.cloud;
    if (!cloud.available) throw new Error("图片云仓状态不可用，请先刷新");
    if (!cloud.enabled) throw new Error("图片云仓尚未启用");
    if (!cloud.configured) throw new Error("图片云仓凭据尚未配置");
    if (cloud.running) throw new Error("图片云仓已有上传任务在运行");
    if (cloud.restore.running) throw new Error("图片恢复抽检正在运行");
    if (cloud.queued + cloud.retryableFailed <= 0) throw new Error("当前没有待上传图片");
    try {
      const receipt = await this.assetRegistry.runAssetUpload(limit);
      this.logBus.append(
        "success",
        "image.cloud-store",
        `图片云仓任务已提交：${receipt.jobId}（${receipt.provider}，上限 ${receipt.limit}）`,
      );
    } catch (error) {
      this.recordCloudFailure("asset.upload.run", error);
      this.emit();
      throw error;
    }
    await this.refreshRegistrySummary();
    return { ...this.snapshot.cloud };
  }

  async registerFileImagesInPlace(file: TFile): Promise<{ total: number; registered: number; failed: number }> {
    if (this.running) throw new Error("图片治理任务正在运行，请稍后再试");
    if (!this.assetRegistry?.registerImageInPlace) throw new Error("当前 Daemon 尚未提供图片原位登记接口");
    const paths = this.isSupportedImage(file)
      ? [file.path]
      : file.extension.toLowerCase() === "md"
        ? Object.keys(this.app.metadataCache.resolvedLinks?.[file.path] ?? {})
          .filter(path => {
            const target = this.app.vault.getAbstractFileByPath(path);
            return target instanceof TFile && this.isSupportedImage(target);
          })
        : [];
    if (!paths.length) throw new Error("当前文件没有已解析的本地 PNG/JPEG/WebP 图片");
    if (paths.length > MAX_RECONCILIATIONS_PER_PASS) {
      throw new Error(`当前笔记引用 ${paths.length} 张图片，超过单次 20 张；请逐张打开图片登记`);
    }
    const { total, registered, failed } = await this.registerImagePathsInPlace(paths);
    return { total, registered, failed };
  }

  getLocalImageInventory(): Array<{ path: string; bytes: number; format: string; noteCount: number }> {
    const images = this.app.vault.getFiles().filter(file => this.isSupportedImage(file));
    const counts = new Map<string, number>();
    const paths = new Set(images.map(file => file.path));
    for (const links of Object.values(this.app.metadataCache.resolvedLinks ?? {})) {
      for (const path of Object.keys(links)) {
        if (paths.has(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }
    return images.map(file => ({
      path: file.path, bytes: file.stat.size, format: file.extension.toLowerCase(), noteCount: counts.get(file.path) ?? 0,
    })).sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
  }

  async registerImagePathsInPlace(selectedPaths: string[]): Promise<ImageRegistrationReceipt> {
    if (this.running) throw new Error("图片治理任务正在运行，请稍后再试");
    if (!this.assetRegistry?.registerImageInPlace) throw new Error("当前 Daemon 尚未提供图片原位登记接口");
    const paths = [...new Set(selectedPaths)];
    if (!paths.length || paths.length > MAX_RECONCILIATIONS_PER_PASS) throw new Error("原位登记单次需选择 1–20 张图片");
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !this.isSupportedImage(file)) throw new Error(`图片不可用或不在登记范围：${path}`);
    }
    this.running = true;
    this.snapshot.running = true;
    this.emit();
    let registered = 0;
    const items: ImageRegistrationReceipt["items"] = [];
    try {
      for (const path of paths) {
        try {
          const asset = await this.assetRegistry.registerImageInPlace(path, this.resolvedNoteReferences(path));
          if (!asset.asset_id) throw new Error("登记未返回资产 ID");
          registered += 1;
          items.push({ path, assetId: asset.asset_id });
          this.logBus.append("success", "image.asset-registry", `图片原位登记：${path} → ${asset.asset_id}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          items.push({ path, error: message });
          this.logBus.append("error", "image.asset-registry", `图片原位登记失败：${path} · ${message}`);
        }
      }
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.emit();
    }
    await this.refreshRegistrySummary();
    return { total: paths.length, registered, failed: paths.length - registered, items };
  }

  async reconcileExistingDerivativesNow(limit = MAX_RECONCILIATIONS_PER_PASS): Promise<ImageGovernanceSnapshot> {
    if (this.running) throw new Error("图片治理任务正在运行，请稍后再试");
    if (!this.assetRegistry) throw new Error("Asset Registry 尚未连接");
    const boundedLimit = Math.max(1, Math.min(MAX_RECONCILIATIONS_PER_PASS, Math.floor(Number(limit) || 1)));
    this.running = true;
    this.snapshot.running = true;
    this.beginReconciliationPass(boundedLimit);
    this.emit();
    try {
      const originals = this.orderFilesForReconciliation(
        this.app.vault.getFiles()
          .filter(file => this.isSupportedImage(file) && file.extension.toLowerCase() !== "webp"),
      );
      for (const original of originals) {
        if (this.reconciliationBudget <= 0) break;
        const displayPath = original.path.replace(/\.[^./]+$/, ".webp");
        const display = this.app.vault.getAbstractFileByPath(displayPath);
        if (!(display instanceof TFile) || display.extension.toLowerCase() !== "webp") continue;
        await this.reconcileExistingDerivative(original, display);
        // This path intentionally does not call encodeWebp(), createBinary(),
        // rewriteReferences(), modify(), or trash(). Yield only for UI health.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      this.logBus.append(
        "success",
        "image.asset-registry",
        `已有 WebP 补登记批次完成：本轮尝试 ${this.reconciliationSeen.size} 对，上限 ${boundedLimit}`,
      );
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.snapshot.lastRunAt = Date.now();
      this.endReconciliationPass();
      this.emit();
    }
    await this.refreshRegistrySummary();
    return this.getSnapshot();
  }

  async runRestoreDrill(
    role: "display" | "original" = "display",
    assetId?: string,
  ): Promise<ImageCloudStoreSnapshot> {
    if (!this.assetRegistry?.runAssetRestoreDrill) throw new Error("当前 Daemon 尚未提供图片恢复抽检");
    const cloud = this.snapshot.cloud;
    if (!cloud.available) throw new Error("图片云仓状态不可用，请先刷新");
    if (!cloud.enabled) throw new Error("图片云仓尚未启用");
    if (!cloud.configured) throw new Error("图片云仓尚未达到可用状态");
    if (cloud.running) throw new Error("图片云仓上传任务正在运行");
    if (cloud.restore.running) throw new Error("图片恢复抽检正在运行");
    if ((cloud.remoteVerifiedAssets ?? 0) <= 0) throw new Error("当前没有 COS 专属已验签资产可供恢复抽检");
    try {
      const receipt = await this.assetRegistry.runAssetRestoreDrill(role, assetId);
      this.logBus.append(
        "success",
        "image.cloud-store",
        `图片恢复抽检已提交：${receipt.jobId}（${receipt.role}${assetId ? ` · ${assetId}` : ""}）`,
      );
    } catch (error) {
      this.recordCloudFailure("asset.restore.drill", error);
      this.emit();
      throw error;
    }
    await this.refreshRegistrySummary();
    return { ...this.snapshot.cloud };
  }

  async runRestoreSampler(): Promise<ImageCloudStoreSnapshot> {
    if (!this.assetRegistry?.runAssetRestoreSampler) {
      throw new Error("当前 Daemon 尚未提供定期恢复抽样");
    }
    const sampler = this.snapshot.cloud.restoreSampler;
    const cloud = this.snapshot.cloud;
    if (!cloud.available) throw new Error("图片云仓状态不可用，请先刷新");
    if (!cloud.enabled) throw new Error("图片云仓尚未启用");
    if (!cloud.configured) throw new Error("图片云仓尚未达到可用状态");
    if (cloud.running || cloud.restore.running || sampler.running) {
      throw new Error("已有图片云端任务正在运行");
    }
    try {
      const receipt = await this.assetRegistry.runAssetRestoreSampler(1);
      this.logBus.append(
        "success",
        "image.cloud-store",
        receipt.queued
          ? `定期恢复抽样已提交：${receipt.jobId}`
          : `定期恢复抽样检查完成：${receipt.status}`,
      );
    } catch (error) {
      this.recordCloudFailure("asset.restore.sampler", error);
      this.emit();
      throw error;
    }
    await this.refreshRegistrySummary();
    return { ...this.snapshot.cloud };
  }

  async pauseRestoreSampler(paused: boolean): Promise<ImageCloudStoreSnapshot> {
    if (!this.assetRegistry?.pauseAssetRestoreSampler) {
      throw new Error("当前 Daemon 尚未提供恢复抽样暂停控制");
    }
    await this.assetRegistry.pauseAssetRestoreSampler(paused);
    await this.refreshRegistrySummary();
    return { ...this.snapshot.cloud };
  }

  async getRetentionManifest(assetIds?: string[]): Promise<Record<string, unknown>> {
    if (!this.assetRegistry?.getAssetRetentionManifest) {
      throw new Error("当前 Daemon 尚未提供保留候选 Manifest");
    }
    return this.assetRegistry.getAssetRetentionManifest(assetIds);
  }

  async scanNow(compress = true): Promise<ImageGovernanceSnapshot> {
    this.cancelStartupScan();
    if (this.running) return this.getSnapshot();
    const startedAt = performance.now();
    this.running = true;
    this.snapshot.running = true;
    this.snapshot.scanned = 0;
    this.snapshot.candidates = 0;
    this.snapshot.converted = 0;
    this.snapshot.skipped = 0;
    this.snapshot.failures = 0;
    this.snapshot.bytesBefore = 0;
    this.snapshot.bytesAfter = 0;
    this.snapshot.lastError = null;
    this.beginReconciliationPass(compress ? MAX_RECONCILIATIONS_PER_PASS : 0);
    this.emit();

    try {
      this.syncSettings();
      const settings = this.getSettings();
      let newConversionAttempts = 0;
      let deferredNewConversions = 0;
      let files = this.app.vault.getFiles().filter(file => this.isSupportedImage(file));
      files = compress
        ? this.orderFilesForReconciliation(files)
        : files.sort((left, right) => left.path.localeCompare(right.path));
      for (const file of files) {
        this.snapshot.scanned += 1;
        if (!compress || !settings.enabled) {
          // Existing WebP files are deliberately not re-encoded by
          // optimizeFile().  Do not count them as actionable candidates in
          // the read-only scan, otherwise the workbench reports a permanently
          // inflated queue that the governance pass can never drain.
          if (file.extension.toLowerCase() !== "webp"
            && file.stat.size >= settings.minBytes
            && this.app.vault.getAbstractFileByPath(this.displayPathFor(file.path)) === null) {
            this.snapshot.candidates += 1;
          }
          if (this.snapshot.scanned % READ_ONLY_SCAN_YIELD_INTERVAL === 0) {
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          }
          continue;
        }
        const extension = file.extension.toLowerCase();
        const targetPath = extension === "webp" ? file.path : this.displayPathFor(file.path);
        const targetExists = extension === "webp"
          || this.app.vault.getAbstractFileByPath(targetPath) !== null;
        if (extension !== "webp" && file.stat.size >= settings.minBytes && !targetExists) {
          if (newConversionAttempts >= MAX_NEW_CONVERSIONS_PER_PASS) {
            this.snapshot.candidates += 1;
            deferredNewConversions += 1;
            continue;
          }
          newConversionAttempts += 1;
        }
        try {
          await this.optimizeFile(file);
        } catch (error) {
          this.recordFailure(error);
        }
        // Yield between files so Obsidian remains responsive during a large pass.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      if (deferredNewConversions > 0) {
        this.logBus.append(
          "info",
          "image.governance",
          `本批已达到 ${MAX_NEW_CONVERSIONS_PER_PASS} 张新图编码上限，另有 ${deferredNewConversions} 张保留到下批；原图未改动`,
        );
      }
      this.snapshot.lastRunAt = Date.now();
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.endReconciliationPass();
      this.emit();
      this.scheduleDrain();
    }
    if (!compress) {
      this.logBus.append(
        "info",
        "image.governance.scan",
        `metadata scan ${this.snapshot.scanned} images · ${this.snapshot.candidates} candidates`,
        Math.round(performance.now() - startedAt),
      );
    }
    await this.refreshRegistrySummary();
    return this.getSnapshot();
  }

  private scheduleStartupScan(): void {
    if (this.startupScanHandle !== null) return;
    const run = (): void => {
      this.startupScanHandle = null;
      this.startupScanUsesIdleCallback = false;
      void this.scanNow(false);
    };
    if (typeof window.requestIdleCallback === "function") {
      this.startupScanUsesIdleCallback = true;
      this.startupScanHandle = window.requestIdleCallback(run, { timeout: STARTUP_SCAN_IDLE_TIMEOUT_MS });
      return;
    }
    this.startupScanHandle = window.setTimeout(run, 500);
  }

  private cancelStartupScan(): void {
    if (this.startupScanHandle === null) return;
    if (this.startupScanUsesIdleCallback && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(this.startupScanHandle);
    } else {
      window.clearTimeout(this.startupScanHandle);
    }
    this.startupScanHandle = null;
    this.startupScanUsesIdleCallback = false;
  }

  /**
   * Govern exactly one explicitly selected Vault image.
   *
   * This is intentionally separate from scanNow(): it never enumerates the
   * Vault and therefore provides a safe canary/repair path for one image.  The
   * source file is retained, while target collision, hidden-directory,
   * read-back, source-identity, reference-rollback and Asset Registry gates
   * continue to be enforced by optimizeFile().
   */
  async governSingleImageNow(
    filePath: string,
    options: GovernSingleImageOptions = {},
  ): Promise<ImageGovernanceSnapshot> {
    if (this.running) throw new Error("图片治理任务正在运行，请稍后再试");
    const file = this.resolveGovernableImage(filePath, "单图治理");

    this.syncSettings();
    if (!this.getSettings().enabled) throw new Error("图片治理器当前未启用");
    this.running = true;
    this.snapshot.running = true;
    this.snapshot.scanned = 1;
    this.snapshot.candidates = 0;
    this.snapshot.converted = 0;
    this.snapshot.skipped = 0;
    this.snapshot.failures = 0;
    this.snapshot.bytesBefore = 0;
    this.snapshot.bytesAfter = 0;
    this.snapshot.lastError = null;
    this.beginReconciliationPass(0);
    this.emit();

    try {
      const expectedIdentity = this.fileIdentity(file);
      await this.optimizeFile(file, expectedIdentity, {
        ignoreMinBytes: options.ignoreMinBytes === true,
      });
      this.snapshot.lastRunAt = Date.now();
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.endReconciliationPass();
      this.emit();
      this.scheduleDrain();
    }
    await this.refreshRegistrySummary();
    return this.getSnapshot();
  }

  /**
   * Return a read-only, stable candidate projection for the workbench.
   * No image bytes are read and no Vault file is mutated.
   */
  listGovernanceCandidates(limit = 50): ImageGovernanceCandidate[] {
    this.syncSettings();
    const settings = this.getSettings();
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    const candidates = this.app.vault.getFiles()
      .filter(file => this.isSupportedImage(file))
      .filter(file => file.extension.toLowerCase() !== "webp")
      .filter(file => file.stat.size >= settings.minBytes)
      .filter(file => this.app.vault.getAbstractFileByPath(this.displayPathFor(file.path)) === null)
      .map(file => {
        const referenceCount = this.resolvedNoteReferences(file.path).length;
        return {
          path: file.path,
          name: file.name,
          bytes: file.stat.size,
          modifiedAt: file.stat.mtime,
          displayPath: this.displayPathFor(file.path),
          referenceCount,
          ...classifyImageGovernanceCandidate(file.path, referenceCount),
        };
      });
    return sortImageGovernanceCandidates(candidates, "largest").slice(0, boundedLimit);
  }

  /**
   * Govern only the explicitly supplied Vault-relative paths.
   *
   * The batch is capped before any mutation, duplicate paths are de-duplicated,
   * invalid entries become isolated failure receipts, and every legal item
   * still passes through optimizeFile() with its source identity locked.
   */
  async governSelectedImagesNow(filePaths: string[]): Promise<ImageGovernanceBatchReceipt> {
    if (this.running) throw new Error("图片治理任务正在运行，请稍后再试");
    if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error("请先选择至少一张候选图片");
    const uniqueInputs = [...new Set(filePaths.map(value => String(value ?? "").trim()))];
    if (uniqueInputs.length > MAX_NEW_CONVERSIONS_PER_PASS) {
      throw new Error(`单批最多治理 ${MAX_NEW_CONVERSIONS_PER_PASS} 张图片；本次收到 ${uniqueInputs.length} 张，未执行任何写入`);
    }

    this.syncSettings();
    if (!this.getSettings().enabled) throw new Error("图片治理器当前未启用");

    const createdAt = Date.now();
    const resolved: Array<{ file: TFile; identity: ImageFileIdentity }> = [];
    const results: ImageGovernanceBatchItemResult[] = [];
    for (const input of uniqueInputs) {
      try {
        const file = this.resolveGovernableImage(input, "批次治理");
        resolved.push({ file, identity: this.fileIdentity(file) });
      } catch (error) {
        results.push({
          path: input,
          status: "failed",
          beforeBytes: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const manifestPaths = resolved.map(item => item.file.path);
    const manifest: ImageGovernanceBatchManifest = {
      manifestId: this.createBatchManifestId(createdAt, manifestPaths),
      createdAt,
      paths: manifestPaths,
      totalBytes: resolved.reduce((sum, item) => sum + item.identity.size, 0),
    };

    this.running = true;
    this.snapshot.running = true;
    this.snapshot.scanned = uniqueInputs.length;
    this.snapshot.candidates = 0;
    this.snapshot.converted = 0;
    this.snapshot.skipped = 0;
    this.snapshot.failures = results.length;
    this.snapshot.bytesBefore = 0;
    this.snapshot.bytesAfter = 0;
    this.snapshot.lastError = results.length ? results[results.length - 1].error ?? null : null;
    this.beginReconciliationPass(0);
    this.emit();

    try {
      for (const item of resolved) {
        const convertedBefore = this.snapshot.converted;
        const skippedBefore = this.snapshot.skipped;
        try {
          const outcome = await this.optimizeFile(item.file, item.identity);
          const converted = this.snapshot.converted > convertedBefore;
          const target = this.app.vault.getAbstractFileByPath(this.displayPathFor(item.file.path));
          results.push({
            path: item.file.path,
            status: converted ? "converted" : "skipped",
            beforeBytes: item.identity.size,
            afterBytes: converted && target instanceof TFile ? target.stat.size : undefined,
            rewrittenNoteCount: converted ? outcome?.rewrittenNoteCount ?? 0 : undefined,
            rewrittenTokenCount: converted ? outcome?.rewrittenTokenCount ?? 0 : undefined,
            error: converted
              ? undefined
              : this.snapshot.skipped > skippedBefore
                ? "未达到压缩收益门，或同名 WebP 已存在"
                : "图片未发生转换",
          });
        } catch (error) {
          this.recordFailure(error);
          results.push({
            path: item.file.path,
            status: "failed",
            beforeBytes: item.identity.size,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.emit();
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      this.snapshot.lastRunAt = Date.now();
      this.logBus.append(
        results.some(item => item.status === "failed") ? "warn" : "success",
        "image.governance.batch",
        `显式图片批次 ${manifest.manifestId} 已完成：${results.filter(item => item.status === "converted").length} 转换、${results.filter(item => item.status === "skipped").length} 跳过、${results.filter(item => item.status === "failed").length} 失败；原图全部保留`,
      );
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.endReconciliationPass();
      this.emit();
      this.scheduleDrain();
    }
    await this.refreshRegistrySummary();
    const receipt = { manifest, results, snapshot: this.getSnapshot() };
    await this.persistBatchReceipt(receipt);
    return receipt;
  }

  private async persistBatchReceipt(receipt: ImageGovernanceBatchReceipt): Promise<void> {
    const finishedAt = Date.now();
    const convertedResults = receipt.results.filter(item => item.status === "converted");
    const entry: PersistedImageGovernanceBatch = {
      manifestId: receipt.manifest.manifestId,
      createdAt: receipt.manifest.createdAt,
      finishedAt,
      paths: [...receipt.manifest.paths],
      totalBytes: receipt.manifest.totalBytes,
      converted: convertedResults.length,
      skipped: receipt.results.filter(item => item.status === "skipped").length,
      failed: receipt.results.filter(item => item.status === "failed").length,
      bytesBefore: convertedResults.reduce((sum, item) => sum + item.beforeBytes, 0),
      bytesAfter: convertedResults.reduce((sum, item) => sum + (item.afterBytes ?? item.beforeBytes), 0),
      results: receipt.results.map(item => ({ ...item })),
    };
    try {
      await this.writeBatchHistory([entry, ...this.getBatchHistory()].slice(0, 20));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logBus.append(
        "error",
        "image.governance.history",
        `图片批次已安全完成，但持久回执写入失败：${message}`,
      );
    }
  }

  private syncSettings(): void {
    const settings = this.getSettings();
    this.snapshot.enabled = settings.enabled;
    this.snapshot.autoCompress = settings.enabled && settings.autoCompress;
  }

  private resolveGovernableImage(filePath: string, actionLabel: string): TFile {
    const path = String(filePath || "").replace(/\\/g, "/").trim();
    if (!path || path.startsWith("/") || path.includes(":")
      || path.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`${actionLabel}只接受 Vault 内的规范相对路径`);
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`没有找到要治理的 Vault 图片：${path}`);
    if (!this.isSupportedImage(file)) throw new Error(`该图片类型或目录不允许进入图片治理：${path}`);
    if (file.extension.toLowerCase() === "webp") throw new Error(`当前图片已经是 WebP，无需再次编码：${path}`);
    return file;
  }

  private createBatchManifestId(createdAt: number, paths: string[]): string {
    let hash = 2166136261;
    for (const character of paths.join("\n")) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `igb_${createdAt.toString(36)}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  private isSupportedImage(file: TFile): boolean {
    return SUPPORTED_EXTENSIONS.has(file.extension.toLowerCase())
      && !this.hasHiddenDirectorySegment(file.path);
  }

  private hasHiddenDirectorySegment(filePath: string): boolean {
    const segments = filePath.replace(/\\/g, "/").split("/").filter(Boolean);
    return segments.slice(0, -1).some(segment => segment.startsWith("."));
  }

  private displayPathFor(filePath: string): string {
    return filePath.replace(/\.[^./]+$/, ".webp");
  }

  private handleVaultFile(file: unknown): void {
    if (!(file instanceof TFile) || !this.isSupportedImage(file)) return;
    // WebP is already the current display target.  Asset backup/indexing will
    // be handled by the persistent asset registry; the compression queue has
    // no work to do for it.
    if (file.extension.toLowerCase() === "webp") return;
    this.syncSettings();
    if (!this.snapshot.autoCompress) return;
    this.queue.set(file.path, {
      identity: this.fileIdentity(file),
      readyAt: Date.now() + Math.max(0, this.getSettings().debounceMs),
    });
    this.emit();
    this.scheduleDrain();
  }

  private async drainQueue(): Promise<void> {
    if (this.running) {
      this.drainRequested = true;
      return;
    }
    this.syncSettings();
    if (!this.snapshot.autoCompress) {
      this.queue.clear();
      this.drainRequested = false;
      this.emit();
      return;
    }

    const now = Date.now();
    const ready = [...this.queue.entries()]
      .filter(([, item]) => item.readyAt <= now)
      .sort((left, right) => left[1].readyAt - right[1].readyAt || left[0].localeCompare(right[0]));
    if (!ready.length) {
      this.scheduleDrain();
      return;
    }
    const batch = ready.slice(0, MAX_NEW_CONVERSIONS_PER_PASS);
    for (const [path] of batch) this.queue.delete(path);

    this.beginReconciliationPass(Math.min(MAX_RECONCILIATIONS_PER_PASS, batch.length));
    this.running = true;
    this.snapshot.running = true;
    this.emit();
    try {
      for (const [path, queued] of batch) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        if (!sameIdentity(this.fileIdentity(file), queued.identity)) {
          this.deferUntilStable(file);
          continue;
        }
        try {
          await this.optimizeFile(file, queued.identity);
        } catch (error) {
          if (error instanceof ImageSourceChangedError) {
            const current = this.app.vault.getAbstractFileByPath(path);
            if (current instanceof TFile && this.isSupportedImage(current)) this.deferUntilStable(current);
          } else {
            this.recordFailure(error);
          }
        }
        this.emit();
      }
    } finally {
      this.running = false;
      this.snapshot.running = false;
      this.endReconciliationPass();
      this.snapshot.lastRunAt = Date.now();
      this.emit();
      this.drainRequested = false;
      this.scheduleDrain(this.queue.size > 0 ? AUTO_BATCH_PAUSE_MS : 0);
    }
    await this.refreshRegistrySummary();
  }

  private async optimizeFile(
    file: TFile,
    expectedIdentity?: ImageFileIdentity,
    options: GovernSingleImageOptions = {},
  ): Promise<ImageOptimizationOutcome> {
    if (!this.isSupportedImage(file)) {
      return { status: "skipped", rewrittenNoteCount: 0, rewrittenTokenCount: 0 };
    }
    const settings = this.getSettings();
    if (!options.ignoreMinBytes && file.stat.size < settings.minBytes) {
      this.snapshot.skipped += 1;
      return { status: "skipped", rewrittenNoteCount: 0, rewrittenTokenCount: 0 };
    }
    // Existing WebP files already use the target format. Re-encoding them
    // would require an in-place binary write API and is intentionally skipped.
    if (file.extension.toLowerCase() === "webp") {
      this.snapshot.skipped += 1;
      return { status: "skipped", rewrittenNoteCount: 0, rewrittenTokenCount: 0 };
    }

    const newPath = this.displayPathFor(file.path);
    const existingTarget = this.app.vault.getAbstractFileByPath(newPath);
    if (existingTarget) {
      this.snapshot.skipped += 1;
      if (existingTarget instanceof TFile && existingTarget.extension.toLowerCase() === "webp") {
        this.logBus.append(
          "info",
          "image.governance",
          `检测到同名 WebP，未自动认定衍生关系：${file.path} → ${newPath}；请使用“补登记已有 WebP”显式处理`,
        );
      } else {
        this.logBus.append("warn", "image.governance", `跳过图片转换：目标路径已被占用 ${newPath}`);
      }
      return { status: "skipped", rewrittenNoteCount: 0, rewrittenTokenCount: 0 };
    }

    this.snapshot.candidates += 1;
    const beforeEncode = this.fileIdentity(file);
    if (expectedIdentity && !sameIdentity(beforeEncode, expectedIdentity)) {
      throw new ImageSourceChangedError(file.path);
    }
    const source = await this.app.vault.readBinary(file);
    if (source.byteLength !== beforeEncode.size) {
      throw new ImageSourceChangedError(file.path);
    }
    const encoded = await this.encodeWebp(source, settings);
    this.assertSourceIdentity(file.path, beforeEncode);
    if (!encoded || encoded.data.byteLength >= source.byteLength * settings.minSavingsRatio) {
      this.snapshot.skipped += 1;
      return { status: "skipped", rewrittenNoteCount: 0, rewrittenTokenCount: 0 };
    }

    let created: TFile | null = null;
    const updates: ReferenceUpdate[] = [];
    const expectedReferences = this.resolvedNoteReferences(file.path);
    try {
      created = await this.app.vault.createBinary(newPath, encoded.data);
      const persisted = await this.app.vault.readBinary(created);
      if (!sameBytes(encoded.data, persisted)) {
        throw new Error(`WebP 写入后字节校验失败：${newPath}`);
      }
      this.assertSourceIdentity(file.path, beforeEncode);
      const changed = await this.rewriteReferences(file, newPath);
      updates.push(...changed);
      const rewrittenTokenCount = changed.reduce(
        (sum, update) => sum + (Number.isFinite(update.rewrittenTokens) ? update.rewrittenTokens : 0),
        0,
      );
      if (expectedReferences.length > 0 && (changed.length === 0 || rewrittenTokenCount === 0)) {
        throw new Error(
          `引用完整性门失败：采集前有 ${expectedReferences.length} 篇已解析引用，但没有实际改写任何笔记 token：${file.path}`,
        );
      }
      this.assertSourceIdentity(file.path, beforeEncode);
      try {
        await this.registerAssetDerivative(
          file.path,
          newPath,
          [...new Set(changed.map(update => update.file.path))],
        );
      } catch (error) {
        // Registry is an audit/index layer. Its outage must never undo the
        // valid WebP or the already repaired note references.
        const message = error instanceof Error ? error.message : String(error);
        this.snapshot.lastError = `Asset Registry 登记失败：${message}`;
        this.snapshot.registry = {
          ...this.snapshot.registry,
          available: false,
          checkedAt: Date.now(),
          lastError: message,
        };
        this.logBus.append(
          "error",
          "image.asset-registry",
          `图片已安全保留，但 Asset Registry 登记失败：${file.path} → ${newPath}；${message}`,
        );
      }
      this.snapshot.converted += 1;
      this.snapshot.bytesBefore += source.byteLength;
      this.snapshot.bytesAfter += encoded.data.byteLength;
      this.logBus.append(
        "success",
        "image.governance",
        `图片已压缩并更新引用：${file.path} → ${newPath} (${source.byteLength} → ${encoded.data.byteLength} B，${changed.length} 篇笔记 / ${rewrittenTokenCount} 个 token)；原图保留待 Asset Registry 云端验签`,
      );
      return {
        status: "converted",
        rewrittenNoteCount: changed.length,
        rewrittenTokenCount,
      };
    } catch (error) {
      let rollbackIncomplete = error instanceof ReferenceRewriteError && error.rollbackIncomplete;
      for (const update of [...updates].reverse()) {
        try {
          await this.app.vault.modify(update.file, update.before);
        } catch (rollbackError) {
          rollbackIncomplete = true;
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          this.logBus.append(
            "error",
            "image.governance",
            `图片引用回滚失败：${update.file.path}；${rollbackMessage}`,
          );
        }
      }
      if (created && created.path === newPath && created.path !== file.path) {
        if (rollbackIncomplete) {
          this.logBus.append(
            "error",
            "image.governance",
            `引用回滚不完整，已保留 WebP 防止形成断链：${newPath}`,
          );
        } else {
          try {
            await this.app.vault.trash(created, false);
          } catch {
            // If cleanup itself fails, surface the original conversion error.
          }
        }
      }
      if (rollbackIncomplete) {
        throw new ReferenceRewriteError(
          `图片引用回滚不完整；为避免断链已保留 WebP：${newPath}`,
          true,
        );
      }
      throw error;
    }
  }

  private fileIdentity(file: TFile): ImageFileIdentity {
    return { size: file.stat.size, mtime: file.stat.mtime };
  }

  private beginReconciliationPass(limit: number): void {
    this.reconciliationBudget = Math.max(0, Math.min(MAX_RECONCILIATIONS_PER_PASS, Math.floor(limit)));
    this.reconciliationSeen.clear();
  }

  private endReconciliationPass(): void {
    this.reconciliationBudget = 0;
    this.reconciliationSeen.clear();
  }

  private orderFilesForReconciliation(files: TFile[]): TFile[] {
    let ordered = [...files].sort((left, right) => left.path.localeCompare(right.path));
    if (this.reconciliationResumeAfter && ordered.length > 1) {
      const resumeIndex = ordered.findIndex(file => file.path === this.reconciliationResumeAfter);
      if (resumeIndex >= 0) ordered = [...ordered.slice(resumeIndex + 1), ...ordered.slice(0, resumeIndex + 1)];
    }
    if (this.reconciliationRetryPaths.size) {
      const retries = ordered.filter(file => this.reconciliationRetryPaths.has(file.path));
      const retrySet = new Set(retries.map(file => file.path));
      ordered = [...retries, ...ordered.filter(file => !retrySet.has(file.path))];
    }
    return ordered;
  }

  private async reconcileExistingDerivative(original: TFile, display: TFile): Promise<void> {
    const key = `${original.path}\u0000${display.path}`;
    if (this.reconciliationBudget <= 0 || this.reconciliationSeen.has(key)) return;
    this.reconciliationSeen.add(key);
    this.reconciliationBudget -= 1;
    this.reconciliationResumeAfter = original.path;
    this.reconciliationRetryPaths.delete(original.path);
    try {
      const enqueued = await this.registerAssetDerivative(
        original.path,
        display.path,
        this.resolvedNoteReferences(original.path, display.path),
      );
      if (!enqueued) {
        this.logBus.append(
          "warn",
          "image.cloud-store",
          `已有 WebP 已补登记，但云上传排队仍待重试：${original.path}`,
        );
        return;
      }
      this.logBus.append(
        "success",
        "image.asset-registry",
        `已有 WebP 已完成补登记与云上传排队：${original.path} → ${display.path}`,
      );
    } catch (error) {
      this.queueReconciliationRetry(original.path);
      const message = error instanceof Error ? error.message : String(error);
      this.snapshot.registry = {
        ...this.snapshot.registry,
        available: false,
        checkedAt: Date.now(),
        lastError: message,
      };
      this.logBus.append(
        "error",
        "image.asset-registry",
        `已有 WebP 补登记失败，下轮可重试：${original.path} → ${display.path}；${message}`,
      );
    }
  }

  private resolvedNoteReferences(...assetPaths: string[]): string[] {
    const references: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};
    for (const [notePath, links] of Object.entries(resolvedLinks)) {
      if (assetPaths.some(path => links[path] !== undefined)) references.push(notePath);
      if (references.length >= 2000) break;
    }
    return references;
  }

  private async registerAssetDerivative(
    originalPath: string,
    displayPath: string,
    noteRefs: string[],
  ): Promise<boolean> {
    if (!this.assetRegistry) return false;
    const original = await this.assetRegistry.discoverImageAsset(originalPath, noteRefs);
    if (!original.asset_id) throw new Error("discover 没有返回 asset_id");
    const derivative = await this.assetRegistry.registerImageDerivative(original.asset_id, displayPath);
    if (!derivative.asset_id || !derivative.status) {
      throw new Error("register-derivative 没有返回有效状态");
    }
    this.logBus.append(
      "success",
      "image.asset-registry",
      `图片资产已登记：${originalPath} → ${displayPath}（${derivative.status}，引用 ${original.note_ref_count}）`,
    );
    if (!this.assetRegistry.enqueueImageAssetUpload) {
      this.queueReconciliationRetry(originalPath);
      this.recordCloudFailure("asset.upload.enqueue", new Error("当前 Daemon 尚未提供图片上传排队接口"));
      return false;
    }
    try {
      const upload = await this.assetRegistry.enqueueImageAssetUpload(
        original.asset_id,
        originalPath,
        displayPath,
      );
      this.logBus.append(
        "success",
        "image.cloud-store",
        `图片已进入云上传队列：${originalPath}（${upload.status}${upload.reused ? "，复用既有任务" : ""}）`,
      );
      this.reconciliationRetryPaths.delete(originalPath);
      this.reconciliationRetryAttempts.delete(originalPath);
      return true;
    } catch (error) {
      // Cloud enqueue is downstream of a fully persisted WebP and repaired
      // Markdown references. Never throw it into the conversion rollback.
      this.queueReconciliationRetry(originalPath);
      this.recordCloudFailure("asset.upload.enqueue", error);
      return false;
    }
  }

  private recordCloudFailure(layer: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.snapshot.cloud = {
      ...this.snapshot.cloud,
      lastError: { layer, message },
    };
    this.logBus.append("error", "image.cloud-store", `图片云仓失败：${message}`);
  }

  private queueReconciliationRetry(originalPath: string): void {
    const attempts = (this.reconciliationRetryAttempts.get(originalPath) ?? 0) + 1;
    this.reconciliationRetryAttempts.set(originalPath, attempts);
    // Prioritise two immediate follow-up passes, then fall back to the rotating
    // cursor so one permanently broken pair cannot starve the rest of the Vault.
    if (attempts <= 2) this.reconciliationRetryPaths.add(originalPath);
    else this.reconciliationRetryPaths.delete(originalPath);
  }

  private assertSourceIdentity(path: string, expected: ImageFileIdentity): void {
    const current = this.app.vault.getAbstractFileByPath(path);
    if (!(current instanceof TFile) || !sameIdentity(this.fileIdentity(current), expected)) {
      throw new ImageSourceChangedError(path);
    }
  }

  private deferUntilStable(file: TFile): void {
    this.queue.set(file.path, {
      identity: this.fileIdentity(file),
      readyAt: Date.now() + Math.max(0, this.getSettings().debounceMs),
    });
    this.drainRequested = true;
    this.logBus.append("info", "image.governance", `图片仍在写入，已延后自动处理：${file.path}`);
  }

  private scheduleDrain(minimumDelayMs = 0): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.size) {
      this.drainRequested = false;
      return;
    }
    if (this.running) {
      this.drainRequested = true;
      return;
    }
    const nextReadyAt = Math.min(...[...this.queue.values()].map(item => item.readyAt));
    const delay = Math.max(0, minimumDelayMs, nextReadyAt - Date.now());
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.drainQueue();
    }, delay);
  }

  private async encodeWebp(source: ArrayBuffer, settings: ImageGovernanceSettings): Promise<EncodedImage | null> {
    const bitmap = await createImageBitmap(new Blob([source]));
    try {
      const scale = Math.min(1, settings.maxDimension / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, "image/webp", settings.quality);
      });
      if (!blob) return null;
      return { data: await blob.arrayBuffer(), mime: "image/webp", width, height };
    } finally {
      bitmap.close();
    }
  }

  private async rewriteReferences(oldFile: TFile, newPath: string): Promise<ReferenceUpdate[]> {
    const allNotes = this.app.vault.getMarkdownFiles();
    const oldPath = oldFile.path;
    const oldName = oldFile.name;
    const newName = newPath.split("/").pop() ?? newPath;
    const uniqueName = this.app.vault.getFiles()
      .filter(file => file.name === oldName).length === 1;
    const changed: ReferenceUpdate[] = [];

    for (const note of allNotes) {
      const before = await this.app.vault.read(note);
      const noteFolder = parentPath(note.path);
      const relativeOld = relativePath(noteFolder, oldPath);
      const relativeNew = relativePath(noteFolder, newPath);
      const resolved = this.app.metadataCache.resolvedLinks[note.path]?.[oldPath] !== undefined;
      const hasExactPath = before.includes(oldPath) || before.includes(encodeURI(oldPath));
      const hasRelativePath = before.includes(relativeOld) || before.includes(encodeURI(relativeOld));
      const hasWikiName = uniqueName && /!?\[\[[^\]]+\]\]/.test(before) && before.includes(oldName);
      if (!resolved && !hasExactPath && !hasRelativePath && !hasWikiName) continue;

      let after = before;
      let rewrittenTokens = 0;
      for (const [from, to] of [
        [oldPath, newPath],
        [encodeURI(oldPath), encodeURI(newPath)],
        [relativeOld, relativeNew],
        [encodeURI(relativeOld), encodeURI(relativeNew)],
      ] as Array<[string, string]>) {
        rewrittenTokens += from ? after.split(from).length - 1 : 0;
        after = replaceLiteral(after, from, to);
      }
      if (uniqueName) {
        const escapedName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wikiNamePattern = new RegExp(`(\\!?\\[\\[)${escapedName}(?=[|\\]])`, "g");
        after = after.replace(wikiNamePattern, (_whole, open) => {
          rewrittenTokens += 1;
          return `${open}${newName}`;
        });
      }
      // Obsidian often stores a shortest unique suffix rather than either a
      // Vault-root path or a path relative to the note, for example
      // ![[91_assets/example.png]].  resolvedLinks proves that this note
      // reaches oldPath, but it does not reveal which token did so. Resolve
      // every Wiki destination with Obsidian's own linker and only rewrite a
      // token whose destination is the exact source file. Aliases, headings
      // and block references are preserved.
      const resolveLink = this.app.metadataCache.getFirstLinkpathDest?.bind(this.app.metadataCache);
      if (resolved && resolveLink) {
        after = after.replace(/(!?\[\[)([^\]]+)(\]\])/g, (whole, open, inner, close) => {
          const aliasAt = inner.indexOf("|");
          const destination = aliasAt >= 0 ? inner.slice(0, aliasAt) : inner;
          const alias = aliasAt >= 0 ? inner.slice(aliasAt) : "";
          const subpathAt = destination.search(/[#^]/);
          const linkpath = subpathAt >= 0 ? destination.slice(0, subpathAt) : destination;
          const subpath = subpathAt >= 0 ? destination.slice(subpathAt) : "";
          let decodedLinkpath = linkpath;
          try {
            decodedLinkpath = decodeURI(linkpath);
          } catch {
            // Leave malformed escapes to Obsidian's resolver, which will
            // fail closed instead of broad string replacement.
          }
          const destinationFile = resolveLink(decodedLinkpath, note.path);
          if (!(destinationFile instanceof TFile) || destinationFile.path !== oldPath) return whole;
          rewrittenTokens += 1;
          const rewrittenLinkpath = /\.[^./\\]+$/.test(linkpath)
            ? linkpath.replace(/\.[^./\\]+$/, ".webp")
            : `${linkpath}.webp`;
          return `${open}${rewrittenLinkpath}${subpath}${alias}${close}`;
        });
        // Markdown image/link destinations may also use Obsidian's shortest
        // unique filename, e.g. ![preview](img-004.jpg), while the real file
        // lives in an assets/ child folder.  Resolve the destination through
        // Obsidian and rewrite only an exact identity match. Optional titles
        // and angle-bracket destinations are preserved.
        after = after.replace(
          /(!?\[[^\]\r\n]*\]\()(<[^>\r\n]+>|[^)\s]+)([^)\r\n]*\))/g,
          (whole, open, rawDestination, suffix) => {
            const angled = rawDestination.startsWith("<") && rawDestination.endsWith(">");
            const linkpath = angled ? rawDestination.slice(1, -1) : rawDestination;
            let decodedLinkpath = linkpath;
            try {
              decodedLinkpath = decodeURI(linkpath);
            } catch {
              // Malformed escapes fail closed through Obsidian's resolver.
            }
            const destinationFile = resolveLink(decodedLinkpath, note.path);
            if (!(destinationFile instanceof TFile) || destinationFile.path !== oldPath) return whole;
            rewrittenTokens += 1;
            const rewrittenLinkpath = /\.[^./\\]+$/.test(linkpath)
              ? linkpath.replace(/\.[^./\\]+$/, ".webp")
              : `${linkpath}.webp`;
            const rewrittenDestination = angled ? `<${rewrittenLinkpath}>` : rewrittenLinkpath;
            return `${open}${rewrittenDestination}${suffix}`;
          },
        );
      }
      if (after === before) continue;
      try {
        await this.app.vault.modify(note, after);
        changed.push({ file: note, before, rewrittenTokens });
      } catch (error) {
        let rollbackIncomplete = false;
        for (const update of [...changed].reverse()) {
          try {
            await this.app.vault.modify(update.file, update.before);
          } catch (rollbackError) {
            rollbackIncomplete = true;
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            this.logBus.append(
              "error",
              "image.governance",
              `图片引用回滚失败：${update.file.path}；${rollbackMessage}`,
            );
          }
        }
        if (rollbackIncomplete) {
          throw new ReferenceRewriteError(
            `写入 ${note.path} 失败且已有引用未能完整回滚`,
            true,
          );
        }
        throw error;
      }
    }
    return changed;
  }

  private recordFailure(error: unknown): void {
    this.snapshot.failures += 1;
    this.snapshot.lastError = error instanceof Error ? error.message : String(error);
    this.logBus.append("error", "image.governance", `图片治理失败：${this.snapshot.lastError}`);
  }

  private emit(): void {
    this.syncSettings();
    const current = this.getSnapshot();
    for (const listener of this.listeners) listener(current);
  }
}
