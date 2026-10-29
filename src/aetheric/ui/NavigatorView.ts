import { TFolder, setIcon, Menu } from "obsidian";
import type { AethericWorkspace } from "../types";
import { AosUI } from "./AosUI";

export interface NavigatorViewContext {
  plugin: any;
  app: any;
  getWorkspace: () => AethericWorkspace | null;
  getInspirationFiles: (includeArchived?: boolean) => any[];
  selectWorkspace: (id: string) => void;
  selectFolder: (path: string) => void;
  promptAddFolder: () => void;
  openNoteEditorModal: (path?: string) => void;
  showFavoriteFiles: () => void;
  showRecentFiles: () => void;
  switchModule: (module: any) => void;
  toggleFavoriteFolder: (path: string) => void;
  applyPanelWidths: () => void;
}

/**
 * NavigatorView: Decoupled Folder Tree, Pillar Navigation and Workspace Rail Component.
 */
export class NavigatorView {
  private containerEl?: HTMLElement;

  constructor(private context: NavigatorViewContext) {}

  public render(containerEl?: HTMLElement): void {
    this.renderNavigator(containerEl);
  }

  public renderNavigator(containerEl?: HTMLElement): void {
    if (containerEl) this.containerEl = containerEl;
    if (!this.containerEl) return;
    const state = this.context.plugin.store.getSnapshot();
    const workspace = this.context.getWorkspace();
    this.containerEl!.empty();
    this.containerEl!.classList.toggle("is-collapsed", state.navigatorMode === "collapsed");

    const header = this.containerEl!.createDiv({ cls: "aos-navigator-header" });
    header.createSpan({ text: "Workspace" });
    AosUI.deckButton(header, {
      label: state.navigatorMode === "collapsed" ? "»" : "«",
      className: "aos-icon-button",
      title: state.navigatorMode === "collapsed" ? "展开导航栏" : "折叠导航栏",
      onClick: () => {
        const next = state.navigatorMode === "collapsed" ? "full" : "collapsed";
        this.context.plugin.store.patch({ navigatorMode: next });
        this.context.applyPanelWidths();
        this.renderNavigator();
      },
    });

    if (!workspace) return;
    const workspaceCard = this.containerEl!.createDiv({ cls: "aos-workspace-card" });
    const iconSpan = workspaceCard.createSpan({ cls: "aos-workspace-icon" });
    if (workspace.icon && /^[a-z-]+$/.test(workspace.icon)) {
      setIcon(iconSpan, workspace.icon);
    } else {
      iconSpan.setText(workspace.icon ?? "◇");
    }
    const text = workspaceCard.createDiv();
    text.createDiv({ cls: "aos-workspace-name", text: workspace.name });
    const noteCount = this.context.plugin.indexService.getFileCount(workspace);
    text.createDiv({ cls: "aos-workspace-desc", text: `${noteCount} 篇知识笔记 · 圣地知识流` });

    if (state.navigatorMode === "collapsed") {
      for (const item of this.context.plugin.settings.workspaces) {
        const button = this.containerEl!.createEl("button", { cls: "aos-collapsed-workspace" });
        if (item.icon && /^[a-z-]+$/.test(item.icon)) {
          setIcon(button, item.icon);
        } else {
          button.setText(item.icon ?? "◇");
        }
        button.setAttribute("title", item.name);
        button.classList.toggle("is-active", item.id === workspace.id);
        button.addEventListener("click", () => this.context.selectWorkspace(item.id));
      }
      return;
    }

    // 1. Pinned Folders (★ 常用置顶目录)
    const pinnedSection = this.containerEl!.createDiv({ cls: "aos-nav-section aos-pinned-section" });
    const pinnedHeader = pinnedSection.createDiv({ cls: "aos-section-header" });
    pinnedHeader.createDiv({ cls: "aos-nav-section-title", text: "★ 常用置顶目录" });
    const addPinBtn = pinnedHeader.createEl("button", {
      cls: "aos-quick-add-btn",
      text: "+",
      attr: { title: "添加置顶目录" },
    });
    addPinBtn.addEventListener("click", () => this.context.promptAddFolder());

    const pinnedChips = pinnedSection.createDiv({ cls: "aos-pinned-chips" });
    const favoriteFolderPaths = state.favoriteFolderPaths || [];
    if (favoriteFolderPaths.length === 0) {
      pinnedChips.createDiv({ cls: "aos-empty-hint", text: "右键目录可固定至常用置顶" });
    } else {
      for (const folderPath of favoriteFolderPaths) {
        this.renderPinnedFolderChip(pinnedChips, folderPath, state.selectedFolderPath === folderPath);
      }
    }

    // 2. Pillars & Schools Tree (🏛️ 松果阁四大圣地体系)
    const pillarsSection = this.containerEl!.createDiv({ cls: "aos-nav-section aos-pillars-section" });
    const pillarsHeader = pillarsSection.createDiv({ cls: "aos-section-header" });
    pillarsHeader.createDiv({ cls: "aos-nav-section-title", text: "🏛️ 松果阁体系" });

    const treeContainer = pillarsSection.createDiv({ cls: "aos-pillars-tree" });
    const expandedSet = new Set<string>(state.expandedFolderPaths);

    for (const rootPath of workspace.rootPaths) {
      const folder = this.context.plugin.indexService.getFolder(rootPath);
      if (folder) {
        this.renderPillarNode(treeContainer, folder, 0, expandedSet, state.selectedFolderPath);
      }
    }

    // 3. Quick Tools (⚡ 快捷工具)
    const quick = this.containerEl!.createDiv({ cls: "aos-nav-section aos-quick-section" });
    const quickHeader = quick.createDiv({ cls: "aos-section-header" });
    quickHeader.createDiv({ cls: "aos-nav-section-title", text: "⚡ 快捷工具" });

    const recentButton = this.renderQuickButton(quick, "最近访问", `${state.recentFilePaths.length}`, "history", () => this.context.showRecentFiles());
    recentButton.dataset.aosQuick = "recent";
    this.renderQuickButton(quick, "收藏节点", `${state.favoritePaths.length}`, "star", () => this.context.showFavoriteFiles());
    this.renderQuickButton(quick, "灵感待炼", `${this.context.getInspirationFiles().length}`, "lightbulb", () => this.context.switchModule("inspiration"));
    this.renderQuickButton(
      quick,
      state.folderTreeVisible ? "收起全库目录树" : "浏览全库目录树",
      "",
      "folder-tree",
      () => {
        this.context.plugin.store.patch({ folderTreeVisible: !state.folderTreeVisible });
        this.renderNavigator();
      }
    );

    if (state.folderTreeVisible) {
      this.renderFullVaultFolderTree();
    }
  }

