import { App } from "obsidian";
import { NativeUiService } from "./NativeUiService";

type LayoutTarget = "shell" | "document" | "native";

/**
 * Owns all transitions between the Aetheric shell and native Obsidian views.
 * Keeping this in one place prevents active-leaf-change and openNode() from
 * racing to collapse/expand the same split panes.
 */
export class LayoutCoordinator {
  private transaction = 0;
  private target: LayoutTarget = "native";
  private mask: HTMLDivElement | null = null;
  private documentOpenTransaction: number | null = null;

  constructor(private app: App, private nativeUi: NativeUiService) {}

  handleActiveView(viewType: string, hideNativeUi: boolean): void {
    if (viewType === "aetheric-os-shell-view") {
      this.documentOpenTransaction = null;
      const token = this.begin("shell");
      this.nativeUi.apply(hideNativeUi);
      this.finishAfterPaint(token);
      return;
    }

    if (viewType === "markdown") {
      // openNode() owns the mask until openFile() resolves. The leaf event only
      // makes sure the native chrome is visible and the warm sidebar is open.
      this.nativeUi.apply(false);
      this.ensureDocumentSidebar();
      if (this.documentOpenTransaction === null) {
        const token = this.begin("document");
        this.finishAfterPaint(token);
      }
      return;
    }

    this.documentOpenTransaction = null;
    const token = this.begin("native");
    this.nativeUi.apply(false);
    this.finishAfterPaint(token);
  }

  beginDocumentOpen(): number {
    const token = this.begin("document");
    this.documentOpenTransaction = token;
    this.nativeUi.apply(false);
    this.ensureDocumentSidebar();
    return token;
  }

  completeDocumentOpen(token: number): void {
    if (this.documentOpenTransaction === token) this.documentOpenTransaction = null;
    this.finishAfterPaint(token);
  }

  restore(): void {
    this.transaction += 1;
    this.documentOpenTransaction = null;
    this.target = "native";
    this.removeMask();
    this.nativeUi.restore();
  }

  private begin(target: LayoutTarget): number {
    const token = ++this.transaction;
    this.target = target;
    this.ensureMask();
    return token;
  }

  private ensureDocumentSidebar(): void {
    // The shell no longer collapses this split, so Claudian and its scroll/input
    // state remain mounted. expand() only restores older persisted/collapsed layouts.
    this.app.workspace.rightSplit.expand();
  }

  private ensureMask(): void {
    if (this.mask?.isConnected) return;
    const existing = this.app.workspace.containerEl.querySelector<HTMLDivElement>(".aos-page-transition-mask");
    if (existing) {
      this.mask = existing;
      return;
    }
    this.mask = this.app.workspace.containerEl.createDiv({ cls: "aos-page-transition-mask" });
    this.mask.createDiv({ cls: "aos-spinner" });
  }

  private finishAfterPaint(token: number): void {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => this.finish(token));
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
    this.mask?.remove();
    this.mask = null;
  }
}
