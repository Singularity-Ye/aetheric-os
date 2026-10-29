import { Notice, setIcon, TFile } from "obsidian";
import { HermesClient, type HermesMessage, type HermesSession } from "../HermesClient";
import { AosUI } from "../ui/AosUI";

export interface TasksPageContext {
  plugin: any;
  metric: (parent: HTMLElement, label: string, value: string, detail: string) => HTMLElement;
  renderTaskList: (parent: HTMLElement, tasks: any[], mini: boolean) => void;
  renderArtifactList: (parent: HTMLElement, artifacts: readonly any[]) => void;
}

/**
 * TasksPage: High-craft, Antigravity-grade dual-pane Hermes Agent Mission Control.
 * Unified with Aetheric OS ivory/walnut-gold design language, with rock-solid scroll stability.
 */
export class TasksPage {
  private hermes = new HermesClient();
  private sessions: HermesSession[] = [];
  private activeSessionId: string | null = null;
  private messages: HermesMessage[] = [];
  private activeTab: "sessions" | "plan" | "daemon" = "sessions";
  private searchQuery = "";
  private isSending = false;
  private health: { online: boolean; model?: string; sessionCount: number } = {
    online: false,
    model: "gpt-5.6-luna",
    sessionCount: 0,
  };

  private containerEl!: HTMLElement;
  private messageListEl!: HTMLElement;
  private composerInputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private sessionListContainerEl!: HTMLElement;

  /** Track user scrolling so background updates do not yank scroll position */
  private userScrolledUp = false;

  constructor(private context: TasksPageContext) {}

  async mount(parent: HTMLElement): Promise<void> {
    if (this.containerEl && this.containerEl.parentElement === parent) {
      this.render();
      return;
    }

    this.containerEl = parent.createDiv({ cls: "aos-page aos-hermes-workbench" });

    // Initial health probe & load
    this.health = await this.hermes.checkHealth();
    if (this.health.online) {
      this.sessions = await this.hermes.listSessions(60);
      if (this.sessions.length > 0 && !this.activeSessionId) {
        this.activeSessionId = this.sessions[0].id;
      }
    }

    this.render();
  }

  onDaemonUpdate(): void {
    if (this.activeTab === "daemon") {
      this.renderMain();
    }
  }

  private render(): void {
    this.containerEl.empty();
    this.renderSidebar();
    this.renderMain();
  }

