import * as fs from "fs";
import * as path from "path";
import ScriptoriumPlugin from "../../main";

export class WorkerControlAdapter {
  private lastRequestTime = 0;
  private readonly debounceMs = 1200;

  constructor(private plugin: ScriptoriumPlugin) {}

  /**
   * Retrieves the Worker Authorization Token.
   * Checks Scriptorium settings first, then falls back to parsing hamaxiang-system/.env.
   */
  async getWorkerToken(): Promise<string | null> {
    // 1. Check plugin settings (separate Worker Token)
    if (this.plugin.settings.hamasxiangWorkerToken) {
      return this.plugin.settings.hamasxiangWorkerToken.trim();
    }

    // 2. Fallback to .env in hamaxiang-system path
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    if (!systemPath) {
      return null;
    }

    const envPath = path.join(systemPath, ".env");
    try {
      if (fs.existsSync(envPath)) {
        const content = await fs.promises.readFile(envPath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("#")) continue;
          const idx = trimmed.indexOf("=");
          if (idx > 0) {
            const key = trimmed.substring(0, idx).trim();
            const val = trimmed.substring(idx + 1).trim();
            if (key === "AUTOCLI_WORKER_TOKEN") {
              return val;
            }
          }
        }
      }
    } catch (e) {
      // safe ignore log
    }

    return null;
  }

  /**
   * Helper to fetch toggle status from the Cloudflare Worker.
   * Returns true if deduplication is ENABLED (i.e. disabled is false).
   */
  async fetchStatus(): Promise<boolean> {
    this.checkRateLimit();

    const workerUrl = await this.getToggleUrl();
    const token = await this.getWorkerToken();

    if (!token) {
      throw new Error("未能在设置或 .env 中找到 AUTOCLI_WORKER_TOKEN 凭证。");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(workerUrl, {
        method: "GET",
        headers: {
          "Authorization": token,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Worker HTTP 错误: ${res.status}`);
      }

      const data = await res.json();
      return !data.disabled;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("云端收件箱连接超时，请检查网络状况。");
      }
      throw new Error(`连通云端失败: ${err.message}`);
    }
  }

  /**
   * Sets the deduplication status on the Cloudflare Worker.
   * Returns true if deduplication is now ENABLED (i.e. disabled is false).
   */
  async toggleStatus(targetDisabled: boolean): Promise<boolean> {
    this.checkRateLimit();

    const workerUrl = await this.getToggleUrl();
    const token = await this.getWorkerToken();

    if (!token) {
      throw new Error("未能在设置或 .env 中找到 AUTOCLI_WORKER_TOKEN 凭证。");
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": token,
        },
        body: JSON.stringify({ disabled: targetDisabled }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Worker HTTP 错误: ${res.status}`);
      }

      const data = await res.json();
      return !data.disabled;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error("连接超时，云端去重状态未能成功更改。");
      }
      throw new Error(`更新去重状态失败: ${err.message}`);
    }
  }

  private async getToggleUrl(): Promise<string> {
    let inboxUrl = "";

    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    if (systemPath) {
      const envPath = path.join(systemPath, ".env");
      try {
        if (fs.existsSync(envPath)) {
          const content = await fs.promises.readFile(envPath, "utf-8");
          const lines = content.split(/\r?\n/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("#")) continue;
            const idx = trimmed.indexOf("=");
            if (idx > 0) {
              const key = trimmed.substring(0, idx).trim();
              const val = trimmed.substring(idx + 1).trim();
              if (key === "AUTOCLI_WORKER_URL") {
                inboxUrl = val;
                break;
              }
            }
          }
        }
      } catch (e) {}
    }

    if (!inboxUrl) {
      throw new Error("未配置云端 Worker URL。请在 .env 文件中设置 AUTOCLI_WORKER_URL。");
    }

    const url = inboxUrl.replace(/\/inbox$/, "/toggle-dedup");
    return url;
  }

  private checkRateLimit(): void {
    const now = Date.now();
    if (now - this.lastRequestTime < this.debounceMs) {
      throw new Error("法力过于频繁，请稍候再试（操作已防抖拦截）。");
    }
    this.lastRequestTime = now;
  }
}
