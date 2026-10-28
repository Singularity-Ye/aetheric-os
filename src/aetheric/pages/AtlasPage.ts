import { App, Menu, TFile } from "obsidian";
import { AosUI } from "../ui/AosUI";
import { CompatAdapter } from "../CompatAdapter";
import type { KnowledgeNodeViewModel } from "../types";

export interface AtlasPageContext {
  app: App;
  plugin: any;
  shell: any;
  getWorkspace: () => any;
  toNode: (path: string) => KnowledgeNodeViewModel | null;
  selectNode: (node: KnowledgeNodeViewModel, pushHistory?: boolean) => void;
  openNode: (node: KnowledgeNodeViewModel) => Promise<void>;
  selectFolder: (folderPath: string, pushHistory?: boolean) => void;
  toggleFavorite: (path: string) => void;
  openNoteEditorModal: () => Promise<void>;
  mountNativeGraph: (
    canvas: HTMLDivElement,
    seedPath: string,
    data: any,
    scope: any,
    selectedTags: readonly string[],
  ) => Promise<void>;
  disposeNativeGraphView: () => void;
  getNativeGraphView: () => any;
}

/**
 * AtlasPage: The Unified Knowledge Atlas Workbench.
 * Integrates Note Stream (Column 2) and Native Obsidian Graph View (Column 3).
 * Fully decoupled from the main shell monolith.
 */
export class AtlasPage {
  private containerEl: HTMLElement | null = null;
  private filterQuery = "";
  private graphScope: "current-folder" | "current-file" = "current-folder";
  private currentFolderPath = "";
  private isStreamCollapsed = false;
  private graphToolsEl: HTMLElement | null = null;
  private streamToggleBtn: HTMLButtonElement | null = null;

  constructor(private context: AtlasPageContext) {}

  mount(parent: HTMLElement, folderPath: string): void {
    this.destroy();
    this.currentFolderPath = folderPath;
    this.containerEl = parent.createDiv({ cls: "aos-page aos-atlas-page" });
    if (this.isStreamCollapsed) {
      this.containerEl.addClass("is-stream-collapsed");
    }

    // Column 2: Note Stream
    const stream = this.containerEl.createDiv({ cls: "aos-atlas-stream" });
    this.renderNoteStream(stream, folderPath);

    // Column 3: Graph Viewport (Strictly Native Obsidian Graph)
    const graphCol = this.containerEl.createDiv({ cls: "aos-atlas-graph" });
    this.renderGraph(graphCol, folderPath);
  }

  destroy(): void {
    this.context.disposeNativeGraphView();
    if (this.containerEl) {
      this.containerEl.empty();
      this.containerEl = null;
    }
    this.graphToolsEl = null;
    this.streamToggleBtn = null;
  }

  onResize(): void {
    const nativeGv = this.context.getNativeGraphView();
    if (nativeGv && typeof nativeGv.onResize === "function") {
      nativeGv.onResize();
    }
  }

  public toggleStream(collapse?: boolean): void {
    this.isStreamCollapsed = collapse !== undefined ? collapse : !this.isStreamCollapsed;
    if (this.containerEl) {
      this.containerEl.classList.toggle("is-stream-collapsed", this.isStreamCollapsed);
    }
    if (this.graphToolsEl && this.currentFolderPath) {
      this.updateStreamToggleBtn(this.graphToolsEl, this.currentFolderPath);
    }
    setTimeout(() => {
      this.onResize();
    }, 240);
  }

  private updateStreamToggleBtn(toolsEl: HTMLElement, folderPath: string): void {
    if (this.streamToggleBtn) {
      this.streamToggleBtn.remove();
      this.streamToggleBtn = null;
    }
    const noteCount = this.context.plugin.indexService.listFiles(folderPath).length;
    if (this.isStreamCollapsed) {
      this.streamToggleBtn = AosUI.button(toolsEl, {
        label: `📋 ${noteCount} 篇笔记 (展开)`,
        icon: "panel-left-open",
        variant: "primary",
        title: "展开笔记列表",
        onClick: () => this.toggleStream(false),
      });
    } else {
      this.streamToggleBtn = AosUI.button(toolsEl, {
        label: "◨ 收起列表",
        icon: "panel-left-close",
        variant: "secondary",
        title: "收起笔记列表以宽屏查看图谱",
        onClick: () => this.toggleStream(true),
      });
    }
  }

