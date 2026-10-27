import { LogBus } from "./LogBus";
import { AethericShellState, LogEntry, LogLevel } from "./types";

interface LogDockOptions {
  getState: () => Readonly<AethericShellState>;
  onStateChange: (patch: Partial<AethericShellState["logDock"]>) => void;
}

export class LogDock {
  private root: HTMLDivElement;
  private terminal: HTMLDivElement;
  private followButton: HTMLButtonElement;
  private unseenButton: HTMLButtonElement;
  private maximizeButton: HTMLButtonElement;
  private collapseButton: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private levelSelect: HTMLSelectElement;
  private entries: readonly LogEntry[] = [];
  private follow = true;
  private unseen = 0;
  private search = "";
  private level: LogLevel | "all" = "all";
  private unsubscribe: (() => void) | null = null;
  private pointerMove: ((event: PointerEvent) => void) | null = null;
  private pointerUp: (() => void) | null = null;

  constructor(parent: HTMLElement, bus: LogBus, private options: LogDockOptions) {
    const state = options.getState().logDock;
    this.follow = state.follow;
    this.unseen = state.unseenCount;
    this.root = parent.createDiv({ cls: "aos-log-dock" });
    this.root.style.setProperty("--aos-log-height", `${state.height}px`);
    this.root.classList.toggle("is-maximized", state.maximized);
    this.root.classList.toggle("is-collapsed", !state.open);

    const handle = this.root.createDiv({ cls: "aos-log-resize-handle" });
    handle.addEventListener("pointerdown", event => this.beginResize(event));

    const header = this.root.createDiv({ cls: "aos-log-header" });
    const title = header.createDiv({ cls: "aos-log-title", text: "▥ 实时日志" });
    title.addEventListener("click", () => this.toggleOpen());
    const controls = header.createDiv({ cls: "aos-log-controls" });
    this.searchInput = controls.createEl("input", { cls: "aos-log-search", attr: { placeholder: "搜索日志…" } });
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value.toLocaleLowerCase("zh-CN");
      this.render();
    });
    this.levelSelect = controls.createEl("select", { cls: "aos-log-select" });
    for (const [value, label] of [["all", "全部级别"], ["info", "INFO"], ["success", "SUCCESS"], ["warn", "WARN"], ["error", "ERROR"]]) {
      this.levelSelect.createEl("option", { value, text: label });
    }
    this.levelSelect.addEventListener("change", () => {
      this.level = this.levelSelect.value as LogLevel | "all";
      this.render();
    });
    this.followButton = controls.createEl("button", { cls: "aos-log-button" });
    this.followButton.addEventListener("click", () => this.scrollToBottom());
    this.unseenButton = controls.createEl("button", { cls: "aos-log-button is-unseen" });
    this.unseenButton.addEventListener("click", () => this.scrollToBottom());
    this.maximizeButton = controls.createEl("button", { cls: "aos-log-button" });
    this.maximizeButton.addEventListener("click", () => this.toggleMaximized());
    this.collapseButton = controls.createEl("button", { cls: "aos-log-button is-collapse" });
    this.collapseButton.addEventListener("click", () => this.toggleOpen());
    const clearButton = controls.createEl("button", { cls: "aos-log-button", text: "清空" });
    clearButton.addEventListener("click", () => bus.clear());

    this.terminal = this.root.createDiv({ cls: "aos-log-terminal" });
    this.terminal.addEventListener("scroll", () => this.handleScroll(), { passive: true });
    this.updateControls();

    this.unsubscribe = bus.subscribe((entries, latest) => {
      const shouldFollow = this.follow || this.isNearBottom();
      this.entries = entries;
      const open = this.options.getState().logDock.open;
      if (open) {
        if (latest) this.appendEntry(latest);
        else this.render();
      }
      if (latest && open && shouldFollow) requestAnimationFrame(() => this.scrollToBottom(false));
      if (latest && !shouldFollow) {
        this.follow = false;
        this.unseen += 1;
        this.persistFollowState();
      } else if (!open) {
        // A collapsed dock is a status strip, not a hidden 500-row terminal.
        // Keep the data snapshot and controls current without touching the DOM.
        this.updateControls();
      }
    });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.removeResizeListeners();
  }

  private render(): void {
    if (!this.options.getState().logDock.open) {
      this.updateControls();
      return;
    }
    const wasNearBottom = this.isNearBottom();
    this.terminal.empty();
    for (const entry of this.entries) if (this.matches(entry)) this.renderEntry(entry);
    if (this.follow && wasNearBottom) requestAnimationFrame(() => this.scrollToBottom(false));
    this.updateControls();
  }

  private appendEntry(entry: LogEntry): void {
    if (!this.matches(entry)) return;
    this.renderEntry(entry);
    // LogBus keeps at most 500 records. Incremental painting should mirror that
    // bound instead of rebuilding every existing row for each route click.
    const oldestId = this.entries[0]?.id ?? entry.id;
    while (this.terminal.firstElementChild instanceof HTMLElement) {
      const rowId = Number(this.terminal.firstElementChild.dataset.logId ?? oldestId);
      if (rowId >= oldestId) break;
      this.terminal.firstElementChild.remove();
    }
  }

  private matches(entry: LogEntry): boolean {
    if (this.level !== "all" && entry.level !== this.level) return false;
    if (!this.search) return true;
    return `${entry.source} ${entry.message}`.toLocaleLowerCase("zh-CN").includes(this.search);
  }

  private renderEntry(entry: LogEntry): void {
    const row = this.terminal.createDiv({ cls: `aos-log-row is-${entry.level}` });
    row.dataset.logId = `${entry.id}`;
    row.createSpan({ cls: "aos-log-time", text: new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false }) });
    row.createSpan({ cls: "aos-log-level", text: entry.level.toUpperCase() });
    row.createSpan({ cls: "aos-log-source", text: entry.source });
    row.createSpan({ cls: "aos-log-message", text: entry.message });
    if (entry.durationMs !== undefined) row.createSpan({ cls: "aos-log-duration", text: `${entry.durationMs}ms` });
  }

  private handleScroll(): void {
    const nearBottom = this.isNearBottom();
    if (nearBottom === this.follow && (nearBottom || this.unseen === 0)) return;
    this.follow = nearBottom;
    if (nearBottom) this.unseen = 0;
    this.persistFollowState();
  }

  private isNearBottom(): boolean {
    return this.terminal.scrollHeight - this.terminal.scrollTop - this.terminal.clientHeight < 48;
  }

  private scrollToBottom(persist = true): void {
    this.follow = true;
    this.unseen = 0;
    this.terminal.scrollTop = this.terminal.scrollHeight;
    if (persist) this.persistFollowState();
    else this.updateControls();
  }

  private persistFollowState(): void {
    this.options.onStateChange({ follow: this.follow, unseenCount: this.unseen });
    this.updateControls();
  }

  private toggleMaximized(): void {
    const maximized = !this.options.getState().logDock.maximized;
    this.root.classList.toggle("is-maximized", maximized);
    this.options.onStateChange({ maximized });
    this.updateControls();
    if (this.follow) requestAnimationFrame(() => this.scrollToBottom(false));
  }

  private toggleOpen(): void {
    const current = this.options.getState().logDock;
    const open = !current.open;
    this.root.classList.toggle("is-collapsed", !open);
    if (!open && current.maximized) this.root.classList.remove("is-maximized");
    this.options.onStateChange({ open, maximized: open ? current.maximized : false });
    if (open) this.render();
    else this.terminal.empty();
    this.updateControls();
    if (open && this.follow) requestAnimationFrame(() => this.scrollToBottom(false));
  }

  private updateControls(): void {
    this.followButton.textContent = this.follow ? "↓ 跟随中" : "⏸ 已暂停";
    this.followButton.classList.toggle("is-paused", !this.follow);
    this.unseenButton.textContent = `↓ ${this.unseen} 条新日志`;
    this.unseenButton.classList.toggle("is-visible", !this.follow && this.unseen > 0);
    this.maximizeButton.textContent = this.options.getState().logDock.maximized ? "还原" : "展开日志";
    this.collapseButton.textContent = this.options.getState().logDock.open ? "收起" : "展开";
  }

  private beginResize(event: PointerEvent): void {
    if (this.options.getState().logDock.maximized || !this.options.getState().logDock.open) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.root.getBoundingClientRect().height;
    let latestHeight = startHeight;
    this.pointerMove = moveEvent => {
      latestHeight = Math.max(96, Math.min(window.innerHeight * 0.72, startHeight + startY - moveEvent.clientY));
      this.root.style.setProperty("--aos-log-height", `${latestHeight}px`);
    };
    this.pointerUp = () => {
      this.options.onStateChange({ height: Math.round(latestHeight) });
      this.removeResizeListeners();
    };
    document.addEventListener("pointermove", this.pointerMove);
    document.addEventListener("pointerup", this.pointerUp, { once: true });
  }

  private removeResizeListeners(): void {
    if (this.pointerMove) document.removeEventListener("pointermove", this.pointerMove);
    if (this.pointerUp) document.removeEventListener("pointerup", this.pointerUp);
    this.pointerMove = null;
    this.pointerUp = null;
  }
}
