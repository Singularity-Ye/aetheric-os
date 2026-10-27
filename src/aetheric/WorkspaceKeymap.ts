import type { AethericModule } from "./types";

export type WorkspaceShortcutId =
  | "module.overview"
  | "module.navigation"
  | "module.schedule"
  | "module.inspiration"
  | "module.collection"
  | "module.tasks"
  | "module.intelligence"
  | "module.knowledge"
  | "module.logs"
  | "graph.map"
  | "graph.relation"
  | "graph.depth.workspace"
  | "graph.depth.section"
  | "graph.depth.folder"
  | "graph.depth.note"
  | "graph.depth.previous"
  | "graph.depth.next";

export type WorkspaceShortcutSettings = Record<WorkspaceShortcutId, string>;

export interface WorkspaceShortcutDefinition {
  id: WorkspaceShortcutId;
  group: "模块切换" | "目录地图";
  label: string;
  description: string;
}

/**
 * A left-hand 3 × 3 command grid for global module routing, plus unmodified keys for
 * the active graph surface.  Module shortcuts stay stable when the visual rail
 * is reordered, which is essential for muscle memory and template reuse.
 */
export const DEFAULT_WORKSPACE_SHORTCUTS: WorkspaceShortcutSettings = Object.freeze({
  "module.overview": "Alt+Q",
  "module.schedule": "Alt+W",
  "module.navigation": "Alt+E",
  "module.collection": "Alt+A",
  "module.tasks": "Alt+S",
  "module.intelligence": "Alt+D",
  "module.inspiration": "Alt+Z",
  "module.knowledge": "Alt+X",
  "module.logs": "Alt+C",
  "graph.map": "A",
  "graph.relation": "D",
  "graph.depth.workspace": "Q",
  "graph.depth.section": "W",
  "graph.depth.folder": "E",
  "graph.depth.note": "R",
  "graph.depth.previous": "[",
  "graph.depth.next": "]",
});

/**
 * Defaults shipped by the first configurable-keymap build. Settings migration
 * uses this snapshot once; runtime normalization deliberately does not, so a
 * user remains free to choose one of these bindings later.
 */
export const LEGACY_WORKSPACE_SHORTCUTS_V1: WorkspaceShortcutSettings = Object.freeze({
  "module.overview": "Ctrl+Alt+Q",
  "module.navigation": "Ctrl+Alt+W",
  "module.schedule": "Ctrl+Alt+E",
  "module.inspiration": "Ctrl+Alt+R",
  "module.collection": "Ctrl+Alt+A",
  "module.tasks": "Ctrl+Alt+S",
  "module.intelligence": "Ctrl+Alt+D",
  "module.knowledge": "Ctrl+Alt+F",
  "module.logs": "Ctrl+Alt+G",
  "graph.map": "A",
  "graph.relation": "D",
  "graph.depth.workspace": "Q",
  "graph.depth.section": "W",
  "graph.depth.folder": "E",
  "graph.depth.note": "R",
  "graph.depth.previous": "[",
  "graph.depth.next": "]",
});

/** Defaults from schema v5, before the workbench moved to one modifier. */
export const LEGACY_WORKSPACE_SHORTCUTS_V2: WorkspaceShortcutSettings = Object.freeze({
  "module.overview": "Ctrl+Alt+Q",
  "module.schedule": "Ctrl+Alt+W",
  "module.navigation": "Ctrl+Alt+E",
  "module.collection": "Ctrl+Alt+A",
  "module.tasks": "Ctrl+Alt+S",
  "module.intelligence": "Ctrl+Alt+D",
  "module.inspiration": "Ctrl+Alt+Z",
  "module.knowledge": "Ctrl+Alt+X",
  "module.logs": "Ctrl+Alt+C",
  "graph.map": "A",
  "graph.relation": "D",
  "graph.depth.workspace": "Q",
  "graph.depth.section": "W",
  "graph.depth.folder": "E",
  "graph.depth.note": "R",
  "graph.depth.previous": "[",
  "graph.depth.next": "]",
});

export function migrateLegacyWorkspaceShortcuts(
  raw?: Partial<WorkspaceShortcutSettings> | null,
): WorkspaceShortcutSettings {
  const migrated = normalizeWorkspaceShortcuts(raw);
  if (!raw) return migrated;
  for (const id of Object.keys(MODULE_SHORTCUT_IDS) as AethericModule[]) {
    const shortcutId = MODULE_SHORTCUT_IDS[id];
    if (
      raw[shortcutId] === LEGACY_WORKSPACE_SHORTCUTS_V1[shortcutId]
      || raw[shortcutId] === LEGACY_WORKSPACE_SHORTCUTS_V2[shortcutId]
    ) {
      migrated[shortcutId] = DEFAULT_WORKSPACE_SHORTCUTS[shortcutId];
    }
  }
  return migrated;
}

