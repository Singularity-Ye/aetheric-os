import { App, TFile, TFolder, normalizePath } from "obsidian";

export type PlanItemKind = "focus" | "micro_task";
export type PlanProtocolVersion = "aos-plan/v1" | "aos-plan/v2";
export type PlanSourceActor = "user" | "hermes" | "codex";
export type PlanExecutor = PlanSourceActor;
export type PlanExecutionStatus = "idle" | "queued" | "running" | "review" | "done" | "failed";
export type PlanItemStatus = "proposed" | "queued" | "running" | "review" | "done" | "failed" | "planned";

export interface PlanExecution {
  mode: "manual" | "agent";
  executor: PlanExecutor;
  intent: string;
  input_note?: string;
  output_kind?: string;
  expected_artifact?: string;
  artifact_path?: string;
  not_before?: string;
  deadline?: string;
  priority: number;
  dependencies: string[];
  run_id?: string;
  /** Deterministic local refinement job bound to the current execution run. */
  refinement_job_id?: string;
  retry_count: number;
  status: PlanExecutionStatus;
  error?: string;
}

export interface PlanCompletionReceipt {
  summary?: string;
  result_path?: string;
  completed_at?: string;
}

export interface CreatePlanExecutionInput {
  mode?: PlanExecution["mode"];
  executor?: PlanExecutor;
  intent?: string;
  input_note?: string;
  output_kind?: string;
  expected_artifact?: string;
  artifact_path?: string;
  not_before?: string;
  deadline?: string;
  priority?: number;
  dependencies?: string[];
  run_id?: string;
  refinement_job_id?: string;
  retry_count?: number;
  status?: PlanExecutionStatus;
  error?: string;
}

export type PlanExecutionPatch = {
  [K in keyof PlanExecution]?: PlanExecution[K] | null;
};

export interface CreatePlanItemInput {
  title: string;
  kind: PlanItemKind;
  date: string;
  scheduled: boolean;
  start: string;
  end: string;
  /** Optional link back to an inspiration card/note that seeded this plan item. */
  sourceNotePath?: string;
  /** The actor that proposed this item. Defaults to the local user. */
  actor?: PlanSourceActor;
  /** New callers may opt into the v2 execution model; old callers remain manual. */
  status?: PlanItemStatus;
  execution?: CreatePlanExecutionInput;
  completion_receipt?: PlanCompletionReceipt;
}

export type CreateAgentPlanItemInput = Omit<
  CreatePlanItemInput,
  "actor" | "status" | "execution" | "completion_receipt"
> & {
  executor: PlanExecutor;
  intent: string;
  actor?: PlanSourceActor;
  queue?: boolean;
  input_note?: string;
  output_kind?: string;
  expected_artifact?: string;
  artifact_path?: string;
  not_before?: string;
  deadline?: string;
  priority?: number;
  dependencies?: string[];
};

export interface UpdatePlanItemPatch {
  title?: string;
  kind?: PlanItemKind;
  status?: PlanItemStatus;
  plan_date?: string;
  schedule?: PlanItem["schedule"] | null;
  source_note?: PlanSourceNote | null;
  source_actor?: PlanSourceActor;
  execution?: PlanExecutionPatch;
  completion_receipt?: PlanCompletionReceipt | null;
}

export interface PlanSourceNote {
  path: string;
  kind: "inspiration";
}

export interface LegacyChecklistItem {
  source: PlanItemKind;
  index: number;
  text: string;
  completed: boolean;
  lineContent: string;
  legacyPath: string;
}

export interface PlanItem {
  item_id: string;
  title: string;
  kind: PlanItemKind;
  status: PlanItemStatus;
  plan_date: string;
  domain: string;
  schedule?: {
    date: string;
    start: string;
    end: string;
    timezone: "Asia/Shanghai";
    fixed: boolean;
    preview: boolean;
  };
  source: {
    channel: "legacy_markdown" | "plan_ledger";
    actor: PlanSourceActor;
    legacy_path: string;
    legacy_line: number;
  };
  source_note?: PlanSourceNote;
  execution: PlanExecution;
  completion_receipt?: PlanCompletionReceipt;
  confirmation: {
    required: boolean;
    status: "not_required";
  };
  created_at: string;
  updated_at: string;
}

export interface PlanTodaySnapshot {
  protocol_version: "aos-plan/v2";
  date: string;
  generated_at: string;
  items: PlanItem[];
  legacy: {
    todo_path: string;
    focus_path: string;
  };
  summary: {
    focus_done: number;
    focus_total: number;
    micro_done: number;
    micro_total: number;
    execution: {
      idle: number;
      queued: number;
      running: number;
      review: number;
      done: number;
      failed: number;
      agent_total: number;
      manual_total: number;
    };
  };
}

interface PlanLedgerEvent {
  event_id: string;
  protocol_version: PlanProtocolVersion;
  event_type: "ledger_initialized" | "plan_created" | "plan_updated" | "plan_deleted";
  actor: {
    kind: "workbench" | PlanSourceActor;
    id: string;
  };
  source: {
    surface: "workbench" | "hermes" | "codex";
    operation:
      | "plan_ledger_init"
      | "plan_create"
      | "plan_update"
      | "plan_delete"
      | "plan_queue"
      | "plan_claim"
      | "plan_review"
      | "plan_complete"
      | "plan_fail";
  };
  payload: Record<string, unknown>;
  requires_confirmation: false;
  idempotency_key: string;
  created_at: string;
}

interface PlanLedgerState {
  items: Map<string, PlanItem>;
  patches: Map<string, UpdatePlanItemPatch & { updated_at?: string }>;
  deleted: Set<string>;
}

