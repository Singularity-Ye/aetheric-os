import { setIcon, Menu } from "obsidian";

export type AosButtonVariant = "pill" | "primary" | "secondary" | "icon" | "ghost";

export interface AosButtonOptions {
  label?: string;
  icon?: string;
  variant?: AosButtonVariant;
  isActive?: boolean;
  isDisabled?: boolean;
  title?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export interface AosNoteCardOptions {
  title: string;
  icon?: string;
  kind?: string;
  date?: string;
  relations?: number;
  tags?: string[];
  snippet?: string;
  isSelected?: boolean;
  onClick?: (event: MouseEvent) => void;
  onDblClick?: (event: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
}

export interface AosToolbarOptions {
  title: string;
  icon?: string;
  stats?: string;
}

export interface AosBreadcrumbsOptions {
  folderPath: string;
  countText?: string;
  onSelectFolder: (targetPath: string) => void;
  onCollapse?: () => void;
  collapseTitle?: string;
}

export interface AosSearchInputOptions {
  placeholder?: string;
  value?: string;
  onInput: (val: string) => void;
  onActionClick?: () => void;
  actionIcon?: string;
  actionTitle?: string;
}

/**
 * AosUI: Centralized UI Primitives Factory for Aetheric OS.
 * Decouples all DOM element construction and design system classes
 * from business logic, ensuring 100% component reuse and consistent aesthetic.
 */
export class AosUI {
  /**
   * Creates a standardized, beautifully styled Aetheric OS button.
   */
  static button(parent: HTMLElement, options: AosButtonOptions): HTMLButtonElement {
    const variantClass = options.variant === "primary"
      ? "aos-graph-native-btn is-primary"
      : options.variant === "secondary"
        ? "aos-graph-native-btn is-secondary"
        : options.variant === "icon"
          ? "aos-icon-button"
          : "aos-graph-native-btn";

    const activeClass = options.isActive ? "is-active" : "";
    const extraClass = options.className || "";

    const btn = parent.createEl("button", {
      cls: `${variantClass} ${activeClass} ${extraClass}`.trim(),
      attr: { type: "button" },
    });

    if (options.title) {
      btn.setAttribute("title", options.title);
      btn.setAttribute("aria-label", options.title);
    }
    if (options.isDisabled) {
      btn.disabled = true;
    }

    if (options.icon) {
      const iconSlot = btn.createSpan({ cls: "aos-graph-control-icon" });
      setIcon(iconSlot, options.icon);
    }

    if (options.label) {
      btn.createSpan({ cls: "aos-graph-control-label", text: options.label });
    }

    if (options.onClick) {
      btn.addEventListener("click", event => {
        if (!btn.disabled) options.onClick!(event);
      });
    }

    return btn;
  }

  /**
   * Creates a standardized search & filter bar with optional action button.
   */
  static searchBar(parent: HTMLElement, options: AosSearchInputOptions): {
    containerEl: HTMLElement;
    inputEl: HTMLInputElement;
    actionBtn?: HTMLButtonElement;
  } {
    const container = parent.createDiv({ cls: "aos-atlas-search-bar" });
    const input = container.createEl("input", {
      cls: "aos-atlas-search-input",
      attr: {
        type: "text",
        placeholder: options.placeholder || "搜索…",
      },
    });

    input.value = options.value || "";
    input.addEventListener("input", () => options.onInput(input.value));

    let actionBtn: HTMLButtonElement | undefined;
    if (options.onActionClick && options.actionIcon) {
      actionBtn = container.createEl("button", {
        cls: "aos-atlas-add-btn",
        attr: { title: options.actionTitle || "" },
      });
      setIcon(actionBtn, options.actionIcon);
      actionBtn.addEventListener("click", options.onActionClick);
    }

    return { containerEl: container, inputEl: input, actionBtn };
  }

  /**
   * Sanitizes ugly folder prefixes (e.g. 02_, 01_) and parenthetical suffixes
   * to ensure breadcrumbs are clean and fit comfortably without truncation.
   */
  static formatCrumbLabel(rawName: string, isRoot = false): string {
    if (isRoot) {
      if (rawName.includes("松果池")) return "松果池";
      if (rawName.includes("藏经阁")) return "藏经阁";
      if (rawName.includes("丹炉间")) return "丹炉间";
      if (rawName.includes("生活簿")) return "生活簿";
    }
    const cleaned = rawName.replace(/^\d+[_ -]/, "").replace(/（[^）]+）|\([^)]+\)/g, "").trim();
    return cleaned || rawName;
  }

  /**
   * Creates a standardized clickable breadcrumb stream with count badge and smart folding.
   */
  static breadcrumbs(parent: HTMLElement, options: AosBreadcrumbsOptions): {
    containerEl: HTMLElement;
    breadcrumbEl: HTMLElement;
    countBadgeEl: HTMLElement;
  } {
    const container = parent.createDiv({ cls: "aos-atlas-stream-header" });
    const breadcrumb = container.createDiv({ cls: "aos-atlas-breadcrumb" });

    const parts = options.folderPath.split("/").filter(Boolean);
    let accum = "";
    const crumbsData: Array<{ raw: string; label: string; path: string; isLast: boolean }> = [];
    for (let i = 0; i < parts.length; i++) {
      const raw = parts[i];
      accum = accum ? `${accum}/${raw}` : raw;
      crumbsData.push({
        raw,
        label: AosUI.formatCrumbLabel(raw, i === 0),
        path: accum,
        isLast: i === parts.length - 1,
      });
    }

    if (crumbsData.length > 3) {
      // First crumb (Root Pillar)
      const first = crumbsData[0];
      const firstBtn = breadcrumb.createEl("button", {
        cls: "aos-crumb-btn",
        text: first.label,
        attr: { title: `跳转到: ${first.path}` },
      });
      firstBtn.addEventListener("click", () => options.onSelectFolder(first.path));
      breadcrumb.createSpan({ cls: "aos-crumb-sep", text: "›" });

      // Intermediate dropdown button
      const moreBtn = breadcrumb.createEl("button", {
        cls: "aos-crumb-btn aos-crumb-more",
        text: "…",
        attr: { title: "点击查看中间层级目录" },
      });
      moreBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menu = new Menu();
        for (let i = 1; i < crumbsData.length - 1; i++) {
          const item = crumbsData[i];
          menu.addItem((m: any) => {
            m.setTitle(item.raw)
              .setIcon("folder")
              .onClick(() => options.onSelectFolder(item.path));
          });
        }
        menu.showAtPosition({ x: e.clientX, y: e.clientY });
      });
      breadcrumb.createSpan({ cls: "aos-crumb-sep", text: "›" });

      // Last crumb (Current Folder - Always Protected and Fully Visible)
      const last = crumbsData[crumbsData.length - 1];
      const lastBtn = breadcrumb.createEl("button", {
        cls: "aos-crumb-btn is-current",
        text: last.label,
        attr: { title: `当前目录: ${last.path}` },
      });
      lastBtn.addEventListener("click", () => options.onSelectFolder(last.path));
    } else {
      // 1 to 3 crumbs: render cleanly with sanitized labels
      for (let i = 0; i < crumbsData.length; i++) {
        const item = crumbsData[i];
        const btn = breadcrumb.createEl("button", {
          cls: `aos-crumb-btn ${item.isLast ? "is-current" : ""}`,
          text: item.label,
          attr: { title: item.isLast ? `当前目录: ${item.path}` : `跳转到: ${item.path}` },
        });
        btn.addEventListener("click", () => options.onSelectFolder(item.path));
        if (!item.isLast) {
          breadcrumb.createSpan({ cls: "aos-crumb-sep", text: "›" });
        }
      }
    }

