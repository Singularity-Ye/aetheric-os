import { ItemView, WorkspaceLeaf, FileSystemAdapter, Notice, TFile } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import ScriptoriumPlugin from "../main";

export const SCRIPTORIUM_DASHBOARD_VIEW = "scriptorium-dashboard-view";

const ZEN_TIPS = [
  "Git 是您的终极安全网。尽情整理、大胆重构，任何误删均可瞬间还原！",
  "理财心法：跑不赢印钞机就是亏钱。守住会下蛋的鹅，抵制差价博弈诱惑。",
  "AI 是极佳的逻辑编译器，人类是温润的情感本体。双轨制学习，方得顿悟。",
  "高频修改文件时，优先采用 Node.js 脚本批量替换，消除频繁弹出终端审批的打扰。",
  "小红书与生活流笔记要保留人间烟火气。3D 弯曲画廊在详情页更适配哦！",
  "不要把生活流的体验笔记写成学术论文，轻松、简单、带有人情味是松果阁的底色。",
  "格物院课程笔记注重 LaTeX 排版与解题菜谱 (Recipes)，期末拿分才是硬道理。",
  "整理收件箱前，请务必先运行 git status 确认当前分支状态是否清爽。"
];

export class ScriptoriumDashboardView extends ItemView {
  plugin: ScriptoriumPlugin;
  terminalLog: HTMLDivElement;
  todoContainer: HTMLDivElement;
  tipTextEl: HTMLDivElement;
  consolePanel: HTMLDivElement;
  logFollowBtn: HTMLButtonElement;
  logExpandBtn: HTMLButtonElement;
  logNewBadge: HTMLButtonElement;
  logFollowEnabled = true;
  pendingLogCount = 0;
  logExpanded = false;

  constructor(leaf: WorkspaceLeaf, plugin: ScriptoriumPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SCRIPTORIUM_DASHBOARD_VIEW;
  }

