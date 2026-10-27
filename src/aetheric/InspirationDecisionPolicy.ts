export type InspirationValueLevel = "high" | "medium" | "low" | "unrated";

export interface InspirationDecisionViewModel {
  score: number | null;
  scoreLabel: string;
  level: InspirationValueLevel;
  reasonLabel: "入选原因" | "可迁移方向";
  reason: string;
  freshness: string;
  nextAction: string;
}

const NEXT_ACTION_LABELS: Record<string, string> = {
  review: "交给 AI 评估",
  deepen: "深化这条素材",
  schedule: "排入执行队列",
  scheduled: "等待执行",
  execute: "执行下一步",
  link: "关联正式笔记",
  archive: "归档留存",
};

function compactText(value: unknown, maxLength = 72): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstText(frontmatter: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = compactText(frontmatter[key]);
    if (text) return text;
  }
  return "";
}

function normalizeScore(frontmatter: Record<string, unknown>): number | null {
  const raw = frontmatter.value_score ?? frontmatter.priority;
  const score = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(score) || score < 0 || score > 5) return null;
  return Math.round(score * 10) / 10;
}

function valueLevel(score: number | null): { level: InspirationValueLevel; label: string } {
  if (score === null) return { level: "unrated", label: "待评估" };
  if (score >= 4) return { level: "high", label: "高价值" };
  if (score >= 3) return { level: "medium", label: "中价值" };
  return { level: "low", label: "低价值" };
}

function nextActionText(frontmatter: Record<string, unknown>): string {
  const explicit = compactText(frontmatter.next_action_title, 56);
  if (explicit) return explicit;

  const raw = frontmatter.next_action;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const nested = compactText((raw as Record<string, unknown>).title, 56);
    if (nested) return nested;
  }

  const text = compactText(raw, 56);
  if (!text) return "待 AI 评估";
  return NEXT_ACTION_LABELS[text.toLowerCase()] ?? text;
}

export function buildInspirationDecision(
  frontmatter: Record<string, unknown>,
  passiveRadarSignal: boolean,
  freshness: string,
): InspirationDecisionViewModel {
  const score = normalizeScore(frontmatter);
  const value = valueLevel(score);
  const reason = firstText(frontmatter, ["value_reason", "selection_reason", "recommendation_reason"]);
  return {
    score,
    scoreLabel: score === null ? value.label : `${value.label} · ${score}/5`,
    level: value.level,
    reasonLabel: passiveRadarSignal ? "入选原因" : "可迁移方向",
    reason: reason || "待 AI 评估",
    freshness: compactText(freshness, 12) || "待评估",
    nextAction: nextActionText(frontmatter),
  };
}
