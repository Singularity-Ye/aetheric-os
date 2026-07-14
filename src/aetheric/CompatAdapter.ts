import { App, Notice, TFile } from "obsidian";

export class CompatAdapter {
  static getObsidianVersion(app: App): string {
    return (app as any).apiVersion || "unknown";
  }

  static reloadObsidianWindow(app: App): void {
    const commands = (app as any).commands;
    if (commands && typeof commands.executeCommandById === "function") {
      try {
        commands.executeCommandById("app:reload");
        return;
      } catch (e) {
        console.error("[CompatAdapter] Failed to execute app:reload", e);
      }
    }
    new Notice("无法自动重载窗口，请使用 Ctrl+R 手动重载。");
  }

  static isClaudianAvailable(app: App): boolean {
    const plugins = (app as any).plugins?.plugins;
    return !!(plugins && plugins["realclaudian"]);
  }

  static isClaudianViewInitialized(leaf: any): boolean {
    if (!leaf || !leaf.view) return false;
    if (leaf.view.getViewType() !== "claudian-view") return false;
    return !!(leaf.view as any).tabManager;
  }

  static getClaudianContentEl(leaf: any): HTMLElement | null {
    return leaf?.view?.contentEl || null;
  }

  static syncClaudianContext(app: App, notePath: string): void {
    const claudianPlugin = (app as any).plugins?.plugins?.["realclaudian"];
    if (!claudianPlugin) return;

    // Privacy boundary for 08_密室
    if (notePath.startsWith("08_密室/")) {
      const allowed = [
        "08_密室/todo.md",
        "08_密室/林下工作台.md",
        "08_密室/待办池.md",
        "08_密室/灵感池.md"
      ];
      const isAllowed = allowed.includes(notePath) || notePath.startsWith("08_密室/生活计划/");
      if (!isAllowed) {
        console.warn(`[CompatAdapter] Blocked Claudian context sync for sensitive note: ${notePath}`);
        return;
      }
    }

    try {
      const leaves = app.workspace.getLeavesOfType("claudian-view");
      for (const leaf of leaves) {
        const view = leaf.view as any;
        if (view) {
          const activeTab = typeof view.getTabManager === "function"
            ? view.getTabManager()?.getActiveTab()
            : (view.tabManager?.activeTab || null);
          const fileContextManager = activeTab?.ui?.fileContextManager;
          if (fileContextManager && typeof fileContextManager.setCurrentNote === "function") {
            fileContextManager.setCurrentNote(notePath);
            console.log(`[CompatAdapter] Synchronized Claudian context to: ${notePath}`);
          }
        }
      }
    } catch (e) {
      console.warn("[CompatAdapter] Failed to synchronize Claudian context", e);
    }
  }

  static safeSetGraphFile(graphView: any, file: any): void {
    if (graphView && typeof graphView.setFile === "function") {
      try {
        graphView.setFile(file);
      } catch (e) {
        console.error("[CompatAdapter] Failed to setFile on GraphView", e);
      }
    }
  }

  static async safeSetGraphState(graphView: any, state: any): Promise<void> {
    if (graphView && typeof graphView.setState === "function") {
      try {
        await graphView.setState(state, { history: false });
      } catch (e) {
        console.error("[CompatAdapter] Failed to setState on GraphView", e);
      }
    }
  }

  static safeGetGraphState(graphView: any): any {
    if (graphView && typeof graphView.getState === "function") {
      try {
        return graphView.getState();
      } catch (e) {
        console.error("[CompatAdapter] Failed to getState on GraphView", e);
      }
    }
    return null;
  }

  static safeApplyGraphSearch(graphView: any, searchQuery: string, showTags: boolean): void {
    const engine = graphView?.dataEngine;
    if (
      !engine
      || typeof engine.setOptions !== "function"
      || !engine.requestUpdateSearch
      || typeof engine.requestUpdateSearch.run !== "function"
    ) {
      throw new Error("Embedded graph search engine is unavailable");
    }

    try {
      engine.setOptions({
        search: searchQuery,
        showTags: showTags,
      });
      engine.requestUpdateSearch.run();
    } catch (e) {
      throw new Error(`Failed to apply search options: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
