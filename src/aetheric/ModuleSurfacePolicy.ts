import type { AethericModule } from "./types";

/**
 * The shell owns the persistent rails, but feature pages do not automatically
 * inherit every panel.  Keeping this contract outside the view makes the
 * layout boundary explicit before the individual renderers are split out.
 */
export type ContextPaneMode = "node" | "hidden";

export interface ModuleSurfacePolicy {
  /** The node context pane is a navigation surface, not a global dashboard. */
  contextPane: ContextPaneMode;
}

export const MODULE_SURFACE_POLICY: Readonly<Record<AethericModule, ModuleSurfacePolicy>> = {
  overview: { contextPane: "hidden" },
  navigation: { contextPane: "node" },
  schedule: { contextPane: "hidden" },
  collection: { contextPane: "hidden" },
  tasks: { contextPane: "hidden" },
  intelligence: { contextPane: "hidden" },
  inspiration: { contextPane: "hidden" },
  knowledge: { contextPane: "hidden" },
  logs: { contextPane: "hidden" },
};

export function moduleUsesContextPane(module: AethericModule): boolean {
  return MODULE_SURFACE_POLICY[module]?.contextPane === "node";
}