  private renderNoteStream(parent: HTMLElement, folderPath: string): void {
    const state = this.context.plugin.store.getSnapshot();

    // 1. Breadcrumbs using AosUI with Collapse Drawer Action
    const { countBadgeEl } = AosUI.breadcrumbs(parent, {
      folderPath,
      countText: "… 篇",
      onSelectFolder: targetPath => this.context.selectFolder(targetPath),
      onCollapse: () => this.toggleStream(true),
      collapseTitle: "收起笔记列表以宽屏查看图谱",
    });

    // 2. Search & Filter bar using AosUI
    AosUI.searchBar(parent, {
      placeholder: "搜索过滤当前笔记…",
      value: this.filterQuery,
      actionIcon: "file-plus-2",
      actionTitle: "在此目录新建笔记",
      onInput: val => {
        this.filterQuery = val;
        renderList(val);
      },
      onActionClick: () => void this.context.openNoteEditorModal(),
    });

    // 3. Note List Container
    const listContainer = parent.createDiv({ cls: "aos-atlas-note-list" });

    const renderList = (filter = "") => {
      listContainer.empty();
      let allNotes = this.context.plugin.indexService.listFiles(folderPath);
      if (filter.trim()) {
        const needle = filter.trim().toLowerCase();
        allNotes = allNotes.filter((n: any) =>
          n.title.toLowerCase().includes(needle) ||
          n.path.toLowerCase().includes(needle) ||
          n.tags.some((t: string) => t.toLowerCase().includes(needle))
        );
      }

      countBadgeEl.textContent = `${allNotes.length} 篇`;

      if (allNotes.length === 0) {
        AosUI.empty(listContainer, "当前目录暂无笔记");
        return;
      }

      for (const node of allNotes) {
        const isSelected = (this.context.shell.getSelectedNodePath() === node.path) || (state.selectedFilePath === node.path);
        
        AosUI.noteCard(listContainer, {
          title: node.title,
          kind: node.kind,
          date: this.formatDate(node.mtime),
          relations: node.relationCount,
          tags: node.tags,
          isSelected,
          onClick: () => {
            this.context.selectNode(node);
            const nativeGv = this.context.getNativeGraphView();
            if (nativeGv && this.graphScope === "current-file") {
              const tFile = this.context.app.vault.getAbstractFileByPath(node.path);
              if (tFile instanceof TFile) {
                CompatAdapter.safeSetGraphFile(nativeGv, tFile);
              }
            }
            listContainer.querySelectorAll(".aos-atlas-note-card").forEach(el => el.classList.remove("is-selected"));
          },
          onDblClick: () => void this.context.openNode(node),
          onContextMenu: event => {
            event.preventDefault();
            event.stopPropagation();
            const menu = new Menu();
            menu.addItem(item => {
              item.setTitle("在编辑器中打开")
                .setIcon("file-edit")
                .onClick(() => void this.context.openNode(node));
            });
            menu.addItem(item => {
              const isFav = this.context.plugin.store.getSnapshot().favoritePaths.includes(node.path);
              item.setTitle(isFav ? "★ 取消收藏" : "☆ 收藏笔记")
                .setIcon("star")
                .onClick(() => this.context.toggleFavorite(node.path));
            });
            menu.showAtPosition({ x: event.clientX, y: event.clientY });
          },
        });
      }
    };

    renderList(this.filterQuery);
  }

  private renderGraph(parent: HTMLElement, folderPath: string): void {
    parent.empty();
    const state = this.context.plugin.store.getSnapshot();
    const folderName = folderPath.split("/").pop() || folderPath;

    // Scoped graph data using VaultIndexService
    const rawData = this.context.plugin.indexService.getGraphData(
      state.selectedFilePath,
      "current-folder",
      this.context.getWorkspace(),
      folderPath,
      64,
    );

    // 1. Toolbar using AosUI
    const { toolsEl } = AosUI.toolbar(parent, {
      title: `局部关系图谱 · ${folderName}`,
      icon: "git-fork",
      stats: `${rawData.nodes.length} 节点 · ${rawData.edges.length} 关联`,
    });
    this.graphToolsEl = toolsEl;

    // 2. Stream Drawer Toggle Button
    this.updateStreamToggleBtn(toolsEl, folderPath);

    // 3. In Native mode: Scope toggle (Current Folder vs Focused File)
    if (state.selectedFilePath) {
      const isFileScope = this.graphScope === "current-file";
      AosUI.button(toolsEl, {
        label: isFileScope ? "📁 目录图谱" : "🔍 焦点单篇",
        icon: isFileScope ? "folder" : "focus",
        isActive: isFileScope,
        title: isFileScope ? "切换为显示整目录关系图谱" : "切换为以当前选中文档为焦点的单篇局部图谱",
        onClick: () => {
          this.graphScope = isFileScope ? "current-folder" : "current-file";
          this.renderGraph(parent, folderPath);
        },
      });
    }

    // 4. Native Obsidian Graph Canvas Host
    const canvasHost = parent.createDiv({ cls: "aos-atlas-canvas-host" });
    const seedPath = (state.selectedFilePath && rawData.nodes.some((n: any) => n.path === state.selectedFilePath))
      ? state.selectedFilePath
      : (rawData.nodes[0]?.path || "");

    void this.context.mountNativeGraph(canvasHost, seedPath, rawData, this.graphScope, []);
  }

  private formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    const now = new Date();
    const isThisYear = d.getFullYear() === now.getFullYear();
    const month = d.getMonth() + 1;
    const date = d.getDate();
    return isThisYear ? `${month}/${date}` : `${d.getFullYear()}/${month}/${date}`;
  }
}
