const DATE_PREFIX = /^(\d{4})[-_./年](\d{1,2})[-_./月](\d{1,2})(?:日)?\s*(?:[｜|·:_—–-]+\s*)?/;
const COMPACT_DATE_PREFIX = /^(\d{4})(\d{2})(\d{2})\s*(?:[｜|·:_—–-]+\s*)?/;
const ORDER_PREFIX = /^\d{1,3}(?:[._、-]+|\s+)(?=\S)/;
const VERSION_SUFFIX = /\s*(?:[-_｜|·—–]\s*)?\(?v(?:ersion)?\s*\d+(?:\.\d+)*\)?\s*$/i;
const GENERIC_SUFFIX = /\s*(?:[-_｜|·—–]+\s*)?(?:交接(?:日志|说明|记录)?|任务卡|验收(?:回执|日志)|更新日志|开发日志)\s*$/i;
const LOW_INFORMATION_TITLE = /^(?:readme|index|home|说明|目录|未命名|untitled)$/i;
const ACCOUNT_TITLE = /^@[\p{L}\p{N}_.-]+$/u;
const DATE_ONLY_TITLE = /^\d{4}(?:[-_./年]\d{1,2}){1,2}(?:日)?$/;

function fileStem(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()!
    .replace(/\.md$/i, "")
    .trim();
}

function cleanSeparators(value: string): string {
  return value
    .replace(/^[\s｜|·:_—–-]+|[\s｜|·:_—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parentFolderLabel(path: string): string {
  const segments = String(path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.length <= 1) return "笔记";
  const parent = fileStem(segments[segments.length - 2] ?? "")
    .replace(ORDER_PREFIX, "")
    .trim();
  return parent || "笔记";
}

/** Approximate screen width without requiring a DOM/canvas measurement. */
export function graphLabelVisualWidth(value: string): number {
  let width = 0;
  for (const glyph of Array.from(value)) {
    const codePoint = glyph.codePointAt(0) ?? 0;
    if (/\s/u.test(glyph)) {
      width += 0.6;
    } else if (
      codePoint >= 0x1100 && (
        codePoint <= 0x115f
        || codePoint === 0x2329
        || codePoint === 0x232a
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe10 && codePoint <= 0xfe6f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      )
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function truncateGraphLabel(value: string, maxVisualWidth = 18): string {
  const normalized = cleanSeparators(value);
  if (!normalized || graphLabelVisualWidth(normalized) <= maxVisualWidth) return normalized;
  const ellipsis = "…";
  const available = Math.max(1, maxVisualWidth - graphLabelVisualWidth(ellipsis));
  let width = 0;
  let result = "";
  for (const glyph of Array.from(normalized)) {
    const glyphWidth = graphLabelVisualWidth(glyph);
    if (width + glyphWidth > available) break;
    result += glyph;
    width += glyphWidth;
  }
  return `${result.trimEnd()}${ellipsis}`;
}

/**
 * Build a short, recognisable canvas label while preserving the full title in
 * the graph node's `label` field for tooltips, ARIA and the detail panel.
 */
export function compactGraphNodeLabel(fullTitle: string, path = "", maxVisualWidth = 18): string {
  const rawTitle = fileStem(fullTitle) || fileStem(path) || "未命名笔记";
  const parent = parentFolderLabel(path);
  const dateMatch = rawTitle.match(DATE_PREFIX) ?? rawTitle.match(COMPACT_DATE_PREFIX);
  const dateHint = dateMatch ? `${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}` : "";

  let compact = rawTitle
    .replace(DATE_PREFIX, "")
    .replace(COMPACT_DATE_PREFIX, "")
    .replace(ORDER_PREFIX, "")
    .replace(VERSION_SUFFIX, "");
  compact = cleanSeparators(compact.replace(GENERIC_SUFFIX, ""));

  if (!compact || DATE_ONLY_TITLE.test(compact)) compact = `${parent}·${dateHint || "记录"}`;
  else if (LOW_INFORMATION_TITLE.test(compact)) compact = `${parent}·说明`;
  else if (ACCOUNT_TITLE.test(compact)) compact = `${parent}·${compact}`;

  return truncateGraphLabel(compact, maxVisualWidth) || "未命名笔记";
}