const PLAN_ROOT = "08_密室/生活计划";
const PLAN_EVENTS_DIR = `${PLAN_ROOT}/_events`;
const PLAN_SNAPSHOTS_DIR = `${PLAN_ROOT}/_snapshots`;
const TODO_PATH = "08_密室/todo.md";
const FOCUS_PATH = "08_密室/林下工作台.md";

export class PlanLedgerService {
  private mutationTail: Promise<void> = Promise.resolve();
  private itemSequence = 0;

  constructor(private app: App) {}

  async loadLegacyTodoItems(): Promise<LegacyChecklistItem[]> {
    return this.readChecklist(TODO_PATH, "micro_task");
  }

  async loadLegacyFocusItems(): Promise<LegacyChecklistItem[]> {
    return this.readChecklist(FOCUS_PATH, "focus", "### 今日三件事", 3);
  }

  async refreshTodaySnapshot(date = new Date()): Promise<PlanTodaySnapshot> {
    await this.ensureLedgerFiles(date);
    const snapshot = await this.buildTodaySnapshot(date);
    await this.writeJson(`${PLAN_SNAPSHOTS_DIR}/today.json`, snapshot);
    return snapshot;
  }

  async buildTodaySnapshot(date = new Date()): Promise<PlanTodaySnapshot> {
    const [focusItems, microItems] = await Promise.all([
      this.loadLegacyFocusItems(),
      this.loadLegacyTodoItems(),
    ]);
    const isoDate = toLocalDate(date);
    const generatedAt = new Date().toISOString();
    const legacyItems = [...focusItems.filter(item => item.text.trim()), ...microItems];
    const ledgerState = await this.loadLedgerState();
    const items = legacyItems
      .map((item, index) => this.toPlanItem(item, isoDate, generatedAt, index))
      .map(item => this.applyPatch(item, ledgerState.patches.get(item.item_id)))
      .filter(item => !ledgerState.deleted.has(item.item_id));
    items.push(...[...ledgerState.items.values()]
      .map(item => this.applyPatch(item, ledgerState.patches.get(item.item_id)))
      .filter(item => item.plan_date === isoDate && !ledgerState.deleted.has(item.item_id)));
    return {
      protocol_version: "aos-plan/v2",
      date: isoDate,
      generated_at: generatedAt,
      items,
      legacy: {
        todo_path: TODO_PATH,
        focus_path: FOCUS_PATH,
      },
      summary: {
        focus_done: items.filter(item => item.kind === "focus" && item.status === "done").length,
        focus_total: items.filter(item => item.kind === "focus").length,
        micro_done: items.filter(item => item.kind === "micro_task" && item.status === "done").length,
        micro_total: items.filter(item => item.kind === "micro_task").length,
        execution: {
          idle: items.filter(item => item.execution.status === "idle").length,
          queued: items.filter(item => item.execution.status === "queued").length,
          running: items.filter(item => item.execution.status === "running").length,
          review: items.filter(item => item.execution.status === "review").length,
          done: items.filter(item => item.execution.status === "done").length,
          failed: items.filter(item => item.execution.status === "failed").length,
          agent_total: items.filter(item => item.execution.mode === "agent").length,
          manual_total: items.filter(item => item.execution.mode === "manual").length,
        },
      },
    };
  }

  async loadPlanItemsForDates(dates: string[]): Promise<PlanItem[]> {
    const wanted = new Set(dates);
    const state = await this.loadLedgerState();
    return [...state.items.values()]
      .map(item => this.applyPatch(item, state.patches.get(item.item_id)))
      .filter(item => wanted.has(item.plan_date) && !state.deleted.has(item.item_id));
  }

  /**
   * Return the existing ledger item for an inspiration source, if any.
   *
   * A source note is a single candidate in the workbench lifecycle. Keeping
   * this lookup in the ledger prevents the UI from creating duplicate plan
   * cards when metadata cache refresh and a user's second click race each
   * other.
   */
  async findPlanItemBySource(sourceNotePath: string): Promise<PlanItem | undefined> {
    const normalized = normalizeSourceNotePath(sourceNotePath);
    if (!normalized) return undefined;
    const state = await this.loadLedgerState();
    return [...state.items.values()]
      .map(item => this.applyPatch(item, state.patches.get(item.item_id)))
      .filter(item => !state.deleted.has(item.item_id))
      .filter(item => normalizeSourceNotePath(item.source_note?.path) === normalized)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  }

