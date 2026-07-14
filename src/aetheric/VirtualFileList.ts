import { App, Menu, TFile } from "obsidian";
import { KnowledgeNodeViewModel } from "./types";

interface VirtualFileListOptions {
  view: any;
  onSelect: (file: KnowledgeNodeViewModel) => void;
  onOpen: (file: KnowledgeNodeViewModel) => void;
  isFavorite: (path: string) => boolean;
  onToggleFavorite: (path: string) => void;
}

export type VirtualRowItem =
  | { type: "file"; node: KnowledgeNodeViewModel }
  | { type: "header"; path: string; folderName: string; fileCount: number; collapsed: boolean };

export class VirtualFileList {
  private readonly rowHeight = 58;
  private readonly overscan = 6;
  private viewport: HTMLDivElement;
  private spacer: HTMLDivElement;
  private rowsLayer: HTMLDivElement;
  private items: VirtualRowItem[] = [];
  private rawNodes: KnowledgeNodeViewModel[] = [];
  private collapsedFolders = new Set<string>();
  private selectedPath: string | null = null;
  private scrollHandler: () => void;

  constructor(parent: HTMLElement, private app: App, private options: VirtualFileListOptions) {
    this.viewport = parent.createDiv({ cls: "aos-virtual-list" });
    this.spacer = this.viewport.createDiv({ cls: "aos-virtual-spacer" });
    this.rowsLayer = this.viewport.createDiv({ cls: "aos-virtual-rows" });
    this.scrollHandler = () => this.renderWindow();
    this.viewport.addEventListener("scroll", this.scrollHandler, { passive: true });
  }

  setItems(nodes: KnowledgeNodeViewModel[], selectedPath: string | null): void {
    this.rawNodes = nodes;
    this.selectedPath = selectedPath;
    this.rebuildItems();
  }

  private rebuildItems(): void {
    const groups = new Map<string, KnowledgeNodeViewModel[]>();
    for (const node of this.rawNodes) {
      const path = node.parentPath || "Vault";
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path)!.push(node);
    }