export const MODULE_SHORTCUT_IDS: Record<AethericModule, WorkspaceShortcutId> = Object.freeze({
  overview: "module.overview",
  navigation: "module.navigation",
  schedule: "module.schedule",
  inspiration: "module.inspiration",
  collection: "module.collection",
  tasks: "module.tasks",
  intelligence: "module.intelligence",
  knowledge: "module.knowledge",
  logs: "module.logs",
});

export const GRAPH_DEPTH_SHORTCUT_IDS = Object.freeze({
  0: "graph.depth.workspace",
  1: "graph.depth.section",
  2: "graph.depth.folder",
  3: "graph.depth.note",
} as const satisfies Record<0 | 1 | 2 | 3, WorkspaceShortcutId>);

export const WORKSPACE_SHORTCUT_DEFINITIONS: readonly WorkspaceShortcutDefinition[] = Object.freeze([
  { id: "module.overview", group: "模块切换", label: "总览", description: "全局切换到工作台总览" },
  { id: "module.schedule", group: "模块切换", label: "日程", description: "全局切换到日程时间轴" },
  { id: "module.navigation", group: "模块切换", label: "导航", description: "全局切换到目录与笔记导航" },
  { id: "module.collection", group: "模块切换", label: "采集", description: "全局切换到统一采集" },
  { id: "module.tasks", group: "模块切换", label: "任务", description: "全局切换到任务账本" },
  { id: "module.intelligence", group: "模块切换", label: "情报", description: "全局切换到情报站" },
  { id: "module.inspiration", group: "模块切换", label: "灵感", description: "全局切换到灵感轨" },
  { id: "module.knowledge", group: "模块切换", label: "图谱", description: "全局切换到目录地图" },
  { id: "module.logs", group: "模块切换", label: "日志", description: "全局切换到运行日志" },
  { id: "graph.map", group: "目录地图", label: "方块地图", description: "图谱模块内切回固定目录地块" },
  { id: "graph.relation", group: "目录地图", label: "关系探索", description: "图谱模块内切到多层关系视图" },
  { id: "graph.depth.workspace", group: "目录地图", label: "工作域深度", description: "悬停地块时，以该地块上下文切到工作域" },
  { id: "graph.depth.section", group: "目录地图", label: "分区深度", description: "悬停地块时，以该地块上下文切到分区" },
  { id: "graph.depth.folder", group: "目录地图", label: "子目录深度", description: "悬停地块时，以该地块上下文切到子目录" },
  { id: "graph.depth.note", group: "目录地图", label: "笔记深度", description: "悬停地块时，以该地块上下文切到笔记" },
  { id: "graph.depth.previous", group: "目录地图", label: "上一层", description: "不依赖悬停，逐层返回" },
  { id: "graph.depth.next", group: "目录地图", label: "下一层", description: "不依赖悬停，逐层深入" },
]);

export function normalizeWorkspaceShortcuts(raw?: Partial<WorkspaceShortcutSettings> | null): WorkspaceShortcutSettings {
  return { ...DEFAULT_WORKSPACE_SHORTCUTS, ...(raw ?? {}) };
}

export function shortcutEventKey(event: Pick<KeyboardEvent, "key">): string {
  if (event.key === " ") return "Space";
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

export function serializeShortcutEvent(event: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return null;
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.metaKey) modifiers.push("Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey && event.key !== "Shift") modifiers.push("Shift");
  return [...modifiers, shortcutEventKey(event)].join("+");
}

export function shortcutMatches(event: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key || shortcutEventKey(event) !== key) return false;
  const modifiers = new Set(parts);
  return event.ctrlKey === modifiers.has("Ctrl")
    && event.metaKey === modifiers.has("Meta")
    && event.altKey === modifiers.has("Alt")
    && event.shiftKey === modifiers.has("Shift");
}

export function formatShortcut(shortcut: string): string {
  return shortcut
    .replace(/ArrowLeft/g, "←")
    .replace(/ArrowRight/g, "→")
    .replace(/ArrowUp/g, "↑")
    .replace(/ArrowDown/g, "↓")
    .replace(/Space/g, "空格")
    .replace(/Meta/g, "⌘");
}

export function shortcutKeycap(shortcut: string): string {
  const key = shortcut.split("+").filter(Boolean).pop() ?? shortcut;
  return formatShortcut(key);
}