  async createPlanItem(input: CreatePlanItemInput): Promise<PlanItem> {
    return this.serializeMutation(async () => {
    const title = input.title.trim();
    if (!title) throw new Error("卡片标题不能为空");
    if (!isIsoDate(input.date)) throw new Error("请选择有效的日期");
    if (input.scheduled) {
      const start = scheduleMinutes(input.start);
      const end = scheduleMinutes(input.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("结束时间必须晚于开始时间");
      }
    }

    const timestamp = new Date().toISOString();
    const sourceNotePath = normalizeSourceNotePath(input.sourceNotePath);
    const eventPath = `${PLAN_EVENTS_DIR}/${input.date.slice(0, 7)}.jsonl`;
    await this.ensureLedgerFiles(toLocalDateDate(input.date));
    const actor = normalizePlanActor(input.actor ?? input.execution?.executor) ?? "user";
    const requestedStatus = normalizePlanItemStatus(
      input.status ?? planStatusForExecution(input.execution?.status) ?? "proposed",
    );
    const execution = normalizeExecution(input.execution, title, actor, requestedStatus);
    validateExecution(execution);
    const item: PlanItem = {
      item_id: `pln_${input.date.replace(/-/g, "")}_${input.kind}_${Date.now().toString(36)}_${(this.itemSequence++).toString(36)}`,
      title,
      kind: input.kind,
      status: requestedStatus,
      plan_date: input.date,
      domain: input.kind === "focus" ? "today_focus" : "today_micro",
      ...(input.scheduled
        ? {
            schedule: {
              date: input.date,
              start: input.start,
              end: input.end,
              timezone: "Asia/Shanghai" as const,
              fixed: false,
              preview: false,
            },
          }
        : {}),
      source: {
        channel: "plan_ledger",
        actor,
        legacy_path: eventPath,
        legacy_line: 0,
      },
      ...(sourceNotePath ? { source_note: { path: sourceNotePath, kind: "inspiration" as const } } : {}),
      execution,
      ...(input.completion_receipt ? { completion_receipt: normalizeCompletionReceipt(input.completion_receipt) } : {}),
      confirmation: {
        required: false,
        status: "not_required",
      },
      created_at: timestamp,
      updated_at: timestamp,
    };
    const event: PlanLedgerEvent = {
      event_id: `evt_${item.item_id}`,
      protocol_version: "aos-plan/v2",
      event_type: "plan_created",
      actor: {
        kind: actor,
        id: actorId(actor),
      },
      source: {
        surface: actorSurface(actor),
        operation: "plan_create",
      },
      payload: { item },
      requires_confirmation: false,
      idempotency_key: item.item_id,
      created_at: timestamp,
    };
    await this.appendEvent(eventPath, event);
    await this.syncSourceNoteLifecycle(sourceNotePath, "scheduled");
    return item;
    });
  }

  /** Create an executable task without treating a visual schedule slot as permission to run it. */
  async createAgentPlanItem(input: CreateAgentPlanItemInput): Promise<PlanItem> {
    const queued = input.queue !== false;
    const actor = normalizePlanActor(input.actor) ?? input.executor;
    return this.createPlanItem({
      title: input.title,
      kind: input.kind,
      date: input.date,
      scheduled: input.scheduled,
      start: input.start,
      end: input.end,
      sourceNotePath: input.sourceNotePath,
      actor,
      status: queued ? "queued" : "proposed",
      execution: {
        mode: "agent",
        executor: input.executor,
        intent: input.intent,
        input_note: input.input_note ?? input.sourceNotePath,
        output_kind: input.output_kind,
        expected_artifact: input.expected_artifact,
        artifact_path: input.artifact_path,
        not_before: input.not_before,
        deadline: input.deadline,
        priority: input.priority,
        dependencies: input.dependencies,
        retry_count: 0,
        status: queued ? "queued" : "idle",
      },
    });
  }