  // ==========================================================================
  // Left Sidebar: Session & Task Rail
  // ==========================================================================
  private renderSidebar(): void {
    const sidebar = this.containerEl.createDiv({ cls: "aos-hermes-sidebar" });
    const header = sidebar.createDiv({ cls: "aos-hermes-sidebar-header" });

    // Header badge
    const brandLine = header.createDiv({ cls: "aos-hermes-brand-line" });
    const logoSpan = brandLine.createSpan({ cls: "aos-hermes-brand-icon" });
    setIcon(logoSpan, "bot");
    brandLine.createSpan({ cls: "aos-hermes-brand-title", text: "智能体工造作战室" });

    // + New Conversation Button (Gold Relief Style)
    const newBtn = header.createEl("button", {
      cls: "aos-hermes-new-btn",
      attr: { type: "button", title: "开启新的 Hermes 对话与工造任务" },
    });
    const plusIcon = newBtn.createSpan({ cls: "aos-hermes-new-btn-icon" });
    setIcon(plusIcon, "plus");
    newBtn.createSpan({ cls: "aos-hermes-new-btn-text", text: "新建工造会话" });
    newBtn.addEventListener("click", () => void this.handleCreateSession());

    // Search input bar
    const searchWrapper = header.createDiv({ cls: "aos-hermes-search-wrap" });
    const searchIcon = searchWrapper.createSpan({ cls: "aos-hermes-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrapper.createEl("input", {
      cls: "aos-hermes-search",
      attr: { type: "text", placeholder: "搜索会话或工造任务..." },
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener("input", () => {
      this.searchQuery = searchInput.value.toLowerCase().trim();
      if (this.sessionListContainerEl) {
        this.renderSessionList(this.sessionListContainerEl);
      }
    });

    // Sub-mode tabs: Segmented Control
    const tabs = header.createDiv({ cls: "aos-hermes-tabs" });
    const tabConfigs: Array<{ id: "sessions" | "plan" | "daemon"; label: string; icon: string }> = [
      { id: "sessions", label: "会话", icon: "message-square" },
      { id: "plan", label: "账本", icon: "calendar-check" },
      { id: "daemon", label: "守护", icon: "radio" },
    ];

    for (const t of tabConfigs) {
      const btn = tabs.createEl("button", {
        cls: `aos-hermes-tab-btn ${this.activeTab === t.id ? "is-active" : ""}`,
      });
      const iconSpan = btn.createSpan({ cls: "aos-hermes-tab-icon" });
      setIcon(iconSpan, t.icon);
      btn.createSpan({ text: t.label });
      btn.addEventListener("click", () => {
        this.activeTab = t.id;
        this.render();
      });
    }

    // Scrollable List container
    this.sessionListContainerEl = sidebar.createDiv({ cls: "aos-hermes-session-list" });
    if (this.activeTab === "sessions") {
      this.renderSessionList(this.sessionListContainerEl);
    } else {
      this.renderAlternateSidebarMeta(this.sessionListContainerEl);
    }
  }

  private renderSessionList(container: HTMLElement): void {
    container.empty();
    const filtered = this.sessions.filter((s) =>
      this.searchQuery ? (s.title || s.id).toLowerCase().includes(this.searchQuery) : true
    );

    if (filtered.length === 0) {
      const empty = container.createDiv({ cls: "aos-empty-hint", attr: { style: "padding: 30px 14px;" } });
      empty.createSpan({
        text: this.health.online ? "未发现匹配的工造会话" : "🔴 Hermes Gateway 离线 (8642)",
      });
      return;
    }

    for (const s of filtered) {
      const isActive = s.id === this.activeSessionId;
      const item = container.createDiv({ cls: `aos-hermes-session-item ${isActive ? "is-active" : ""}` });

      const titleRow = item.createDiv({ cls: "aos-hermes-session-title" });
      const dot = titleRow.createSpan({ cls: "aos-hermes-status-dot is-online" });
      titleRow.createSpan({ cls: "aos-hermes-session-title-text", text: s.title || s.id });

      const metaRow = item.createDiv({ cls: "aos-hermes-session-meta" });
      metaRow.createSpan({ cls: "aos-hermes-session-time", text: this.formatRelativeTime(s.last_active || s.started_at) });
      if (s.message_count) {
        const countBadge = metaRow.createSpan({ cls: "aos-hermes-count-badge" });
        countBadge.setText(`${s.message_count} 交互`);
      }

      item.addEventListener("click", () => {
        if (this.activeSessionId === s.id) return;
        this.activeSessionId = s.id;
        this.userScrolledUp = false;
        this.render();
      });
    }
  }

  private renderAlternateSidebarMeta(container: HTMLElement): void {
    container.empty();
    const box = container.createDiv({ cls: "aos-hermes-meta-card" });
    if (this.activeTab === "plan") {
      box.createEl("h4", { text: "📋 计划账本 (PlanLedger)" });
      box.createEl("p", {
        cls: "aos-panel-note",
        text: "统筹仙尊规划与 Agent 自动化任务的完整执行流。支持查看排队、执行中、待审阅和已完成的工造交付产物。",
      });
    } else {
      box.createEl("h4", { text: "⚙️ 后台守护 (Daemon)" });
      box.createEl("p", {
        cls: "aos-panel-note",
        text: "底层 Hamasxiang 抓取爬虫与 X Watch 守护进程。专司多平台凭据与持久化数据管线，保持静默自愈。",
      });
    }
  }

  // ==========================================================================
  // Right Main Deck: Chat & Mission Control
  // ==========================================================================
  private renderMain(): void {
    const main = this.containerEl.createDiv({ cls: "aos-hermes-main" });

    if (this.activeTab === "plan") {
      this.renderPlanLedgerDeck(main);
      return;
    }
    if (this.activeTab === "daemon") {
      this.renderDaemonDeck(main);
      return;
    }

    // Top Header
    const activeSession = this.sessions.find((s) => s.id === this.activeSessionId);
    const header = main.createDiv({ cls: "aos-hermes-header" });

    const leftArea = header.createDiv({ cls: "aos-hermes-header-left" });
    const botWrap = leftArea.createSpan({ cls: "aos-hermes-header-icon-wrap" });
    const botIcon = botWrap.createSpan({ cls: "aos-hermes-header-icon" });
    setIcon(botIcon, "bot");

    leftArea.createSpan({
      cls: "aos-hermes-header-title",
      text: activeSession?.title || "Hermes Agent 工造作战室",
    });

    const modelName = activeSession?.model || this.health.model || "gpt-5.6-luna";
    const badge = leftArea.createSpan({
      cls: `aos-hermes-badge ${this.health.online ? "is-online" : "is-offline"}`,
    });
    badge.setText(
      this.health.online
        ? `灵台通达 · ${modelName}`
        : "离线 (127.0.0.1:8642)"
    );

    // Right Deck Actions (Warm Ivory & Gold border, strictly matching 图四 style)
    const actions = header.createDiv({ cls: "aos-hermes-deck-actions" });
    const refreshBtn = actions.createEl("button", {
      cls: "aos-hermes-deck-btn",
      attr: { type: "button", title: "刷新会话交互" },
    });
    const refIcon = refreshBtn.createSpan({ cls: "aos-hermes-deck-btn-icon" });
    setIcon(refIcon, "rotate-cw");
    refreshBtn.createSpan({ text: "刷新" });
    refreshBtn.addEventListener("click", () => void this.reloadCurrentSession());

    if (this.activeSessionId) {
      const delBtn = actions.createEl("button", {
        cls: "aos-hermes-deck-btn is-danger",
        attr: { type: "button", title: "删除此工造会话" },
      });
      const delIcon = delBtn.createSpan({ cls: "aos-hermes-deck-btn-icon" });
      setIcon(delIcon, "trash-2");
      delBtn.createSpan({ text: "删除会话" });
      delBtn.addEventListener("click", () => void this.handleDeleteSession());
    }

    // Message Stream container with scroll listener
    this.messageListEl = main.createDiv({ cls: "aos-hermes-messages" });
    this.messageListEl.addEventListener("scroll", () => {
      const distanceFromBottom =
        this.messageListEl.scrollHeight - this.messageListEl.scrollTop - this.messageListEl.clientHeight;
      this.userScrolledUp = distanceFromBottom > 100;
    });

    void this.loadAndRenderMessages();

    // Bottom Composer
    this.renderComposer(main);
  }

  private async loadAndRenderMessages(): Promise<void> {
    if (!this.activeSessionId) {
      this.renderEmptyState(this.messageListEl);
      return;
    }
    this.messageListEl.empty();
    const loading = this.messageListEl.createDiv({
      cls: "aos-empty-hint",
      text: "正在加载会话交互...",
      attr: { style: "margin: auto;" },
    });

    this.messages = await this.hermes.getSessionMessages(this.activeSessionId);
    loading.remove();

    if (this.messages.length === 0) {
      this.renderEmptyState(this.messageListEl);
      return;
    }

    for (const msg of this.messages) {
      this.renderMessageBubble(this.messageListEl, msg);
    }

    // Stable auto-scroll: only snap to bottom if user has not scrolled up
    if (!this.userScrolledUp) {
      this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
    }
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "aos-hermes-empty-state" });
    const icon = empty.createSpan({ cls: "aos-empty-icon" });
    setIcon(icon, "sparkles");
    empty.createEl("h3", { text: "松果天工台 · Hermes Agent" });
    empty.createEl("p", {
      cls: "aos-panel-note",
      text: "输入指令或从下方快速卡片开始，驱动 Hermes 读取知识库、执行抓取与自动化工造。",
    });

    const cards = empty.createDiv({ cls: "aos-hermes-empty-cards" });
    const promptPresets = [
      "💡 提炼今日收件箱中的灵感，按《05_屋主手札》规范生成架构思考",
      "📊 深度分析 Parallax 交易状态机算法与单测覆盖",
      "🔍 梳理《博德之门3》构筑策略并归入生活簿/游艺录",
      "📅 规划今日松果天工台的开发任务与执行计划",
    ];

    for (const p of promptPresets) {
      const card = cards.createDiv({ cls: "aos-hermes-prompt-card", text: p });
      card.addEventListener("click", () => {
        if (this.composerInputEl) {
          this.composerInputEl.value = p;
          this.composerInputEl.focus();
          if (this.sendBtnEl) {
            this.sendBtnEl.removeAttribute("disabled");
            this.sendBtnEl.classList.add("is-active");
          }
        }
      });
    }
  }

