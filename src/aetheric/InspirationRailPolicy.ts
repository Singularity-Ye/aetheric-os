type InspirationFrontmatter = Record<string, unknown>;

export type InspirationAreaId = "knowledge" | "life" | "project" | "radar" | "inbox";

/** A capture id identifies the user's thought, even when several drafts exist. */
export function captureIdeaIdentity(frontmatter: InspirationFrontmatter): string {
  const id = String(frontmatter.idea_id ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? `idea:${id}` : "";
}

export function isInspirationEvidence(frontmatter: InspirationFrontmatter): boolean {
  return frontmatter.rail_excluded === true
    || String(frontmatter.rail_excluded).toLowerCase() === "true"
    || frontmatter.record_role === "evidence";
}

function normalizedText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim().toLowerCase()
    : "";
}

/**
 * The only durable opt-in switches for passive watcher captures.
 * Manual promotion writes both fields, so tags and folder guesses must not
 * silently promote every item produced by a scheduled feed.
 */
export function hasExplicitInspirationOptIn(frontmatter: InspirationFrontmatter): boolean {
  const type = normalizedText(frontmatter.type);
  const rail = normalizedText(frontmatter.rail);
  return frontmatter.promote_to_inspiration === true
    || normalizedText(frontmatter.promote_to_inspiration) === "true"
    || type === "inspiration_card"
    || rail === "inspiration"
    || rail === "灵感";
}

/** Scheduled feeds are evidence/intelligence sources, not inspiration intent. */
export function isScheduledWatcherCapture(frontmatter: InspirationFrontmatter): boolean {
  const source = normalizedText(frontmatter.source);
  if (["aos-cloud-x-watch", "x_watch", "x-watch", "cloud_x_watch", "cloud-x-watch"].includes(source)) return true;
  if (/^aos-(?:cloud-)?[a-z0-9_-]+-watch(?:er)?$/.test(source)) return true;

  const channel = normalizedText(frontmatter.inbox_channel || frontmatter.capture_channel);
  if (/^(?:x_watch|scheduled_watch|watcher|daemon)$/u.test(channel)) return true;

  const mode = normalizedText(frontmatter.capture_mode || frontmatter.collection_mode || frontmatter.trigger);
  if (/^(?:passive|scheduled|watch|watcher|daemon|定时|后台)$/u.test(mode)) return true;
  if (/^(?:active|manual|user|主动|用户)$/u.test(mode)) return false;

  // Explicit request ids identify user-driven capture even when old notes do
  // not yet carry the newer local_capture/weixin_hermes channel.
  if (normalizedText(frontmatter.capture_request_id) || normalizedText(frontmatter.capture_id)) return false;

  const origin = [frontmatter.origin, frontmatter.collector].map(normalizedText);
  if (origin.some(value => /(?:^|[-_])(watch|watcher|scheduled|daemon)(?:$|[-_])/u.test(value))) return true;

  const primaryTopic = normalizedText(frontmatter.primary_topic);
  const topics = Array.isArray(frontmatter.topics)
    ? frontmatter.topics.map(normalizedText)
    : normalizedText(frontmatter.topics).split(/[\s,;|]+/u).filter(Boolean);
  if (primaryTopic === "watched_account" || topics.includes("x_watch") || topics.includes("x-watch")) return true;

  const scheduled = frontmatter.scheduled === true || normalizedText(frontmatter.scheduled) === "true";
  return scheduled && ["x", "twitter", "推特"].includes(normalizedText(frontmatter.source_platform));
}

/** Passive watcher output stays in the intelligence inbox until promoted. */
export function shouldAutoProjectCaptureToInspiration(frontmatter: InspirationFrontmatter): boolean {
  return !isScheduledWatcherCapture(frontmatter);
}

/**
 * Automatic watcher promotion is deliberately narrow. A failed analysis can
 * never pass merely because an earlier collector marked the signal as high.
 */
