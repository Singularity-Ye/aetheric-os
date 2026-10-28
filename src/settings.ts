import { App, PluginSettingTab, Setting } from "obsidian";
import ScriptoriumPlugin from "./main";
import {
  AethericShellState,
  AethericWorkspace,
  DEFAULT_SHELL_STATE,
  DEFAULT_WORKSPACES,
  normalizeModuleLayout,
} from "./aetheric/types";
import {
  DEFAULT_WORKSPACE_SHORTCUTS,
  migrateLegacyWorkspaceShortcuts,
  normalizeWorkspaceShortcuts,
  type WorkspaceShortcutSettings,
} from "./aetheric/WorkspaceKeymap";

export type { WorkspaceShortcutSettings } from "./aetheric/WorkspaceKeymap";

export interface ScheduleShortcutSettings {
  moveDayPrevious: string;
  moveDayNext: string;
  moveTimeEarlier: string;
  moveTimeLater: string;
  resizeShorter: string;
  resizeLonger: string;
  openDetails: string;
  toggleDone: string;
}

export interface ImageGovernanceSettings {
  /** Enable the watcher and expose the manual scan actions. */
  enabled: boolean;
  /** Compress newly created/modified images automatically. */
  autoCompress: boolean;
  /** Ignore tiny assets where the disk and render savings are negligible. */
  minBytes: number;
  /** WebP quality passed to the browser encoder. */
  quality: number;
  /** Downscale very large images before encoding. */
  maxDimension: number;
  /** Require at least this fraction of the original size to be saved. */
  minSavingsRatio: number;
  /** Coalesce bursts from screenshot/import tools. */
  debounceMs: number;
}

export interface PersistedImageGovernanceBatchItem {
  path: string;
  status: "converted" | "skipped" | "failed";
  beforeBytes: number;
  afterBytes?: number;
  rewrittenNoteCount?: number;
  rewrittenTokenCount?: number;
  error?: string;
}

export interface PersistedImageGovernanceBatch {
  manifestId: string;
  createdAt: number;
  finishedAt: number;
  paths: string[];
  totalBytes: number;
  converted: number;
  skipped: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
  results: PersistedImageGovernanceBatchItem[];
}

const IMAGE_GOVERNANCE_HISTORY_LIMIT = 20;
const IMAGE_GOVERNANCE_BATCH_LIMIT = 10;

function normalizeVaultRelativePath(value: unknown): string | null {
  const path = String(value ?? "").replace(/\\/g, "/").trim();
  if (!path || path.startsWith("/") || path.includes(":")
    || path.split("/").some(segment => !segment || segment === "." || segment === "..")) return null;
  return path;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
}

export function normalizeImageGovernanceHistory(value: unknown): PersistedImageGovernanceBatch[] {
  if (!Array.isArray(value)) return [];
  const normalized: PersistedImageGovernanceBatch[] = [];
  for (const raw of value.slice(0, IMAGE_GOVERNANCE_HISTORY_LIMIT)) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw as Record<string, unknown>;
    const manifestId = String(source.manifestId ?? "").trim().slice(0, 96);
    if (!manifestId) continue;
    const paths = Array.isArray(source.paths)
      ? source.paths.map(normalizeVaultRelativePath).filter((path): path is string => path !== null).slice(0, IMAGE_GOVERNANCE_BATCH_LIMIT)
      : [];
    const rawResults = Array.isArray(source.results) ? source.results : [];
    const results: PersistedImageGovernanceBatchItem[] = [];
    for (const rawResult of rawResults.slice(0, IMAGE_GOVERNANCE_BATCH_LIMIT)) {
      if (!rawResult || typeof rawResult !== "object") continue;
      const item = rawResult as Record<string, unknown>;
      const path = normalizeVaultRelativePath(item.path);
      const status = item.status;
      if (!path || (status !== "converted" && status !== "skipped" && status !== "failed")) continue;
      const afterBytes = item.afterBytes === undefined ? undefined : normalizeNonNegativeInteger(item.afterBytes);
      const rewrittenNoteCount = item.rewrittenNoteCount === undefined
        ? undefined
        : normalizeNonNegativeInteger(item.rewrittenNoteCount);
      const rewrittenTokenCount = item.rewrittenTokenCount === undefined
        ? undefined
        : normalizeNonNegativeInteger(item.rewrittenTokenCount);
      const error = item.error === undefined ? undefined : String(item.error).slice(0, 300);
      results.push({
        path,
        status,
        beforeBytes: normalizeNonNegativeInteger(item.beforeBytes),
        ...(afterBytes === undefined ? {} : { afterBytes }),
        ...(rewrittenNoteCount === undefined ? {} : { rewrittenNoteCount }),
        ...(rewrittenTokenCount === undefined ? {} : { rewrittenTokenCount }),
        ...(error ? { error } : {}),
      });
    }
    const converted = results.filter(item => item.status === "converted").length;
    const skipped = results.filter(item => item.status === "skipped").length;
    const failed = results.filter(item => item.status === "failed").length;
    normalized.push({
      manifestId,
      createdAt: normalizeNonNegativeInteger(source.createdAt),
      finishedAt: normalizeNonNegativeInteger(source.finishedAt),
      paths,
      totalBytes: normalizeNonNegativeInteger(source.totalBytes),
      converted,
      skipped,
      failed,
      bytesBefore: normalizeNonNegativeInteger(source.bytesBefore),
      bytesAfter: normalizeNonNegativeInteger(source.bytesAfter),
      results,
    });
  }
  return normalized;
}

