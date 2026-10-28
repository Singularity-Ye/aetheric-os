import { App, Menu, TFile } from "obsidian";
import { CanvasLocalGraph, type CanvasLocalGraphData } from "../CanvasLocalGraph";
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
 * Integrates Note Stream (Column 2) and Dual-Engine Graph View (Column 3: Native & Canvas).
 * Fully decoupled from the main shell monolith.
 */
export class AtlasPage {
  private containerEl: HTMLElement | null = null;
  private canvasGraph: CanvasLocalGraph | null = null;
  private filterQuery = "";
  private graphEngine: "native" | "canvas" = "native";
  private graphScope: "current-folder" | "current-file" = "current-folder";
  private currentFolderPath = "";

  constructor(private context: AtlasPageContext) {}

  mount(parent: HTMLElement, folderPath: string): void {
    this.destroy();
    this.currentFolderPath = folderPath;
    this.containerEl = parent.createDiv({ cls: "aos-page aos-atlas-page" });

    // Column 2: Note Stream
    const stream = this.containerEl.createDiv({ cls: "aos-atlas-stream" });
    this.renderNoteStream(stream, folderPath);

    // Column 3: Graph Viewport
    const graphCol = this.containerEl.createDiv({ cls: "aos-atlas-graph" });
    this.renderGraph(graphCol, folderPath);
  }

  destroy(): void {
    if (this.canvasGraph) {
      this.canvasGraph.destroy();
      this.canvasGraph = null;
    }
    this.context.disposeNativeGraphView();
    if (this.containerEl) {
      this.containerEl.empty();
      this.containerEl = null;
    }
  }

  onResize(): void {
    this.canvasGraph?.resetView();
  }

  private renderNoteStream(parent: HTMLElement, folderPath: string): void {
    const state = this.context.plugin.store.getSnapshot();

    // 1. Breadcrumbs using AosUI
    const { countBadgeEl } = AosUI.breadcrumbs(parent, {
      folderPath,
      countText: "… 篇",
      onSelectFolder: targetPath => this.context.selectFolder(targetPath),
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
            if (this.graphEngine === "canvas") {
              this.canvasGraph?.setSelectedNode(node.path);
            } else if (this.graphEngine === "native") {
              const nativeGv = this.context.getNativeGraphView();
              if (nativeGv && this.graphScope === "current-file") {
                const tFile = this.context.app.vault.getAbstractFileByPath(node.path);
                if (tFile instanceof TFile) {
                  CompatAdapter.safeSetGraphFile(nativeGv, tFile);
                }
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

    // 2. Engine Toggle Buttons using AosUI
    AosUI.button(toolsEl, {
      label: "✦ 原生图谱",
      icon: "git-branch",
      isActive: this.graphEngine === "native",
      onClick: () => {
        if (this.graphEngine === "native") return;
        this.graphEngine = "native";
        this.renderGraph(parent, folderPath);
      },
    });

    AosUI.button(toolsEl, {
      label: "⚡ 轻量图谱",
      icon: "zap",
      isActive: this.graphEngine === "canvas",
      onClick: () => {
        if (this.graphEngine === "canvas") return;
        this.graphEngine = "canvas";
        this.renderGraph(parent, folderPath);
      },
    });

    // 3. Engine-specific Action Buttons using AosUI
    if (this.graphEngine === "canvas") {
      AosUI.button(toolsEl, {
        label: "居中复位",
        icon: "maximize-2",
        onClick: () => this.canvasGraph?.resetView(),
      });
      AosUI.button(toolsEl, {
        label: "重新布局",
        icon: "refresh-cw",
        onClick: () => this.canvasGraph?.restartLayout(),
      });
    } else {
      // In Native mode: Scope toggle
      if (state.selectedFilePath) {
        const isFileScope = this.graphScope === "current-file";
        AosUI.button(toolsEl, {
          label: isFileScope ? "📁 目录图谱" : "🔍 焦点单篇",
          icon: isFileScope ? "folder" : "focus",
          isActive: isFileScope,
          onClick: () => {
            this.graphScope = isFileScope ? "current-folder" : "current-file";
            this.renderGraph(parent, folderPath);
          },
        });
      }
    }

    // 4. Graph Host
    const canvasHost = parent.createDiv({ cls: "aos-atlas-canvas-host" });

    if (this.graphEngine === "native") {
      if (this.canvasGraph) {
        this.canvasGraph.destroy();
        this.canvasGraph = null;
      }
      const seedPath = (state.selectedFilePath && rawData.nodes.some((n: any) => n.path === state.selectedFilePath))
        ? state.selectedFilePath
        : (rawData.nodes[0]?.path || "");

      void this.context.mountNativeGraph(canvasHost, seedPath, rawData, this.graphScope, []);
    } else {
      this.context.disposeNativeGraphView();

      const graphData: CanvasLocalGraphData = {
        nodes: rawData.nodes,
        edges: rawData.edges,
        folderName,
      };

      this.canvasGraph = new CanvasLocalGraph(canvasHost, {
        onSelectNode: path => {
          const node = this.context.toNode(path);
          if (node) {
            this.context.selectNode(node);
            const streamList = this.containerEl?.querySelector(".aos-atlas-note-list");
            if (streamList) {
              streamList.querySelectorAll(".aos-atlas-note-card").forEach(c => {
                const match = c.querySelector(".aos-atlas-card-title")?.textContent === node.title;
                c.classList.toggle("is-selected", match);
                if (match) c.scrollIntoView({ behavior: "smooth", block: "nearest" });
              });
            }
          }
        },
        onOpenNode: path => {
          const node = this.context.toNode(path);
          if (node) void this.context.openNode(node);
        },
      });

      this.canvasGraph.setData(graphData, state.selectedFilePath);
    }
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