export function passesScheduledWatcherValueGate(frontmatter: InspirationFrontmatter): boolean {
  const analysisStatus = normalizedText(
    frontmatter.analysis_status || frontmatter.analysisStatus || frontmatter.agent_status,
  );
  if (/^(?:failed|error|blocked|insufficient_evidence|rejected|archived)$/u.test(analysisStatus)) return false;

  const score = Number(frontmatter.value_score ?? frontmatter.valueScore);
  if (Number.isFinite(score) && score >= 4) return true;

  const signal = normalizedText(frontmatter.signal || frontmatter.priority_signal || frontmatter.value_signal);
  return /^(?:high|critical|精选|高价值)$/u.test(signal);
}

/**
 * A watcher can enter the inspiration rail only through an explicit promotion.
 * Value/attention scoring belongs to the intelligence module: a valuable post
 * is still not automatically the user's inspiration intent.
 */
export function shouldScheduledWatcherEnterRail(frontmatter: InspirationFrontmatter): boolean {
  return isScheduledWatcherCapture(frontmatter)
    && hasExplicitInspirationOptIn(frontmatter);
}

function canonicalArea(value: unknown): InspirationAreaId | null {
  const text = normalizedText(value);
  if (!text) return null;
  if (/^(?:knowledge|knowledge-base|知识|知识库|藏经阁)$/u.test(text)) return "knowledge";
  if (/^(?:life|生活|生活库|生活簿)$/u.test(text)) return "life";
  if (/^(?:project|项目|项目区)$/u.test(text)) return "project";
  if (/^(?:radar|intelligence|情报|信息雷达|信息雷达轨)$/u.test(text)) return "radar";
  if (/^(?:inbox|待分区|收件箱)$/u.test(text)) return "inbox";
  return null;
}

function semanticArea(text: string): InspirationAreaId | null {
  if (/生活簿|生活库|食味录|行路志|游艺录|映卷录|案上书/iu.test(text)) return "life";
  if (/藏经阁|知识库|技艺录|思辨录|博物志|刀笔集|格物院/iu.test(text)) return "knowledge";
  if (/项目区|project/iu.test(text)) return "project";
  return null;
}

/**
 * A platform says where evidence came from, not what the evidence means.
 * Explicit rail-area override wins; then stable routing/path semantics; then
 * actionable knowledge wording; only afterwards do legacy area/radar hints run.
 */
export function inferInspirationAreaId(
  frontmatter: InspirationFrontmatter,
  path: string,
  fallbackTitle = "",
): InspirationAreaId {
  const override = canonicalArea(
    frontmatter.rail_area || frontmatter.area_override || frontmatter.inspiration_area,
  );
  if (override) return override;

  const watcher = isScheduledWatcherCapture(frontmatter);
  const explicitWatcherPromotion = hasExplicitInspirationOptIn(frontmatter);
  // A watcher remains intelligence even if its title happens to contain
  // tutorial-like words. Explicit promotion may be routed by note semantics.
  if (watcher && !explicitWatcherPromotion && passesScheduledWatcherValueGate(frontmatter)) return "radar";

  const strongContext = [
    frontmatter.section,
    frontmatter.category,
    frontmatter["分流建议"],
    frontmatter.source_note_path,
    path,
  ].map(normalizedText).join(" ");
  const routed = semanticArea(strongContext);
  if (routed) return routed;

  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter(value => typeof value === "string").join(" ")
    : "";
  const titleContext = [frontmatter.title, fallbackTitle, frontmatter.content_kind, tags]
    .map(normalizedText)
    .join(" ");
  if (/博德之门|星露谷|环世界|泰拉瑞亚|旅游|旅行|探店|美食|显示器.*(?:推荐|评测|选购)|(?:推荐|评测|选购).*显示器/iu.test(titleContext)) {
    return "life";
  }
  if (/教程|方法(?:论)?|指南|攻略|实操|工作流|拆解|复盘|技巧|手册|原理|案例分析|\bskill\b|how[- ]?to/iu.test(titleContext)) {
    return "knowledge";
  }

  const explicitArea = canonicalArea(frontmatter.area || frontmatter.section || frontmatter["分流方向"]);
  if (explicitArea) return explicitArea;

  if (watcher) return "radar";
  const weakContext = [frontmatter["分流方向"], tags, path].map(normalizedText).join(" ");
  if (/情报|雷达|watch|radar|x情报/iu.test(weakContext)) return "radar";
  return "inbox";
}
