import { App, Modal, Notice } from "obsidian";
import type ScriptoriumPlugin from "../../main";
import type { CreatePlanItemInput, PlanItemKind } from "../PlanLedgerService";
import { DEFAULT_SCHEDULE_SHORTCUTS, ScheduleShortcutSettings } from "../../settings";
import { formatShortcut, serializeShortcutEvent } from "../WorkspaceKeymap";

export const SCHEDULE_DAY_START = 6 * 60;
export const SCHEDULE_DAY_END = 24 * 60 - 15;
export const SCHEDULE_STEP = 15;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function snapMinutes(minutes: number, step = 15): number {
  return Math.round(minutes / step) * step;
}

export function scheduleValue(date: string, start: string, end: string): {
  date: string;
  start: string;
  end: string;
  timezone: string;
  fixed: boolean;
  preview: boolean;
} {
  return {
    date,
    start,
    end,
    timezone: "Asia/Shanghai",
    fixed: false,
    preview: false,
  };
}

export function scheduleMinutes(value: string): number {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

export function minutesToScheduleTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getWeekDates(dateText: string): string[] {
  const date = parseLocalDate(dateText);
  const day = date.getDay() || 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - day + 1);
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(monday);
    current.setDate(monday.getDate() + index);
    return formatLocalDate(current);
  });
}

export type ScheduleShortcutName = keyof ScheduleShortcutSettings;

const SCHEDULE_SHORTCUT_LABELS: Array<{ key: ScheduleShortcutName; label: string; description: string }> = [
  { key: "moveDayPrevious", label: "前一天", description: "在当前周时间轴向左移动" },
  { key: "moveDayNext", label: "后一天", description: "在当前周时间轴向右移动" },
  { key: "moveTimeEarlier", label: "提前开始", description: "开始时间提前 15 分钟" },
  { key: "moveTimeLater", label: "延后开始", description: "开始时间延后 15 分钟" },
  { key: "resizeShorter", label: "缩短时长", description: "结束时间提前 15 分钟" },
  { key: "resizeLonger", label: "延长时长", description: "结束时间延后 15 分钟" },
  { key: "openDetails", label: "打开详情", description: "打开当前计划卡片详情" },
  { key: "toggleDone", label: "完成 / 恢复", description: "切换任务完成状态" },
];

export class ScheduleCreateModal extends Modal {
  constructor(
    app: App,
    private initial: CreatePlanItemInput,
    private onSubmit: (input: CreatePlanItemInput) => Promise<void>,
    private labels: { heading?: string; submit?: string } = {},
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-schedule-create-modal");
    contentEl.createEl("h2", { text: this.labels.heading ?? "新增计划卡片" });
    contentEl.createDiv({ cls: "aos-schedule-create-note", text: "卡片会写入本地计划事件流，之后刷新页面仍会保留。" });
    if (this.initial.sourceNotePath) {
      contentEl.createDiv({ cls: "aos-schedule-create-source", text: `来源灵感：${this.initial.sourceNotePath}` });
    }

    const form = contentEl.createEl("form", { cls: "aos-schedule-create-form" });
    const titleLabel = form.createEl("label", { cls: "aos-schedule-create-field" });
    titleLabel.createSpan({ text: "标题" });
    const titleInput = titleLabel.createEl("input", {
      attr: { type: "text", placeholder: "例如：整理松果天工台的前沿情报与架构笔记", required: "true", autofocus: "true" },
    });
    titleInput.value = this.initial.title;

    const basics = form.createDiv({ cls: "aos-schedule-create-grid" });
    const kindLabel = basics.createEl("label", { cls: "aos-schedule-create-field" });
    kindLabel.createSpan({ text: "卡片类型" });
    const kindSelect = kindLabel.createEl("select");
    kindSelect.createEl("option", { value: "micro_task", text: "小目标" });
    kindSelect.createEl("option", { value: "focus", text: "今日要事" });
    kindSelect.value = this.initial.kind;

    const dateLabel = basics.createEl("label", { cls: "aos-schedule-create-field" });
    dateLabel.createSpan({ text: "日期" });
    const dateInput = dateLabel.createEl("input", { attr: { type: "date", required: "true" } });
    dateInput.value = this.initial.date;

    const scheduleLabel = form.createEl("label", { cls: "aos-schedule-create-toggle" });
    const scheduleInput = scheduleLabel.createEl("input", { attr: { type: "checkbox" } });
    scheduleInput.checked = this.initial.scheduled;
    scheduleLabel.createSpan({ text: "安排到时间轴" });

    const timeGrid = form.createDiv({ cls: "aos-schedule-create-grid aos-schedule-time-fields" });
    const startLabel = timeGrid.createEl("label", { cls: "aos-schedule-create-field" });
    startLabel.createSpan({ text: "开始" });
    const startInput = startLabel.createEl("input", { attr: { type: "time", required: "true" } });
    startInput.value = this.initial.start;

    const endLabel = timeGrid.createEl("label", { cls: "aos-schedule-create-field" });
    endLabel.createSpan({ text: "结束" });
    const endInput = endLabel.createEl("input", { attr: { type: "time", required: "true" } });
    endInput.value = this.initial.end;

    const updateTimeState = (): void => {
      startInput.disabled = !scheduleInput.checked;
      endInput.disabled = !scheduleInput.checked;
      timeGrid.classList.toggle("is-disabled", !scheduleInput.checked);
    };
    scheduleInput.addEventListener("change", updateTimeState);
    updateTimeState();

    const actions = form.createDiv({ cls: "aos-schedule-create-actions" });
    const cancel = actions.createEl("button", { type: "button", text: "取消" });
    const submit = actions.createEl("button", { type: "submit", cls: "mod-cta", text: this.labels.submit ?? "加入计划" });
    cancel.addEventListener("click", () => this.close());
    form.addEventListener("submit", event => {
      event.preventDefault();
      const title = titleInput.value.trim();
      if (!title || !dateInput.value) {
        new Notice("请填写标题和日期");
        return;
      }
      const input: CreatePlanItemInput = {
        title,
        kind: kindSelect.value as PlanItemKind,
        date: dateInput.value,
        scheduled: scheduleInput.checked,
        start: startInput.value,
        end: endInput.value,
        sourceNotePath: this.initial.sourceNotePath,
      };
      submit.disabled = true;
      void this.onSubmit(input)
        .then(() => this.close())
        .catch(error => {
          submit.disabled = false;
          new Notice(`新增卡片失败：${error instanceof Error ? error.message : String(error)}`);
        });
    });
  }
}