  async queueExecution(itemId: string, actor?: PlanSourceActor): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      const current = await this.requireCurrentPlanItem(itemId);
      if (current.execution.mode !== "agent") throw new Error("手动计划不能进入智能体执行队列");
      if (current.status === "queued" && current.execution.status === "queued") return current;
      if (!["proposed", "failed"].includes(normalizePlanItemStatus(current.status))) {
        throw new Error(`任务当前状态为 ${current.status}，不能重新排队`);
      }
      if (!["idle", "failed"].includes(current.execution.status)) {
        throw new Error(`执行状态为 ${current.execution.status}，不能重新排队`);
      }
      const eventActor = normalizePlanActor(actor) ?? current.execution.executor;
      return this.writePlanUpdate(current, {
        status: "queued",
        execution: { status: "queued", run_id: null, refinement_job_id: null, error: null },
        completion_receipt: null,
      }, eventActor, "plan_queue");
    });
  }

  async claimExecution(itemId: string, executor?: PlanExecutor, runId?: string): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      const state = await this.loadLedgerState();
      const current = this.requirePlanItemFromState(itemId, state);
      if (current.execution.mode !== "agent") throw new Error("手动计划不能由智能体领取");
      const claimant = normalizePlanActor(executor) ?? current.execution.executor;
      if (claimant !== current.execution.executor) {
        throw new Error(`任务已指定给 ${current.execution.executor}，${claimant} 不能领取`);
      }
      const requestedRunId = String(runId ?? "").trim();
      if (current.execution.status === "running"
        && requestedRunId
        && current.execution.run_id === requestedRunId) {
        return current;
      }
      if (normalizePlanItemStatus(current.status) !== "queued" || current.execution.status !== "queued") {
        throw new Error(`任务不是可领取状态：${current.status}/${current.execution.status}`);
      }
      if (current.execution.not_before && Date.parse(current.execution.not_before) > Date.now()) {
        throw new Error(`任务尚未到可执行时间：${current.execution.not_before}`);
      }
      const blockedBy = current.execution.dependencies.filter(dependencyId => {
        const dependency = this.planItemFromState(dependencyId, state);
        return !dependency || normalizePlanItemStatus(dependency.status) !== "done";
      });
      if (blockedBy.length) throw new Error(`任务依赖尚未完成：${blockedBy.join(", ")}`);
      const normalizedRunId = requestedRunId || `run_${itemId}_${Date.now().toString(36)}`;
      return this.writePlanUpdate(current, {
        status: "running",
        execution: { status: "running", run_id: normalizedRunId, error: null },
      }, claimant, "plan_claim", `plan_claim:${itemId}:${normalizedRunId}`);
    });
  }

  async submitExecutionForReview(
    itemId: string,
    receipt: PlanCompletionReceipt = {},
    runId?: string,
  ): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      const current = await this.requireCurrentPlanItem(itemId);
      this.assertMatchingExecutionRun(current, runId);
      if (["review", "done"].includes(current.execution.status)) return current;
      if (current.execution.status !== "running") {
        throw new Error(`只有运行中的任务可以提交审核，当前为 ${current.execution.status}`);
      }
      const normalizedReceipt = normalizeCompletionReceipt(receipt);
      return this.writePlanUpdate(current, {
        status: "review",
        execution: {
          status: "review",
          ...(normalizedReceipt.result_path ? { artifact_path: normalizedReceipt.result_path } : {}),
          error: null,
        },
        ...(hasCompletionReceipt(normalizedReceipt) ? { completion_receipt: normalizedReceipt } : {}),
      }, current.execution.executor, "plan_review");
    });
  }

  async completeExecution(
    itemId: string,
    receipt: PlanCompletionReceipt = {},
    runId?: string,
  ): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      const current = await this.requireCurrentPlanItem(itemId);
      this.assertMatchingExecutionRun(current, runId);
      if (current.execution.status === "done") return current;
      if (!["running", "review"].includes(current.execution.status)) {
        throw new Error(`任务尚未运行或审核，不能完成：${current.execution.status}`);
      }
      const normalizedReceipt = normalizeCompletionReceipt({
        ...(current.completion_receipt ?? {}),
        ...receipt,
        completed_at: receipt.completed_at ?? new Date().toISOString(),
      });
      return this.writePlanUpdate(current, {
        status: "done",
        execution: {
          status: "done",
          ...(normalizedReceipt.result_path ? { artifact_path: normalizedReceipt.result_path } : {}),
          error: null,
        },
        completion_receipt: normalizedReceipt,
      }, current.execution.executor, "plan_complete");
    });
  }

  async failExecution(itemId: string, error: string, runId?: string): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      const current = await this.requireCurrentPlanItem(itemId);
      this.assertMatchingExecutionRun(current, runId);
      if (current.execution.status === "failed") return current;
      if (!["queued", "running", "review"].includes(current.execution.status)) {
        throw new Error(`任务当前不能标记失败：${current.execution.status}`);
      }
      const message = error.trim();
      if (!message) throw new Error("失败原因不能为空");
      return this.writePlanUpdate(current, {
        status: "failed",
        execution: {
          status: "failed",
          error: message,
          retry_count: current.execution.retry_count + 1,
        },
      }, current.execution.executor, "plan_fail");
    });
  }

  async updatePlanItem(item: PlanItem, patch: UpdatePlanItemPatch): Promise<PlanItem> {
    return this.serializeMutation(async () => {
      let current = item;
      if (item.source.channel === "plan_ledger") {
        current = await this.requireCurrentPlanItem(item.item_id);
        this.assertFreshSnapshot(item, current);
      }
      return this.writePlanUpdate(current, patch, "user", "plan_update");
    });
  }

  private async writePlanUpdate(
    item: PlanItem,
    patch: UpdatePlanItemPatch,
    actor: PlanSourceActor,
    operation: PlanLedgerEvent["source"]["operation"],
    idempotencyKey?: string,
  ): Promise<PlanItem> {
    const next = this.applyPatch(item, patch);
    if (!next.title.trim()) throw new Error("卡片标题不能为空");
    if (!isIsoDate(next.plan_date)) throw new Error("请选择有效的日期");
    if (next.schedule) {
      const start = scheduleMinutes(next.schedule.start);
      const end = scheduleMinutes(next.schedule.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error("结束时间必须晚于开始时间");
      }
    }
    validateExecution(next.execution, next.item_id);
    const timestamp = nextIsoTimestamp(item.updated_at);
    const eventPath = this.eventPathForItem(item);
    await this.ensureEventPath(eventPath, item.plan_date);
    const event: PlanLedgerEvent = {
      event_id: `evt_update_${item.item_id}_${Date.now().toString(36)}`,
      protocol_version: "aos-plan/v2",
      event_type: "plan_updated",
      actor: { kind: actor, id: actorId(actor) },
      source: { surface: actorSurface(actor), operation },
      payload: { item_id: item.item_id, patch: { ...patch, updated_at: timestamp } },
      requires_confirmation: false,
      idempotency_key: idempotencyKey ?? `${operation}:${item.item_id}:${timestamp}`,
      created_at: timestamp,
    };
    await this.appendEvent(eventPath, event);
    const previousSourceNotePath = normalizeSourceNotePath(item.source_note?.path);
    const nextSourceNotePath = normalizeSourceNotePath(next.source_note?.path);
    if (previousSourceNotePath && previousSourceNotePath !== nextSourceNotePath) {
      await this.syncSourceNoteLifecycle(previousSourceNotePath, "candidate");
    }
    await this.syncSourceNoteLifecycle(nextSourceNotePath, "scheduled");
    return { ...next, updated_at: timestamp };
  }

  async deletePlanItem(item: PlanItem): Promise<void> {
    return this.serializeMutation(async () => {
      const state = await this.loadLedgerState();
      if (state.deleted.has(item.item_id)) return;
      let current = item;
      if (item.source.channel === "plan_ledger") {
        current = this.requirePlanItemFromState(item.item_id, state);
        this.assertFreshSnapshot(item, current);
      }
      const timestamp = new Date().toISOString();
      const eventPath = this.eventPathForItem(current);
      await this.ensureEventPath(eventPath, current.plan_date);
      const event: PlanLedgerEvent = {
        event_id: `evt_delete_${current.item_id}_${Date.now().toString(36)}`,
        protocol_version: "aos-plan/v2",
        event_type: "plan_deleted",
        actor: { kind: "user", id: "local-user" },
        source: { surface: "workbench", operation: "plan_delete" },
        payload: { item_id: current.item_id },
        requires_confirmation: false,
        idempotency_key: `plan_deleted:${current.item_id}`,
        created_at: timestamp,
      };
      await this.appendEvent(eventPath, event);
      await this.syncSourceNoteLifecycle(normalizeSourceNotePath(current.source_note?.path), "candidate");
    });
  }

  private async readChecklist(
    notePath: string,
    source: PlanItemKind,
    sectionHeading?: string,
    limit?: number,
  ): Promise<LegacyChecklistItem[]> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return [];
    const content = await this.app.vault.read(file);
    const lines = content.split(/\r?\n/);
    const items: LegacyChecklistItem[] = [];
    let inSection = !sectionHeading;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (sectionHeading && line.includes(sectionHeading)) {
        inSection = true;
        continue;
      }
      if (sectionHeading && inSection && (line.startsWith("## ") || line.startsWith("---"))) break;
      if (!inSection) continue;

      const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
      if (!match) continue;
      items.push({
        source,
        index: i,
        completed: match[1].toLowerCase() === "x",
        text: match[2].trim(),
        lineContent: line,
        legacyPath: notePath,
      });
      if (limit && items.length >= limit) break;
    }
    return items;
  }

  private toPlanItem(item: LegacyChecklistItem, date: string, timestamp: string, index: number): PlanItem {
    const schedule = this.buildPreviewSchedule(item, date, index);
    return {
      item_id: `pln_${date.replace(/-/g, "")}_${item.source}_${item.index}`,
      title: item.text,
      kind: item.source,
      status: item.completed ? "done" : "proposed",
      plan_date: date,
      domain: item.source === "focus" ? "today_focus" : "today_micro",
      ...(schedule ? { schedule } : {}),
      source: {
        channel: "legacy_markdown",
        actor: "user",
        legacy_path: item.legacyPath,
        legacy_line: item.index + 1,
      },
      execution: {
        mode: "manual",
        executor: "user",
        intent: item.text,
        priority: 0,
        dependencies: [],
        retry_count: 0,
        status: item.completed ? "done" : "idle",
      },
      confirmation: {
        required: false,
        status: "not_required",
      },
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  private buildPreviewSchedule(item: LegacyChecklistItem, date: string, index: number): PlanItem["schedule"] | undefined {
    if (item.completed) return undefined;
    const slots = item.source === "focus"
      ? [
        ["09:30", "11:00"],
        ["14:00", "15:30"],
        ["16:30", "18:00"],
      ]
      : [
        ["09:30", "10:30"],
        ["11:00", "12:00"],
        ["14:00", "15:00"],
        ["16:00", "17:00"],
      ];
    const slot = slots[index % slots.length];
    return {
      date,
      start: slot[0],
      end: slot[1],
      timezone: "Asia/Shanghai",
      fixed: false,
      preview: true,
    };
  }

  private async ensureLedgerFiles(date: Date): Promise<void> {
    await this.ensureFolder(PLAN_EVENTS_DIR);
    await this.ensureFolder(PLAN_SNAPSHOTS_DIR);
    const eventPath = `${PLAN_EVENTS_DIR}/${toLocalMonth(date)}.jsonl`;
    if (await this.adapterExists(eventPath)) return;
    const createdAt = new Date().toISOString();
    const event: PlanLedgerEvent = {
      event_id: `evt_${toLocalDate(date).replace(/-/g, "")}_ledger_initialized`,
      protocol_version: "aos-plan/v2",
      event_type: "ledger_initialized",
      actor: {
        kind: "workbench",
        id: "aetheric-os",
      },
      source: {
        surface: "workbench",
        operation: "plan_ledger_init",
      },
      payload: {
        plan_root: PLAN_ROOT,
        legacy_todo_path: TODO_PATH,
        legacy_focus_path: FOCUS_PATH,
      },
      requires_confirmation: false,
      idempotency_key: `ledger_initialized:${toLocalMonth(date)}`,
      created_at: createdAt,
    };
    await this.app.vault.create(eventPath, `${JSON.stringify(event)}\n`);
  }

  private async loadLedgerItems(date: string): Promise<PlanItem[]> {
    return this.loadPlanItemsForDates([date]);
  }

  private async loadLedgerState(): Promise<PlanLedgerState> {
    const items = new Map<string, PlanItem>();
    const patches = new Map<string, UpdatePlanItemPatch & { updated_at?: string }>();
    const deleted = new Set<string>();
    const seenEvents = new Set<string>();
    const eventsFolder = this.app.vault.getAbstractFileByPath(PLAN_EVENTS_DIR);
    const files = eventsFolder instanceof TFolder
      ? eventsFolder.children.filter(child => child instanceof TFile && child.name.endsWith(".jsonl")) as TFile[]
      : [];
    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const content = await this.app.vault.read(file);
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as PlanLedgerEvent;
          const eventIdentity = String(event.idempotency_key || event.event_id || "").trim();
          if (eventIdentity && seenEvents.has(eventIdentity)) continue;
          if (eventIdentity) seenEvents.add(eventIdentity);
          const itemId = typeof event.payload?.item_id === "string" ? event.payload.item_id : "";
          if (event.event_type === "plan_created") {
            const item = event.payload?.item as Partial<PlanItem> | undefined;
            if (item && typeof item.item_id === "string" && typeof item.title === "string" && typeof item.plan_date === "string") {
              // The first creation is authoritative. A later duplicate create
              // or stale UI event must never resurrect a tombstoned item.
              if (!deleted.has(item.item_id) && !items.has(item.item_id)) {
                items.set(item.item_id, normalizeLoadedPlanItem(item));
              }
            }
          } else if (event.event_type === "plan_updated" && itemId) {
            if (deleted.has(itemId)) continue;
            const patch = event.payload?.patch;
            if (patch && typeof patch === "object" && !Array.isArray(patch)) {
              patches.set(itemId, mergePlanPatches(
                patches.get(itemId),
                patch as UpdatePlanItemPatch & { updated_at?: string },
              ));
            }
          } else if (event.event_type === "plan_deleted" && itemId) {
            deleted.add(itemId);
          }
        } catch {
          // Ignore an incomplete line so one interrupted write cannot hide the rest of the ledger.
        }
      }
    }
    return { items, patches, deleted };
  }

  private applyPatch(item: PlanItem, patch?: UpdatePlanItemPatch & { updated_at?: string }): PlanItem {
    const normalizedItem = normalizeLoadedPlanItem(item);
    if (!patch) return normalizedItem;
    const next: PlanItem = {
      ...normalizedItem,
      source: { ...normalizedItem.source },
      execution: { ...normalizedItem.execution, dependencies: [...normalizedItem.execution.dependencies] },
      ...(normalizedItem.completion_receipt
        ? { completion_receipt: { ...normalizedItem.completion_receipt } }
        : {}),
    };
    if (typeof patch.title === "string") next.title = patch.title;
    if (patch.kind === "focus" || patch.kind === "micro_task") next.kind = patch.kind;
    if (isPlanItemStatus(patch.status)) {
      next.status = normalizePlanItemStatus(patch.status);
      if (!patch.execution) {
        next.execution.status = executionStatusForPlan(next.status, next.execution.mode);
      }
    }
    if (typeof patch.plan_date === "string") next.plan_date = patch.plan_date;
    if (patch.schedule === null) delete next.schedule;
    else if (patch.schedule) next.schedule = { ...patch.schedule, preview: false };
    if (patch.source_note === null) delete next.source_note;
    else if (patch.source_note) next.source_note = patch.source_note;
    if (normalizePlanActor(patch.source_actor)) next.source.actor = patch.source_actor as PlanSourceActor;
    if (patch.execution) next.execution = applyExecutionPatch(next.execution, patch.execution, next.title, next.status);
    if (patch.completion_receipt === null) delete next.completion_receipt;
    else if (patch.completion_receipt) next.completion_receipt = normalizeCompletionReceipt(patch.completion_receipt);
    if (patch.updated_at) next.updated_at = patch.updated_at;
    return next;
  }

  private planItemFromState(itemId: string, state: PlanLedgerState): PlanItem | undefined {
    const item = state.items.get(itemId);
    if (!item || state.deleted.has(itemId)) return undefined;
    return this.applyPatch(item, state.patches.get(itemId));
  }

  private requirePlanItemFromState(itemId: string, state: PlanLedgerState): PlanItem {
    const item = this.planItemFromState(itemId, state);
    if (!item) throw new Error(`计划任务不存在或已删除：${itemId}`);
    return item;
  }

  private async requireCurrentPlanItem(itemId: string): Promise<PlanItem> {
    return this.requirePlanItemFromState(itemId, await this.loadLedgerState());
  }

  private assertMatchingExecutionRun(item: PlanItem, runId?: string): void {
    const candidate = String(runId ?? "").trim();
    const expected = String(item.execution.run_id ?? "").trim();
    if (expected && !candidate) {
      throw new Error(`任务 ${item.item_id} 必须提供当前执行批次 run_id`);
    }
    if (expected && candidate !== expected) {
      throw new Error(`执行批次不匹配：${candidate}`);
    }
    if (!expected && candidate) throw new Error(`任务尚未建立执行批次：${candidate}`);
  }

  private assertFreshSnapshot(candidate: PlanItem, current: PlanItem): void {
    if (candidate.updated_at !== current.updated_at) {
      throw new Error(`计划任务已被更新，请刷新后重试：${candidate.item_id}`);
    }
  }

  private eventPathForItem(item: PlanItem): string {
    const recorded = normalizePath(String(item.source.legacy_path ?? "").trim());
    if (item.source.channel === "plan_ledger"
      && recorded.startsWith(`${PLAN_EVENTS_DIR}/`)
      && /^\d{4}-\d{2}\.jsonl$/.test(recorded.slice(PLAN_EVENTS_DIR.length + 1))) {
      return recorded;
    }
    return `${PLAN_EVENTS_DIR}/${item.plan_date.slice(0, 7)}.jsonl`;
  }

  private async ensureEventPath(eventPath: string, fallbackDate: string): Promise<void> {
    if (await this.adapterExists(eventPath)) return;
    const month = eventPath.match(/\/(\d{4}-\d{2})\.jsonl$/)?.[1];
    const date = month && isIsoDate(`${month}-01`) ? `${month}-01` : fallbackDate;
    await this.ensureLedgerFiles(toLocalDateDate(date));
    if (!(await this.adapterExists(eventPath))) {
      throw new Error(`计划事件文件不存在：${eventPath}`);
    }
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Keep the source inspiration's lifecycle in step with the plan ledger.
   * `scheduled` here means "attached to a plan", not "already placed on the
   * time axis". This is the intentional boundary that keeps a source out of
   * the unlinked inspiration pool while it is pending, planned, or completed.
   */
  private async syncSourceNoteLifecycle(
    sourceNotePath: string | undefined,
    status: "candidate" | "scheduled",
  ): Promise<void> {
    const normalized = normalizeSourceNotePath(sourceNotePath);
    if (!normalized) return;
    const abstract = this.app.vault.getAbstractFileByPath(normalized);
    if (!(abstract instanceof TFile)) return;
    try {
      await this.app.fileManager.processFrontMatter(abstract, frontmatter => {
        // Do not resurrect an explicitly archived source merely because a
        // removed plan happened to reference it.
        frontmatter.type = frontmatter.type || "inspiration_card";
        frontmatter.source_note_path = frontmatter.source_note_path || normalized;
        frontmatter.plan_link_status = status === "scheduled" ? "linked" : "unlinked";
        frontmatter.plan_next_action = status === "scheduled" ? "execute" : "review";

        const derivedNotePath = typeof frontmatter.derived_note_path === "string"
          ? frontmatter.derived_note_path.trim()
          : "";
        const refinementStatus = typeof frontmatter.refinement_status === "string"
          ? frontmatter.refinement_status
          : derivedNotePath
            ? "refined"
            : frontmatter.status === "refining"
              ? "refining"
              : "idle";
        frontmatter.refinement_status = refinementStatus;

        // `status` remains as a compatibility projection for old queries, but
        // plan attachment must never erase a completed or running refinement.
        if (frontmatter.status !== "archived") {
          frontmatter.status = refinementStatus === "refined"
            ? "refined"
            : refinementStatus === "refining"
              ? "refining"
              : status;
        }
        if (!frontmatter.next_action || ["review", "execute"].includes(frontmatter.next_action)) {
          frontmatter.next_action = status === "scheduled" ? "execute" : "review";
        }
        frontmatter.updated_at = new Date().toISOString();
      });
    } catch {
      // The plan ledger remains authoritative if a source note was renamed,
      // locked, or temporarily unavailable. The next metadata refresh can
      // reconcile it without reporting a false plan-write failure.
    }
  }

  private async appendEvent(path: string, event: PlanLedgerEvent): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`计划事件文件不存在：${path}`);
    const content = await this.app.vault.read(file);
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const existing = JSON.parse(line) as Partial<PlanLedgerEvent>;
        if (existing.idempotency_key === event.idempotency_key) return;
      } catch {
        // An interrupted tail is ignored; the new complete event can still be appended safely.
      }
    }
    await this.app.vault.append(file, `${JSON.stringify(event)}\n`);
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath);
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (await this.adapterExists(current)) continue;
      await this.app.vault.createFolder(current);
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    const content = `${JSON.stringify(data, null, 2)}\n`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    } else {
      await this.app.vault.create(path, content);
    }
  }

  private async adapterExists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(normalizePath(path));
  }
}