export const DEFAULT_IMAGE_GOVERNANCE: ImageGovernanceSettings = {
  enabled: true,
  // Deliberately opt-in until Asset Registry/cloud attestation exists.
  autoCompress: false,
  minBytes: 192 * 1024,
  quality: 0.82,
  maxDimension: 2400,
  minSavingsRatio: 0.88,
  debounceMs: 2500,
};

export const DEFAULT_SCHEDULE_SHORTCUTS: ScheduleShortcutSettings = {
  moveDayPrevious: "ArrowLeft",
  moveDayNext: "ArrowRight",
  moveTimeEarlier: "ArrowUp",
  moveTimeLater: "ArrowDown",
  resizeShorter: "Shift+ArrowUp",
  resizeLonger: "Shift+ArrowDown",
  openDetails: "Enter",
  toggleDone: "Space",
};

export interface ScriptoriumSettings {
  schemaVersion: number;
  personalBlogPath: string;
  autoOpenShell: boolean;
  nativeUiHidden: boolean;
  hamasxiangDaemonToken: string;
  workspaces: AethericWorkspace[];
  shellState: AethericShellState;
  weatherCache?: { data: any; timestamp: number };
  hamasxiangSystemPath: string;
  daemonMode: "managed" | "external";
  stopDaemonOnUnload: boolean;
  hamasxiangWorkerToken: string;
  workspaceShortcuts: WorkspaceShortcutSettings;
  scheduleShortcuts: ScheduleShortcutSettings;
  imageGovernance: ImageGovernanceSettings;
  imageGovernanceHistory: PersistedImageGovernanceBatch[];
}

export const DEFAULT_SETTINGS: ScriptoriumSettings = {
  schemaVersion: 9,
  personalBlogPath: "d:\\Yhx06\\Documents\\仙术工坊——项目集\\个人博客网站-松果阁\\personal-blog",
  autoOpenShell: true,
  nativeUiHidden: true,
  hamasxiangDaemonToken: "",
  workspaces: DEFAULT_WORKSPACES,
  shellState: DEFAULT_SHELL_STATE,
  weatherCache: undefined,
  hamasxiangSystemPath: "d:\\Yhx06\\Documents\\仙术工坊——项目集\\hamaxiang-system",
  daemonMode: "managed",
  stopDaemonOnUnload: false,
  hamasxiangWorkerToken: "",
  workspaceShortcuts: DEFAULT_WORKSPACE_SHORTCUTS,
  scheduleShortcuts: DEFAULT_SCHEDULE_SHORTCUTS,
  imageGovernance: DEFAULT_IMAGE_GOVERNANCE,
  imageGovernanceHistory: [],
};