  private renderMessageBubble(container: HTMLElement, msg: HermesMessage): void {
    const isUser = msg.role === "user";
    const bubble = container.createDiv({
      cls: isUser ? "aos-hermes-msg-user" : "aos-hermes-msg-assistant",
    });

    // Assistant Header with thinking & tools
    if (!isUser) {
      const headerRow = bubble.createDiv({ cls: "aos-hermes-msg-header" });
      const leftTag = headerRow.createSpan({ cls: "aos-hermes-author-badge" });
      const botIco = leftTag.createSpan();
      setIcon(botIco, "bot");
      leftTag.createSpan({ text: "Hermes Agent" });

      headerRow.createSpan({
        cls: "aos-hermes-msg-time",
        text: this.formatTimestamp(msg.timestamp),
      });

      // Thinking details callout if available
      const reasoning = msg.reasoning || msg.reasoning_content;
      if (reasoning) {
        const details = bubble.createEl("details", { cls: "aos-hermes-thinking" });
        const summary = details.createEl("summary");
        const thinkIco = summary.createSpan();
        setIcon(thinkIco, "sparkles");
        summary.createSpan({ text: " 深度思考过程 (Thinking)" });
        details.createDiv({ cls: "aos-hermes-thinking-content", text: reasoning });
      }

      // Tool calls if available
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const tcBox = bubble.createDiv({ cls: "aos-hermes-tool-call" });
          const gear = tcBox.createSpan();
          setIcon(gear, "settings");
          tcBox.createSpan({ text: ` 工具调用: ${tc.function?.name || "未知工具"}` });
        }
      }
    } else {
      const headerRow = bubble.createDiv({ cls: "aos-hermes-msg-header is-user" });
      headerRow.createSpan({ text: `👑 仙尊 · ${this.formatTimestamp(msg.timestamp)}` });
    }

    // Message Content with Markdown & Wikilinks parsing
    const contentEl = bubble.createDiv({ cls: "aos-hermes-msg-content" });
    this.renderMarkdownWithWikilinks(contentEl, msg.content);

    // Assistant Action Pills (Refined Aetheric Style with Vector Icons)
    if (!isUser && msg.content) {
      const actions = bubble.createDiv({ cls: "aos-hermes-actions-row" });

      const pinBtn = actions.createEl("button", { cls: "aos-hermes-action-pill" });
      const pinIcon = pinBtn.createSpan({ cls: "aos-hermes-pill-icon" });
      setIcon(pinIcon, "feather");
      pinBtn.createSpan({ text: "写入松果池" });
      pinBtn.addEventListener("click", () => void this.writeToInbox(msg.content));

      const scheduleBtn = actions.createEl("button", { cls: "aos-hermes-action-pill" });
      const calIcon = scheduleBtn.createSpan({ cls: "aos-hermes-pill-icon" });
      setIcon(calIcon, "calendar-plus");
      scheduleBtn.createSpan({ text: "挂入今日日程" });
      scheduleBtn.addEventListener("click", () => void this.createScheduleFromText(msg.content));

      const copyBtn = actions.createEl("button", { cls: "aos-hermes-action-pill" });
      const cpIcon = copyBtn.createSpan({ cls: "aos-hermes-pill-icon" });
      setIcon(cpIcon, "copy");
      copyBtn.createSpan({ text: "复制正文" });
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(msg.content);
        new Notice("已复制到剪贴板");
      });
    }
  }

  // ==========================================================================
  // Bottom Composer Deck
  // ==========================================================================
  private renderComposer(parent: HTMLElement): void {
    const composer = parent.createDiv({ cls: "aos-hermes-composer" });

    // Active Note context chip
    const activeFile = this.context.plugin.app.workspace.getActiveFile();
    if (activeFile instanceof TFile) {
      const chip = composer.createDiv({ cls: "aos-hermes-context-chip" });
      const pin = chip.createSpan();
      setIcon(pin, "paperclip");
      chip.createSpan({ text: `已挂载当前笔记: ${activeFile.basename}` });
    }

    // Input box
    const inputBox = composer.createDiv({ cls: "aos-hermes-input-box" });
    this.composerInputEl = inputBox.createEl("textarea", {
      cls: "aos-hermes-textarea",
      attr: { placeholder: "向 Hermes 下达工造指令... (Enter 发送, Shift+Enter 换行)", rows: "2" },
    });

    this.sendBtnEl = inputBox.createEl("button", {
      cls: "aos-hermes-send-btn",
      attr: { type: "button", "aria-label": "发送指令", disabled: "true" },
    });
    setIcon(this.sendBtnEl, "arrow-up");

    const updateSendBtnState = () => {
      const hasText = Boolean(this.composerInputEl.value.trim());
      if (hasText && !this.isSending) {
        this.sendBtnEl.removeAttribute("disabled");
        this.sendBtnEl.classList.add("is-active");
      } else {
        this.sendBtnEl.setAttribute("disabled", "true");
        this.sendBtnEl.classList.remove("is-active");
      }
    };

    this.composerInputEl.addEventListener("input", updateSendBtnState);

    const doSend = () => {
      const text = this.composerInputEl.value.trim();
      if (!text || this.isSending) return;
      void this.handleSendMessage(text);
    };

    this.sendBtnEl.addEventListener("click", doSend);
    this.composerInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });

    // Quick prompt chips
    const quickBar = composer.createDiv({ cls: "aos-hermes-quick-chips" });
    const presets = [
      { label: "✦ 提炼为手札", prompt: "请读取当前笔记，按照《05_屋主手札》规范提炼核心认知突破与行动要点：" },
      { label: "✦ 架构解耦分析", prompt: "请结合当前工程，给出高内聚低耦合的架构重构方案与单测设计：" },
      { label: "✦ 生成执行计划", prompt: "请将当前需求拆解为 PlanLedger 结构化任务与分步里程碑：" },
    ];
    for (const p of presets) {
      const chip = quickBar.createSpan({ cls: "aos-hermes-preset-pill", text: p.label });
      chip.addEventListener("click", () => {
        this.composerInputEl.value = `${p.prompt} \n`;
        this.composerInputEl.focus();
        updateSendBtnState();
      });
    }
  }

  // ==========================================================================
  // PlanLedger & Daemon Alternate Decks
  // ==========================================================================
  private renderPlanLedgerDeck(parent: HTMLElement): void {
    const deck = parent.createDiv({ cls: "aos-page" });
    const heading = deck.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "计划账本 (PlanLedger)" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "统筹仙尊规划与 Agent 自动化任务的完整执行流。" });

    const summary = deck.createDiv({ cls: "aos-metric-grid" });
    this.context.metric(summary, "执行模式", "Agent / Manual", "双向调度");
    this.context.metric(summary, "状态机", "queued → executing → review", "带防篡改校验");

    const artifacts = deck.createDiv({ cls: "aos-panel" });
    artifacts.createDiv({ cls: "aos-panel-title", text: "已产出交付物 (Artifacts)" });
    this.context.renderArtifactList(artifacts, this.context.plugin.hamasxiangAdapter?.getArtifacts() || []);
  }

  private renderDaemonDeck(parent: HTMLElement): void {
    const deck = parent.createDiv({ cls: "aos-page" });
    const heading = deck.createDiv({ cls: "aos-page-heading" });
    heading.createDiv({ cls: "aos-page-title", text: "后台任务与抓取守护 (Daemon)" });
    heading.createDiv({ cls: "aos-page-subtitle", text: "展示本地 Hamasxiang 爬虫进程状态与操作。" });

    const tasks = this.context.plugin.hamasxiangAdapter?.getTasks() || [];
    const active = deck.createDiv({ cls: "aos-panel aos-task-adapter" });
    active.createDiv({ cls: "aos-panel-title", text: "真实任务快照" });
    this.context.renderTaskList(active, tasks, false);
  }

  // ==========================================================================
  // Handlers & Business Logic
  // ==========================================================================
  private async handleCreateSession(): Promise<void> {
    const session = await this.hermes.createSession();
    if (session) {
      this.sessions.unshift(session);
      this.activeSessionId = session.id;
      this.userScrolledUp = false;
      this.render();
      new Notice(`已创建新工造会话：${session.title}`);
    } else {
      new Notice("创建会话失败，请确认 Hermes Gateway (8642) 运行正常");
    }
  }

  private async handleDeleteSession(): Promise<void> {
    if (!this.activeSessionId) return;
    const toDelete = this.activeSessionId;
    const ok = await this.hermes.deleteSession(toDelete);
    if (ok) {
      this.sessions = this.sessions.filter((s) => s.id !== toDelete);
      this.activeSessionId = this.sessions[0]?.id || null;
      this.userScrolledUp = false;
      this.render();
      new Notice("已删除该工造会话");
    } else {
      new Notice("删除会话失败");
    }
  }

  private async reloadCurrentSession(): Promise<void> {
    this.health = await this.hermes.checkHealth();
    this.sessions = await this.hermes.listSessions(60);
    this.render();
    new Notice("已刷新会话状态");
  }

  private async handleSendMessage(text: string): Promise<void> {
    if (!this.activeSessionId) {
      const newSession = await this.hermes.createSession(text.slice(0, 24));
      if (!newSession) return;
      this.sessions.unshift(newSession);
      this.activeSessionId = newSession.id;
    }

    this.composerInputEl.value = "";
    if (this.sendBtnEl) {
      this.sendBtnEl.setAttribute("disabled", "true");
      this.sendBtnEl.classList.remove("is-active");
    }
    this.isSending = true;
    this.userScrolledUp = false;

    // Immediately push optimistic user message
    this.messages.push({
      role: "user",
      content: text,
      timestamp: Date.now() / 1000,
    });
    this.renderMessageBubble(this.messageListEl, this.messages[this.messages.length - 1]);
    this.messageListEl.scrollTop = this.messageListEl.scrollHeight;

    // Show typing indicator
    const typingIndicator = this.messageListEl.createDiv({
      cls: "aos-hermes-msg-assistant aos-hermes-typing",
    });
    const typingSpan = typingIndicator.createSpan();
    setIcon(typingSpan, "loader");
    typingIndicator.createSpan({ text: " Hermes 正在深入思考与执行工造..." });

    try {
      const response = await this.hermes.sendMessage(this.activeSessionId, text);
      typingIndicator.remove();
      if (response && response.message) {
        await this.loadAndRenderMessages();
      } else {
        new Notice("Hermes 未返回有效响应");
      }
    } catch (err) {
      typingIndicator.remove();
      new Notice(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isSending = false;
      if (this.composerInputEl && this.sendBtnEl) {
        const hasText = Boolean(this.composerInputEl.value.trim());
        if (hasText) {
          this.sendBtnEl.removeAttribute("disabled");
          this.sendBtnEl.classList.add("is-active");
        }
      }
    }
  }

  private async writeToInbox(content: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const title = `Hermes提炼_${Date.now().toString().slice(-4)}`;
    const path = `00_松果池（收件箱）/微信想法/${today}_${title}.md`;
    try {
      await this.context.plugin.app.vault.create(path, content);
      new Notice(`已成功落库到松果池: ${title}`);
    } catch (e) {
      new Notice(`写入失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async createScheduleFromText(content: string): Promise<void> {
    const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").slice(0, 30) || "Hermes 工造待办";
    try {
      await this.context.plugin.planLedger?.createPlanItem({
        title: firstLine,
        kind: "task",
        date: new Date().toISOString().slice(0, 10),
        scheduled: true,
        start: "10:00",
        end: "11:00",
      });
      new Notice(`已挂入今日日程: ${firstLine}`);
    } catch {
      new Notice("挂入日程失败");
    }
  }

  // ==========================================================================
  // Helpers & Formatting
  // ==========================================================================
  private renderMarkdownWithWikilinks(container: HTMLElement, raw: string): void {
    if (!raw) return;
    const paragraphs = raw.split("\n\n");
    for (const para of paragraphs) {
      const p = container.createEl("p", { attr: { style: "margin: 0 0 10px; line-height: 1.65;" } });
      const parts = para.split(/(\[\[[^\]]+\]\])/g);
      for (const part of parts) {
        if (part.startsWith("[[") && part.endsWith("]]")) {
          const linkTarget = part.slice(2, -2);
          const link = p.createEl("a", {
            cls: "internal-link",
            text: `[[${linkTarget}]]`,
            attr: {
              style:
                "color: var(--aos-gold, #a96f17); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; cursor: pointer;",
            },
          });
          link.addEventListener("click", (e) => {
            e.preventDefault();
            this.context.plugin.app.workspace.openLinkText(linkTarget, "");
          });
        } else {
          p.createSpan({ text: part });
        }
      }
    }
  }

  private formatRelativeTime(timestamp?: number): string {
    if (!timestamp) return "刚刚";
    const deltaSec = Math.floor(Date.now() / 1000 - timestamp);
    if (deltaSec < 60) return "刚刚";
    if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}分钟前`;
    if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}小时前`;
    const days = Math.floor(deltaSec / 86400);
    if (days < 30) return `${days}天前`;
    return new Date(timestamp * 1000).toLocaleDateString("zh-CN");
  }

  private formatTimestamp(timestamp?: number): string {
    if (!timestamp) return "";
    return new Date(timestamp * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}