function scheduleMinutes(value: string): number {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return Number.NaN;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return Number.NaN;
  return hour * 60 + minute;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(toLocalDateDate(value).getTime());
}

function toLocalDateDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLocalMonth(date: Date): string {
  return toLocalDate(date).slice(0, 7);
}

function nextIsoTimestamp(previous: string): string {
  const prior = Date.parse(previous);
  const now = Date.now();
  return new Date(Number.isFinite(prior) ? Math.max(now, prior + 1) : now).toISOString();
}

function normalizeSourceNotePath(value: string | undefined): string | undefined {
  const candidate = normalizePath(String(value ?? "").trim());
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) return undefined;
  if (candidate.split("/").includes("..") || !candidate.toLowerCase().endsWith(".md")) return undefined;
  return candidate;
}

function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return value === "planned"
    || value === "proposed"
    || value === "queued"
    || value === "running"
    || value === "review"
    || value === "done"
    || value === "failed";
}

function normalizePlanItemStatus(value: unknown): Exclude<PlanItemStatus, "planned"> {
  if (value === "planned") return "proposed";
  if (value === "proposed" || value === "queued" || value === "running"
    || value === "review" || value === "done" || value === "failed") return value;
  return "proposed";
}

function normalizePlanActor(value: unknown): PlanSourceActor | undefined {
  return value === "user" || value === "hermes" || value === "codex" ? value : undefined;
}

