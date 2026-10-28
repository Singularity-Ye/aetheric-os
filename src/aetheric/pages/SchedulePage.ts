import { Modal, Notice, Menu, setIcon, TFile, normalizePath } from "obsidian";
import type { CreatePlanItemInput, PlanItem, PlanItemKind, PlanTodaySnapshot, UpdatePlanItemPatch } from "../PlanLedgerService";
import type { KnowledgeNodeViewModel } from "../types";
import { DEFAULT_SCHEDULE_SHORTCUTS, ScheduleShortcutSettings } from "../../settings";
import { formatShortcut, shortcutMatches } from "../WorkspaceKeymap";
import { AosUI } from "../ui/AosUI";
import {
  SCHEDULE_DAY_START,
  SCHEDULE_DAY_END,
  SCHEDULE_STEP,
  clampNumber,
  snapMinutes,
  scheduleMinutes,
  minutesToScheduleTime,
  parseLocalDate,
  formatLocalDate,
  getWeekDates,
  ScheduleCreateModal,
  ScheduleShortcutModal,
} from "./ScheduleModals";

export interface SchedulePageContext {
  plugin: any;
  app: any;
  mainPane: HTMLElement;
  openFileByPath: (path: string) => void;
  openNode: (file: any) => Promise<void>;
  getInspirationFiles: (includeArchived?: boolean) => any[];
  inspirationAttachInFlight: Set<string>;
  inspirationDate: (file: any) => string;
  inspirationValue: (file: any) => string;
  frontmatterText: (file: any, key: string) => string;
  planExecutionMeta: (item: PlanItem) => string;
  planExecutionStatusLabel: (item: PlanItem) => string;
  planExecutorLabel: (item: PlanItem) => string;
  agentPlanAction: (item: PlanItem) => { label: string; title: string; icon: string } | null;
  runAgentPlanAction: (item: PlanItem) => Promise<void>;
  toNode: (path: string) => any;
}

/**
 * SchedulePage: Decoupled Schedule, Weekly Kanban, Time Grid and Plan Ledger Workbench.
 */
export class SchedulePage {
  public selectedScheduleItemId: string | null = null;
  public scheduleDetailOpen = true;
  public scheduleRenderToken = 0;
  private schedulePreviewOverrides = new Map<string, { date: string; start: string; end: string }>();
  private scheduleKeyboardUpdates = new Set<string>();

  constructor(private context: SchedulePageContext) {}

  async mount(parent: HTMLElement): Promise<void> {
    await this.renderSchedule();
  }

  isActualSchedule(item: PlanItem): boolean {
    return Boolean(item.schedule && !item.schedule.preview);
  }

  private clearScheduleInteractionOverlays(): void {
    // Drag/resize previews live on document.body so they can escape the
    // timeline's stacking context. If Obsidian switches views during a
    // pointer gesture, the old clone can otherwise survive as a ghost card.
    document.querySelectorAll<HTMLElement>(".aos-schedule-time-card.is-overlay").forEach((element: HTMLElement) => element.remove());
  }

  private scheduleValue(date: string, start: string, end: string): NonNullable<PlanItem["schedule"]> {
    return {
      date,
      start,
      end,
      timezone: "Asia/Shanghai",
      fixed: false,
      preview: false,
    };
  }

  private quickScheduleSlot(): { start: string; end: string } {
    const now = new Date();
    const rounded = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
    const start = clampNumber(Math.max(9 * 60, rounded), 9 * 60, 22 * 60);
    const end = Math.min(start + 60, 23 * 60);
    return { start: minutesToScheduleTime(start), end: minutesToScheduleTime(end) };
  }

