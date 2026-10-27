import { App, TFile } from "obsidian";
import { LogBus } from "./LogBus";

const SUPPRESSED_NOTICE_PREFIXES = [
  "Chat saved as note:",
  "Existing chat note found - updating it now.",
  "No messages to save.",
  "没有消息可保存",
];

/**
 * Small, version-gated companion for Copilot 3.3.3.
 * It never touches chat content itself: Copilot remains responsible for
 * autosave and history parsing while Aetheric only restores the latest id and
 * hides the noisy success toast emitted by automatic saves.
 */
export class CopilotSessionBridge {
  private noticeObserver: MutationObserver | null = null;
  private observedNoticeContainer: HTMLElement | null = null;
  private restoreAttempted = false;

  constructor(private app: App, private logBus: LogBus) {}

  start(): void {
    if (this.noticeObserver || typeof MutationObserver === "undefined") return;
    this.noticeObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement) {
            const container = node.matches(".notice-container")
              ? node
              : node.querySelector<HTMLElement>(".notice-container");
            if (container) this.observeNoticeContainer(container);
          }
          this.dismissAutosaveNotice(node);
        }
      }
    });
    this.noticeObserver.observe(document.body, { childList: true });
    this.observeNoticeContainer(document.body.querySelector<HTMLElement>(".notice-container"));
  }

  stop(): void {
    this.noticeObserver?.disconnect();
    this.noticeObserver = null;
    this.observedNoticeContainer = null;
  }

  private observeNoticeContainer(container: HTMLElement | null): void {
    if (!this.noticeObserver || container === this.observedNoticeContainer) return;
    this.observedNoticeContainer = container;
    // Body observation is intentionally shallow: it only discovers a replaced
    // notice container. Workbench DOM churn must not invoke Copilot filtering.
    this.noticeObserver.disconnect();
    this.noticeObserver.observe(document.body, { childList: true });
    if (container) this.noticeObserver.observe(container, { childList: true, subtree: true });
  }

  async restoreLatestOnce(): Promise<boolean> {
    if (this.restoreAttempted) return false;
    this.restoreAttempted = true;

    const copilot = (this.app as any).plugins?.plugins?.copilot as any;
    if (!copilot || copilot.manifest?.version !== "3.3.3") {
      this.logBus.append("info", "copilot.session", "跳过会话恢复：Copilot 不可用或版本不是 3.3.3");
      return false;
    }
    if (typeof copilot.getChatHistoryItems !== "function" || typeof copilot.loadChatById !== "function") {
      this.logBus.append("info", "copilot.session", "跳过会话恢复：历史接口不可用");
      return false;
    }

    try {
      const items = await copilot.getChatHistoryItems() as Array<{
        id?: string;
        lastAccessedAt?: string | number | Date;
        createdAt?: string | number | Date;
      }>;
      const latest = [...items]
        .filter(item => typeof item.id === "string" && item.id.length > 0)
        .sort((left, right) => this.historyTimestamp(right) - this.historyTimestamp(left))[0];
      if (!latest?.id) return false;
      await copilot.loadChatById(latest.id);
      this.logBus.append("success", "copilot.session", `已恢复最近 Copilot 对话：${latest.id}`);
      return true;
    } catch (error) {
      console.warn("Failed to restore latest Copilot conversation", error);
      this.logBus.append("error", "copilot.session", "恢复最近 Copilot 对话失败；保留当前空会话");
      return false;
    }
  }

  /**
   * Send a guided refinement request through Copilot's own chat state.
   *
   * Copilot 3.3.3 exposes chatUIState.sendMessage as the same path used by
   * its visible composer. We feature-detect the method and keep the call
   * version-gated so a Copilot update cannot silently receive a malformed
   * request. The source note is supplied as native context; the note itself
   * is never modified by this bridge.
   */
  async sendPrompt(prompt: string, sourcePath?: string): Promise<boolean> {
    const copilot = (this.app as any).plugins?.plugins?.copilot as any;
    if (!copilot || copilot.manifest?.version !== "3.3.3") {
      this.logBus.append("info", "copilot.prompt", "跳过自动投喂：Copilot 不可用或版本不是 3.3.3");
      return false;
    }
    const chatUIState = copilot.chatUIState as {
      sendMessage?: (
        message: string,
        context?: { notes?: TFile[]; urls?: string[]; tags?: string[]; folders?: string[] },
        chainType?: string,
        includeActiveNote?: boolean,
        includeActiveWebTab?: boolean,
      ) => Promise<unknown>;
    } | undefined;
    if (!chatUIState || typeof chatUIState.sendMessage !== "function") {
      this.logBus.append("info", "copilot.prompt", "跳过自动投喂：Copilot chatUIState.sendMessage 不可用");
      return false;
    }

    const abstract = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : null;
    const context = abstract instanceof TFile ? { notes: [abstract] } : {};
    try {
      // Copilot's internal sendMessage may wait on an upstream model forever
      // when a provider is offline. Keep the workspace action recoverable: the
      // visible chat can continue working, but the AOS button must receive a
      // bounded failure instead of leaving a pending promise indefinitely.
      const sendPromise = chatUIState.sendMessage(prompt, context, copilot.settings?.defaultChainType ?? "llm_chain", false, false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Copilot 响应超时（45 秒）")), 45000);
      });
      await Promise.race([sendPromise, timeoutPromise]);
      this.logBus.append("success", "copilot.prompt", sourcePath ? `已向 Copilot 投喂：${sourcePath}` : "已向 Copilot 投喂整理请求");
      return true;
    } catch (error) {
      console.warn("Failed to send prompt to Copilot", error);
      this.logBus.append("error", "copilot.prompt", `Copilot 自动投喂失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private dismissAutosaveNotice(node: Node): void {
    if (!(node instanceof HTMLElement)) return;
    const notices = Array.from(new Set([
      node.closest<HTMLElement>(".notice"),
      ...(node.matches(".notice") ? [node] : []),
      ...Array.from(node.querySelectorAll<HTMLElement>(".notice")),
    ].filter((notice): notice is HTMLElement => notice instanceof HTMLElement)));
    for (const notice of notices) {
      const text = notice.textContent?.trim() ?? "";
      if (SUPPRESSED_NOTICE_PREFIXES.some(prefix => text.startsWith(prefix))) notice.remove();
    }
  }

  private historyTimestamp(item: { lastAccessedAt?: string | number | Date; createdAt?: string | number | Date }): number {
    const value = item.lastAccessedAt ?? item.createdAt ?? 0;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