export function mergeSettings(raw: Partial<ScriptoriumSettings> | null | undefined): ScriptoriumSettings {
  const rawShell = raw?.shellState as Partial<AethericShellState> | undefined;
  const shellState = {
    ...structuredClone(DEFAULT_SHELL_STATE),
    ...rawShell,
    selectedWorkspaceId: rawShell?.selectedWorkspaceId === "erliu-novelist" ? "hamaxiang" : (rawShell?.selectedWorkspaceId ?? DEFAULT_SHELL_STATE.selectedWorkspaceId),
    moduleLayout: normalizeModuleLayout(raw?.shellState?.moduleLayout),
    logDock: {
      ...structuredClone(DEFAULT_SHELL_STATE.logDock),
      ...(raw?.shellState?.logDock ?? {}),
    },
  };
  // v2 changes the log dock from a permanently open panel to an opt-in drawer.
  if (!raw?.schemaVersion || raw.schemaVersion < 2) shellState.logDock.open = false;
  const imageGovernance = {
    ...DEFAULT_IMAGE_GOVERNANCE,
    ...(raw?.imageGovernance ?? {}),
  };
  // v7 makes automatic mutation explicitly opt-in. A pre-v7 persisted
  // `true` came from the former unsafe default, so it must not survive the
  // migration as apparent user consent.
  if (!raw?.schemaVersion || raw.schemaVersion < 7) imageGovernance.autoCompress = false;
  // v9 migrates default workspaces and ensures favoriteFolderPaths are populated
  if (!raw?.schemaVersion || raw.schemaVersion < 9) {
    if (!shellState.favoriteFolderPaths || shellState.favoriteFolderPaths.length === 0) {
      shellState.favoriteFolderPaths = [...(DEFAULT_SHELL_STATE.favoriteFolderPaths ?? [])];
    }
    if (!shellState.expandedFolderPaths || shellState.expandedFolderPaths.length === 0) {
      shellState.expandedFolderPaths = [...(DEFAULT_SHELL_STATE.expandedFolderPaths ?? [])];
    }
  }
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...(raw ?? {}),
    workspaces: (() => {
      const list = [...(raw?.workspaces ?? [])].filter(ws => ws.id !== "erliu-novelist");
      for (const defaultWs of DEFAULT_WORKSPACES) {
        const idx = list.findIndex(ws => ws.id === defaultWs.id);
        if (idx >= 0) {
          list[idx] = structuredClone(defaultWs);
        } else {
          list.push(structuredClone(defaultWs));
        }
      }
      return list.length ? list : structuredClone(DEFAULT_WORKSPACES);
    })(),
    shellState,
    scheduleShortcuts: {
      ...DEFAULT_SCHEDULE_SHORTCUTS,
      ...(raw?.scheduleShortcuts ?? {}),
    },
    workspaceShortcuts: raw?.schemaVersion && raw.schemaVersion >= 6
      ? normalizeWorkspaceShortcuts(raw?.workspaceShortcuts)
      : migrateLegacyWorkspaceShortcuts(raw?.workspaceShortcuts),
    imageGovernance,
    imageGovernanceHistory: normalizeImageGovernanceHistory(raw?.imageGovernanceHistory),
    schemaVersion: 8,
  };
}

