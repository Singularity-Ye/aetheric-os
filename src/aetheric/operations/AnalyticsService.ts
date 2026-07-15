import { IndexedFile } from "../types";
import ScriptoriumPlugin from "../../main";

export interface AnalyticsSnapshot {
  totalNotes: number;
  todayNotes: number;
  evidenceCounts: {
    subtitle_full: number;
    subtitle_unstable: number;
    subtitle_suspect: number;
    toc_metadata: number;
    asr_pending: number;
    asr_failed: number;
  };
  platformCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  dateCounts: Record<string, number>;
  scrollsList: Array<{
    title: string;
    filePath: string;
    platform: string;
    category: string;
    date: string;
    evidence: string;
  }>;
}

type AnalyticsUpdateListener = (snapshot: AnalyticsSnapshot) => void;

export class AnalyticsService {
  private snapshot: AnalyticsSnapshot = this.getEmptySnapshot();
  private listeners = new Set<AnalyticsUpdateListener>();
  private isActive = false;
  private isDirty = true;
  private isCalculating = false;
  private indexSubscription: (() => void) | null = null;

  constructor(private plugin: ScriptoriumPlugin) {}

  start(): void {
    // Subscribe to VaultIndexService updates
    this.indexSubscription = this.plugin.indexService.subscribe(() => {
      this.isDirty = true;
      if (this.isActive) {
        void this.startCalculation();
      }
    });
  }

  destroy(): void {
    if (this.indexSubscription) {
      this.indexSubscription();
      this.indexSubscription = null;
    }
    this.listeners.clear();
  }

  /**
   * Sets whether the Analytics view is active.
   * If it becomes active and the cache is dirty, triggers calculation.
   */
  setActive(active: boolean): void {
    this.isActive = active;
    if (active && (this.isDirty || this.snapshot.totalNotes === 0)) {
      void this.startCalculation();
    }
  }

