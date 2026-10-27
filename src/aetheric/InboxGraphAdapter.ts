import type { AethericWorkspace, GraphData, IndexedFile, KnowledgeNodeViewModel } from "./types";
import { capturePlatformId } from "./CaptureUrlUtils";
import { isGraphVisiblePath, normalizeGraphPath } from "./GraphVisibilityPolicy";

function normalizeVaultPath(value: string): string {
  return normalizeGraphPath(value);
}

/** The semantic facets exposed by the first inbox-map lens. */
export type InboxFacetKind = "area" | "platform" | "status" | "period" | "folder";

export interface InboxGraphFilters {
  area?: string;
  platform?: string;
  status?: string;
  period?: string;
  /** A temporary focus on one title/source cluster in the template map. */
  cluster?: string;
  showFolders?: boolean;
  /** Include daemon/scheduled captures (off by default to keep the map useful). */
  includePassive?: boolean;
  /** Keep the first lens readable; note cards are expanded only on demand. */
  detail?: "overview" | "focus";
  limit?: number;
}

export interface InboxGraphNote {
  path: string;
  title: string;
  mtime: number;
  area: string;
  platform: string;
  status: string;
  period: string;
  folder: string;
  /** Whether the capture was user-directed or a background signal. */
  captureMode: "active" | "passive" | "unknown";
  captureModeEvidence: "frontmatter" | "path" | "inferred";
  /** Stable, normalized key used only by the read-only template projection. */
  clusterKey: string;
  evidence: Partial<Record<InboxFacetKind, "frontmatter" | "path" | "inferred">>;
}

export interface InboxGraphNode {
  id: string;
  label: string;
  kind: "note" | InboxFacetKind;
  count: number;
  path?: string;
  note?: InboxGraphNote;
}

export interface InboxGraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
  facetKind: InboxFacetKind;
  evidence: "frontmatter" | "path" | "inferred";
  confidence: "explicit" | "inferred";
  weight: number;
}

export interface InboxGraphData {
  nodes: InboxGraphNode[];
  edges: InboxGraphEdge[];
  notes: InboxGraphNote[];
  totalCount: number;
  filteredCount: number;
  truncated: boolean;
}

/**
 * The inbox map uses the same three-level vocabulary as the novelist graph:
 * an area entry, a source lane, optional repeated-title cluster, and note
 * cards.  Status/period/folder remain filters or metadata instead of graph
 * nodes so they cannot create a hairball around every note.
 */
export type InboxTemplateNodeKind = "area" | "platform" | "cluster" | "note";

export interface InboxTemplateGraphNode {
  id: string;
  label: string;
  kind: InboxTemplateNodeKind;
  count: number;
  path?: string;
  note?: InboxGraphNote;
  memberPaths?: string[];
  area?: string;
  platform?: string;
  folder?: string;
  clusterKey?: string;
  /** Source grouping key, retained for deterministic layout and inspection. */
  groupKey?: string;
  /** Presentation-only aggregate used when a dense layer exceeds its readable tile budget. */
  presentation?: "overflow";
}

export type InboxTemplateEdgeKind = "area" | "platform" | "cluster";

export interface InboxTemplateGraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: "classified_as_area" | "captured_from_platform" | "topic_cluster" | "contains_note" | "related_notes";
  facetKind: InboxTemplateEdgeKind;
  evidence: "frontmatter" | "path" | "inferred";
  confidence: "explicit" | "inferred";
  weight: number;
}

export interface InboxTemplateGraphData {
  nodes: InboxTemplateGraphNode[];
  edges: InboxTemplateGraphEdge[];
  notes: InboxGraphNote[];
  totalCount: number;
  filteredCount: number;
  truncated: boolean;
  /** Number of raw notes before the passive-capture lens is applied. */
  rawCount: number;
  /** Background captures hidden by the default active lens. */
  passiveExcludedCount: number;
  areaCount: number;
  sourceCount: number;
  clusterCount: number;
  /** The current map lens; overview intentionally omits individual note labels. */
  detail: "overview" | "focus";
  /** Directory-map depth: 0=workspace, 1=section, 2=subdirectory, 3=notes. */
  depth?: WorkspaceGraphDepth;
  /** Number of notes represented by the current lens, including hidden cards. */
  noteCount: number;
  /** Notes matching filters but outside the explicit adapter limit. */
  hiddenNoteCount: number;
}

export type WorkspaceGraphDepth = 0 | 1 | 2 | 3;

export interface InboxFacetOptions {
  area: string[];
  platform: string[];
  status: string[];
  period: string[];
}

