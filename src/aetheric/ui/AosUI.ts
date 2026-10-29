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

export interface AosDeckButtonOptions {
  label: string;
  icon?: string;
  isDanger?: boolean;
  isDisabled?: boolean;
  title?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

export interface AosSegmentedTabItem {
  id: string;
  label: string;
  icon?: string;
}

export interface AosSegmentedControlOptions {
  tabs: AosSegmentedTabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export interface AosSearchCapsuleOptions {
  placeholder?: string;
  value?: string;
  onInput: (val: string) => void;
  className?: string;
}

export interface AosStatusBadgeOptions {
  online: boolean;
  onlineText?: string;
  offlineText?: string;
  className?: string;
}

export interface AosActionPillOptions {
  label: string;
  icon?: string;
  title?: string;
  onClick?: (event: MouseEvent) => void;
  className?: string;
}

export interface AosChatComposerOptions {
  placeholder?: string;
  activeNoteTitle?: string;
  planPendingText?: string;
  inboxPendingText?: string;
  presets?: Array<{ label: string; prompt: string }>;
  onSend: (text: string) => void;
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

  /**
   * Creates a warm ivory micro-card deck button (strictly matching 图四「松果阁总坛」style).
   */
  static deckButton(parent: HTMLElement, options: AosDeckButtonOptions): HTMLButtonElement {
    const dangerClass = options.isDanger ? "is-danger" : "";
    const extraClass = options.className || "";
    const btn = parent.createEl("button", {
      cls: `aos-hermes-deck-btn ${dangerClass} ${extraClass}`.trim(),
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
      const iconSpan = btn.createSpan({ cls: "aos-hermes-deck-btn-icon" });
      setIcon(iconSpan, options.icon);
    }

    btn.createSpan({ cls: "aos-hermes-deck-btn-text", text: options.label });

    if (options.onClick) {
      btn.addEventListener("click", (e) => {
        if (!btn.disabled) options.onClick!(e);
      });
    }

    return btn;
  }

  /**
   * Creates a Segmented Control (Pill-shaped slider tabs) container.
   */
  static segmentedControl(parent: HTMLElement, options: AosSegmentedControlOptions): {
    containerEl: HTMLElement;
    buttons: Map<string, HTMLButtonElement>;
  } {
    const container = parent.createDiv({
      cls: `aos-hermes-tabs ${options.className || ""}`.trim(),
    });
    const buttons = new Map<string, HTMLButtonElement>();

    for (const tab of options.tabs) {
      const isActive = tab.id === options.activeId;
      const btn = container.createEl("button", {
        cls: `aos-hermes-tab-btn ${isActive ? "is-active" : ""}`,
        attr: { type: "button" },
      });

      if (tab.icon) {
        const iconSpan = btn.createSpan({ cls: "aos-hermes-tab-icon" });
        setIcon(iconSpan, tab.icon);
      }
      btn.createSpan({ text: tab.label });

      btn.addEventListener("click", () => {
        options.onChange(tab.id);
      });

      buttons.set(tab.id, btn);
    }

    return { containerEl: container, buttons };
  }

  /**
   * Creates a 100% overlap-free Flexbox search capsule.
   */
  static searchCapsule(parent: HTMLElement, options: AosSearchCapsuleOptions): {
    containerEl: HTMLElement;
    inputEl: HTMLInputElement;
  } {
    const wrap = parent.createDiv({
      cls: `aos-hermes-search-wrap ${options.className || ""}`.trim(),
    });
    const iconSpan = wrap.createSpan({ cls: "aos-hermes-search-icon" });
    setIcon(iconSpan, "search");

    const input = wrap.createEl("input", {
      cls: "aos-hermes-search",
      attr: {
        type: "text",
        placeholder: options.placeholder || "搜索…",
      },
    });

    if (options.value) {
      input.value = options.value;
    }

    input.addEventListener("input", () => {
      options.onInput(input.value);
    });

    return { containerEl: wrap, inputEl: input };
  }

  /**
   * Creates an Aetheric status badge (5px breathing pulse dot).
   */
  static statusBadge(parent: HTMLElement, options: AosStatusBadgeOptions): HTMLSpanElement {
    const isOnline = options.online;
    const badge = parent.createSpan({
      cls: `aos-hermes-badge ${isOnline ? "is-online" : "is-offline"} ${options.className || ""}`.trim(),
    });

    const text = isOnline
      ? (options.onlineText || "灵台通达")
      : (options.offlineText || "离线");
    badge.setText(text);

    return badge;
  }

  /**
   * Creates an Aetheric action pill (24px minimal gold pill button).
   */
  static actionPill(parent: HTMLElement, options: AosActionPillOptions): HTMLButtonElement {
    const pill = parent.createEl("button", {
      cls: `aos-hermes-action-pill ${options.className || ""}`.trim(),
      attr: { type: "button" },
    });

    if (options.title) {
      pill.setAttribute("title", options.title);
    }

    if (options.icon) {
      const iconSpan = pill.createSpan({ cls: "aos-hermes-pill-icon" });
      setIcon(iconSpan, options.icon);
    }

    pill.createSpan({ text: options.label });

    if (options.onClick) {
      pill.addEventListener("click", (e) => options.onClick!(e));
    }

    return pill;
  }

  /**
   * Creates a modern AI chat composer with context chip, amber shuttle button, and quick chips.
   */
  static chatComposer(parent: HTMLElement, options: AosChatComposerOptions): {
    composerEl: HTMLElement;
    inputEl: HTMLTextAreaElement;
    sendBtnEl: HTMLButtonElement;
    setSending: (sending: boolean) => void;
  } {
    const composer = parent.createDiv({ cls: "aos-hermes-composer" });

    // Context chips (Active Note + Today Plan + Mobile Inbox perception)
    if (options.activeNoteTitle || options.planPendingText || options.inboxPendingText) {
      const chipsContainer = composer.createDiv({ cls: "aos-hermes-context-chips-container" });
      if (options.activeNoteTitle) {
        const chip = chipsContainer.createDiv({ cls: "aos-hermes-context-chip" });
        const pin = chip.createSpan({ cls: "aos-hermes-chip-icon" });
        setIcon(pin, "paperclip");
        chip.createSpan({ text: `已挂载当前笔记: ${options.activeNoteTitle}` });
      }
      if (options.planPendingText) {
        const planChip = chipsContainer.createDiv({ cls: "aos-hermes-context-chip is-plan" });
        const cal = planChip.createSpan({ cls: "aos-hermes-chip-icon" });
        setIcon(cal, "calendar");
        planChip.createSpan({ text: options.planPendingText });
      }
      if (options.inboxPendingText) {
        const inboxChip = chipsContainer.createDiv({ cls: "aos-hermes-context-chip is-inbox" });
        const phone = inboxChip.createSpan({ cls: "aos-hermes-chip-icon" });
        setIcon(phone, "smartphone");
        inboxChip.createSpan({ text: options.inboxPendingText });
      }
    }

    // Input box capsule
    const inputBox = composer.createDiv({ cls: "aos-hermes-input-box" });
    const textarea = inputBox.createEl("textarea", {
      cls: "aos-hermes-textarea",
      attr: {
        placeholder: options.placeholder || "输入指令... (Enter 发送, Shift+Enter 换行)",
        rows: "2",
      },
    });

    const sendBtn = inputBox.createEl("button", {
      cls: "aos-hermes-send-btn",
      attr: { type: "button", "aria-label": "发送指令", disabled: "true" },
    });
    setIcon(sendBtn, "arrow-up");

    let isSending = false;

    const updateSendBtnState = () => {
      const hasText = Boolean(textarea.value.trim());
      if (hasText && !isSending) {
        sendBtn.removeAttribute("disabled");
        sendBtn.classList.add("is-active");
      } else {
        sendBtn.setAttribute("disabled", "true");
        sendBtn.classList.remove("is-active");
      }
    };

    textarea.addEventListener("input", updateSendBtnState);

    const doSend = () => {
      const text = textarea.value.trim();
      if (!text || isSending) return;
      options.onSend(text);
    };

    sendBtn.addEventListener("click", doSend);
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // Quick prompt chips
    if (options.presets && options.presets.length > 0) {
      const quickBar = composer.createDiv({ cls: "aos-hermes-quick-chips" });
      for (const p of options.presets) {
        const chip = quickBar.createSpan({ cls: "aos-hermes-preset-pill", text: p.label });
        chip.addEventListener("click", () => {
          textarea.value = `${p.prompt} \n`;
          textarea.focus();
          updateSendBtnState();
        });
      }
    }

    const setSending = (sending: boolean) => {
      isSending = sending;
      updateSendBtnState();
    };

    return { composerEl: composer, inputEl: textarea, sendBtnEl: sendBtn, setSending };
  }
}
