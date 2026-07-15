export interface ParsedProgress {
  current: number;
  total: number;
  percentage: number;
  stage?: string;
}

export class ProgressParser {
  private static legacyRegexes = [
    /(?:进度:|修复中|同步|[\s\(\[])(\d+)\/(\d+)(?:[\s\)\]]|$)/,
    /(\d+)\s*\/\s*(\d+)/
  ];

  /**
   * Parses a single output line from a child process to check for progress events.
   * Supports both structural JSONL and legacy regex text matching.
   */
  static parseLine(line: string): ParsedProgress | null {
    const trimmed = line.trim();
    if (!trimmed) {
      return null;
    }

    // 1. Attempt to parse as structural JSONL first
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const obj = JSON.parse(trimmed);
        if (
          obj &&
          typeof obj === "object" &&
          (obj.event === "progress" || (typeof obj.current === "number" && typeof obj.total === "number"))
        ) {
          const current = Number(obj.current);
          const total = Number(obj.total);
          if (!isNaN(current) && !isNaN(total) && total > 0) {
            return {
              current,
              total,
              percentage: Math.min(100, Math.max(0, Math.round((current / total) * 100))),
              stage: typeof obj.stage === "string" ? obj.stage : undefined,
            };
          }
        }
      } catch (e) {
        // Fall through to regex if JSON parse fails
      }
    }

    // 2. Legacy regex fallback
    for (const regex of this.legacyRegexes) {
      const match = trimmed.match(regex);
      if (match) {
        const current = parseInt(match[1], 10);
        const total = parseInt(match[2], 10);
        if (!isNaN(current) && !isNaN(total) && total > 0 && current <= total) {
          return {
            current,
            total,
            percentage: Math.round((current / total) * 100),
          };
        }
      }
    }

    return null;
  }
}
