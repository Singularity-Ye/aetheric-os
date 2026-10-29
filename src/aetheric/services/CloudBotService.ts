import { App, Notice } from "obsidian";
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
   * Load cached cloud bot snapshot from vault synchronously/locally
   */
  async loadSnapshot(): Promise<CloudBotSnapshot | null> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.snapshotPath)) {
        const raw = await adapter.read(this.snapshotPath);
        return JSON.parse(raw) as CloudBotSnapshot;
      }
    } catch (e) {
      console.warn("[CloudBotService] Failed to load local snapshot:", e);
    }
    return null;
  }

  /**
   * Trigger background refresh by executing Python sync script
   */
  async refreshFromCloud(): Promise<CloudBotSnapshot | null> {
    if (this.isRefreshing) {
      new Notice("云端微信 Bot 正在同步中，请稍候...");
      return this.loadSnapshot();
    }
    this.isRefreshing = true;

    try {
      if (typeof window !== "undefined" && (window as any).require) {
        const { execFile } = (window as any).require("child_process");
        const scriptPath = "d:\\Yhx06\\Documents\\仙术工坊——项目集\\hamaxiang-system\\deploy\\sync_cloud_bot_data.py";

        await new Promise<void>((resolve, reject) => {
          execFile("python", [scriptPath], { timeout: 10000 }, (err: any, stdout: string, stderr: string) => {
            if (err) {
              console.warn("[CloudBotService] sync script error:", stderr || err);
              // don't reject to avoid breaking UI, fallback to local cache
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

    const updated = await this.loadSnapshot();
    if (updated) {
      new Notice("🎉 云端生活与微信 Bot 数据已同步！");
    }
    return updated;
  }
}