  getDisplayText(): string {
    return "🌲 松果阁控制台";
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();

    // 1. Root Container Wrapper
    const dashboard = container.createEl("div", { cls: "scriptorium-dashboard-container" });

    // 2. Background Star Dust Layer
    dashboard.createEl("div", { cls: "scriptorium-stars-bg" });

    // 3. Header
    const header = dashboard.createEl("div", { cls: "scriptorium-header" });
    header.createEl("div", { text: "Pinecone Control Center", cls: "scriptorium-eyebrow" });
    
    const titleArea = header.createEl("div", { cls: "scriptorium-title-area" });
    titleArea.createEl("h2", { text: "🌲 松果阁控制台" });
    header.createEl("p", { text: "高频文件夹导航、小目标看板与博客一键发布中心", cls: "scriptorium-subtitle" });

    // 4. Main Layout
    const layout = dashboard.createEl("div", { cls: "scriptorium-layout" });

    // Card 1: Quick Links (高频文件夹导航)
    const navCard = layout.createEl("div", { cls: "scriptorium-card" });
    navCard.createEl("h3", { text: "🗂️ 常用高频文件夹直达" });
    
    const linksGrid = navCard.createEl("div", { cls: "scriptorium-grid" });
    linksGrid.style.cssText = "display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;";

    const folderShortcuts = [
      { name: "📬 收件箱", path: "00_松果池（收件箱）" },
      { name: "🍳 美食食味录", path: "03_生活簿（生活区）/食味录（美食与探店）" },
      { name: "🗺️ 行路志", path: "03_生活簿（生活区）/行路志（旅行与城市）" },
      { name: "🛠️ 技艺录", path: "01_藏经阁（知识库）/技艺录（技术与工具）" },
      { name: "📚 格物院", path: "01_藏经阁（知识库）/格物院（课程与学科）" },
      { name: "🗃️ 原始证据库", path: "01_藏经阁（知识库）/archive_raw（原始证据库）" }
    ];

    for (const shortcut of folderShortcuts) {
      const btn = linksGrid.createEl("button", { 
        text: shortcut.name, 
        cls: "scriptorium-btn"
      });
      btn.style.cssText = "padding: 8px; font-size: 0.85em; text-align: left; background: var(--item-bg); border: 1px solid var(--item-border);";
      btn.addEventListener("click", () => this.revealFolderPath(shortcut.path));
    }

    // Card 2: Daily Zen Tips Card (心法卡片)
    const tipCard = layout.createEl("div", { cls: "scriptorium-card" });
    const tipHeader = tipCard.createEl("div");
    tipHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;";
    
    const titleEl = tipHeader.createEl("h3", { text: "💡 仙术心法提示" });
    titleEl.style.cssText = "margin: 0;";
    const refreshTipBtn = tipHeader.createEl("button", { 
      text: "🔄", 
      cls: "scriptorium-btn-icon"
    });
    refreshTipBtn.style.cssText = "background: none; border: none; cursor: pointer; padding: 2px;";
    refreshTipBtn.addEventListener("click", () => this.refreshZenTip());

    this.tipTextEl = tipCard.createEl("div", { cls: "scriptorium-tip-text" });
    this.tipTextEl.style.cssText = "font-size: 0.88em; line-height: 1.5; color: var(--text-muted); background: var(--item-bg); padding: 12px; border-radius: 8px; border-left: 3px solid var(--text-accent);";
    this.refreshZenTip();

    // Card 3: Goals & Tasks Checklist (小目标待办看板)
    const todoCard = layout.createEl("div", { cls: "scriptorium-card" });
    todoCard.createEl("h3", { text: "🎯 我的小目标与任务" });
    this.todoContainer = todoCard.createEl("div", { cls: "scriptorium-todo-list" });
    this.todoContainer.style.cssText = "margin-top: 10px; display: flex; flex-direction: column; gap: 8px; max-height: 250px; overflow-y: auto;";
    await this.loadTodoTasks();

    // Card 4: Blog Sync Commands (一键博客发布)
    const blogCard = layout.createEl("div", { cls: "scriptorium-card" });
    blogCard.createEl("h3", { text: "🚀 个人博客一键管理" });
    
    const blogBtnRow = blogCard.createEl("div", { cls: "scriptorium-row" });
    blogBtnRow.style.cssText = "display: flex; gap: 10px; margin-top: 10px;";
    
    const btnSync = blogBtnRow.createEl("button", { text: "⚡ 同步并构建图谱", cls: "scriptorium-btn" });
    btnSync.style.flex = "1";
    btnSync.addEventListener("click", () => this.runBlogCommand("npm run build-graph"));

    const btnBuild = blogBtnRow.createEl("button", { text: "📦 生产环境打包验证", cls: "scriptorium-btn" });
    btnBuild.style.flex = "1";
    btnBuild.addEventListener("click", () => this.runBlogCommand("npm run build"));

    // Console Panel (传书日志)
    this.consolePanel = layout.createEl("div", { cls: "scriptorium-console-panel" });
    const consoleHeader = this.consolePanel.createEl("div", { cls: "scriptorium-console-header" });
    consoleHeader.createEl("div", { text: "🖥️ 控制台运行日志", cls: "scriptorium-console-title" });
    const consoleActions = consoleHeader.createEl("div", { cls: "scriptorium-console-actions" });
    this.logFollowBtn = consoleActions.createEl("button", { text: "↓ 跟随中", cls: "scriptorium-console-clear log-follow-btn" });
    this.logFollowBtn.setAttribute("title", "向上浏览时自动暂停跟随");
    this.registerDomEvent(this.logFollowBtn, "click", () => this.scrollToLogBottom());
    this.logExpandBtn = consoleActions.createEl("button", { text: "⛶ 放大", cls: "scriptorium-console-clear" });
    this.registerDomEvent(this.logExpandBtn, "click", () => this.toggleLogExpanded());
    const clearBtn = consoleActions.createEl("button", { text: "清空", cls: "scriptorium-console-clear" });
    this.registerDomEvent(clearBtn, "click", () => {
      this.terminalLog.innerHTML = "";
      this.pendingLogCount = 0;
      this.logFollowEnabled = true;
      this.updateLogFollowUI();
    });

    this.terminalLog = this.consolePanel.createEl("div", { cls: "scriptorium-terminal" });
    this.registerDomEvent(this.terminalLog, "scroll", () => this.handleLogScroll());
    this.logNewBadge = this.consolePanel.createEl("button", { text: "↓ 回到底部", cls: "scriptorium-log-new-badge is-hidden" });
    this.registerDomEvent(this.logNewBadge, "click", () => this.scrollToLogBottom());
    this.log("松果阁控制台就绪。点击对应指令启动操作...\n");
  }

  async onClose(): Promise<void> {
    this.logExpanded = false;
  }