    window.requestAnimationFrame(() => {
      breadcrumb.scrollLeft = breadcrumb.scrollWidth;
    });

    const countBadge = container.createSpan({ cls: "aos-atlas-count-badge" });
    if (options.countText) {
      countBadge.textContent = options.countText;
    }

    if (options.onCollapse) {
      const collapseBtn = container.createEl("button", {
        cls: "aos-crumb-collapse-btn",
        attr: { "aria-label": options.collapseTitle || "收起笔记列表", title: options.collapseTitle || "收起笔记列表" },
      });
      setIcon(collapseBtn, "panel-left-close");
      collapseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        options.onCollapse!();
      });
    }

    return { containerEl: container, breadcrumbEl: breadcrumb, countBadgeEl: countBadge };
  }

  /**
   * Creates a standardized note stream card with gold left-accent and meta chips.
   */
  static noteCard(parent: HTMLElement, options: AosNoteCardOptions): HTMLElement {
    const isSelected = !!options.isSelected;
    const card = parent.createDiv({
      cls: `aos-atlas-note-card ${isSelected ? "is-selected" : ""}`,
    });

    // Icon
    const iconSpan = card.createSpan({ cls: `aos-atlas-card-icon is-${options.kind || "note"}` });
    setIcon(iconSpan, options.icon || (options.kind === "project" ? "folder" : "file-text"));

    // Body
    const body = card.createDiv({ cls: "aos-atlas-card-body" });
    const titleRow = body.createDiv({ cls: "aos-atlas-card-title-row" });
    titleRow.createSpan({ cls: "aos-atlas-card-title", text: options.title });

    // Meta row
    const metaRow = body.createDiv({ cls: "aos-atlas-card-meta-row" });
    if (options.date) {
      metaRow.createSpan({ cls: "aos-atlas-card-date", text: options.date });
    }
    if (typeof options.relations === "number" && options.relations > 0) {
      metaRow.createSpan({ cls: "aos-atlas-card-relations", text: `🔗 ${options.relations}` });
    }
    if (options.tags && options.tags.length > 0) {
      for (const t of options.tags.slice(0, 2)) {
        metaRow.createSpan({ cls: "aos-atlas-card-tag", text: `#${t}` });
      }
    }

    // Snippet preview
    if (options.snippet) {
      body.createDiv({ cls: "aos-atlas-card-preview", text: options.snippet });
    }

    if (options.onClick) {
      card.addEventListener("click", options.onClick);
    }
    if (options.onDblClick) {
      card.addEventListener("dblclick", options.onDblClick);
    }
    if (options.onContextMenu) {
      card.addEventListener("contextmenu", options.onContextMenu);
    }

    return card;
  }

  /**
   * Creates a standardized panel / graph toolbar.
   */
  static toolbar(parent: HTMLElement, options: AosToolbarOptions): {
    toolbarEl: HTMLElement;
    infoEl: HTMLElement;
    toolsEl: HTMLElement;
    statsEl?: HTMLElement;
  } {
    const toolbar = parent.createDiv({ cls: "aos-atlas-graph-toolbar" });
    const info = toolbar.createDiv({ cls: "aos-atlas-graph-info" });

    if (options.icon) {
      const iconSpan = info.createSpan({ cls: "aos-atlas-folder-icon" });
      setIcon(iconSpan, options.icon);
    }

    info.createSpan({ cls: "aos-atlas-folder-title", text: options.title });
    const tools = toolbar.createDiv({ cls: "aos-atlas-graph-tools" });

    let statsEl: HTMLElement | undefined;
    if (options.stats) {
      statsEl = toolbar.createDiv({ cls: "aos-atlas-graph-stats", text: options.stats });
    }

    return { toolbarEl: toolbar, infoEl: info, toolsEl: tools, statsEl };
  }

  /**
   * Creates a standardized empty state hint.
   */
  static empty(parent: HTMLElement, text: string): HTMLElement {
    return parent.createDiv({ cls: "aos-atlas-empty", text });
  }

  /**
   * Creates a standardized KPI / metric card.
   */
  static metric(parent: HTMLElement, label: string, value: string, detail?: string): HTMLDivElement {
    const card = parent.createDiv({ cls: "aos-metric-card" });
    card.createDiv({ cls: "aos-metric-label", text: label });
    card.createDiv({ cls: "aos-metric-value", text: value });
    if (detail) {
      card.createDiv({ cls: "aos-metric-detail", text: detail });
    }
    return card;
  }

  /**
   * Creates a standardized panel container with optional title, note, and actions.
   */
  static panel(parent: HTMLElement, options?: {
    title?: string;
    note?: string;
    className?: string;
  }): {
    panelEl: HTMLDivElement;
    titleEl?: HTMLDivElement;
    noteEl?: HTMLDivElement;
  } {
    const panel = parent.createDiv({ cls: `aos-panel ${options?.className || ""}`.trim() });
    let titleEl: HTMLDivElement | undefined;
    let noteEl: HTMLDivElement | undefined;

    if (options?.title) {
      titleEl = panel.createDiv({ cls: "aos-panel-title", text: options.title });
    }
    if (options?.note) {
      noteEl = panel.createDiv({ cls: "aos-panel-note", text: options.note });
    }
    return { panelEl: panel, titleEl, noteEl };
  }

  /**
   * Creates a standardized status dot.
   */
  static statusDot(parent: HTMLElement, status: "idle" | "running" | "done" | "failed" | "queued" | "warning"): HTMLSpanElement {
    const dot = parent.createSpan({ cls: "aos-status-dot" });
    if (status === "running") dot.addClass("is-running");
    else if (status === "done") dot.addClass("is-done");
    else if (status === "failed") dot.addClass("is-error");
    else if (status === "queued") dot.addClass("is-queued");
    else if (status === "warning") dot.addClass("is-warning");
    return dot;
  }
}
