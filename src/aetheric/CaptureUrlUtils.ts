/**
 * URL parsing shared by the collection dashboard and the operations tab.
 *
 * The daemon owns the final validation, but the UI should use the same
 * forgiving paste behaviour: WeChat share text, Markdown and Chinese
 * punctuation are all common inputs.  Keeping this small parser in one place
 * prevents the two workbench entry points from creating different jobs.
 */

const CAPTURE_URL_RE = /https:\/\/[^\s<>"'`]+/gi;
const URL_TRAILING_CHARS = ".,;:!?，。；：！？、)]}〉》」』】）］｝`\"'";

export function extractCaptureUrls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const urls: string[] = [];
  for (const raw of values) {
    const text = String(raw ?? "").trim().replace(/^`+|`+$/g, "");
    if (!text) continue;
    const matches = text.match(CAPTURE_URL_RE) ?? (
      /^https?:\/\//i.test(text) ? [text] : []
    );
    for (const match of matches) {
      const candidate = match
        .trim()
        .replace(/^<+|>+$/g, "")
        .replace(new RegExp(`[${escapeRegExp(URL_TRAILING_CHARS)}]+$`), "");
      if (candidate.toLowerCase().startsWith("https://")) urls.push(candidate);
    }
  }
  return urls;
}

/** Remove harmless presentation differences without discarding auth/query data. */
export function normalizeCaptureUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (capturePlatformId(trimmed) === "x") {
      const status = parsed.pathname.match(/\/(?:i\/web\/)?status\/(\d+)/i);
      if (status) return `https://x.com/i/web/status/${status[1]}`;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/#.*$/, "").replace(/\/$/, "");
  }
}

export function dedupeCaptureUrls(value: unknown): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of extractCaptureUrls(value)) {
    if (!isSpecificHttpsPage(url)) continue;
    const key = normalizeCaptureUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

function isSpecificHttpsPage(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && Boolean(parsed.pathname) && parsed.pathname !== "/";
  } catch {
    return false;
  }
}

export type CapturePlatformId = "bilibili" | "douyin" | "xiaohongshu" | "x" | "youtube" | "dianping" | "github" | "generic";

function hostnameIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Resolve known capture sources from the URL hostname only. */
export function capturePlatformId(value: string): CapturePlatformId {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (hostnameIs(host, "bilibili.com") || hostnameIs(host, "b23.tv")) return "bilibili";
  if (hostnameIs(host, "douyin.com") || hostnameIs(host, "iesdouyin.com")) return "douyin";
  if (hostnameIs(host, "xiaohongshu.com") || hostnameIs(host, "xhslink.com") || hostnameIs(host, "xhslink.cn")) return "xiaohongshu";
  if (hostnameIs(host, "x.com") || hostnameIs(host, "twitter.com")) return "x";
  if (hostnameIs(host, "youtube.com") || hostnameIs(host, "youtu.be")) return "youtube";
  if (hostnameIs(host, "dianping.com") || hostnameIs(host, "dpurl.cn")) return "dianping";
  if (hostnameIs(host, "github.com")) return "github";
  return "generic";
}

export function capturePlatformLabel(value: string): string {
  const labels: Record<CapturePlatformId, string> = {
    bilibili: "B站",
    douyin: "抖音",
    xiaohongshu: "小红书",
    x: "X",
    youtube: "YouTube",
    dianping: "大众点评",
    github: "GitHub",
    generic: "网页",
  };
  return labels[capturePlatformId(value)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