function isExecutionStatus(value: unknown): value is PlanExecutionStatus {
  return value === "idle"
    || value === "queued"
    || value === "running"
    || value === "review"
    || value === "done"
    || value === "failed";
}

function planStatusForExecution(status: PlanExecutionStatus | undefined): Exclude<PlanItemStatus, "planned"> | undefined {
  if (!status) return undefined;
  return status === "idle" ? "proposed" : status;
}

function executionStatusForPlan(status: PlanItemStatus, mode: PlanExecution["mode"]): PlanExecutionStatus {
  const normalized = normalizePlanItemStatus(status);
  if (normalized === "proposed") return "idle";
  if (mode === "manual" && normalized !== "done" && normalized !== "failed") return "idle";
  return normalized;
}

function normalizeExecution(
  input: CreatePlanExecutionInput | Partial<PlanExecution> | undefined,
  title: string,
  actor: PlanSourceActor,
  itemStatus: PlanItemStatus,
): PlanExecution {
  const mode = input?.mode === "agent" ? "agent" : "manual";
  const executor = normalizePlanActor(input?.executor) ?? actor;
  const intent = String(input?.intent ?? "").trim() || (mode === "manual" ? title.trim() : "");
  const priority = typeof input?.priority === "number" ? input.priority : 0;
  const retryCount = typeof input?.retry_count === "number" ? input.retry_count : 0;
  const dependencies = Array.isArray(input?.dependencies)
    ? [...new Set(input.dependencies.map(value => String(value).trim()).filter(Boolean))]
    : [];
  const status = isExecutionStatus(input?.status)
    ? input.status
    : executionStatusForPlan(itemStatus, mode);
  const execution: PlanExecution = {
    mode,
    executor,
    intent,
    priority,
    dependencies,
    retry_count: retryCount,
    status,
  };
  assignNonEmptyString(execution, "input_note", input?.input_note);
  assignNonEmptyString(execution, "output_kind", input?.output_kind);
  assignNonEmptyString(execution, "expected_artifact", input?.expected_artifact);
  assignNonEmptyString(execution, "artifact_path", input?.artifact_path);
  assignNonEmptyString(execution, "not_before", input?.not_before);
  assignNonEmptyString(execution, "deadline", input?.deadline);
  assignNonEmptyString(execution, "run_id", input?.run_id);
  assignNonEmptyString(execution, "refinement_job_id", input?.refinement_job_id);
  assignNonEmptyString(execution, "error", input?.error);
  return execution;
}