  // Get absolute path of vault
  getVaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return "";
  }

  isLogNearBottom(): boolean {
    if (!this.terminalLog) return true;
    return this.terminalLog.scrollHeight - this.terminalLog.scrollTop - this.terminalLog.clientHeight < 48;
  }

  handleLogScroll(): void {
    if (!this.terminalLog) return;
    const nearBottom = this.isLogNearBottom();
    this.logFollowEnabled = nearBottom;
    if (nearBottom) this.pendingLogCount = 0;
    this.updateLogFollowUI();
  }

  updateLogFollowUI(): void {
    if (this.logFollowBtn) {
      this.logFollowBtn.textContent = this.logFollowEnabled ? "↓ 跟随中" : "⏸ 已暂停";
      this.logFollowBtn.classList.toggle("is-paused", !this.logFollowEnabled);
    }
    if (this.logNewBadge) {
      this.logNewBadge.textContent = this.pendingLogCount > 0 ? `↓ ${this.pendingLogCount} 条新日志 · 回到底部` : "↓ 回到底部";
      this.logNewBadge.classList.toggle("is-hidden", this.logFollowEnabled || this.pendingLogCount === 0);
    }
  }

  scrollToLogBottom(): void {
    if (!this.terminalLog) return;
    this.logFollowEnabled = true;
    this.pendingLogCount = 0;
    this.terminalLog.scrollTop = this.terminalLog.scrollHeight;
    this.updateLogFollowUI();
  }

  toggleLogExpanded(): void {
    if (!this.consolePanel) return;
    this.logExpanded = !this.logExpanded;
    this.consolePanel.classList.toggle("is-expanded", this.logExpanded);
    if (this.logExpandBtn) this.logExpandBtn.textContent = this.logExpanded ? "↙ 还原" : "⛶ 放大";
    if (this.logExpanded && this.logFollowEnabled) requestAnimationFrame(() => this.scrollToLogBottom());
  }

  // Log message to terminal console and the shared Aetheric LogBus.
  log(message: string, isError = false): void {
    const shouldFollow = this.logFollowEnabled || this.isLogNearBottom();
    const line = document.createElement("div");
    line.className = isError ? "log-line error" : "log-line success";
    line.textContent = message;
    this.terminalLog.appendChild(line);
    this.plugin.logBus.append(isError ? "error" : "info", "scriptorium.legacy", message);
    if (shouldFollow) {
      this.logFollowEnabled = true;
      requestAnimationFrame(() => this.scrollToLogBottom());
    } else {
      this.pendingLogCount += 1;
      this.logFollowEnabled = false;
      this.updateLogFollowUI();
    }
  }

  // Refresh Zen Tip card
  refreshZenTip(): void {
    const randomTip = ZEN_TIPS[Math.floor(Math.random() * ZEN_TIPS.length)];
    if (this.tipTextEl) {
      this.tipTextEl.textContent = randomTip;
    }
  }

  // Route folder selection to Aetheric OS instead of using Obsidian private file-explorer internals.
  revealFolderPath(folderPath: string): void {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      this.log(`⚠️ 路径在库中未找到: ${folderPath}\n`, true);
      new Notice(`路径未找到: ${folderPath}`);
      return;
    }

    void this.plugin.openFolderInAetheric(folderPath);
    this.log(`📂 已交由 Aetheric 导航器定位: ${folderPath}\n`);
  }

  // Read and parse checklist from the todo.md file
  async loadTodoTasks(): Promise<void> {
    this.todoContainer.empty();
    const todoRelPath = this.plugin.settings.todoFilePath;
    const file = this.app.vault.getAbstractFileByPath(todoRelPath);

    if (!file || !(file instanceof TFile)) {
      // Show init button
      const errText = this.todoContainer.createEl("div", {
        text: `未检测到目标文件: ${todoRelPath}`
      });
      errText.style.cssText = "color:var(--text-muted); font-size:0.85em; margin-bottom:8px;";
      
      const initBtn = this.todoContainer.createEl("button", {
        text: "⚡ 初始化 todo.md 目标列表",
        cls: "scriptorium-btn"
      });
      initBtn.addEventListener("click", () => this.initializeTodoFile());
      return;
    }

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split(/\r?\n/);
      
      let checkboxCount = 0;

      lines.forEach((line, idx) => {
        const match = line.match(/^\s*-\s+\[([ x])\]\s*(.*)$/i);
        if (match) {
          checkboxCount++;
          const isChecked = match[1].toLowerCase() === "x";
          const taskText = match[2].trim();

          const taskRow = this.todoContainer.createEl("div");
          taskRow.style.cssText = "display:flex; align-items:center; gap:8px; padding:4px 8px; background:var(--item-bg); border-radius:6px; border:1px solid var(--item-border);";

          const checkbox = taskRow.createEl("input", {
            type: "checkbox"
          }) as HTMLInputElement;
          checkbox.checked = isChecked;
          checkbox.addEventListener("change", () => this.toggleTodoTask(idx, !isChecked));

          const label = taskRow.createEl("span", {
            text: taskText
          });
          label.style.cssText = `font-size:0.88em; flex:1; cursor:pointer; ${isChecked ? 'text-decoration:line-through; color:var(--text-muted);' : ''}`;
          label.addEventListener("click", () => this.toggleTodoTask(idx, !isChecked));
        }
      });

      if (checkboxCount === 0) {
        const emptyMsg = this.todoContainer.createEl("div", {
          text: "📝 没有找到待办的小目标，可以去 todo.md 文件中添加！"
        });
        emptyMsg.style.cssText = "color:var(--text-muted); font-size:0.85em; padding:5px;";
      }
    } catch (err: any) {
      const failMsg = this.todoContainer.createEl("div", {
        text: `读取失败: ${err.message}`
      });
      failMsg.style.cssText = "color:red; font-size:0.85em;";
    }
  }

  // Write a default todo template to path if missing
  async initializeTodoFile(): Promise<void> {
    const todoRelPath = this.plugin.settings.todoFilePath;
    
    // Ensure parent folders exist
    const parentPath = path.dirname(todoRelPath);
    if (parentPath && parentPath !== ".") {
      const parentFolder = this.app.vault.getAbstractFileByPath(parentPath);
      if (!parentFolder) {
        await this.app.vault.createFolder(parentPath);
      }
    }

    const defaultContent = `# 🌲 松果阁今日小目标\n\n- [ ] 使用 3D 圆形画廊丰富小红书/美食笔记视觉\n- [ ] 精读格物院编译原理语法分析与状态转换\n- [ ] 进行博客文章的一键同步测试\n- [x] 清空收件箱 Batch 1~8 历史赤字\n`;
    
    try {
      await this.app.vault.create(todoRelPath, defaultContent);
      this.log(`✨ 已成功创建待办模板文件: ${todoRelPath}\n`);
      new Notice(`已创建目标模板`);
      await this.loadTodoTasks();
    } catch (err: any) {
      this.log(`❌ 创建失败: ${err.message}\n`, true);
    }
  }

  // Toggle checklist checkbox state and rewrite file
  async toggleTodoTask(lineIndex: number, newCheckedState: boolean): Promise<void> {
    const todoRelPath = this.plugin.settings.todoFilePath;
    const file = this.app.vault.getAbstractFileByPath(todoRelPath);

    if (!file || !(file instanceof TFile)) return;

    try {
      const content = await this.app.vault.read(file);
      const lines = content.split(/\r?\n/);

      if (lineIndex < lines.length) {
        const line = lines[lineIndex];
        const match = line.match(/^(\s*-\s+\[)([ x])(\]\s*.*)$/i);
        if (match) {
          lines[lineIndex] = `${match[1]}${newCheckedState ? 'x' : ' '}${match[3]}`;
          const newContent = lines.join("\n");
          await this.app.vault.modify(file, newContent);
          
          new Notice(newCheckedState ? "🎯 达成小目标！" : "↩️ 已取消达成");
          await this.loadTodoTasks();
        }
      }
    } catch (err: any) {
      this.log(`❌ 状态更新失败: ${err.message}\n`, true);
    }
  }

  // Run shell commands in the blog directory and pipe to terminal console
  runBlogCommand(cmd: string): void {
    const blogPath = this.plugin.settings.personalBlogPath;
    
    if (!fs.existsSync(blogPath)) {
      this.log(`❌ 博客路径未配置或在本地未找到: ${blogPath}\n`, true);
      this.log(`请先在【控制台插件设置】中指定正确的个人博客绝对路径。\n`, true);
      new Notice("博客路径不存在，请检查设置");
      return;
    }

    this.log(`\n📂 运行目录: ${blogPath}`);
    this.log(`⚡ 正在执行指令: ${cmd} ...\n`);
    
    const child = exec(cmd, { cwd: blogPath });

    child.stdout?.on("data", (data) => {
      this.log(data.toString());
    });

    child.stderr?.on("data", (data) => {
      this.log(data.toString(), true);
    });

    child.on("close", (code) => {
      if (code === 0) {
        this.log(`\n🎉 指令执行完毕！(Exit code: 0)\n`);
        new Notice("控制台指令执行成功！");
      } else {
        this.log(`\n❌ 指令执行失败。(Exit code: ${code})\n`, true);
        new Notice(`控制台指令执行失败 (${code})`);
      }
    });

    child.on("error", (err) => {
      this.log(`❌ 进程异常: ${err.message}\n`, true);
    });
  }
}