  private async updateScheduleItem(item: PlanItem, patch: UpdatePlanItemPatch, successText: string): Promise<void> {
    try {
      await this.context.plugin.planLedger.updatePlanItem(item, patch);
      this.schedulePreviewOverrides.delete(item.item_id);
      this.selectedScheduleItemId = item.item_id;
      new Notice(successText);
      await this.renderSchedule();
    } catch (error: any) {
      new Notice(`更新计划失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openScheduleEditModal(item: PlanItem): void {
    const schedule = item.schedule && !item.schedule.preview ? item.schedule : undefined;
    new ScheduleCreateModal(this.context.app, {
      title: item.title,
      kind: item.kind,
      date: schedule?.date ?? item.plan_date,
      scheduled: Boolean(schedule),
      start: schedule?.start ?? "09:00",
      end: schedule?.end ?? "10:00",
      sourceNotePath: item.source_note?.path,
    }, async input => {
      await this.updateScheduleItem(item, {
        title: input.title,
        kind: input.kind,
        plan_date: input.date,
        schedule: input.scheduled ? this.scheduleValue(input.date, input.start, input.end) : null,
      }, input.scheduled ? "计划卡片已更新并排期" : "计划卡片已更新，暂存候选池");
    }, { heading: "编辑计划卡片", submit: "保存修改" }).open();
  }

  private async scheduleCandidate(item: PlanItem, date: string): Promise<void> {
    const slot = this.quickScheduleSlot();
    await this.scheduleCandidateAt(item, date, scheduleMinutes(slot.start), 60);
  }

  private async scheduleCandidateAt(item: PlanItem, date: string, startMinutes: number, duration = 60): Promise<void> {
    const safeDuration = Math.max(SCHEDULE_STEP, Math.min(duration, SCHEDULE_DAY_END - SCHEDULE_DAY_START));
    const start = clampNumber(snapMinutes(startMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - safeDuration);
    const end = clampNumber(start + safeDuration, start + SCHEDULE_STEP, SCHEDULE_DAY_END);
    const startText = minutesToScheduleTime(start);
    const endText = minutesToScheduleTime(end);
    await this.updateScheduleItem(item, {
      plan_date: date,
      schedule: this.scheduleValue(date, startText, endText),
    }, `已排到 ${date} ${startText}-${endText}`);
  }

  private async togglePlanDone(item: PlanItem): Promise<void> {
    if (item.execution.mode === "agent") {
      new Notice("Agent 任务必须按「排队 → 执行 → 验收」状态机推进，不能用普通完成按钮越级结案");
      return;
    }
    await this.updateScheduleItem(item, {
      status: item.status === "done" ? "proposed" : "done",
    }, item.status === "done" ? "已恢复计划卡片；来源灵感仍保持挂接" : "已标记完成；来源灵感已收口");
  }

  private async removePlanItem(item: PlanItem): Promise<void> {
    if (item.execution.mode === "agent" && ["queued", "running", "review"].includes(item.execution.status)) {
      new Notice("Agent 任务仍在排队、执行或验收中；当前没有可靠取消接口，未移除任务");
      return;
    }
    try {
      await this.context.plugin.planLedger.deletePlanItem(item);
      this.schedulePreviewOverrides.delete(item.item_id);
      if (this.selectedScheduleItemId === item.item_id) this.selectedScheduleItemId = null;
      this.scheduleDetailOpen = false;
      new Notice(item.source_note ? "计划已移入回收区；来源灵感已回到未挂接候选" : "卡片已移入计划回收区");
      await this.renderSchedule();
    } catch (error: any) {
      new Notice(`移除卡片失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private createScheduleButton(
    parent: HTMLElement,
    label: string,
    icon: string,
    cls: string,
    title = label,
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls, attr: { type: "button", title, "aria-label": title } });
    const iconSlot = button.createSpan({ cls: "aos-schedule-button-icon" });
    setIcon(iconSlot, icon);
    button.createSpan({ cls: "aos-schedule-button-label", text: label });
    return button;
  }

  private openScheduleCardMenu(item: PlanItem, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(entry => entry.setTitle("编辑卡片").setIcon("pencil").onClick(() => this.openScheduleEditModal(item)));
    if (item.execution.mode === "manual") {
      menu.addItem(entry => entry
        .setTitle(item.status === "done" ? "恢复任务" : "完成任务")
        .setIcon(item.status === "done" ? "rotate-ccw" : "check")
        .onClick(() => void this.togglePlanDone(item)));
    } else {
      const action = this.context.agentPlanAction(item);
      if (action) {
        menu.addItem(entry => entry
          .setTitle(action.title)
          .setIcon(action.icon)
          .onClick(() => void this.context.runAgentPlanAction(item)));
      }
    }
    if (this.isActualSchedule(item)) {
      menu.addItem(entry => entry
        .setTitle("退回待安排")
        .setIcon("inbox")
        .onClick(() => void this.updateScheduleItem(item, { schedule: null }, item.source_note ? "已退回待安排；来源灵感仍保持挂接" : "已退回待安排")));
    } else if (item.status !== "done") {
      menu.addItem(entry => entry
        .setTitle("排到今天")
        .setIcon("calendar-plus")
        .onClick(() => void this.scheduleCandidate(item, formatLocalDate(new Date()))));
    }
    if (item.source_note) {
      menu.addItem(entry => entry
        .setTitle("打开来源灵感")
        .setIcon("lightbulb")
        .onClick(() => {
          const node = this.context.toNode(item.source_note?.path ?? "");
          if (node) void this.context.openNode(node);
          else new Notice(`灵感笔记不存在：${item.source_note?.path ?? ""}`);
        }));
    }
    menu.addSeparator();
    menu.addItem(entry => entry
      .setTitle("移入计划回收区")
      .setIcon("trash-2")
      .onClick(() => void this.removePlanItem(item)));
    menu.showAtMouseEvent(event);
  }

  private async attachInspirationToCandidate(file: KnowledgeNodeViewModel, date: string): Promise<void> {
    if (this.context.inspirationAttachInFlight.has(file.path)) return;
    this.context.inspirationAttachInFlight.add(file.path);
    try {
      const existing = await this.context.plugin.planLedger.findPlanItemBySource(file.path);
      if (existing) {
        this.selectedScheduleItemId = existing.item_id;
        this.scheduleDetailOpen = true;
        new Notice(existing.status === "done" ? "这条灵感已对应一张已完成计划，已打开详情" : "这条灵感已经挂接到候选任务，已打开详情");
        await this.renderSchedule();
        return;
      }
      const item = await this.context.plugin.planLedger.createPlanItem({
        title: file.title,
        kind: "micro_task",
        date,
        scheduled: false,
        start: "09:00",
        end: "10:00",
        sourceNotePath: file.path,
      });
      this.selectedScheduleItemId = item.item_id;
      this.scheduleDetailOpen = true;
      await this.renderSchedule();
      new Notice("已加入候选任务；来源灵感自动从未挂接列表移出");
    } catch (error: any) {
      new Notice("加入候选任务失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      this.context.inspirationAttachInFlight.delete(file.path);
    }
  }

  private async renderSchedule(): Promise<void> {
    if (this.context.plugin.store.getSnapshot().activeModule !== "schedule") return;
    this.clearScheduleInteractionOverlays();
    const renderToken = ++this.scheduleRenderToken;
    const isCurrentSchedule = (): boolean =>
      this.context.plugin.store.getSnapshot().activeModule === "schedule" && this.scheduleRenderToken === renderToken;

    const previousPage = this.context.mainPane.querySelector<HTMLDivElement>(".aos-schedule-page");
    const scrollState = {
      mainTop: this.context.mainPane.scrollTop,
      mainLeft: this.context.mainPane.scrollLeft,
      sidebarTop: previousPage?.querySelector<HTMLElement>(".aos-schedule-sidebar")?.scrollTop ?? 0,
      detailTop: previousPage?.querySelector<HTMLElement>(".aos-schedule-detail")?.scrollTop ?? 0,
    };
    const initialSnapshot = await this.context.plugin.planLedger.refreshTodaySnapshot();
    if (!isCurrentSchedule()) return;
    // 在脱离 DOM 的页面树里完成异步数据和事件绑定，最后一次性替换可见页面。
    // 这样保存/切换详情时不会先清空主面板再等待 weekly ledger，避免白屏闪烁。
    const page = document.createElement("div") as HTMLDivElement;
    page.className = "aos-page aos-schedule-page";
    const heading = page.createDiv({ cls: "aos-page-heading" });
    const titleBlock = heading.createDiv();
    titleBlock.createDiv({ cls: "aos-page-title", text: "日程 Schedule" });
    titleBlock.createDiv({ cls: "aos-page-subtitle", text: "灵感来源 → 候选任务 → 计划中 → 已完成；每一步只需一次操作" });
    const actions = heading.createDiv({ cls: "aos-schedule-actions" });
    const addCard = this.createScheduleButton(actions, "新增卡片", "plus", "aos-compact-button is-primary");
    const refresh = this.createScheduleButton(actions, "刷新日程", "refresh-cw", "aos-compact-button");
    const detailToggle = this.createScheduleButton(
      actions,
      this.scheduleDetailOpen ? "收起详情" : "详情",
      this.scheduleDetailOpen ? "panel-right-close" : "panel-right-open",
      "aos-compact-button",
    );

    const shell = page.createDiv({ cls: `aos-schedule-shell ${this.scheduleDetailOpen ? "has-detail" : ""}` });
    const inbox = shell.createDiv({ cls: "aos-schedule-sidebar aos-panel" });
    const canvas = shell.createDiv({ cls: "aos-schedule-canvas aos-panel" });
    const detail = shell.createDiv({ cls: `aos-schedule-detail aos-panel ${this.scheduleDetailOpen ? "is-open" : ""}` });

    const render = async (seed?: PlanTodaySnapshot): Promise<void> => {
      const snapshot = seed ?? await this.context.plugin.planLedger.refreshTodaySnapshot();
      if (!isCurrentSchedule()) return;
      const weekDates = getWeekDates(snapshot.date);
      const weeklyLedgerItems = await this.context.plugin.planLedger.loadPlanItemsForDates(weekDates);
      if (!isCurrentSchedule()) return;
      const byId = new Map<string, PlanItem>();
      for (const item of [...snapshot.items, ...weeklyLedgerItems]) byId.set(item.item_id, item);
      const displayItems = [...byId.values()];
      const linkedSourcePaths = new Set(
        displayItems
          .map((item: any) => item.source_note?.path)
          .filter((value): value is string => Boolean(value)),
      );
      const pendingItems = displayItems
        .filter((item: any) => item.status !== "done" && !this.isActualSchedule(item))
        .sort((a: any, b: any) => Number(a.kind === "focus") - Number(b.kind === "focus") || b.updated_at.localeCompare(a.updated_at));
      const scheduledItems = displayItems.filter((item: any) => this.isActualSchedule(item));
      const activeScheduledItems = scheduledItems.filter((item: any) => item.status !== "done");
      const completedItems = displayItems.filter((item: any) => item.status === "done").sort((a: any, b: any) => b.updated_at.localeCompare(a.updated_at));

      inbox.empty();
      canvas.empty();
      detail.empty();

      const inboxHeader = inbox.createDiv({ cls: "aos-schedule-section-header" });
      const inboxTitle = inboxHeader.createDiv();
      inboxTitle.createDiv({ cls: "aos-panel-title", text: "候选任务 · 待安排" });
      inboxTitle.createDiv({ cls: "aos-panel-note", text: `${pendingItems.length} 张待安排 · 拖入时间轴才算进入计划中` });
      const addInboxCard = inboxHeader.createEl("button", {
        cls: "aos-icon-button aos-schedule-add-icon",
        attr: { type: "button", "aria-label": "新增计划卡片", title: "新增计划卡片" },
      });
      setIcon(addInboxCard, "plus");
      addInboxCard.addEventListener("click", () => this.openScheduleCreateModal({ date: snapshot.date, scheduled: false }));

      const renderPlanRow = (item: PlanItem, group: "pending" | "scheduled" | "completed"): void => {
        const row = inbox.createDiv({ cls: `aos-schedule-candidate ${item.status === "done" ? "is-done" : ""} ${item.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""} ${this.selectedScheduleItemId === item.item_id ? "is-selected" : ""}` });
        if (group === "pending") {
          row.setAttribute("draggable", "true");
          row.setAttribute("title", "拖到右侧时间轴的日期与时间格");
          row.addEventListener("dragstart", event => {
            event.dataTransfer?.setData("application/x-aos-plan-item", item.item_id);
            event.dataTransfer?.setData("text/plain", item.item_id);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
            row.classList.add("is-dragging");
          });
          row.addEventListener("dragend", () => row.classList.remove("is-dragging"));
        }
        const body = row.createDiv({ cls: "aos-schedule-candidate-body" });
        body.createDiv({ cls: "aos-schedule-candidate-title", text: item.title || "未命名事项" });
        const schedule = item.schedule && !item.schedule.preview ? `${item.schedule.date.slice(5)} ${item.schedule.start}-${item.schedule.end}` : "未排期";
        body.createDiv({ cls: "aos-schedule-candidate-meta", text: `${schedule} · ${item.kind === "focus" ? "今日要事" : "小目标"} · ${this.context.planExecutionMeta(item)}` });
        const rowActions = row.createDiv({ cls: "aos-schedule-candidate-actions" });
        const select = (label: string, title: string, handler: () => void | Promise<void>, primary = false, icon = "circle-dot"): void => {
          const button = this.createScheduleButton(rowActions, label, icon, `aos-schedule-inline-action ${primary ? "is-primary" : ""}`, title);
          button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void handler(); });
        };
        if (group === "pending") select("排今天", "按一个快捷时段排到今天", () => this.scheduleCandidate(item, snapshot.date), item.execution.mode === "manual", "calendar-plus");
        if (item.execution.mode === "manual") {
          if (group === "scheduled") select("完成", "标记完成", () => this.togglePlanDone(item), true, "check");
          if (group === "completed") select("恢复", "恢复到计划", () => this.togglePlanDone(item), false, "rotate-ccw");
        } else {
          const agentAction = this.context.agentPlanAction(item);
          if (agentAction) select(agentAction.label, agentAction.title, () => this.context.runAgentPlanAction(item), true, agentAction.icon);
        }
        select("编辑", "编辑标题、日期或时段", () => this.openScheduleEditModal(item), false, "pencil");
        select("移除", "移入计划回收区", () => this.removePlanItem(item), false, "trash-2");
        row.addEventListener("click", () => {
          this.selectedScheduleItemId = item.item_id;
          this.scheduleDetailOpen = true;
          void this.renderSchedule();
        });
      };

      const pendingHeader = inbox.createDiv({ cls: "aos-schedule-subsection-header" });
      pendingHeader.createSpan({ cls: "aos-schedule-subsection-title", text: "待安排" });
      pendingHeader.createSpan({ cls: "aos-schedule-subsection-count", text: `${pendingItems.length}` });
      if (!pendingItems.length) inbox.createDiv({ cls: "aos-empty-state", text: "暂无待安排任务 · 从灵感来源加入或新增一张计划" });
      pendingItems.slice(0, 12).forEach(item => renderPlanRow(item, "pending"));

      const scheduledHeader = inbox.createDiv({ cls: "aos-schedule-subsection-header aos-schedule-subsection-spaced" });
      scheduledHeader.createSpan({ cls: "aos-schedule-subsection-title", text: "时间块 · 计划中" });
      scheduledHeader.createSpan({ cls: "aos-schedule-subsection-count", text: `${activeScheduledItems.length}` });
      if (!activeScheduledItems.length) inbox.createDiv({ cls: "aos-empty-state", text: "本周还没有未完成排期" });
      activeScheduledItems.slice(0, 8).forEach(item => renderPlanRow(item, "scheduled"));

      if (completedItems.length) {
        const completedDetails = inbox.createEl("details", { cls: "aos-schedule-completed" });
        const completedSummary = completedDetails.createEl("summary");
        completedSummary.createSpan({ text: `已完成 / 历史 · ${completedItems.length}` });
        completedItems.slice(0, 8).forEach(item => renderPlanRow(item, "completed"));
      }

      const inspirationCandidates = inbox.createDiv({ cls: "aos-schedule-inspiration-candidates" });
      const inspirationCandidateHeader = inspirationCandidates.createDiv({ cls: "aos-schedule-section-header" });
      inspirationCandidateHeader.createDiv({ cls: "aos-panel-title", text: "灵感来源 · 未挂接" });
      inspirationCandidateHeader.createDiv({ cls: "aos-panel-note", text: "加入候选任务后会自动从这里移出；原始灵感笔记始终保留在灵感轨。" });
      const candidateFiles = this.context.getInspirationFiles()
        .filter(file => !["scheduled", "archived"].includes(this.context.frontmatterText(file, "status")))
        .filter(file => !linkedSourcePaths.has(file.path))
        .slice(0, 5);
      if (!candidateFiles.length) {
        inspirationCandidates.createDiv({ cls: "aos-empty-state", text: "暂无未挂接灵感 · 新捕获的高价值素材会出现在这里" });
      } else {
        for (const file of candidateFiles) {
          const row = inspirationCandidates.createDiv({ cls: "aos-schedule-inspiration-candidate" });
          const content = row.createDiv({ cls: "aos-schedule-inspiration-candidate-content" });
          content.createDiv({ cls: "aos-schedule-candidate-title", text: file.title });
          content.createDiv({ cls: "aos-schedule-candidate-meta", text: `${this.context.inspirationDate(file)} · ${this.context.inspirationValue(file)}` });
          const rowActions = row.createDiv({ cls: "aos-schedule-inspiration-candidate-actions" });
          const view = this.createScheduleButton(rowActions, "查看", "eye", "aos-inspiration-card-action", "打开灵感卡");
          view.addEventListener("click", event => { event.stopPropagation(); void this.context.openNode(file); });
          const attach = this.createScheduleButton(rowActions, "加入候选任务", "calendar-plus", "aos-inspiration-card-action is-primary", "加入候选任务");
          attach.addEventListener("click", event => {
            event.stopPropagation();
            attach.disabled = true;
            attach.setAttribute("aria-busy", "true");
            void this.attachInspirationToCandidate(file, snapshot.date).finally(() => {
              if (attach.isConnected) {
                attach.disabled = false;
                attach.removeAttribute("aria-busy");
              }
            });
          });
        }
      }

      const canvasHeader = canvas.createDiv({ cls: "aos-schedule-canvas-header" });
      canvasHeader.createDiv({ cls: "aos-panel-title", text: "本周时间轴" });
      canvasHeader.createDiv({ cls: "aos-panel-note", text: `${activeScheduledItems.length} 个计划中 · ${scheduledItems.length - activeScheduledItems.length} 个已完成 · 顶部拖动移动时间块，底部拖动调整时长；中间点击查看详情` });
      const shortcuts = this.context.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS;
      const keyboardHint = canvasHeader.createDiv({ cls: "aos-schedule-keyboard-hint" });
      keyboardHint.createSpan({ text: `快捷键：${formatShortcut(shortcuts.moveDayPrevious)}/${formatShortcut(shortcuts.moveDayNext)} 日期 · ${formatShortcut(shortcuts.moveTimeEarlier)}/${formatShortcut(shortcuts.moveTimeLater)} 时间 · ${formatShortcut(shortcuts.resizeShorter)}/${formatShortcut(shortcuts.resizeLonger)} 时长 · ${formatShortcut(shortcuts.openDetails)} 详情 · ${formatShortcut(shortcuts.toggleDone)} 完成` });
      const shortcutConfig = this.createScheduleButton(keyboardHint, "配置快捷键", "keyboard", "aos-schedule-shortcut-config", "查看说明并修改日程快捷键");
      shortcutConfig.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        new ScheduleShortcutModal(this.context.app, this.context.plugin, () => void this.renderSchedule()).open();
      });
      const weekHeader = canvas.createDiv({ cls: "aos-schedule-week-header" });
      weekHeader.createDiv({ cls: "aos-schedule-week-spacer" });
      const weekdayLabels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
      weekDates.forEach((date, index) => {
        const cell = weekHeader.createDiv({ cls: `aos-schedule-week-day ${date === snapshot.date ? "is-today" : ""}` });
        cell.createDiv({ cls: "aos-schedule-week-day-name", text: weekdayLabels[index] });
        cell.createDiv({ cls: "aos-schedule-week-day-date", text: date.slice(5) });
      });
      const timeline = canvas.createDiv({ cls: "aos-schedule-timeline" });
      const gridLayer = timeline.createDiv({ cls: "aos-schedule-grid-layer" });
      for (let hour = 6; hour <= 24; hour++) {
        const row = gridLayer.createDiv({ cls: "aos-schedule-hour-row" });
        row.createDiv({ cls: "aos-schedule-hour-label", text: `${String(hour).padStart(2, "0")}:00` });
        for (let day = 0; day < 7; day++) row.createDiv({ cls: `aos-schedule-hour-track ${weekDates[day] === snapshot.date ? "is-today" : ""}` });
      }
      const cardLayer = timeline.createDiv({ cls: "aos-schedule-card-layer" });
      const timelinePosition = (clientX: number, clientY: number): { date: string; start: number } => {
        const rect = timeline.getBoundingClientRect();
        const contentLeft = 66;
        const contentWidth = Math.max(1, rect.width - contentLeft - 10);
        const dayWidth = contentWidth / 7;
        const dayIndex = clampNumber(Math.floor((clientX - rect.left - contentLeft) / dayWidth), 0, 6);
        const rawMinutes = 360 + ((clientY - rect.top) / Math.max(1, rect.height)) * (18 * 60);
        return { date: weekDates[dayIndex], start: clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - SCHEDULE_STEP) };
      };
      timeline.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest(".aos-schedule-time-card")) return;
        const point = timelinePosition(event.clientX, event.clientY);
        const start = minutesToScheduleTime(point.start);
        const end = minutesToScheduleTime(Math.min(point.start + 60, SCHEDULE_DAY_END));
        this.openScheduleCreateModal({ date: point.date, scheduled: true, start, end });
      });
      timeline.addEventListener("dragover", event => {
        if (event.dataTransfer?.types.includes("application/x-aos-plan-item") || event.dataTransfer?.types.includes("text/plain")) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          timeline.classList.add("is-drop-target");
        }
      });
      timeline.addEventListener("dragleave", event => {
        if (!(event.relatedTarget instanceof Node) || !timeline.contains(event.relatedTarget)) timeline.classList.remove("is-drop-target");
      });
      timeline.addEventListener("drop", event => {
        event.preventDefault();
        timeline.classList.remove("is-drop-target");
        const itemId = event.dataTransfer?.getData("application/x-aos-plan-item") || event.dataTransfer?.getData("text/plain");
        const item = displayItems.find(candidate => candidate.item_id === itemId);
        if (!item || item.status === "done" || this.isActualSchedule(item)) return;
        const point = timelinePosition(event.clientX, event.clientY);
        void this.scheduleCandidateAt(item, point.date, point.start, 60);
      });
      for (const item of scheduledItems) {
        const override = this.schedulePreviewOverrides.get(item.item_id);
        const schedule = {
          date: override?.date ?? item.schedule?.date ?? snapshot.date,
          start: override?.start ?? item.schedule?.start ?? "06:00",
          end: override?.end ?? item.schedule?.end ?? item.schedule?.start ?? "06:30",
        };
        if (!weekDates.includes(schedule.date)) continue;
        const start = scheduleMinutes(schedule.start);
        const end = scheduleMinutes(schedule.end);
        const dayIndex = Math.max(0, weekDates.indexOf(schedule.date));
        const top = Math.max(0, ((start - 360) / (18 * 60)) * 100);
        const height = Math.max(4.5, ((Math.max(end, start + 15) - start) / (18 * 60)) * 100);
        const card = cardLayer.createDiv({ cls: `aos-schedule-time-card ${item.kind === "focus" ? "is-focus" : "is-micro"} ${item.status === "done" ? "is-done" : ""} ${item.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""}` });
        card.style.left = `calc(${(dayIndex * 100) / 7}% + 4px)`;
        card.style.width = `calc(${100 / 7}% - 8px)`;
        card.style.top = `${top}%`;
        card.style.height = `${height}%`;
        card.setAttribute("title", `${item.title || "未命名事项"}\n${schedule.start}-${schedule.end}`);
        card.dataset.scheduleItemId = item.item_id;
        card.setAttribute("tabindex", "0");
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `${item.title || "未命名事项"}，${schedule.start} 到 ${schedule.end}。聚焦后可用方向键调整`);
        card.classList.toggle("is-selected", this.selectedScheduleItemId === item.item_id);
        const dragHandle = card.createDiv({ cls: "aos-schedule-drag-handle", attr: { title: "拖动移动日期与开始时间", "aria-label": "拖动移动日期与开始时间" } });
        setIcon(dragHandle, "grip-horizontal");
        dragHandle.createSpan({ cls: "aos-schedule-drag-label", text: "移动时间块" });
        card.createDiv({ cls: "aos-schedule-time-card-title", text: item.title || "未命名事项" });
        const meta = card.createDiv({ cls: "aos-schedule-time-card-meta", text: `${schedule.start}-${schedule.end}${item.source_note ? " · 灵感挂接" : ""} · ${this.context.planExecutionMeta(item)}` });
        const cardActions = card.createDiv({ cls: "aos-schedule-time-card-actions" });
        if (item.execution.mode === "manual") {
          const doneButton = this.createScheduleButton(cardActions, item.status === "done" ? "恢复" : "完成", item.status === "done" ? "rotate-ccw" : "check", "aos-schedule-time-card-action", item.status === "done" ? "恢复计划" : "完成任务");
          doneButton.addEventListener("pointerdown", event => event.stopPropagation());
          doneButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.togglePlanDone(item); });
        } else {
          const agentAction = this.context.agentPlanAction(item);
          if (agentAction) {
            const actionButton = this.createScheduleButton(cardActions, agentAction.label, agentAction.icon, "aos-schedule-time-card-action", agentAction.title);
            actionButton.addEventListener("pointerdown", event => event.stopPropagation());
            actionButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void this.context.runAgentPlanAction(item); });
          }
        }
        const menuButton = this.createScheduleButton(cardActions, "", "more-horizontal", "aos-schedule-time-card-action", "更多操作");
        menuButton.addEventListener("pointerdown", event => event.stopPropagation());
        menuButton.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); this.openScheduleCardMenu(item, event); });
        const resizeHandle = card.createDiv({ cls: "aos-schedule-resize-handle", attr: { "aria-label": "拖动调整时长" } });
        card.addEventListener("click", event => {
          if (event.target instanceof Element && event.target.closest(".aos-schedule-drag-handle, .aos-schedule-resize-handle, .aos-schedule-time-card-actions")) return;
          this.selectedScheduleItemId = item.item_id;
          this.scheduleDetailOpen = true;
          void this.renderSchedule();
        });
        this.attachScheduleCardPreviewInteraction(card, meta, cardLayer, weekDates, item, schedule, dragHandle, resizeHandle, () => this.renderSchedule());
      }

      const focusList = canvas.createDiv({ cls: "aos-schedule-focus-strip" });
      const focusItems = snapshot.items.filter((item: any) => item.kind === "focus");
      for (let index = 0; index < 3; index += 1) {
        const item = focusItems[index];
        const card = focusList.createDiv({ cls: `aos-schedule-card ${item?.status === "done" ? "is-done" : ""} ${item?.execution.mode === "agent" ? `is-agent is-execution-${item.execution.status}` : ""} ${item ? "" : "is-empty"}`, attr: { role: "button", tabindex: "0" } });
        card.createDiv({ cls: "aos-schedule-card-title", text: item?.title || "设置一件今日要事" });
        card.createDiv({
          cls: "aos-schedule-card-meta",
          text: item
            ? `${item.status === "done" ? "已完成" : this.isActualSchedule(item) ? `${item.schedule?.start}-${item.schedule?.end}` : "未排期"} · 今日要事 · ${this.context.planExecutionMeta(item)}`
            : "点击新增 · 今日要事",
        });
        const activate = (): void => {
          if (item) {
            this.selectedScheduleItemId = item.item_id;
            this.scheduleDetailOpen = true;
            void this.renderSchedule();
          } else this.openScheduleCreateModal({ kind: "focus", date: snapshot.date, scheduled: false });
        };
        card.addEventListener("click", activate);
        card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); } });
      }

      const inspirationBridge = page.createDiv({ cls: "aos-panel aos-schedule-inspiration-bridge" });
      const bridgeHeader = inspirationBridge.createDiv({ cls: "aos-schedule-section-header" });
      const bridgeTitle = bridgeHeader.createDiv();
      bridgeTitle.createDiv({ cls: "aos-panel-title", text: "灵感生命周期" });
      bridgeTitle.createDiv({ cls: "aos-panel-note", text: "左侧只放未挂接来源；加入候选任务后，来源笔记仍可在灵感轨回看，但不会重复进入候选。" });
      const lifecycle = inspirationBridge.createDiv({ cls: "aos-schedule-lifecycle" });
      for (const [index, step] of [
        ["01", "灵感来源", "新捕获、尚未挂接"],
        ["02", "候选任务", "一键加入，等待安排"],
        ["03", "执行 / 验收 / 完成", "日历只投影时间；Agent 产物必须经过执行状态与验收"],
      ] as const) {
        const item = lifecycle.createDiv({ cls: "aos-schedule-lifecycle-step" });
        item.createSpan({ cls: "aos-schedule-lifecycle-index", text: index });
        const copy = item.createDiv({ cls: "aos-schedule-lifecycle-copy" });
        copy.createDiv({ cls: "aos-schedule-lifecycle-title", text: step[1] });
        copy.createDiv({ cls: "aos-schedule-lifecycle-note", text: step[2] });
      }

      const selectedItem = displayItems.find(item => item.item_id === this.selectedScheduleItemId);
      this.renderScheduleDetail(detail, selectedItem, displayItems.length, snapshot.generated_at, () => {
        this.scheduleDetailOpen = false;
        void this.renderSchedule();
      });
    };

    addCard.addEventListener("click", () => this.openScheduleCreateModal({ date: formatLocalDate(new Date()), scheduled: false }));
    refresh.addEventListener("click", () => void this.renderSchedule());
    detailToggle.addEventListener("click", () => { this.scheduleDetailOpen = !this.scheduleDetailOpen; void this.renderSchedule(); });
    await render(initialSnapshot);
    if (isCurrentSchedule()) {
      const visiblePage = this.context.mainPane.querySelector<HTMLDivElement>(".aos-schedule-page");
      if (visiblePage) visiblePage.replaceWith(page);
      else {
        this.context.mainPane.empty();
        this.context.mainPane.appendChild(page);
      }
      const restoreScroll = (): void => {
        if (!isCurrentSchedule()) return;
        this.context.mainPane.scrollTop = scrollState.mainTop;
        this.context.mainPane.scrollLeft = scrollState.mainLeft;
        const sidebar = this.context.mainPane.querySelector<HTMLElement>(".aos-schedule-sidebar");
        const detailPane = this.context.mainPane.querySelector<HTMLElement>(".aos-schedule-detail");
        if (sidebar) sidebar.scrollTop = scrollState.sidebarTop;
        if (detailPane) detailPane.scrollTop = scrollState.detailTop;
      };
      restoreScroll();
      requestAnimationFrame(restoreScroll);
    }
  }

  public openScheduleCreateModal(defaults: Partial<CreatePlanItemInput> = {}): void {
    const today = formatLocalDate(new Date());
    new ScheduleCreateModal(this.context.app, {
      title: defaults.title ?? "",
      kind: defaults.kind ?? "micro_task",
      date: defaults.date ?? today,
      scheduled: defaults.scheduled ?? true,
      start: defaults.start ?? "09:00",
      end: defaults.end ?? "10:00",
      sourceNotePath: defaults.sourceNotePath,
    }, async input => {
      if (input.sourceNotePath) {
        const existing = await this.context.plugin.planLedger.findPlanItemBySource(input.sourceNotePath);
        if (existing) {
          this.selectedScheduleItemId = existing.item_id;
          this.scheduleDetailOpen = true;
          await this.renderSchedule();
          new Notice("这条灵感已经挂接到候选任务，未重复创建卡片");
          return;
        }
      }
      const item = await this.context.plugin.planLedger.createPlanItem(input);
      this.selectedScheduleItemId = item.item_id;
      this.schedulePreviewOverrides.delete(item.item_id);
      await this.renderSchedule();
      new Notice(input.scheduled ? "已加入时间轴；完成按钮只代表任务做完" : input.sourceNotePath ? "已加入候选任务；来源灵感已挂接" : "已加入候选任务池");
    }).open();
  }

  private renderScheduleDetail(
    detail: HTMLDivElement,
    selectedItem: PlanItem | undefined,
    itemCount: number,
    generatedAt: string,
    onClose: () => void,
  ): void {
    const header = detail.createDiv({ cls: "aos-schedule-detail-header" });
    header.createDiv({ cls: "aos-panel-title", text: "卡片详情" });
    const close = header.createEl("button", { cls: "aos-icon-button aos-schedule-detail-close", attr: { "aria-label": "收起详情" } });
    setIcon(close, "panel-right-close");
    close.addEventListener("click", onClose);

    if (selectedItem) {
      detail.createDiv({ cls: "aos-schedule-detail-title", text: selectedItem.title || "未命名事项" });
      const override = this.schedulePreviewOverrides.get(selectedItem.item_id);
      const schedule = selectedItem.schedule
        ? {
            date: override?.date ?? selectedItem.schedule.date,
            start: override?.start ?? selectedItem.schedule.start,
            end: override?.end ?? selectedItem.schedule.end,
          }
        : null;
      const stats = detail.createDiv({ cls: "aos-schedule-stats" });
      stats.createDiv({ text: selectedItem.kind === "focus" ? "今日三件事" : "小目标" });
      stats.createDiv({ text: selectedItem.execution.mode === "agent" ? `执行者 ${this.context.planExecutorLabel(selectedItem)} · ${this.context.planExecutionStatusLabel(selectedItem)}` : "执行者 用户 · 手动任务" });
      stats.createDiv({
        text: selectedItem.status === "done"
          ? selectedItem.source_note ? "已完成 · 来源灵感已收口" : "已完成 · 任务已做完"
          : this.isActualSchedule(selectedItem)
            ? selectedItem.source_note ? "计划中 · 来源灵感已挂接" : "已加入时间轴 · 任务未完成"
            : selectedItem.source_note ? "待安排 · 来源灵感已挂接" : "候选任务 · 尚未安排",
      });
      if (schedule) stats.createDiv({ text: `${schedule.date} ${schedule.start}-${schedule.end}` });
      detail.createDiv({
        cls: "aos-panel-note",
        text: selectedItem.execution.mode === "agent"
          ? selectedItem.execution.status === "review"
            ? "Agent 已提交产物，只有“验收通过”会完成任务；普通完成按钮不会越过状态机。"
            : selectedItem.execution.status === "queued" || selectedItem.execution.status === "running"
              ? "任务正在 Agent 队列中推进；时间块只是日历投影，不代表执行完成。"
              : selectedItem.execution.status === "failed"
                ? "上轮执行失败，可查看错误后重新排队；不会伪装成已完成。"
                : "这是 Agent 任务；先进入队列，再由执行器领取并产出结果。"
          : selectedItem.schedule?.preview
          ? "这是旧清单给出的建议时段，尚未算作真实时间块；拖入时间轴或点击“排今天”才会加入计划。"
          : this.isActualSchedule(selectedItem)
            ? "这张卡已经加入时间轴，但还没有完成。点击“完成”才表示任务执行完毕；来源灵感会继续保留在灵感轨，不再回到未挂接列表。"
            : selectedItem.source_note
              ? "这张卡已经接住一条灵感来源，目前只是待安排；排今天或拖入时间轴后才会进入计划中。"
              : "这张卡还在候选任务池；编辑、排今天或拖入时间轴都不会把它标记为完成。",
      });
      const actions = detail.createDiv({ cls: "aos-schedule-detail-actions" });
      const edit = this.createScheduleButton(actions, "编辑", "pencil", "aos-compact-button is-primary");
      edit.addEventListener("click", () => this.openScheduleEditModal(selectedItem));
      if (selectedItem.execution.mode === "manual") {
        const done = this.createScheduleButton(actions, selectedItem.status === "done" ? "恢复" : "完成", selectedItem.status === "done" ? "rotate-ccw" : "check", "aos-compact-button");
        done.addEventListener("click", () => void this.togglePlanDone(selectedItem));
      } else {
        const agentAction = this.context.agentPlanAction(selectedItem);
        if (agentAction) {
          const action = this.createScheduleButton(actions, agentAction.label, agentAction.icon, "aos-compact-button is-primary", agentAction.title);
          action.addEventListener("click", () => void this.context.runAgentPlanAction(selectedItem));
        }
      }
      if (this.isActualSchedule(selectedItem)) {
        const unschedule = this.createScheduleButton(actions, "退回待安排", "inbox", "aos-compact-button");
        unschedule.addEventListener("click", () => void this.updateScheduleItem(selectedItem, { schedule: null }, selectedItem.source_note ? "已退回待安排；来源灵感仍保持挂接" : "已退回待安排"));
      } else if (selectedItem.status !== "done") {
        const scheduleNow = this.createScheduleButton(actions, "排到今天", "calendar-plus", "aos-compact-button is-primary");
        scheduleNow.addEventListener("click", () => void this.scheduleCandidate(selectedItem, formatLocalDate(new Date())));
      }
      const remove = this.createScheduleButton(actions, "移除", "trash-2", "aos-compact-button is-danger");
      remove.addEventListener("click", () => void this.removePlanItem(selectedItem));
      if (selectedItem.execution.mode === "agent" && ["queued", "running", "review"].includes(selectedItem.execution.status)) {
        remove.disabled = true;
        remove.setAttribute("title", "任务仍在执行状态；接入可靠取消接口前不能移除");
      }
      if (selectedItem.execution.mode === "agent") {
        const execution = detail.createDiv({ cls: "aos-schedule-source-note aos-schedule-execution-detail" });
        execution.createDiv({ cls: "aos-schedule-event-title", text: "Agent 执行契约" });
        execution.createDiv({ cls: "aos-panel-note", text: `意图：${selectedItem.execution.intent}` });
        if (selectedItem.execution.expected_artifact) {
          execution.createDiv({ cls: "aos-panel-note", text: `预期产物：${selectedItem.execution.expected_artifact}` });
        }
        if (selectedItem.execution.error) {
          execution.createDiv({ cls: "aos-panel-note is-error", text: `失败原因：${selectedItem.execution.error}` });
        }
        const artifactPath = selectedItem.completion_receipt?.result_path || selectedItem.execution.artifact_path;
        if (selectedItem.completion_receipt?.summary) {
          execution.createDiv({ cls: "aos-panel-note", text: `结果：${selectedItem.completion_receipt.summary}` });
        }
        if (artifactPath) {
          execution.createDiv({ cls: "aos-panel-note", text: `产物：${artifactPath}` });
          const openArtifact = this.createScheduleButton(execution, "查看产物", "file-check", "aos-inspiration-card-action is-primary");
          openArtifact.addEventListener("click", () => this.context.openFileByPath(normalizePath(artifactPath)));
        }
      }
      if (selectedItem.source_note) {
        const source = detail.createDiv({ cls: "aos-schedule-source-note" });
        source.createDiv({ cls: "aos-schedule-event-title", text: "来源灵感" });
        source.createDiv({ cls: "aos-panel-note", text: selectedItem.source_note.path });
        const openSource = this.createScheduleButton(source, "打开灵感卡", "lightbulb", "aos-inspiration-card-action is-primary");
        openSource.addEventListener("click", () => {
          const node = this.context.toNode(selectedItem.source_note?.path ?? "");
          if (node) void this.context.openNode(node);
          else new Notice(`灵感笔记不存在：${selectedItem.source_note?.path ?? ""}`);
        });
      }
    } else {
      detail.createDiv({ cls: "aos-panel-note", text: "点击周历卡片后，这里显示标题、时间与当前状态。未排期卡片会留在左侧候选池。" });
    }

    const eventHint = detail.createDiv({ cls: "aos-schedule-event-hint" });
    eventHint.createDiv({ cls: "aos-schedule-event-title", text: "当前快照" });
    eventHint.createDiv({ text: `事项总数 ${itemCount}` });
    eventHint.createDiv({ text: `生成时间 ${new Date(generatedAt).toLocaleTimeString()}` });
  }

  private async nudgeScheduleItemByKeyboard(
    item: PlanItem,
    schedule: { date: string; start: string; end: string },
    weekDates: string[],
    axis: "day" | "time" | "resize",
    delta: number,
    render: () => Promise<void>,
  ): Promise<void> {
    if (this.scheduleKeyboardUpdates.has(item.item_id)) return;
    const current = this.schedulePreviewOverrides.get(item.item_id) ?? schedule;
    const startMinutes = scheduleMinutes(current.start);
    const endMinutes = scheduleMinutes(current.end);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) return;

    const duration = Math.max(SCHEDULE_STEP, endMinutes - startMinutes);
    let nextDate = current.date;
    let nextStart = startMinutes;
    let nextEnd = endMinutes;
    if (axis === "day") {
      const dayIndex = clampNumber(weekDates.indexOf(current.date), 0, weekDates.length - 1);
      nextDate = weekDates[clampNumber(dayIndex + delta, 0, weekDates.length - 1)];
    } else if (axis === "time") {
      nextStart = clampNumber(snapMinutes(startMinutes + delta, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - duration);
      nextEnd = nextStart + duration;
    } else {
      nextEnd = clampNumber(snapMinutes(endMinutes + delta, SCHEDULE_STEP), startMinutes + SCHEDULE_STEP, SCHEDULE_DAY_END);
    }
    if (nextDate === current.date && nextStart === startMinutes && nextEnd === endMinutes) return;

    this.scheduleKeyboardUpdates.add(item.item_id);
    this.schedulePreviewOverrides.set(item.item_id, {
      date: nextDate,
      start: minutesToScheduleTime(nextStart),
      end: minutesToScheduleTime(nextEnd),
    });
    try {
      await this.context.plugin.planLedger.updatePlanItem(item, {
        plan_date: nextDate,
        schedule: this.scheduleValue(nextDate, minutesToScheduleTime(nextStart), minutesToScheduleTime(nextEnd)),
      });
      this.schedulePreviewOverrides.delete(item.item_id);
      this.selectedScheduleItemId = item.item_id;
      await render();
      const direction = axis === "day" ? "日期" : axis === "time" ? "开始时间" : "时长";
      new Notice(`已调整${direction}：${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)}`);
      window.requestAnimationFrame(() => {
        const nextCard = Array.from(this.context.mainPane.querySelectorAll<HTMLElement>(".aos-schedule-time-card"))
          .find(candidate => candidate.dataset.scheduleItemId === item.item_id);
        nextCard?.focus({ preventScroll: true });
      });
    } catch (error: any) {
      this.schedulePreviewOverrides.delete(item.item_id);
      new Notice(`快捷调整失败：${error instanceof Error ? error.message : String(error)}`);
      await render();
    } finally {
      this.scheduleKeyboardUpdates.delete(item.item_id);
    }
  }

  private attachScheduleCardPreviewInteraction(
    card: HTMLDivElement,
    meta: HTMLDivElement,
    layer: HTMLDivElement,
    weekDates: string[],
    item: PlanItem,
    schedule: { date: string; start: string; end: string },
    dragHandle: HTMLDivElement,
    resizeHandle: HTMLDivElement,
    render: () => Promise<void>,
  ): void {
    card.addEventListener("keydown", event => {
      const shortcuts = this.context.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS;
      if (shortcutMatches(event, shortcuts.openDetails)) {
        event.preventDefault();
        this.selectedScheduleItemId = item.item_id;
        this.scheduleDetailOpen = true;
        void this.renderSchedule();
        return;
      }
      if (shortcutMatches(event, shortcuts.toggleDone)) {
        event.preventDefault();
        event.stopPropagation();
        this.selectedScheduleItemId = item.item_id;
        void this.togglePlanDone(item);
        return;
      }
      let axis: "day" | "time" | "resize" | null = null;
      let step = 0;
      if (shortcutMatches(event, shortcuts.moveDayPrevious)) { axis = "day"; step = -1; }
      else if (shortcutMatches(event, shortcuts.moveDayNext)) { axis = "day"; step = 1; }
      else if (shortcutMatches(event, shortcuts.moveTimeEarlier)) { axis = "time"; step = -SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.moveTimeLater)) { axis = "time"; step = SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.resizeShorter)) { axis = "resize"; step = -SCHEDULE_STEP; }
      else if (shortcutMatches(event, shortcuts.resizeLonger)) { axis = "resize"; step = SCHEDULE_STEP; }
      if (!axis) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectedScheduleItemId = item.item_id;
      void this.nudgeScheduleItemByKeyboard(item, schedule, weekDates, axis, step, render);
    });
    card.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const resizing = target === resizeHandle || Boolean(target?.closest(".aos-schedule-resize-handle"));
      const dragging = target === dragHandle || Boolean(target?.closest(".aos-schedule-drag-handle"));
      if (!resizing && !dragging) return;
      event.stopPropagation();
      card.setPointerCapture(event.pointerId);

      const current = this.schedulePreviewOverrides.get(item.item_id) ?? schedule;
      const startMinutes = scheduleMinutes(current.start);
      const endMinutes = scheduleMinutes(current.end);
      const duration = Math.max(15, endMinutes - startMinutes);
      let nextDate = current.date;
      let nextStart = startMinutes;
      let nextEnd = endMinutes;
      let frame = 0;
      let hasChanged = false;
      let active = false;
      let overlay: HTMLDivElement | null = null;
      const startX = event.clientX;
      const startY = event.clientY;
      const activationDistance = resizing ? 3 : 8;
      const layerRect = layer.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const dayWidth = layerRect.width / 7;
      const pointerOffsetX = event.clientX - cardRect.left;
      const pointerOffsetY = event.clientY - cardRect.top;
      const initialHeight = cardRect.height;
      let targetDx = 0;
      let targetDy = 0;
      let targetHeight = initialHeight;
      let visualDx = 0;
      let visualDy = 0;
      let visualHeight = initialHeight;

      const ensureOverlay = (): HTMLDivElement => {
        if (overlay) return overlay;
        event.preventDefault();
        overlay = card.cloneNode(true) as HTMLDivElement;
        overlay.classList.add("is-overlay", resizing ? "is-resizing" : "is-dragging");
        overlay.classList.remove("is-selected");
        overlay.style.left = `${cardRect.left}px`;
        overlay.style.top = `${cardRect.top}px`;
        overlay.style.width = `${cardRect.width}px`;
        overlay.style.height = `${initialHeight}px`;
        overlay.style.transform = "translate3d(0, 0, 0)";
        document.body.appendChild(overlay);
        card.classList.add("is-interaction-source");
        card.classList.add(resizing ? "is-resizing" : "is-dragging");
        return overlay;
      };

      const applyPreview = (): void => {
        frame = 0;
        const preview = ensureOverlay();
        visualDx += (targetDx - visualDx) * 0.36;
        visualDy += (targetDy - visualDy) * 0.36;
        visualHeight += (targetHeight - visualHeight) * 0.36;
        if (Math.abs(targetDx - visualDx) < 0.35) visualDx = targetDx;
        if (Math.abs(targetDy - visualDy) < 0.35) visualDy = targetDy;
        if (Math.abs(targetHeight - visualHeight) < 0.35) visualHeight = targetHeight;
        preview.style.transform = `translate3d(${visualDx}px, ${visualDy}px, 0)`;
        preview.style.height = `${visualHeight}px`;
        const overlayMeta = preview.querySelector(".aos-schedule-time-card-meta");
        if (overlayMeta) overlayMeta.textContent = `${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)} · 本地预览`;
        if (active && overlay && (Math.abs(targetDx - visualDx) > 0.35 || Math.abs(targetDy - visualDy) > 0.35 || Math.abs(targetHeight - visualHeight) > 0.35)) {
          frame = requestAnimationFrame(applyPreview);
        }
      };

      const scheduleFrame = (): void => {
        if (!frame) frame = requestAnimationFrame(applyPreview);
      };

      const applyFinalToCard = (): void => {
        const dayIndex = clampNumber(weekDates.indexOf(nextDate), 0, 6);
        const top = Math.max(0, ((nextStart - 360) / (18 * 60)) * 100);
        const height = Math.max(4.5, ((nextEnd - nextStart) / (18 * 60)) * 100);
        card.style.left = `calc(${(dayIndex * 100) / 7}% + 4px)`;
        card.style.width = `calc(${100 / 7}% - 8px)`;
        card.style.top = `${top}%`;
        card.style.height = `${height}%`;
        meta.textContent = `${minutesToScheduleTime(nextStart)}-${minutesToScheduleTime(nextEnd)} · 本地预览`;
      };

      const onMove = (moveEvent: PointerEvent): void => {
        const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (!active && moved < activationDistance) return;
        active = true;
        moveEvent.preventDefault();
        if (resizing) {
          const rawMinutes = 360 + ((moveEvent.clientY - layerRect.top) / layerRect.height) * (18 * 60);
          nextEnd = clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), nextStart + SCHEDULE_STEP, SCHEDULE_DAY_END);
        } else {
          const rawLeft = moveEvent.clientX - layerRect.left - pointerOffsetX;
          const rawTop = moveEvent.clientY - layerRect.top - pointerOffsetY;
          const dayIndex = clampNumber(Math.round(rawLeft / dayWidth), 0, 6);
          nextDate = weekDates[dayIndex];
          const rawMinutes = 360 + (rawTop / layerRect.height) * (18 * 60);
          nextStart = clampNumber(snapMinutes(rawMinutes, SCHEDULE_STEP), SCHEDULE_DAY_START, SCHEDULE_DAY_END - duration);
          nextEnd = nextStart + duration;
        }
        const dayIndex = clampNumber(weekDates.indexOf(nextDate), 0, 6);
        const topPx = ((nextStart - 360) / (18 * 60)) * layerRect.height;
        const heightPx = ((nextEnd - nextStart) / (18 * 60)) * layerRect.height;
        const targetViewportLeft = layerRect.left + dayIndex * dayWidth + 4;
        const targetViewportTop = layerRect.top + Math.max(0, topPx);
        targetDx = targetViewportLeft - cardRect.left;
        targetDy = targetViewportTop - cardRect.top;
        targetHeight = Math.max(34, heightPx);
        hasChanged = nextDate !== current.date || nextStart !== startMinutes || nextEnd !== endMinutes;
        scheduleFrame();
      };

      const onUp = (): void => {
        if (frame) cancelAnimationFrame(frame);
        this.selectedScheduleItemId = item.item_id;
        this.scheduleDetailOpen = !active && !hasChanged ? true : false;
        if (hasChanged) {
          applyFinalToCard();
          this.schedulePreviewOverrides.set(item.item_id, {
            date: nextDate,
            start: minutesToScheduleTime(nextStart),
            end: minutesToScheduleTime(nextEnd),
          });
        }
        overlay?.remove();
        card.classList.remove("is-dragging", "is-resizing", "is-interaction-source");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (hasChanged) {
          void this.context.plugin.planLedger.updatePlanItem(item, {
            plan_date: nextDate,
            schedule: this.scheduleValue(nextDate, minutesToScheduleTime(nextStart), minutesToScheduleTime(nextEnd)),
          }).then(() => {
            this.schedulePreviewOverrides.delete(item.item_id);
            return render();
          }).catch((error: any) => {
            this.schedulePreviewOverrides.delete(item.item_id);
            new Notice(`保存排期失败：${error instanceof Error ? error.message : String(error)}`);
            void render();
          });
        } else {
          void render();
        }
      };

      const onCancel = (): void => {
        if (frame) cancelAnimationFrame(frame);
        overlay?.remove();
        card.classList.remove("is-dragging", "is-resizing", "is-interaction-source");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      window.addEventListener("pointercancel", onCancel, { once: true });
    });
  }


}