function assignNonEmptyString<K extends keyof PlanExecution>(
  target: PlanExecution,
  key: K,
  value: unknown,
): void {
  const normalized = String(value ?? "").trim();
  if (normalized) (target as unknown as Record<string, unknown>)[key] = normalized;
}

function validateExecution(execution: PlanExecution, itemId?: string): void {
  if (!execution.intent.trim()) throw new Error("智能体任务必须提供执行意图 intent");
  if (!Number.isInteger(execution.priority) || execution.priority < 0 || execution.priority > 5) {
    throw new Error("执行优先级必须是 0–5 的整数");
  }
  if (!Number.isInteger(execution.retry_count) || execution.retry_count < 0) {
    throw new Error("重试次数必须是非负整数");
  }
  if (execution.mode === "manual" && !["idle", "done", "failed"].includes(execution.status)) {
    throw new Error(`手动计划不能使用 ${execution.status} 执行状态`);
  }
  if (execution.not_before && Number.isNaN(Date.parse(execution.not_before))) {
    throw new Error("not_before 必须是有效的日期时间");
  }
  if (execution.deadline && Number.isNaN(Date.parse(execution.deadline))) {
    throw new Error("deadline 必须是有效的日期时间");
  }
  if (execution.not_before && execution.deadline
    && Date.parse(execution.deadline) < Date.parse(execution.not_before)) {
    throw new Error("deadline 不能早于 not_before");
  }
  if (itemId && execution.dependencies.includes(itemId)) throw new Error("任务不能依赖自身");
}