const PLATFORM_BY_FOLDER: Record<string, string> = {
  "B站": "bilibili",
  "抖音": "douyin",
  "小红书": "xiaohongshu",
  "X情报": "x",
  "推特": "x",
  "微信想法": "weixin",
  GitHub: "github",
  YouTube: "youtube",
  "大众点评": "dianping",
};

const DISPLAY_PLATFORM: Record<string, string> = {
  bilibili: "B站",
  douyin: "抖音",
  xiaohongshu: "小红书",
  x: "X / 推特",
  weixin: "微信想法",
  github: "GitHub",
  dianping: "大众点评",
  youtube: "YouTube",
  manual: "手动采集",
  other: "其他网页",
};

function frontmatterString(file: KnowledgeNodeViewModel, key: string): string {
  const value = file.frontmatter[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function firstFolderUnderInbox(path: string): string {
  const marker = "00_松果池（收件箱）/";
  if (!path.startsWith(marker)) return "";
  return path.slice(marker.length).split("/").filter(Boolean)[0] ?? "";
}

function derivePlatform(file: KnowledgeNodeViewModel): { value: string; evidence: "frontmatter" | "path" | "inferred" } {
  const sourceUrl = frontmatterString(file, "source_url") || frontmatterString(file, "sourceUrl") || frontmatterString(file, "canonical_url");
  const urlPlatform = capturePlatformId(sourceUrl);
  if (urlPlatform !== "generic") return { value: urlPlatform, evidence: "frontmatter" };
  const explicit = frontmatterString(file, "source_platform") || frontmatterString(file, "sourcePlatform");
  if (explicit) return { value: explicit.toLowerCase(), evidence: "frontmatter" };
  const folder = firstFolderUnderInbox(file.path);
  if (folder && PLATFORM_BY_FOLDER[folder]) return { value: PLATFORM_BY_FOLDER[folder], evidence: "path" };
  return { value: "other", evidence: "inferred" };
}

function deriveArea(file: KnowledgeNodeViewModel, platform: string): { value: string; evidence: "frontmatter" | "path" | "inferred" } {
  if (platform === "x") return { value: "radar", evidence: "frontmatter" };
  const explicit = frontmatterString(file, "area");
  if (explicit) return { value: explicit, evidence: "frontmatter" };
  return { value: "待分区", evidence: "inferred" };
}

function deriveStatus(file: KnowledgeNodeViewModel): { value: string; evidence: "frontmatter" | "path" | "inferred" } {
  const explicit = frontmatterString(file, "status");
  if (explicit) return { value: explicit, evidence: "frontmatter" };
  return { value: "captured", evidence: "inferred" };
}

function derivePeriod(file: KnowledgeNodeViewModel): { value: string; evidence: "frontmatter" | "path" | "inferred" } {
  const raw = frontmatterString(file, "captured_at") || frontmatterString(file, "created_at") || frontmatterString(file, "date");
  const timestamp = raw ? Date.parse(raw) : file.mtime;
  const date = new Date(Number.isFinite(timestamp) ? timestamp : file.mtime);
  const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return { value, evidence: raw ? "frontmatter" : "inferred" };
}

function deriveFolder(file: KnowledgeNodeViewModel): string {
  const parent = file.parentPath || file.path.split("/").slice(0, -1).join("/");
  return normalizeVaultPath(parent || "00_松果池（收件箱）");
}

function deriveCaptureMode(
  file: KnowledgeNodeViewModel,
  platform: string,
): { value: InboxGraphNote["captureMode"]; evidence: InboxGraphNote["captureModeEvidence"] } {
  const explicitMode = frontmatterString(file, "capture_mode") || frontmatterString(file, "captureMode") || frontmatterString(file, "collection_mode");
  if (/^(active|manual|user|主动|用户)$/iu.test(explicitMode)) return { value: "active", evidence: "frontmatter" };
  if (/^(passive|scheduled|watch|daemon|定时|后台)$/iu.test(explicitMode)) return { value: "passive", evidence: "frontmatter" };

  const channel = frontmatterString(file, "inbox_channel") || frontmatterString(file, "source_channel");
  if (/x_watch|watch|scheduled|daemon|定时|云端监测/iu.test(channel)) return { value: "passive", evidence: "frontmatter" };
  if (/weixin_hermes|weixin-capture|local_capture|bookmarklet|manual|主动/iu.test(channel)) return { value: "active", evidence: "frontmatter" };

  // An explicit capture request is the durable marker for a link the user sent.
  if (frontmatterString(file, "capture_request_id") || frontmatterString(file, "capture_id")) {
    return { value: "active", evidence: "frontmatter" };
  }

  const source = frontmatterString(file, "source");
  if (/x-watch|cloud-x-watch|daemon|scheduled|定时|云端监测/iu.test(source)) return { value: "passive", evidence: "frontmatter" };
  if (platform === "x" && /(^|\/)(X情报)(\/|$)/u.test(file.path)) {
    // Keep legacy X Watch files out of the active lens even if their old
    // frontmatter predates inbox_channel. This is an inferred, not factual,
    // classification and is visible in the graph detail.
    return { value: "passive", evidence: "path" };
  }
  return { value: "unknown", evidence: "inferred" };
}

function normalizeClusterTitle(title: string): string {
  const normalized = title
    .trim()
    .toLocaleLowerCase()
    .replace(/^[@＠][^\s·:：|｜-]+[\s·:：|｜-]*/u, "")
    .replace(/[「」『』“”"']/g, "")
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[|｜]+/g, "|")
    .trim();
  return normalized.length >= 3 ? normalized : `path:${title}`;
}

function noteId(path: string): string {
  return `note:${normalizeVaultPath(path)}`;
}

function facetId(kind: InboxFacetKind, value: string): string {
  return `facet:${kind}:${encodeURIComponent(value)}`;
}

function relationType(kind: InboxFacetKind): string {
  switch (kind) {
    case "area": return "classified_as_area";
    case "platform": return "captured_from_platform";
    case "status": return "has_status";
    case "period": return "captured_in_period";
    case "folder": return "belongs_to_folder";
  }
}

function asNote(file: KnowledgeNodeViewModel): InboxGraphNote {
  const platform = derivePlatform(file);
  const area = deriveArea(file, platform.value);
  const status = deriveStatus(file);
  const period = derivePeriod(file);
  const captureMode = deriveCaptureMode(file, platform.value);
  return {
    path: normalizeVaultPath(file.path),
    title: file.title || file.basename,
    mtime: file.mtime,
    area: area.value,
    platform: platform.value,
    status: status.value,
    period: period.value,
    folder: deriveFolder(file),
    captureMode: captureMode.value,
    captureModeEvidence: captureMode.evidence,
    clusterKey: normalizeClusterTitle(file.title || file.basename),
    evidence: {
      area: area.evidence,
      platform: platform.evidence,
      status: status.evidence,
      period: period.evidence,
      folder: "path",
    },
  };
}

function templateAreaId(value: string): string {
  return `template:area:${encodeURIComponent(value)}`;
}

function templateSourceId(groupKey: string): string {
  return `template:source:${encodeURIComponent(groupKey)}`;
}

function templateClusterId(groupKey: string, clusterKey: string): string {
  return `template:cluster:${encodeURIComponent(`${groupKey}\u0000${clusterKey}`)}`;
}

function evidenceFor(notes: readonly InboxGraphNote[], facet: "area" | "platform"): "frontmatter" | "path" | "inferred" {
  if (notes.some(note => note.evidence[facet] === "frontmatter")) return "frontmatter";
  if (notes.some(note => note.evidence[facet] === "path")) return "path";
  return "inferred";
}

function confidenceFor(evidence: "frontmatter" | "path" | "inferred"): "explicit" | "inferred" {
  return evidence === "inferred" ? "inferred" : "explicit";
}

/**
 * Build the production inbox projection used by the AOS map.
 *
 * Unlike the legacy facet graph, this never connects every note to area,
 * platform, status, period and folder at once.  Notes enter a small lane:
 * `area -> source -> (optional repeated-title cluster) -> note`.  The
 * resulting edges stay meaningful and bounded while the original paths remain
 * available on each note/cluster for navigation.
 */
export function buildInboxTemplateGraph(
  files: readonly KnowledgeNodeViewModel[],
  filters: InboxGraphFilters = {},
): InboxTemplateGraphData {
  // Keep the adapter's programmatic default backwards-compatible for callers
  // outside the Shell; the Shell explicitly opts into the readable overview
  // lens through its persisted filter state.
  const detail = filters.detail ?? "focus";
  const allNotes = files
    .filter(file => file.extension.toLowerCase() === "md")
    .filter(file => isGraphVisiblePath(file.path))
    .filter(file => !file.path.includes("/00_残卷回收站/"))
    .map(asNote)
    .sort((a, b) => b.mtime - a.mtime);
  const passiveExcludedCount = filters.includePassive ? 0 : allNotes.filter(note => note.captureMode === "passive").length;
  const notes = filters.includePassive ? allNotes : allNotes.filter(note => note.captureMode !== "passive");
  const filtered = notes.filter(note =>
    (!filters.area || note.area === filters.area)
    && (!filters.platform || note.platform === filters.platform)
    && (!filters.status || note.status === filters.status)
    && (!filters.period || note.period === filters.period)
    && (!filters.cluster || note.clusterKey === filters.cluster)
  );
  const limit = Math.max(1, Math.min(120, Math.floor(filters.limit ?? 48)));
  const visible = filtered.slice(0, limit);
  const nodes: InboxTemplateGraphNode[] = [];
  const edges: InboxTemplateGraphEdge[] = [];
  const areaGroups = new Map<string, InboxGraphNote[]>();
  const sourceGroups = new Map<string, { area: string; platform: string; folder?: string; notes: InboxGraphNote[] }>();

  for (const note of visible) {
    const areaNotes = areaGroups.get(note.area) ?? [];
    areaNotes.push(note);
    areaGroups.set(note.area, areaNotes);
    const folderPart = filters.showFolders ? note.folder : "";
    const groupKey = `${note.area}\u0000${note.platform}\u0000${folderPart}`;
    const sourceGroup = sourceGroups.get(groupKey) ?? {
      area: note.area,
      platform: note.platform,
      ...(folderPart ? { folder: folderPart } : {}),
      notes: [],
    };
    sourceGroup.notes.push(note);
    sourceGroups.set(groupKey, sourceGroup);
  }

  const sortedAreas = [...areaGroups.entries()].sort(([, a], [, b]) => b.length - a.length);
  for (const [area, areaNotes] of sortedAreas) {
    nodes.push({ id: templateAreaId(area), label: area, kind: "area", count: areaNotes.length, area, memberPaths: areaNotes.map(note => note.path) });
  }

  const sortedSources = [...sourceGroups.entries()].sort(([, a], [, b]) => {
    const countDelta = b.notes.length - a.notes.length;
    return countDelta || a.platform.localeCompare(b.platform, "zh-CN");
  });
  for (const [groupKey, sourceGroup] of sortedSources) {
    const sourceId = templateSourceId(groupKey);
    const sourceLabel = filters.showFolders && sourceGroup.folder
      ? `${displayInboxPlatform(sourceGroup.platform)} · ${sourceGroup.folder.split("/").filter(Boolean).pop() ?? "目录"}`
      : displayInboxPlatform(sourceGroup.platform);
    nodes.push({
      id: sourceId,
      label: sourceLabel,
      kind: "platform",
      count: sourceGroup.notes.length,
      area: sourceGroup.area,
      platform: sourceGroup.platform,
      ...(sourceGroup.folder ? { folder: sourceGroup.folder } : {}),
      groupKey,
      memberPaths: sourceGroup.notes.map(note => note.path),
    });
    const areaId = templateAreaId(sourceGroup.area);
    const areaEvidence = evidenceFor(sourceGroup.notes, "area");
    edges.push({
      id: `${areaId}->${sourceId}`,
      source: areaId,
      target: sourceId,
      relationType: "classified_as_area",
      facetKind: "area",
      evidence: areaEvidence,
      confidence: confidenceFor(areaEvidence),
      weight: sourceGroup.notes.length,
    });

    const titleGroups = new Map<string, InboxGraphNote[]>();
    for (const note of sourceGroup.notes) {
      const grouped = titleGroups.get(note.clusterKey) ?? [];
      grouped.push(note);
      titleGroups.set(note.clusterKey, grouped);
    }
    const sortedTitleGroups = [...titleGroups.entries()].sort(([, a], [, b]) => b.length - a.length || b[0]!.mtime - a[0]!.mtime);
    for (const [clusterKey, clusterNotes] of sortedTitleGroups) {
      if (clusterNotes.length < 2) {
        const note = clusterNotes[0]!;
        // Overview is an index, not a note wall. The source node already
        // carries the count; only the focus lens draws a direct note edge.
        if (detail === "overview") continue;
        const noteIdValue = noteId(note.path);
        const evidence = note.evidence.platform ?? "inferred";
        edges.push({
          id: `${sourceId}->${noteIdValue}`,
          source: sourceId,
          target: noteIdValue,
          relationType: "captured_from_platform",
          facetKind: "platform",
          evidence,
          confidence: confidenceFor(evidence),
          weight: 1,
        });
        continue;
      }
      const clusterId = templateClusterId(groupKey, clusterKey);
      const representative = clusterNotes[0]!;
      nodes.push({
        id: clusterId,
        label: representative.title,
        kind: "cluster",
        count: clusterNotes.length,
        area: sourceGroup.area,
        platform: sourceGroup.platform,
        ...(sourceGroup.folder ? { folder: sourceGroup.folder } : {}),
        clusterKey,
        groupKey,
        memberPaths: clusterNotes.map(note => note.path),
      });
      edges.push({
        id: `${sourceId}->${clusterId}`,
        source: sourceId,
        target: clusterId,
        relationType: "topic_cluster",
        facetKind: "cluster",
        evidence: "inferred",
        confidence: "inferred",
        weight: clusterNotes.length,
      });
      for (const note of clusterNotes) {
        if (detail === "overview") continue;
        const noteIdValue = noteId(note.path);
        edges.push({
          id: `${clusterId}->${noteIdValue}`,
          source: clusterId,
          target: noteIdValue,
          relationType: "contains_note",
          facetKind: "cluster",
          evidence: note.evidence.platform ?? "inferred",
          confidence: confidenceFor(note.evidence.platform ?? "inferred"),
          weight: 1,
        });
      }
    }
  }

  if (detail === "focus") {
    for (const note of visible) {
      nodes.push({ id: noteId(note.path), label: note.title, kind: "note", count: 1, path: note.path, note, area: note.area, platform: note.platform, clusterKey: note.clusterKey });
    }
  }

  return {
    nodes,
    edges,
    notes: visible,
    totalCount: notes.length,
    filteredCount: filtered.length,
    truncated: filtered.length > visible.length,
    rawCount: allNotes.length,
    passiveExcludedCount,
    areaCount: areaGroups.size,
    sourceCount: sourceGroups.size,
    clusterCount: nodes.filter(node => node.kind === "cluster").length,
    detail,
    noteCount: visible.length,
    hiddenNoteCount: Math.max(0, filtered.length - visible.length),
  };
}

/**
 * Convert a regular Vault graph into the same semantic map contract used by
 * the inbox lens. The native graph is still available as an explicit
 * comparison view, but the workbench default now starts with meaningful
 * project/folder entrances instead of painting every Markdown title.
 */
export interface WorkspaceSemanticGraphOptions {
  detail?: "overview" | "focus";
  /** Top-level group, optionally followed by `\u0000` + subdirectory. */
  focusGroup?: string;
  limit?: number;
  /** Progressive disclosure depth for the Folded Atlas rail. */
  depth?: WorkspaceGraphDepth;
}

function isWorkspaceNoisePath(path: string): boolean {
  return !isGraphVisiblePath(path);
}

function workspaceRelativeSegments(path: string, workspace: AethericWorkspace | null): string[] {
  const normalized = normalizeVaultPath(path);
  const roots = (workspace?.rootPaths ?? []).map(normalizeVaultPath).sort((a, b) => b.length - a.length);
  const root = roots.find(candidate => normalized === candidate || normalized.startsWith(`${candidate}/`));
  const relative = root ? normalized.slice(root.length).replace(/^\//, "") : normalized;
  return relative.split("/").filter(Boolean);
}

function workspaceNote(node: { path: string; title: string }, file?: IndexedFile): InboxGraphNote {
  const path = normalizeVaultPath(node.path);
  const frontmatter = file?.frontmatter ?? {};
  const readString = (key: string): string => {
    const value = frontmatter[key];
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  };
  const rawDate = readString("captured_at") || readString("created_at") || readString("date");
  const timestamp = rawDate ? Date.parse(rawDate) : (file?.mtime ?? Date.now());
  const date = new Date(Number.isFinite(timestamp) ? timestamp : (file?.mtime ?? Date.now()));
  const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  const status = readString("status") || "captured";
  const folder = normalizeVaultPath(path.split("/").slice(0, -1).join("/") || "根目录");
  return {
    path,
    title: node.title || file?.basename || path.split("/").pop() || path,
    mtime: file?.mtime ?? timestamp,
    area: readString("area") || "工作域",
    platform: readString("source_platform") || readString("sourcePlatform") || "manual",
    status,
    period,
    folder,
    captureMode: "unknown",
    captureModeEvidence: "inferred",
    clusterKey: normalizeClusterTitle(node.title || path),
    evidence: { folder: "path", period: rawDate ? "frontmatter" : "inferred" },
  };
}

/**
 * Convert a budgeted raw Vault relation graph into the packaged graph runtime
 * contract without adding directory/facet nodes. Unlike the semantic atlas,
 * every node here represents a real note and every edge represents a real
 * resolved link inside the current budget.
 */
export function buildWorkspaceRelationGraph(
  data: GraphData,
  fileLookup?: (path: string) => IndexedFile | undefined,
): InboxTemplateGraphData {
  const visible = data.nodes
    .filter(node => !isWorkspaceNoisePath(node.path))
    .map(node => workspaceNote(node, fileLookup?.(node.path)));
  const visiblePaths = new Set(visible.map(note => note.path));
  const nodes: InboxTemplateGraphNode[] = visible.map(note => ({
    id: noteId(note.path),
    label: note.title,
    kind: "note",
    count: 1,
    path: note.path,
    note,
    area: note.area,
    platform: note.platform,
  }));
  const edges: InboxTemplateGraphEdge[] = data.edges
    .filter(edge => visiblePaths.has(normalizeVaultPath(edge.source)) && visiblePaths.has(normalizeVaultPath(edge.target)))
    .map((edge, index) => ({
      id: `relation:${index}:${normalizeVaultPath(edge.source)}->${normalizeVaultPath(edge.target)}`,
      source: noteId(edge.source),
      target: noteId(edge.target),
      relationType: "related_notes",
      facetKind: "cluster",
      evidence: "frontmatter",
      confidence: "explicit",
      weight: Math.max(1, edge.weight),
    }));
  return {
    nodes,
    edges,
    notes: visible,
    totalCount: visible.length,
    filteredCount: visible.length,
    truncated: data.truncated,
    rawCount: visible.length,
    passiveExcludedCount: 0,
    areaCount: visible.length ? 1 : 0,
    sourceCount: 0,
    clusterCount: 0,
    detail: "focus",
    depth: 3,
    noteCount: visible.length,
    hiddenNoteCount: 0,
  };
}

function workspaceAreaId(value: string): string { return `workspace:area:${encodeURIComponent(value)}`; }
function workspaceSourceId(value: string): string { return `workspace:source:${encodeURIComponent(value)}`; }
function workspaceClusterId(source: string, value: string): string {
  return `workspace:cluster:${encodeURIComponent(`${source}\u0000${value}`)}`;
}

export function buildWorkspaceSemanticGraph(
  data: GraphData,
  workspace: AethericWorkspace | null,
  fileLookup?: (path: string) => IndexedFile | undefined,
  options: WorkspaceSemanticGraphOptions = {},
): InboxTemplateGraphData {
  const depth: WorkspaceGraphDepth = options.depth ?? (options.detail === "focus" ? 3 : 1);
  const detail = depth >= 3 ? "focus" : "overview";
  const limit = Math.max(1, Math.min(48, Math.floor(options.limit ?? (depth >= 3 ? 28 : 48))));
  const eligible = data.nodes
    .filter(node => !isWorkspaceNoisePath(node.path))
    .map(node => ({ node, segments: workspaceRelativeSegments(node.path, workspace), note: workspaceNote(node, fileLookup?.(node.path)) }))
  const focused = eligible
    .filter(item => {
      if (!options.focusGroup) return true;
      const [focusGroup, focusCluster] = options.focusGroup.split("\u0000");
      return (item.segments[0] || "根目录") === focusGroup
        && (!focusCluster || (item.segments[1] || "根目录") === focusCluster);
    })
    .sort((a, b) => b.note.mtime - a.note.mtime);
  const candidates = focused
    .slice(0, limit);
  const allVisible = candidates;
  const areaLabel = workspace?.name || "全库";
  const areaId = workspaceAreaId(areaLabel);
  const nodes: InboxTemplateGraphNode[] = [{
    id: areaId,
    label: areaLabel,
    kind: "area",
    count: allVisible.length,
    area: areaLabel,
    memberPaths: allVisible.map(item => item.note.path),
  }];
  const edges: InboxTemplateGraphEdge[] = [];
  const groups = new Map<string, typeof allVisible>();
  for (const item of allVisible) {
    const group = item.segments[0] || "根目录";
    const list = groups.get(group) ?? [];
    list.push(item);
    groups.set(group, list);
  }
  const groupIds = new Map<string, string>();
  for (const [group, items] of [...groups.entries()].sort(([, a], [, b]) => b.length - a.length)) {
    if (depth < 1) continue;
    const groupId = workspaceSourceId(group);
    groupIds.set(group, groupId);
    nodes.push({ id: groupId, label: group, kind: "platform", count: items.length, area: areaLabel, groupKey: group, memberPaths: items.map(item => item.note.path) });
    edges.push({ id: `${areaId}->${groupId}`, source: areaId, target: groupId, relationType: "classified_as_area", facetKind: "area", evidence: "path", confidence: "explicit", weight: items.length });

    if (depth >= 2) {
      const clusters = new Map<string, typeof items>();
      for (const item of items) {
        const cluster = item.segments[1] || "根目录";
        const list = clusters.get(cluster) ?? [];
        list.push(item);
        clusters.set(cluster, list);
      }
      for (const [cluster, clusterItems] of clusters.entries()) {
        if (cluster === "根目录") continue;
        const clusterId = workspaceClusterId(group, cluster);
        nodes.push({ id: clusterId, label: cluster, kind: "cluster", count: clusterItems.length, area: areaLabel, groupKey: group, clusterKey: cluster, memberPaths: clusterItems.map(item => item.note.path) });
        edges.push({ id: `${groupId}->${clusterId}`, source: groupId, target: clusterId, relationType: "topic_cluster", facetKind: "cluster", evidence: "path", confidence: "explicit", weight: clusterItems.length });
        if (depth < 3) continue;
        for (const item of clusterItems) {
          const noteIdValue = noteId(item.note.path);
          nodes.push({ id: noteIdValue, label: item.note.title, kind: "note", count: 1, path: item.note.path, note: item.note, area: areaLabel, platform: group, groupKey: group, clusterKey: cluster });
          edges.push({ id: `${clusterId}->${noteIdValue}`, source: clusterId, target: noteIdValue, relationType: "contains_note", facetKind: "cluster", evidence: "path", confidence: "explicit", weight: 1 });
        }
      }
      if (depth < 3) continue;
      for (const item of items) {
        // Notes that belong to a named cluster were already emitted above.
        // The old count-based guard only skipped clusters with two or more
        // notes, so a single-note subdirectory was emitted a second time and
        // made ForceGraphEngine reject the whole graph for duplicate ids.
        const hasClusterNode = (item.segments[1] || "根目录") !== "根目录";
        if (hasClusterNode) continue;
        const noteIdValue = noteId(item.note.path);
        nodes.push({ id: noteIdValue, label: item.note.title, kind: "note", count: 1, path: item.note.path, note: item.note, area: areaLabel, platform: group, groupKey: group });
        edges.push({ id: `${groupId}->${noteIdValue}`, source: groupId, target: noteIdValue, relationType: "captured_from_platform", facetKind: "platform", evidence: "path", confidence: "explicit", weight: 1 });
      }
    }
  }

  const crossGroup = new Map<string, { source: string; target: string; weight: number }>();
  const candidatePaths = new Set(allVisible.map(item => item.note.path));
  for (const edge of data.edges) {
    if (!candidatePaths.has(edge.source) || !candidatePaths.has(edge.target)) continue;
    const sourceGroup = allVisible.find(item => item.note.path === edge.source)?.segments[0] || "根目录";
    const targetGroup = allVisible.find(item => item.note.path === edge.target)?.segments[0] || "根目录";
    if (sourceGroup === targetGroup) continue;
    const source = groupIds.get(sourceGroup);
    const target = groupIds.get(targetGroup);
    if (!source || !target) continue;
    const ordered = source < target ? [source, target] : [target, source];
    const key = ordered.join("->");
    const existing = crossGroup.get(key);
    if (existing) existing.weight += Math.max(1, edge.weight);
    else crossGroup.set(key, { source: ordered[0]!, target: ordered[1]!, weight: Math.max(1, edge.weight) });
  }
  // Directory cross-links are evidence, not primary structure. Keep only the
  // strongest few so a vault with ubiquitous wikilinks does not become a
  // complete graph; the renderer reveals these context edges on selection or
  // deliberate review instead of feeding them into the force layout.
  const crossGroupCandidates = [...crossGroup.entries()]
    .sort(([, left], [, right]) => right.weight - left.weight || left.source.localeCompare(right.source));
  const crossGroupLimit = Math.min(12, Math.max(3, Math.ceil(Math.sqrt(Math.max(1, groups.size)) * 2)));
  for (const [id, relation] of crossGroupCandidates.slice(0, crossGroupLimit)) {
    edges.push({ id: `related:${id}`, source: relation.source, target: relation.target, relationType: "related_notes", facetKind: "cluster", evidence: "frontmatter", confidence: "explicit", weight: relation.weight });
  }

  return {
    nodes,
    edges,
    notes: allVisible.map(item => item.note),
    totalCount: eligible.length,
    filteredCount: allVisible.length,
    truncated: data.truncated || focused.length > allVisible.length,
    rawCount: eligible.length,
    passiveExcludedCount: 0,
    areaCount: 1,
    sourceCount: groups.size,
    clusterCount: nodes.filter(node => node.kind === "cluster").length,
    detail,
    depth,
    noteCount: allVisible.length,
    hiddenNoteCount: Math.max(0, focused.length - allVisible.length),
  };
}

/**
 * Convert indexed inbox notes into a small semantic graph.
 *
 * This adapter is deliberately read-only: it consumes index metadata and never
 * writes frontmatter or moves files. The UI can later swap this deterministic
 * layout for the shared force-graph renderer without changing this contract.
 */
export function buildInboxFacetGraph(
  files: readonly KnowledgeNodeViewModel[],
  filters: InboxGraphFilters = {},
): InboxGraphData {
  const notes = files
    .filter(file => file.extension.toLowerCase() === "md")
    .filter(file => isGraphVisiblePath(file.path))
    .filter(file => !file.path.includes("/00_残卷回收站/"))
    .map(asNote)
    .sort((a, b) => b.mtime - a.mtime);

  const filtered = notes.filter(note =>
    (!filters.area || note.area === filters.area)
    && (!filters.platform || note.platform === filters.platform)
    && (!filters.status || note.status === filters.status)
    && (!filters.period || note.period === filters.period)
  );
  const limit = Math.max(1, Math.min(120, Math.floor(filters.limit ?? 48)));
  const visible = filtered.slice(0, limit);
  const nodes: InboxGraphNode[] = [];
  const edges: InboxGraphEdge[] = [];
  const facetCounts = new Map<string, number>();
  const facetKinds: InboxFacetKind[] = filters.showFolders
    ? ["area", "platform", "status", "period", "folder"]
    : ["area", "platform", "status", "period"];

  for (const note of visible) {
    const id = noteId(note.path);
    nodes.push({ id, label: note.title, kind: "note", count: 1, path: note.path, note });
    for (const kind of facetKinds) {
      const value = note[kind];
      const idForFacet = facetId(kind, value);
      facetCounts.set(idForFacet, (facetCounts.get(idForFacet) ?? 0) + 1);
      edges.push({
        id: `${id}->${idForFacet}`,
        source: id,
        target: idForFacet,
        relationType: relationType(kind),
        facetKind: kind,
        evidence: note.evidence[kind] ?? "inferred",
        confidence: note.evidence[kind] === "frontmatter" || note.evidence[kind] === "path" ? "explicit" : "inferred",
        weight: 1,
      });
    }
  }

  const seenFacets = new Set<string>();
  for (const edge of edges) {
    if (seenFacets.has(edge.target)) continue;
    seenFacets.add(edge.target);
    const [, kind, encoded] = edge.target.split(":");
    const value = decodeURIComponent(encoded ?? "");
    nodes.push({ id: edge.target, label: value, kind: kind as InboxFacetKind, count: facetCounts.get(edge.target) ?? 1 });
  }

  return {
    nodes,
    edges,
    notes: visible,
    totalCount: notes.length,
    filteredCount: filtered.length,
    truncated: filtered.length > visible.length,
  };
}

export function getInboxFacetOptions(files: readonly KnowledgeNodeViewModel[]): InboxFacetOptions {
  const notes = files
    .filter(file => file.extension.toLowerCase() === "md")
    .filter(file => isGraphVisiblePath(file.path))
    .filter(file => !file.path.includes("/00_残卷回收站/"))
    .map(asNote);
  const options = {
    area: new Set<string>(),
    platform: new Set<string>(),
    status: new Set<string>(),
    period: new Set<string>(),
  };
  for (const note of notes) {
    options.area.add(note.area);
    options.platform.add(note.platform);
    options.status.add(note.status);
    options.period.add(note.period);
  }
  return {
    area: [...options.area].sort((a, b) => a.localeCompare(b, "zh-CN")),
    platform: [...options.platform].sort((a, b) => (DISPLAY_PLATFORM[a] ?? a).localeCompare(DISPLAY_PLATFORM[b] ?? b, "zh-CN")),
    status: [...options.status].sort((a, b) => a.localeCompare(b, "zh-CN")),
    period: [...options.period].sort((a, b) => b.localeCompare(a)),
  };
}

export function displayInboxPlatform(value: string): string {
  return DISPLAY_PLATFORM[value] ?? value;
}
