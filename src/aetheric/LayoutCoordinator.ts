import { App } from "obsidian";
import { NativeUiService } from "./NativeUiService";

type LayoutTarget = "shell" | "document" | "native";

export function shouldMaskLayoutTransition(from: LayoutTarget, to: LayoutTarget): boolean {
  return (from === "shell") !== (to === "shell");
}

/**
 * Owns all transitions between the Aetheric shell and native Obsidian views.
 * Keeping this in one place prevents active-leaf-change and openNode() from
 * racing to collapse/expand the same split panes.
 */
export class LayoutCoordinator {
  private readonly minimumMaskHoldMs = 90;
  private transaction = 0;
  private target: LayoutTarget = "native";
  private mask: HTMLDivElement | null = null;
  private maskShownAt = 0;
  private maskWatchdog: number | null = null;
  private documentOpenTransaction: number | null = null;

  constructor(private app: App, private nativeUi: NativeUiService) {}

  handleActiveView(viewType: string, hideNativeUi: boolean): void {
    if (viewType === "aetheric-os-shell-view") {
      this.documentOpenTransaction = null;
      this.activateTarget("shell");
      this.nativeUi.apply(hideNativeUi);
      return;
    }

    if (viewType === "markdown" || viewType === "empty") {
      // openNode() owns the mask until openFile() resolves. The leaf event only
      // makes sure the native chrome is visible and the warm sidebar is open.
      if (this.documentOpenTransaction === null) {
        this.activateTarget("document");
      }
      this.nativeUi.apply(false);
      this.ensureDocumentSidebar();
      return;
    }

    this.documentOpenTransaction = null;
    this.activateTarget("native");
    this.nativeUi.apply(false);
  }

  beginDocumentOpen(): number | null {
    const shouldMask = shouldMaskLayoutTransition(this.target, "document");
    const token = ++this.transaction;
    this.target = "document";
    this.documentOpenTransaction = token;
    if (shouldMask) this.ensureMask();
    this.nativeUi.apply(false);
    this.ensureDocumentSidebar();
    return shouldMask ? token : null;
  }

  completeDocumentOpen(token: number | null): void {
    this.documentOpenTransaction = null;
    if (token !== null) this.finishAfterPaint(token);
  }

  restore(): void {
    this.transaction += 1;
    this.documentOpenTransaction = null;
    this.target = "native";
    this.removeMask();
    this.nativeUi.restore();
  }

  private activateTarget(target: LayoutTarget): void {
    if (!shouldMaskLayoutTransition(this.target, target)) {
      this.transaction += 1;
      this.target = target;
      this.removeMask();
      return;
    }
    const token = ++this.transaction;
    this.target = target;
    this.ensureMask();
    this.finishAfterPaint(token);
  }

  private ensureDocumentSidebar(): void {
    // The shell no longer collapses this split, so Claudian and its scroll/input
    // state remain mounted. Obsidian's expand() performs workspace layout work,
    // so only call it when an older persisted layout is actually collapsed.
    if (this.app.workspace.rightSplit.collapsed) {
      this.app.workspace.rightSplit.expand();
    }
  }

  private ensureMask(): void {
    if (this.mask?.isConnected) {
      this.armMaskWatchdog();
      return;
    }
    const existing = this.app.workspace.containerEl.querySelector<HTMLDivElement>(".aos-page-transition-mask");
    if (existing) {
      this.mask = existing;
      this.maskShownAt = performance.now();
      this.armMaskWatchdog();
      return;
    }
    this.mask = this.app.workspace.containerEl.createDiv({ cls: "aos-page-transition-mask" });
    this.maskShownAt = performance.now();
    this.mask.createDiv({ cls: "aos-spinner" });
    this.armMaskWatchdog();
  }

  private armMaskWatchdog(): void {
    if (this.maskWatchdog !== null) window.clearTimeout(this.maskWatchdog);
    const transaction = this.transaction;
    this.maskWatchdog = window.setTimeout(() => {
      this.maskWatchdog = null;
      if (this.mask?.isConnected && transaction === this.transaction) {
        console.warn("Aetheric layout transition exceeded watchdog; removing stale mask");
        this.removeMask();
      }
    }, 8000);
  }

  private finishAfterPaint(token: number): void {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const remaining = Math.max(0, this.minimumMaskHoldMs - (performance.now() - this.maskShownAt));
        window.setTimeout(() => this.finish(token), remaining);
      });
    });
  }

  private finish(token: number): void {
    if (token !== this.transaction || !this.mask) return;
    const mask = this.mask;
    mask.addClass("is-leaving");
    const cleanup = () => {
      if (token !== this.transaction || this.mask !== mask) return;
      this.removeMask();
    };
    mask.addEventListener("transitionend", cleanup, { once: true });
    window.setTimeout(cleanup, 240);
  }

  private removeMask(): void {
    if (this.maskWatchdog !== null) {
      window.clearTimeout(this.maskWatchdog);
      this.maskWatchdog = null;
    }
    this.mask?.remove();
    this.mask = null;
    this.maskShownAt = 0;
  }
}