    const sortedPaths = [...groups.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));

    const listItems: VirtualRowItem[] = [];
    for (const path of sortedPaths) {
      const folderNodes = groups.get(path)!;
      const folderName = path.split("/").pop() || path;
      const collapsed = this.collapsedFolders.has(path);

      listItems.push({
        type: "header",
        path,
        folderName,
        fileCount: folderNodes.length,
        collapsed
      });

      if (!collapsed) {
        for (const node of folderNodes) {
          listItems.push({ type: "file", node });
        }
      }
    }

    this.items = listItems;
    this.spacer.style.height = `${this.items.length * this.rowHeight}px`;
    this.viewport.scrollTop = Math.min(this.viewport.scrollTop, Math.max(0, this.items.length * this.rowHeight - this.viewport.clientHeight));
    this.renderWindow();
  }

  focusPath(path: string): void {
    const index = this.items.findIndex(item => item.type === "file" && item.node.path === path);
    if (index < 0) return;
    this.selectedPath = path;
    const top = index * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
    if (bottom > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = bottom - this.viewport.clientHeight;
    this.renderWindow();
  }

  destroy(): void {
    this.viewport.removeEventListener("scroll", this.scrollHandler);
  }

  private renderWindow(): void {
    const viewportHeight = this.viewport.clientHeight || 420;
    const start = Math.max(0, Math.floor(this.viewport.scrollTop / this.rowHeight) - this.overscan);
    const end = Math.min(this.items.length, Math.ceil((this.viewport.scrollTop + viewportHeight) / this.rowHeight) + this.overscan);
    this.rowsLayer.empty();
    this.rowsLayer.style.transform = `translateY(${start * this.rowHeight}px)`;
    for (let index = start; index < end; index += 1) this.renderRow(this.items[index], index - start);
  }

  private renderRow(item: VirtualRowItem, localIndex: number): void {
    if (item.type === "header") {
      const row = this.rowsLayer.createDiv({ cls: "aos-file-row aos-folder-header-row" });
      row.style.top = `${localIndex * this.rowHeight + 2}px`;
      row.createDiv({ cls: "aos-file-kind is-folder", text: "📁" });

      const content = row.createDiv({ cls: "aos-file-primary" });
      const titleRow = content.createDiv({ cls: "aos-file-title-row" });
      titleRow.createSpan({ cls: "aos-file-title aos-folder-header-title", text: item.folderName });
      titleRow.createSpan({ cls: "aos-node-status aos-folder-count-badge", text: `${item.fileCount} 个节点` });

      const meta = content.createDiv({ cls: "aos-file-meta" });
      meta.createSpan({ text: item.path === "Vault" ? "全库根目录" : `路径: ${item.path}` });

      const action = row.createDiv({ cls: "aos-folder-header-action" });
      action.createSpan({ text: item.collapsed ? "›" : "⌄" });

      row.addEventListener("click", () => {
        if (this.collapsedFolders.has(item.path)) {
          this.collapsedFolders.delete(item.path);
        } else {
          this.collapsedFolders.add(item.path);
        }
        this.rebuildItems();
      });
      return;
    }

    const file = item.node;
    const row = this.rowsLayer.createDiv({ cls: "aos-file-row" });
    row.style.top = `${localIndex * this.rowHeight + 2}px`;
    row.classList.toggle("is-selected", file.path === this.selectedPath);
    row.setAttribute("data-path", file.path);
    row.createDiv({ cls: `aos-file-kind is-${file.kind}`, text: this.kindIcon(file.kind) });

    const content = row.createDiv({ cls: "aos-file-primary" });
    const titleRow = content.createDiv({ cls: "aos-file-title-row" });
    titleRow.createSpan({ cls: "aos-file-title", text: file.title });
    if (file.lifecycleStatus) titleRow.createSpan({ cls: "aos-node-status", text: file.lifecycleStatus });
    const meta = content.createDiv({ cls: "aos-file-meta" });
    meta.createSpan({ text: file.parentPath || "Vault" });
    if (file.tags.length) meta.createSpan({ text: file.tags.slice(0, 2).join(" ") });
    if (file.lastAgent) meta.createSpan({ cls: "aos-agent-activity", text: `${file.lastAgent.agent} · ${file.lastAgent.action}` });

    const side = row.createDiv({ cls: "aos-file-side" });
    side.createSpan({ text: this.relativeTime(file.mtime) });
    side.createSpan({ text: `关联 ${file.relationCount}` });
    const favorite = side.createEl("button", { cls: "aos-icon-button", text: this.options.isFavorite(file.path) ? "★" : "☆" });
    favorite.type = "button";
    favorite.setAttribute("aria-label", "收藏节点");
    favorite.setAttribute("title", this.options.isFavorite(file.path) ? "取消收藏" : "收藏节点");
    favorite.addEventListener("pointerdown", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    favorite.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const nextFavorite = !this.options.isFavorite(file.path);
      favorite.textContent = nextFavorite ? "★" : "☆";
      favorite.setAttribute("title", nextFavorite ? "取消收藏" : "收藏节点");
      this.options.onToggleFavorite(file.path);
    });
    favorite.addEventListener("dblclick", event => {
      event.preventDefault();
      event.stopPropagation();
    });

    row.addEventListener("click", event => {
      if ((event.target as HTMLElement).closest("button")) return;
      this.selectedPath = file.path;
      this.options.onSelect(file);
      this.renderWindow();
    });
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      const isFav = this.options.isFavorite(file.path);
      menu.addItem(item => {
        item.setTitle(isFav ? "★ 取消收藏此节点" : "☆ 收藏此节点")
          .setIcon("star")
          .onClick(() => this.options.onToggleFavorite(file.path));
      });
      menu.addItem(item => {
        item.setTitle("在新标签页中打开")
          .setIcon("file-plus")
          .onClick(() => this.options.onOpen(file));
      });
      menu.addItem(item => {
        item.setTitle("在原生系统管理器中显示")
          .setIcon("folder")
          .onClick(() => {
            const abstractFile = this.app.vault.getAbstractFileByPath(file.path);
            if (abstractFile instanceof TFile) {
              (this.app as any).shell?.showInFolder?.(abstractFile.path);
            }
          });
      });
      menu.showAtPosition({ x: event.clientX, y: event.clientY });
    });
    row.addEventListener("dblclick", event => {
      if ((event.target as HTMLElement).closest("button")) return;
      this.options.onOpen(file);
    });
    row.addEventListener("mouseover", event => {
      this.app.workspace.trigger("hover-link", {
        event,
        source: "aetheric-os",
        hoverParent: this.options.view,
        targetEl: row,
        linktext: file.path,
        sourcePath: file.path,
      });
    });
  }

  private kindIcon(kind: KnowledgeNodeViewModel["kind"]): string {
    if (kind === "project") return "◈";
    if (kind === "report") return "▤";
    if (kind === "dataset") return "▦";
    if (kind === "asset") return "◇";
    if (kind === "note") return "▣";
    return "·";
  }

  private relativeTime(timestamp: number): string {
    const delta = Date.now() - timestamp;
    if (delta < 60000) return "刚刚";
    if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
    if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
    return `${Math.floor(delta / 86400000)} 天前`;
  }
}