export class ScheduleShortcutModal extends Modal {
  constructor(
    app: App,
    private plugin: ScriptoriumPlugin,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("aos-schedule-shortcut-modal");
    contentEl.createEl("h2", { text: "日程快捷键" });
    contentEl.createDiv({
      cls: "aos-schedule-shortcut-note",
      text: "先点击右侧按键框，再按下想要的组合键。快捷键只在时间轴卡片获得焦点时生效，不会覆盖 Obsidian 的全局命令。",
    });

    let draft: ScheduleShortcutSettings = structuredClone(this.plugin.settings.scheduleShortcuts ?? DEFAULT_SCHEDULE_SHORTCUTS);
    let capturing: ScheduleShortcutName | null = null;
    const captureButtons = new Map<ScheduleShortcutName, HTMLButtonElement>();

    const setCaptureText = (key: ScheduleShortcutName, text?: string): void => {
      const button = captureButtons.get(key);
      if (!button) return;
      button.empty();
      button.createSpan({ text: text ?? formatShortcut(draft[key]) });
    };
    const stopCapturing = (): void => {
      if (capturing) setCaptureText(capturing);
      capturing = null;
    };

    const list = contentEl.createDiv({ cls: "aos-schedule-shortcut-list" });
    for (const action of SCHEDULE_SHORTCUT_LABELS) {
      const row = list.createDiv({ cls: "aos-schedule-shortcut-row" });
      const description = row.createDiv({ cls: "aos-schedule-shortcut-description" });
      description.createDiv({ cls: "aos-schedule-shortcut-label", text: action.label });
      description.createDiv({ cls: "aos-schedule-shortcut-help", text: action.description });
      const capture = row.createEl("button", {
        cls: "aos-schedule-shortcut-capture",
        attr: { type: "button", "aria-label": `设置${action.label}快捷键` },
      });
      captureButtons.set(action.key, capture);
      setCaptureText(action.key);
      capture.addEventListener("click", () => {
        if (capturing && capturing !== action.key) setCaptureText(capturing);
        capturing = action.key;
        capture.empty();
        capture.createSpan({ cls: "is-capturing", text: "按下组合键…" });
        capture.focus();
      });
      capture.addEventListener("keydown", event => {
        if (capturing !== action.key) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          stopCapturing();
          return;
        }
        const next = serializeShortcutEvent(event);
        if (!next) return;
        draft[action.key] = next;
        setCaptureText(action.key);
        capturing = null;
      });
    }

    const footer = contentEl.createDiv({ cls: "aos-schedule-shortcut-actions" });
    const reset = footer.createEl("button", { type: "button", text: "恢复默认" });
    reset.addEventListener("click", () => {
      stopCapturing();
      draft = structuredClone(DEFAULT_SCHEDULE_SHORTCUTS);
      for (const action of SCHEDULE_SHORTCUT_LABELS) setCaptureText(action.key);
    });
    const cancel = footer.createEl("button", { type: "button", text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { type: "button", cls: "mod-cta", text: "保存快捷键" });
    save.addEventListener("click", () => {
      stopCapturing();
      const duplicates = new Map<string, string>();
      for (const action of SCHEDULE_SHORTCUT_LABELS) {
        const previous = duplicates.get(draft[action.key]);
        if (previous) {
          new Notice(`快捷键冲突：${previous} 与 ${action.label} 都是 ${formatShortcut(draft[action.key])}`);
          return;
        }
        duplicates.set(draft[action.key], action.label);
      }
      this.plugin.settings.scheduleShortcuts = { ...draft };
      void this.plugin.saveSettings().then(() => {
        new Notice("日程快捷键已保存");
        this.onSaved();
        this.close();
      });
    });
  }
}