  subscribe(listener: AnalyticsUpdateListener): () => void {
    this.listeners.add(listener);
    // Immediately emit current cached snapshot
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AnalyticsSnapshot {
    return this.snapshot;
  }

  private getEmptySnapshot(): AnalyticsSnapshot {
    return {
      totalNotes: 0,
      todayNotes: 0,
      evidenceCounts: {
        subtitle_full: 0,
        subtitle_unstable: 0,
        subtitle_suspect: 0,
        toc_metadata: 0,
        asr_pending: 0,
        asr_failed: 0,
      },
      platformCounts: { B站: 0, 抖音: 0, 小红书: 0, 其他: 0 },
      categoryCounts: {
        "技艺录（技术与工具）": 0,
        "思辨录（认知与方法）": 0,
        "博物志（科普与见闻）": 0,
        "刀笔集（锐评与观察）": 0,
        "食味录（美食与探店）": 0,
        "游艺录（游戏与娱乐）": 0,
        "行路志（旅行与城市）": 0,
        "案上书（阅读与文学）": 0,
        "映卷录（影视与动漫）": 0,
        "其他": 0,
      },
      dateCounts: {},
      scrollsList: [],
    };
  }

  /**
   * Starts a non-blocking chunked computation of the analytics stats.
   * Yields control to the UI thread using requestAnimationFrame after every chunk.
   */
  private async startCalculation(): Promise<void> {
    if (this.isCalculating) return;
    this.isCalculating = true;
    this.isDirty = false;

    console.time("Hamasxiang Analytics Calculation");
    const startTime = Date.now();

    // 1. Retrieve inbox files from VaultIndexService (instant, memory-backed)
    const inboxPath = "00_松果池（收件箱）";
    const allFiles = this.plugin.indexService.listFilesRecursive([inboxPath]);

    const tempSnapshot = this.getEmptySnapshot();
    const todayStr = new Date().toISOString().slice(0, 10);
    const chunkSize = 150; // process 150 files per animation frame
    let currentIndex = 0;

    const processChunk = (): Promise<void> => {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          const limit = Math.min(currentIndex + chunkSize, allFiles.length);
          for (let i = currentIndex; i < limit; i++) {
            const file = allFiles[i];
            if (file.extension !== "md") continue;

            tempSnapshot.totalNotes++;

            // 1. Platform Ingestion
            const relative = file.path.substring(inboxPath.length).replace(/\\/g, "/");
            const parts = relative.split("/").filter((p: string) => p);
            const rawPlat = parts.length > 0 ? parts[0] : "Other";
            const platform = this.normalizePlatform(rawPlat);
            tempSnapshot.platformCounts[platform] = (tempSnapshot.platformCounts[platform] ?? 0) + 1;

            // 2. Frontmatter extraction
            const fm = file.frontmatter ?? {};

            // Date
            let dateVal = String(fm["date"] || fm["创建时间"] || "");
            if (!dateVal) {
              const dateMatch = file.basename.match(/^(\d{4}-\d{2}-\d{2})/);
              if (dateMatch) dateVal = dateMatch[1];
            }
            if (!dateVal) {
              dateVal = new Date(file.mtime).toISOString().slice(0, 10);
            }

            if (dateVal) {
              tempSnapshot.dateCounts[dateVal] = (tempSnapshot.dateCounts[dateVal] ?? 0) + 1;
              if (dateVal === todayStr) {
                tempSnapshot.todayNotes++;
              }
            }

            // Evidence level
            const evidence = String(fm["证据等级"] || fm["evidence_level"] || "subtitle_full");
            if (tempSnapshot.evidenceCounts.hasOwnProperty(evidence)) {
              (tempSnapshot.evidenceCounts as any)[evidence]++;
            }

            // Category
            let category = "其他";
            if (parts.length >= 3) {
              category = parts[1];
            } else {
              category = String(fm["分流建议"] || fm["route"] || "其他");
            }
            const normCategory = this.normalizeCategory(category);
            tempSnapshot.categoryCounts[normCategory] = (tempSnapshot.categoryCounts[normCategory] ?? 0) + 1;

            // Add to scrolls list
            tempSnapshot.scrollsList.push({
              title: typeof fm.title === "string" ? fm.title : file.basename,
              filePath: file.path,
              platform,
              category: normCategory,
              date: dateVal,
              evidence,
            });
          }

          currentIndex = limit;
          resolve();
        });
      });
    };

    while (currentIndex < allFiles.length) {
      await processChunk();
    }

    // Sort scrolls by date descending
    tempSnapshot.scrollsList.sort((a, b) => b.date.localeCompare(a.date));

    this.snapshot = tempSnapshot;
    this.isCalculating = false;

    const duration = Date.now() - startTime;
    console.timeEnd("Hamasxiang Analytics Calculation");
    console.log(`Hamasxiang工造司增量统计耗时: ${duration}ms, 覆盖卷轴总数: ${allFiles.length}`);

    // Emit updates to active UI listeners
    this.listeners.forEach((listener) => listener(this.snapshot));

    // If it became dirty during calculation, run it again
    if (this.isDirty && this.isActive) {
      void this.startCalculation();
    }
  }

  private normalizeCategory(category: string): string {
    if (!category) return "其他";
    category = category.trim();
    if (category.includes("技艺录") || category === "丹炉间") return "技艺录（技术与工具）";
    if (category.includes("思辨录") || category === "内功心法") return "思辨录（认知与方法）";
    if (category.includes("博物志")) return "博物志（科普与见闻）";
    if (category.includes("刀笔集")) return "刀笔集（锐评与观察）";
    if (category.includes("食味录") || category === "美食攻略") return "食味录（美食与探店）";
    if (category.includes("游艺录") || category === "游戏攻略") return "游艺录（游戏与娱乐）";
    if (category.includes("行路志") || category === "旅游攻略") return "行路志（旅行与城市）";
    if (category.includes("案上书")) return "案上书（阅读与文学）";
    if (category.includes("映卷录") || category === "影视录" || category === "光影录") return "映卷录（影视与动漫）";
    return "其他";
  }

  private normalizePlatform(plat: string): string {
    if (!plat) return "其他";
    plat = plat.trim();
    if (plat.includes("B站") || plat.toLowerCase().includes("bili")) return "B站";
    if (plat.includes("抖音") || plat.toLowerCase().includes("tiktok") || plat.toLowerCase().includes("douyin")) return "抖音";
    if (plat.includes("小红书") || plat.toLowerCase().includes("redbook")) return "小红书";
    return "其他";
  }
}