  private getFolderIcon(folderName: string, folderPath: string): string {
    const lower = `${folderName} ${folderPath}`.toLowerCase();
    if (lower.includes("微信") || lower.includes("weixin")) return "message-square";
    if (lower.includes("x情报") || lower.includes("推特") || lower.includes("twitter")) return "rss";
    if (lower.includes("b站") || lower.includes("bilibili") || lower.includes("映卷")) return "tv";
    if (lower.includes("小红书") || lower.includes("redbook")) return "bookmark";
    if (lower.includes("技艺") || lower.includes("工具") || lower.includes("practical")) return "wrench";
    if (lower.includes("思辨") || lower.includes("手札") || lower.includes("屋主")) return "sparkles";
    if (lower.includes("刀笔") || lower.includes("锐评")) return "pen-tool";
    if (lower.includes("博物") || lower.includes("科普")) return "compass";
    if (lower.includes("格物") || lower.includes("学术") || lower.includes("课程")) return "graduation-cap";
    if (lower.includes("天工台") || lower.includes("aetheric") || lower.includes("丹炉")) return "flame";
    if (lower.includes("蛤蟆祥") || lower.includes("frog")) return "frog";
    if (lower.includes("博客") || lower.includes("blog")) return "globe";
    if (lower.includes("食味") || lower.includes("美食")) return "utensils";
    if (lower.includes("行路") || lower.includes("旅行")) return "map-pin";
    if (lower.includes("游艺") || lower.includes("游戏") || lower.includes("bg3")) return "gamepad-2";
    if (lower.includes("松果池") || lower.includes("收件箱") || lower.includes("inbox")) return "inbox";
    if (lower.includes("藏经阁")) return "book-open";
    if (lower.includes("生活簿")) return "coffee";
    return "folder";
  }