function applyExecutionPatch(
  current: PlanExecution,
  patch: PlanExecutionPatch,
  title: string,
  itemStatus: PlanItemStatus,
): PlanExecution {
  const candidate: Record<string, unknown> = {
    ...current,
    dependencies: [...current.dependencies],
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete candidate[key];
    else candidate[key] = value;
  }
  return normalizeExecution(
    candidate as Partial<PlanExecution>,
    title,
    normalizePlanActor(candidate.executor) ?? "user",
    itemStatus,
  );
}

function normalizeCompletionReceipt(receipt: PlanCompletionReceipt): PlanCompletionReceipt {
  const normalized: PlanCompletionReceipt = {};
  const summary = String(receipt.summary ?? "").trim();
  const resultPath = String(receipt.result_path ?? "").trim();
  const completedAt = String(receipt.completed_at ?? "").trim();
  if (summary) normalized.summary = summary;
  if (resultPath) normalized.result_path = resultPath;
  if (completedAt) normalized.completed_at = completedAt;
  return normalized;
}

function hasCompletionReceipt(receipt: PlanCompletionReceipt): boolean {
  return Boolean(receipt.summary || receipt.result_path || receipt.completed_at);
}

function mergePlanPatches(
  previous: (UpdatePlanItemPatch & { updated_at?: string }) | undefined,
  next: UpdatePlanItemPatch & { updated_at?: string },
): UpdatePlanItemPatch & { updated_at?: string } {
  return {
    ...(previous ?? {}),
    ...next,
    ...((previous?.execution || next.execution)
      ? { execution: { ...(previous?.execution ?? {}), ...(next.execution ?? {}) } }
      : {}),
  };
}

function normalizeLoadedPlanItem(item: Partial<PlanItem>): PlanItem {
  const title = String(item.title ?? "").trim();
  const status = normalizePlanItemStatus(item.status);
  const sourceInput = item.source as Partial<PlanItem["source"]> | undefined;
  const actor = normalizePlanActor(sourceInput?.actor) ?? "user";
  const schedule = item.schedule && typeof item.schedule === "object"
    ? {
        date: String(item.schedule.date ?? item.plan_date ?? ""),
        start: String(item.schedule.start ?? ""),
        end: String(item.schedule.end ?? ""),
        timezone: "Asia/Shanghai" as const,
        fixed: Boolean(item.schedule.fixed),
        preview: Boolean(item.schedule.preview),
      }
    : undefined;
  const normalized: PlanItem = {
    item_id: String(item.item_id ?? ""),
    title,
    kind: item.kind === "focus" ? "focus" : "micro_task",
    status,
    plan_date: String(item.plan_date ?? ""),
    domain: String(item.domain ?? (item.kind === "focus" ? "today_focus" : "today_micro")),
    ...(schedule ? { schedule } : {}),
    source: {
      channel: sourceInput?.channel === "legacy_markdown" ? "legacy_markdown" : "plan_ledger",
      actor,
      legacy_path: String(sourceInput?.legacy_path ?? ""),
      legacy_line: Number.isInteger(sourceInput?.legacy_line) ? Number(sourceInput?.legacy_line) : 0,
    },
    execution: normalizeExecution(item.execution, title, actor, status),
    confirmation: {
      required: false,
      status: "not_required",
    },
    created_at: String(item.created_at ?? ""),
    updated_at: String(item.updated_at ?? item.created_at ?? ""),
  };
  const sourceNotePath = normalizeSourceNotePath(item.source_note?.path);
  if (sourceNotePath) normalized.source_note = { path: sourceNotePath, kind: "inspiration" };
  if (item.completion_receipt) {
    const receipt = normalizeCompletionReceipt(item.completion_receipt);
    if (hasCompletionReceipt(receipt)) normalized.completion_receipt = receipt;
  }
  return normalized;
}

function actorId(actor: PlanSourceActor): string {
  return actor === "user" ? "local-user" : actor;
}

function actorSurface(actor: PlanSourceActor): PlanLedgerEvent["source"]["surface"] {
  return actor === "user" ? "workbench" : actor;
}