export class ScriptoriumSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ScriptoriumPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "松果天工台 · Aetheric OS 设置" });

    new Setting(containerEl)
      .setName("启动后自动打开 Aetheric OS")
      .setDesc("Obsidian 布局就绪后打开唯一的常驻 Shell。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoOpenShell)
        .onChange(async value => {
          this.plugin.settings.autoOpenShell = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("默认隐藏原生 Ribbon 与左右侧栏")
      .setDesc("只隐藏外观，不禁用 Obsidian 内核能力。命令面板始终保留安全恢复命令。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.nativeUiHidden)
        .onChange(async value => {
          this.plugin.settings.nativeUiHidden = value;
          this.plugin.nativeUi.apply(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("蛤蟆祥 Daemon Token")
      .setDesc("仅保存在本机 Obsidian 插件 data.json 中，用于 X Watch 等写操作；不要提交到代码仓库。")
      .addText(text => {
        text.inputEl.type = "password";
        const hasToken = !!this.plugin.settings.hamasxiangDaemonToken;
        text.setPlaceholder(hasToken ? "•••••••• (已配置，隐藏)" : "与 hamaxiang-system/.env 保持一致");
        text.setValue("");
        text.onChange(async value => {
          const val = value.trim();
          if (val) {
            this.plugin.settings.hamasxiangDaemonToken = val;
            this.plugin.hamasxiangAdapter.setAuthToken(val);
            await this.plugin.saveSettings();
            text.setPlaceholder("•••••••• (已配置，隐藏)");
            text.setValue("");
          }
        });
      });

    new Setting(containerEl)
      .setName("蛤蟆祥 Cloudflare Worker Token")
      .setDesc("仅保存在本地，用于远端 Worker (如去重锁 /toggle-dedup) 的鉴权凭证。")
      .addText(text => {
        text.inputEl.type = "password";
        const hasToken = !!this.plugin.settings.hamasxiangWorkerToken;
        text.setPlaceholder(hasToken ? "•••••••• (已配置，隐藏)" : "与 Cloudflare Worker 密钥一致");
        text.setValue("");
        text.onChange(async value => {
          const val = value.trim();
          if (val) {
            this.plugin.settings.hamasxiangWorkerToken = val;
            await this.plugin.saveSettings();
            text.setPlaceholder("•••••••• (已配置，隐藏)");
            text.setValue("");
          }
        });
      });

    new Setting(containerEl)
      .setName("个人博客网站路径")
      .setDesc("松果屋博客本地工程目录，运行博客构建与预览命令时使用。")
      .addText(text => text
        .setPlaceholder("D:\\...\\personal-blog")
        .setValue(this.plugin.settings.personalBlogPath)
        .onChange(async value => {
          this.plugin.settings.personalBlogPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("蛤蟆祥 System 路径")
      .setDesc("本地 hamaxiang-system 文件夹的绝对路径，用于加载和管理 .env 配置文件。")
      .addText(text => text
        .setPlaceholder("D:\\...\\hamaxiang-system")
        .setValue(this.plugin.settings.hamasxiangSystemPath)
        .onChange(async value => {
          this.plugin.settings.hamasxiangSystemPath = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("蛤蟆祥 Daemon 启动模式")
      .setDesc("托管模式下由天工台自动守护拉起，外部常驻模式下仅连网检测状态。")
      .addDropdown(dropdown => dropdown
        .addOption("managed", "天工台托管")
        .addOption("external", "外部常驻")
        .setValue(this.plugin.settings.daemonMode)
        .onChange(async value => {
          this.plugin.settings.daemonMode = value as "managed" | "external";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("卸载插件时终止托管守护")
      .setDesc("天工台卸载/重载时是否自动杀掉 Python 进程，默认关闭防止截断后台采集。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.stopDaemonOnUnload)
        .onChange(async value => {
          this.plugin.settings.stopDaemonOnUnload = value;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl("h3", { text: "图片治理 · 自动压缩与引用修复" });
    new Setting(containerEl)
      .setName("启用图片治理器")
      .setDesc("监听新图片并提供工作台扫描入口；只处理超过阈值的 PNG/JPEG，输出 WebP。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.imageGovernance.enabled)
        .onChange(async value => {
          this.plugin.settings.imageGovernance.enabled = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("新图片自动压缩")
      .setDesc("默认关闭。开启后仅在图片稳定且写入校验通过时生成 WebP、更新引用；原图继续保留，等待 Asset Registry 云端验签，当前绝不自动删除或移入回收站。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.imageGovernance.autoCompress)
        .onChange(async value => {
          this.plugin.settings.imageGovernance.autoCompress = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("最小图片大小")
      .setDesc("小于该大小的图片不处理，默认 192 KB；自动治理仍需单独开启。")
      .addText(text => text
        .setValue(String(Math.round(this.plugin.settings.imageGovernance.minBytes / 1024)))
        .onChange(async (value: string) => {
          const kb = Number(value);
          if (!Number.isFinite(kb) || kb < 1) return;
          this.plugin.settings.imageGovernance.minBytes = Math.round(kb * 1024);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("立即恢复 Obsidian 原生界面")
      .setDesc("移除 Aetheric 原生 UI 覆盖 class，作为故障灭火器。")
      .addButton(button => button
        .setButtonText("安全恢复")
        .onClick(() => void this.plugin.restoreNativeUi()));
  }
}