  private renderPinnedFolderChip(parent: HTMLElement, folderPath: string, isActive: boolean): void {
    const chip = parent.createDiv({ cls: "aos-pinned-chip" });
    chip.classList.toggle("is-active", isActive);

    const folderName = folderPath.split("/").pop() || folderPath;
    const iconName = this.getFolderIcon(folderName, folderPath);
    const iconEl = chip.createSpan({ cls: "aos-chip-icon" });
    setIcon(iconEl, iconName);

    const titleEl = chip.createSpan({ cls: "aos-chip-title", text: folderName });
    titleEl.setAttribute("title", folderPath);

    const fileCount = this.context.plugin.indexService.listFiles(folderPath).length;
    if (fileCount > 0) {
      chip.createSpan({ cls: "aos-chip-badge", text: `${fileCount}` });
    }

    chip.addEventListener("click", () => this.context.selectFolder(folderPath));
    chip.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle("★ 从常用置顶移除")
          .setIcon("star-off")
          .onClick(() => this.context.toggleFavoriteFolder(folderPath));
      });
      menu.addItem((item: any) => {
        item.setTitle("在此目录新建笔记")
          .setIcon("file-plus-2")
          .onClick(() => {
            this.context.selectFolder(folderPath);
            void this.context.openNoteEditorModal();
          });
      });
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });
  }

  private renderPillarNode(
    parent: HTMLElement,
    folder: TFolder,
    depth: number,
    expanded: Set<string>,
    selectedFolderPath: string,
  ): void {
    const isExpanded = expanded.has(folder.path);
    const children = this.context.plugin.indexService.getChildFolders(folder.path);
    const isSelected = selectedFolderPath === folder.path;
    const isPillar = depth === 0;

    const row = parent.createDiv({ cls: `aos-pillar-row depth-${depth}` });
    row.classList.toggle("is-pillar", isPillar);
    row.classList.toggle("is-selected", isSelected);
    row.style.setProperty("--aos-folder-depth", `${depth}`);

    const toggle = row.createEl("button", {
      cls: "aos-pillar-toggle",
      text: children.length ? (isExpanded ? "⌄" : "›") : "·",
    });
    toggle.disabled = children.length === 0;
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      const next = new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      this.context.plugin.store.patch({ expandedFolderPaths: [...next] });
      this.renderNavigator();
    });

    const iconSpan = row.createSpan({ cls: "aos-pillar-icon" });
    const iconName = this.getFolderIcon(folder.name, folder.path);
    setIcon(iconSpan, iconName);

    const label = row.createSpan({ cls: "aos-pillar-label", text: folder.name });
    label.setAttribute("title", folder.path);

    const fileCount = this.context.plugin.indexService.listFiles(folder.path).length;
    if (fileCount > 0) {
      row.createSpan({ cls: "aos-pillar-badge", text: `${fileCount}` });
    }

    const favoriteFolderPaths = this.context.plugin.store.getSnapshot().favoriteFolderPaths || [];
    const isFav = favoriteFolderPaths.includes(folder.path);
    if (isFav) {
      const star = row.createSpan({ cls: "aos-pillar-pinned-star", text: "★" });
      star.setAttribute("title", "已置顶到常用");
    }

    row.addEventListener("click", () => this.context.selectFolder(folder.path));

    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isFav ? "★ 从常用置顶移除" : "★ 固定到常用置顶")
          .setIcon(isFav ? "star-off" : "star")
          .onClick(() => this.context.toggleFavoriteFolder(folder.path));
      });
      if (children.length > 0) {
        menu.addItem((item: any) => {
          item.setTitle(isExpanded ? "收起子目录" : "展开子目录")
            .setIcon("folder")
            .onClick(() => {
              const next = new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths);
              if (next.has(folder.path)) next.delete(folder.path);
              else next.add(folder.path);
              this.context.plugin.store.patch({ expandedFolderPaths: [...next] });
              this.renderNavigator();
            });
        });
      }
      menu.addItem((item: any) => {
        item.setTitle("在此目录新建笔记")
          .setIcon("file-plus-2")
          .onClick(() => {
            this.context.selectFolder(folder.path);
            void this.context.openNoteEditorModal();
          });
      });
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });

    if (isExpanded && children.length > 0) {
      for (const child of children) {
        this.renderPillarNode(parent, child, depth + 1, expanded, selectedFolderPath);
      }
    }
  }

  private renderFullVaultFolderTree(): void {
    const section = this.containerEl!.createDiv({ cls: "aos-folder-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: "全库物理目录 · 按需展开" });
    const topFolders = this.context.plugin.indexService.getChildFolders("");
    const expanded = new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths);
    for (const folder of topFolders) {
      this.renderFolderBranch(section, folder, 0, expanded);
    }
  }

  private renderNavigatorSection(
    label: string,
    items: Array<{ title: string; meta: string; action: () => void; active?: boolean }>,
  ): void {
    if (!items.length) return;
    const section = this.containerEl!.createDiv({ cls: "aos-nav-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: label });
    for (const item of items) {
      const button = section.createDiv({ cls: "aos-nav-card" });
      button.classList.toggle("is-active", item.active === true);
      button.createSpan({ cls: "aos-nav-card-title", text: item.title });
      button.createSpan({ cls: "aos-nav-card-meta", text: item.meta });
      button.addEventListener("click", item.action);
    }
  }

  private renderQuickButton(parent: HTMLElement, label: string, count: string, iconName: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "aos-quick-button" });
    const icon = button.createSpan({ cls: "aos-quick-icon" });
    setIcon(icon, iconName);
    button.createSpan({ text: label });
    if (count) button.createSpan({ cls: "aos-quick-count", text: count });
    button.addEventListener("click", action);
    return button;
  }

  private renderFolderTree(workspace: AethericWorkspace): void {
    const section = this.containerEl!.createDiv({ cls: "aos-folder-section" });
    section.createDiv({ cls: "aos-nav-section-title", text: "Physical folders · 按需展开" });
    for (const rootPath of workspace.rootPaths) {
      const folder = this.context.plugin.indexService.getFolder(rootPath);
      if (folder) this.renderFolderBranch(section, folder, 0, new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths));
    }
  }

  private renderFolderBranch(parent: HTMLElement, folder: TFolder, depth: number, expanded: Set<string>): void {
    const state = this.context.plugin.store.getSnapshot();
    const children = this.context.plugin.indexService.getChildFolders(folder.path);
    const row = parent.createDiv({ cls: "aos-folder-row" });
    row.style.setProperty("--aos-folder-depth", `${depth}`);
    const toggle = row.createEl("button", { cls: "aos-folder-toggle", text: children.length ? (expanded.has(folder.path) ? "⌄" : "›") : "·" });
    toggle.disabled = children.length === 0;
    toggle.addEventListener("click", event => {
      event.stopPropagation();
      const next = new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      this.context.plugin.store.patch({ expandedFolderPaths: [...next] });
      this.renderNavigator();
    });
    const label = row.createEl("button", { cls: "aos-folder-label", text: folder.name || "Vault" });
    label.classList.toggle("is-selected", state.selectedFolderPath === folder.path);
    label.addEventListener("click", () => this.context.selectFolder(folder.path));

    const favoriteFolderPaths = state.favoriteFolderPaths || [];
    const isFav = favoriteFolderPaths.includes(folder.path);
    const favBtn = row.createEl("button", {
      cls: "aos-folder-fav-btn",
      text: isFav ? "★" : "☆",
      attr: { title: isFav ? "取消收藏" : "收藏" }
    });
    favBtn.classList.toggle("is-active", isFav);
    row.addEventListener("click", () => this.context.selectFolder(folder.path));
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isFav ? "★ 从快捷访问移除" : "☆ 添加至快捷访问")
          .setIcon("star")
          .onClick(() => this.context.toggleFavoriteFolder(folder.path));
      });
      if (children.length > 0) {
        menu.addItem((item: any) => {
          item.setTitle(expanded.has(folder.path) ? "收起子目录" : "展开子目录")
            .setIcon("folder")
            .onClick(() => {
              const next = new Set<string>(this.context.plugin.store.getSnapshot().expandedFolderPaths);
              if (next.has(folder.path)) next.delete(folder.path);
              else next.add(folder.path);
              this.context.plugin.store.patch({ expandedFolderPaths: [...next] });
              this.renderNavigator();
            });
        });
      }
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });

    if (expanded.has(folder.path)) {
      for (const child of children) this.renderFolderBranch(parent, child, depth + 1, expanded);
    }
  }


}
