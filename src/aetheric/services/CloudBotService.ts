import { App, Notice, normalizePath } from "obsidian";
import * as path from "path";

export interface CouponItem {
  shop_name: string;
  discount_yuan: number;
  threshold_yuan?: number | null;
  coupon_url?: string;
}

export interface SteamHistoryPoint {
  time: string;
  price: number;
  volume: number;
}

export interface SteamSkinData {
  checked_at: string;
  lowest_price_cny: number;
  median_price_cny: number;
  volume: number;
  trend_status: string;
  rate_uah_per_cny: number;
  lowest_price_uah: number;
  item_name: string;
  count: number;
  buy_unit: number;
  history: SteamHistoryPoint[];
}

export interface CloudBotSnapshot {
  coupons: CouponItem[];
  steam: SteamSkinData | null;
  updated_at: string;
}

export class CloudBotService {
  private snapshotPath = "08_密室/生活计划/_snapshots/cloud_bot_snapshot.json";
  private isRefreshing = false;

  constructor(private app: App) {}

  /**
   * Load cached cloud bot snapshot from vault synchronously/locally,
   * with automatic silent background refresh if cache is older than 45 minutes
   */
  async loadSnapshot(autoRefreshIfStale = true, onUpdated?: (snap: CloudBotSnapshot) => void): Promise<CloudBotSnapshot | null> {
    let snapshot: CloudBotSnapshot | null = null;
    try {
      const normalized = normalizePath(this.snapshotPath);
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(normalized)) {
        const raw = await adapter.read(normalized);
        snapshot = JSON.parse(raw) as CloudBotSnapshot;
      } else if (typeof window !== "undefined" && (window as any).require) {
        const fs = (window as any).require("fs");
        const nodePath = (window as any).require("path");
        const basePath = (this.app.vault.adapter as any).basePath || (this.app.vault.adapter as any).getBasePath?.() || "";
        const fullPath = nodePath.join(basePath, this.snapshotPath);
        if (fs.existsSync(fullPath)) {
          snapshot = JSON.parse(fs.readFileSync(fullPath, "utf8")) as CloudBotSnapshot;
        }
      }
    } catch (e) {
      console.warn("[CloudBotService] Failed to load local snapshot:", e);
    }

    if (autoRefreshIfStale && !this.isRefreshing) {
      const isStale = !snapshot || !snapshot.updated_at || (Date.now() - new Date(snapshot.updated_at).getTime() > 45 * 60 * 1000);
      if (isStale) {
        setTimeout(async () => {
          const fresh = await this.refreshFromCloud(true);
          if (fresh && onUpdated) {
            onUpdated(fresh);
          }
        }, 1200);
      }
    }

    return snapshot;
  }

  /**
   * Trigger background refresh by executing Python sync script
   */
  async refreshFromCloud(silent = false): Promise<CloudBotSnapshot | null> {
    if (this.isRefreshing) {
      if (!silent) new Notice("云端微信 Bot 正在同步中，请稍候...");
      return this.loadSnapshot(false);
    }
    this.isRefreshing = true;

    try {
      if (typeof window !== "undefined" && (window as any).require) {
        const { execFile } = (window as any).require("child_process");
        const scriptPath = "d:\\Yhx06\\Documents\\仙术工坊——项目集\\hamaxiang-system\\deploy\\sync_cloud_bot_data.py";

        await new Promise<void>((resolve) => {
          execFile("python", [scriptPath], { timeout: 10000 }, (err: any, stdout: string, stderr: string) => {
            if (err) {
              console.warn("[CloudBotService] sync script error:", stderr || err);
            }
            resolve();
          });
        });
      }
    } catch (err) {
      console.warn("[CloudBotService] Refresh failed:", err);
    } finally {
      this.isRefreshing = false;
    }

    const updated = await this.loadSnapshot(false);
    if (updated && !silent) {
      new Notice("云端生活与微信 Bot 数据已同步！");
    }
    return updated;
  }
}
