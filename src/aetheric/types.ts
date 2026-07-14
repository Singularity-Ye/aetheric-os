export type AethericModule =
  | "overview"
  | "navigation"
  | "collection"
  | "tasks"
  | "intelligence"
  | "knowledge"
  | "logs";

export type NavigatorMode = "full" | "compact" | "collapsed";

export interface WorkspaceProject {
  id: string;
  name: string;
  status?: string;
  rootPath?: string;
}

export interface WorkspaceCapability {
  id: string;
  name: string;
  description?: string;
  command?: string;
}

export interface AethericWorkspace {
  id: string;
  name: string;
  rootPaths: string[];
  inboxPath?: string;
  icon?: string;
  includeTags?: string[];
  projects: WorkspaceProject[];
  capabilities: WorkspaceCapability[];
}

export interface WorkspaceHistory {
  folderPath: string;
  selectedFilePath: string | null;
}

export type LogLevel = "info" | "success" | "warn" | "error";

export interface AethericShellState {
  activeModule: AethericModule;
  selectedWorkspaceId: string;
  selectedProjectId: string | null;
  selectedFolderPath: string;
  selectedFilePath: string | null;
  expandedFolderPaths: string[];
  recentFilePaths: string[];
  favoritePaths: string[];
  favoriteFolderPaths: string[];
  workspaceHistory: Record<string, WorkspaceHistory>;
  navigatorMode: NavigatorMode;
  navigatorWidth: number;
  contextPaneWidth: number;
  taskDrawerOpen: boolean;
  folderTreeVisible: boolean;
  searchQuery: string;
  searchScope: "current-folder" | "current-workspace" | "vault";
  logDock: {
    open: boolean;
    maximized: boolean;
    height: number;
    follow: boolean;
    unseenCount: number;
    levelFilter: LogLevel[];
    sourceFilter: string[];
  };
}

export interface IndexedFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  parentPath: string;
  mtime: number;
  ctime: number;
  size: number;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

export type KnowledgeNodeKind = "note" | "project" | "report" | "dataset" | "asset" | "other";

export interface KnowledgeNodeViewModel extends IndexedFile {
  title: string;
  kind: KnowledgeNodeKind;
  lifecycleStatus?: string;
  relationCount: number;
  lastAgent?: {
    agent: string;
    action: string;
    timestamp?: number;
  };
}

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  source: string;
  message: string;
  durationMs?: number;
}

export type OperationTaskStatus = "online" | "offline" | "queued" | "running" | "success" | "failed" | "idle" | "unknown";

export interface OperationTask {
  id: string;
  title: string;
  source: string;
  status: OperationTaskStatus;
  detail?: string;
  progress?: number;
  updatedAt: number;
  startedAt?: number;
  nextRunAt?: number;
  action?: {
    label: string;
    command: "refresh-hamasxiang" | "run-x-watch" | "open-hamasxiang-console";
  };
}

export type OperationArtifactKind = "capture" | "intelligence" | "note" | "report" | "other";

export interface OperationArtifact {
  id: string;
  kind: OperationArtifactKind;
  title: string;
  status: string;
  summary?: string;
  originalText?: string;
  sourceUrl?: string;
  createdAt: number;
  path?: string;
}

export interface IntelligenceItem {
  id: string;
  platform: string;
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  signalLevel: string;
  confidence?: number;
  relevant: boolean;
  shouldNotify: boolean;
  tags: string[];
  capturedAt: number;
  resultPath?: string;
}

export type GraphScope = "current-file" | "current-folder" | "current-workspace" | "current-tag" | "vault";

export interface GraphNode {
  path: string;
  title: string;
  kind: KnowledgeNodeKind;
  depth: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export const DEFAULT_WORKSPACES: AethericWorkspace[] = [
  {
    id: "hamaxiang",
    name: "蛤蟆祥系统",
    icon: "🐸",
    rootPaths: ["02_丹炉间（项目区）/松果天工台（Aetheric OS）/蛤蟆祥系统"],
    inboxPath: "00_松果池（收件箱）",
    projects: [
      { id: "intel-radar", name: "情报雷达重构", status: "规划中" },
      { id: "aetheric-shell", name: "松果天工台 Shell", status: "进行中", rootPath: "02_丹炉间（项目区）/松果天工台（Aetheric OS）" },
    ],
    capabilities: [
      { id: "x-watch", name: "X Watch", description: "特定用户巡逻与情报监测" },
      { id: "cloud-sync", name: "云端同步", description: "云端卷轴归流与去重" },
      { id: "asr-repair", name: "ASR 修复", description: "字幕识别与残卷修复" },
    ],
  },
  {
    id: "songguo",
    name: "松果屋博客",
    icon: "🌲",
    rootPaths: [
      "02_丹炉间（项目区）/松果屋·博客",
      "02_丹炉间（项目区）/松果天工台（Aetheric OS）/松果屋控制台",
    ],
    projects: [
      { id: "blog-rebuild", name: "松果屋重制", status: "进行中", rootPath: "02_丹炉间（项目区）/松果屋·博客/🚧 筑梦现场 (重制进行时)" },
      { id: "publish-console", name: "发布控制台", status: "运行中", rootPath: "02_丹炉间（项目区）/松果天工台（Aetheric OS）/松果屋控制台" },
    ],
    capabilities: [
      { id: "publish", name: "博客发布", description: "筛选、同步与构建" },
      { id: "knowledge-health", name: "知识健康", description: "链接、标签与残卷检查" },
    ],
  },
  {
    id: "courses",
    name: "课程知识库",
    icon: "📚",
    rootPaths: ["01_藏经阁（知识库）"],
    projects: [],
    capabilities: [{ id: "course-import", name: "课程导入", description: "课程导入" }],
  },
  {
    id: "bg3",
    name: "博德之门3",
    icon: "⚔️",
    rootPaths: ["03_生活簿（生活区）/游艺录（游戏与娱乐）/博德之门3"],
    projects: [
      { id: "bg3-guides", name: "攻略索引", status: "进行中", rootPath: "03_生活簿（生活区）/游艺录（游戏与娱乐）/博德之门3" },
    ],
    capabilities: [
      { id: "bg3-builds", name: "角色BD构建", description: "职业与配装心得" },
      { id: "bg3-story", name: "剧情路线", description: "选项与多结局整理" },
    ],
  },
];

export const DEFAULT_SHELL_STATE: AethericShellState = {
  activeModule: "overview",
  selectedWorkspaceId: "hamaxiang",
  selectedProjectId: null,
  selectedFolderPath: DEFAULT_WORKSPACES[0].rootPaths[0],
  selectedFilePath: null,
  expandedFolderPaths: [],
  recentFilePaths: [],
  favoritePaths: [],
  favoriteFolderPaths: [],
  workspaceHistory: {},
  navigatorMode: "full",
  navigatorWidth: 250,
  contextPaneWidth: 330,
  taskDrawerOpen: false,
  folderTreeVisible: false,
  searchQuery: "",
  searchScope: "current-workspace",
  logDock: {
    open: false,
    maximized: false,
    height: 164,
    follow: true,
    unseenCount: 0,
    levelFilter: [],
    sourceFilter: [],
  },
};
