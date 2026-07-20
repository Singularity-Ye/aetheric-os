import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { FileSystemAdapter } from "obsidian";
import ScriptoriumPlugin from "../../main";
import { ProcessRegistry } from "./ProcessRegistry";
import { ProgressParser, ParsedProgress } from "./ProgressParser";
import { LogLevel } from "../types";

export interface GitStatusItem {
  status: string;
  path: string;
  isSensitive: boolean;
  reason?: string;
}

export type OperationProgressCallback = (progress: ParsedProgress | null) => void;

export class HamasxiangOperationsService {
  private lastProgress: Record<string, ParsedProgress | null> = {};

  constructor(
    private plugin: ScriptoriumPlugin,
    private registry: ProcessRegistry
  ) {}

  private getVaultPath(): string {
    const adapter = this.plugin.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return "";
  }

  getLastProgress(taskType: string): ParsedProgress | null {
    return this.lastProgress[taskType] || null;
  }

  /**
   * Helper to execute a command securely using ProcessRegistry.
   */
  private runCommand(
    taskType: string,
    cmd: string,
    args: string[],
    cwd: string,
    taskTitle: string,
    onProgress?: OperationProgressCallback
  ): void {
    if (this.registry.isRunning(taskType)) {
      throw new Error(`同类型法阵 [${taskTitle}] 正在执行中，请勿重复操作。`);
    }

    this.lastProgress[taskType] = null;
    this.plugin.logBus.append("info", "工造局", `🚀 启动法阵 [${taskTitle}]`);

    const env = { ...process.env };
    // Pass configured Playwright timers to environment
    env.DOUYIN_BROWSER_MIN_WAIT_MS = String(5000);
    env.DOUYIN_BROWSER_WAIT_MS = String(60000);

    const proc = spawn(cmd, args, { cwd, env, shell: false });

    // Register process in registry
    this.registry.register(taskType, proc, cmd, args, cwd);

    const handleDataStream = (data: Buffer, isErrorStream: boolean) => {
      const text = data.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip sensitive token output in logs
        if (trimmed.includes("Bearer ") || trimmed.includes("token") || trimmed.includes("TOKEN")) {
          continue;
        }

        // Parse progress
        const prog = ProgressParser.parseLine(trimmed);
        if (prog) {
          this.lastProgress[taskType] = prog;
          if (onProgress) {
            onProgress(prog);
          }
        }

        // Emit to LogBus
        let level: LogLevel = "info";
        if (isErrorStream) {
          level = "warn";
        } else if (trimmed.includes("❌") || trimmed.includes("Failed") || trimmed.includes("error")) {
          level = "error";
        } else if (trimmed.includes("⚠️") || trimmed.includes("Warn")) {
          level = "warn";
        } else if (trimmed.includes("✅") || trimmed.includes("listening") || trimmed.includes("已完成并投递")) {
          level = "success";
        }

        this.plugin.logBus.append(level, `工造局.${taskType}`, trimmed);
      }
    };

    proc.stdout.on("data", (data) => handleDataStream(data, false));
    proc.stderr.on("data", (data) => handleDataStream(data, true));

    proc.on("close", (code) => {
      if (code === 0) {
        this.plugin.logBus.append("success", "工造局", `❇️ 法阵合拢，[${taskTitle}] 执行圆满成功。`);
      } else {
        this.plugin.logBus.append("error", "工造局", `❌ [${taskTitle}] 执行受阻，退出代号: ${code}`);
      }
    });

    proc.on("error", (err) => {
      this.plugin.logBus.append("error", "工造局", `❌ [${taskTitle}] 启动或执行崩溃: ${err.message}`);
    });
  }

  /**
   * Run Inbox Cloud Ingestion (Autocli --sync)
   */
  runSync(onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const script = path.join(systemPath, "autocli.py");
    this.runCommand("sync", python, ["-u", script, "--sync"], systemPath, "云端归流", onProgress);
  }

  /** Export the allow-listed Vault notes for the cloud robot. */
  runKnowledgeExport(onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const script = path.join(systemPath, "knowledge_bridge.py");
    const vaultPath = this.getVaultPath();
    if (!fs.existsSync(script)) {
      throw new Error(`知识镜像脚本不存在，请检查蛤蟆祥 System 路径：${script}`);
    }
    this.runCommand(
      "knowledge-export",
      python,
      ["-u", script, "export", "--vault", vaultPath, "--output", path.join("data", "knowledge", "export")],
      systemPath,
      "知识镜像导出",
      onProgress,
    );
  }

  /**
   * Run Manual Grab URL
   */
  runManualGrab(url: string, force = false, onProgress?: OperationProgressCallback): void {
    if (!url.trim()) {
      throw new Error("请输入需要参悟的网页链接 (URL)！");
    }
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const script = path.join(systemPath, "autocli.py");
    const args = ["-u", script, url.trim(), "--preview"];
    if (force) args.push("--force");

    this.runCommand("sync", python, args, systemPath, "网页抓取", onProgress);
  }

  /**
   * Run deep repair
   */
  runRepair(onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const cleanVaultScript = path.join(systemPath, "clean_vault.py");
    const vaultPath = this.getVaultPath();

    this.runCommand(
      "repair",
      python,
      ["-u", cleanVaultScript, "--vault", vaultPath, "--repair", "--deep-asr"],
      systemPath,
      "自动修复",
      onProgress
    );
  }

  /**
   * Run platform specific repair
   */
  runPlatformRepair(platform: string, onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const cleanVaultScript = path.join(systemPath, "clean_vault.py");
    const vaultPath = this.getVaultPath();

    this.runCommand(
      "repair",
      python,
      ["-u", cleanVaultScript, "--vault", vaultPath, "--repair", "--deep-asr", "--platform", platform],
      systemPath,
      `${platform === "bilibili" ? "B站" : "抖音"} ASR 修复`,
      onProgress
    );
  }

  /**
   * Run Ingestion Quarantine
   */
  runQuarantine(onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const cleanVaultScript = path.join(systemPath, "clean_vault.py");
    const vaultPath = this.getVaultPath();

    this.runCommand(
      "repair",
      python,
      ["-u", cleanVaultScript, "--vault", vaultPath, "--quarantine"],
      systemPath,
      "淬炼隔离",
      onProgress
    );
  }

  /**
   * Run Ingestion Restore from Quarantine
   */
  runRestore(onProgress?: OperationProgressCallback): void {
    const python = "python";
    const systemPath = this.plugin.settings.hamasxiangSystemPath;
    const cleanVaultScript = path.join(systemPath, "clean_vault.py");
    const vaultPath = this.getVaultPath();

    this.runCommand(
      "repair",
      python,
      ["-u", cleanVaultScript, "--vault", vaultPath, "--restore"],
      systemPath,
      "还原残卷",
      onProgress
    );
  }

  /**
   * Run Blog Publish Graph Compilation
   */
  runPublish(): void {
    const blogCwd = this.plugin.settings.personalBlogPath;
    if (!blogCwd || !fs.existsSync(blogCwd)) {
      throw new Error(`个人博客工作路径不存在，请在天工台设置中检查：${blogCwd}`);
    }
    this.runCommand("preview", "node", ["scripts/build-graph.mjs"], blogCwd, "编译发布");
  }

  /**
   * Toggles the Astro/Jekyll preview dev server
   */
  toggleDevServer(): void {
    const taskType = "preview";
    if (this.registry.isRunning(taskType)) {
      void this.registry.kill(taskType);
      this.plugin.logBus.append("warn", "工造局", "⏹️ 本地预览开发服务已关闭。");
      return;
    }

    const blogCwd = this.plugin.settings.personalBlogPath;
    if (!blogCwd || !fs.existsSync(blogCwd)) {
      throw new Error(`个人博客路径无效，请在设置中检查：${blogCwd}`);
    }

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    this.runCommand(taskType, npmCmd, ["run", "dev"], blogCwd, "本地预览服务");
  }

  /**
   * Checks the git status of the vault repository, filtering and marking sensitive files.
   */
  async checkGitStatus(): Promise<GitStatusItem[]> {
    const vaultPath = this.getVaultPath();
    const gitDir = path.join(vaultPath, ".git");

    if (!fs.existsSync(gitDir)) {
      throw new Error("工作区根目录不是一个有效的 Git 仓库（未找到 .git 目录）。");
    }

    const result: GitStatusItem[] = [];

    // 1. Check detached HEAD
    try {
      const headContent = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (!headContent.startsWith("ref:")) {
        result.push({
          status: "HEAD",
          path: "版本分支状态",
          isSensitive: true,
          reason: "当前处于游离分支状态 (detached HEAD)，备份可能会丢失。请先切换到正常分支。",
        });
      }
    } catch (e: any) {
      throw new Error(`读取 Git HEAD 失败: ${e.message}`);
    }

    // 2. Check Merge/Rebase status
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
      result.push({
        status: "MERGE",
        path: "冲突/合并状态",
        isSensitive: true,
        reason: "当前正处于 Git 合并 (Merge) 中，有未决冲突，请先在终端解决合并。",
      });
    }
    if (
      fs.existsSync(path.join(gitDir, "REBASE_HEAD")) ||
      fs.existsSync(path.join(gitDir, "rebase-merge")) ||
      fs.existsSync(path.join(gitDir, "rebase-apply"))
    ) {
      result.push({
        status: "REBASE",
        path: "冲突/合并状态",
        isSensitive: true,
        reason: "当前正处于 Git 变基 (Rebase) 中，请先在终端解决变基或终止它。",
      });
    }
    if (fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
      result.push({
        status: "PICK",
        path: "冲突/合并状态",
        isSensitive: true,
        reason: "当前正处于 Cherry-pick 状态，请解决冲突或中止操作。",
      });
    }

    // 3. Scan Git Status Porcelain
    const statusItems = await new Promise<GitStatusItem[]>((resolve, reject) => {
      const proc = spawn("git", ["status", "--porcelain"], { cwd: vaultPath, shell: false });
      let output = "";
      let errOutput = "";
      proc.stdout.on("data", (data) => {
        output += data.toString("utf8");
      });
      proc.stderr.on("data", (data) => {
        errOutput += data.toString("utf8");
      });
      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Git status 退出异常 (${code}): ${errOutput.trim()}`));
          return;
        }

        const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
        const subResult: GitStatusItem[] = [];

        for (const line of lines) {
          const status = line.substring(0, 2);
          const rawPath = line.substring(3).trim();

          let filePath = rawPath.replace(/^"|"$/g, "");
          if (status.startsWith("R")) {
            const renameParts = filePath.split(" -> ");
            if (renameParts.length > 1) {
              filePath = renameParts[1].replace(/^"|"$/g, "");
            }
          }

          const lowerPath = filePath.toLowerCase();
          let isSensitive = false;
          let reason = "";

          const isConflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status.trim());
          if (isConflict) {
            isSensitive = true;
            reason = "冲突未解决的文件 (Conflict)";
          } else if (lowerPath.includes(".env")) {
            isSensitive = true;
            reason = "包含敏感环境变量配置文件 (.env)";
          } else if (lowerPath.includes("token") || lowerPath.includes("secret") || lowerPath.includes("key")) {
            isSensitive = true;
            reason = "可能包含敏感凭证 Token 或密钥文件名";
          } else if (lowerPath.includes("temp") || lowerPath.includes("tmp") || lowerPath.startsWith("phase4-api-")) {
            isSensitive = true;
            reason = "属于临时测试目录/测试废弃文件";
          }

          subResult.push({
            status: status.trim(),
            path: filePath,
            isSensitive,
            reason: reason || undefined,
          });
        }
        resolve(subResult);
      });
      proc.on("error", (err) => reject(err));
    });

    result.push(...statusItems);

    // 4. Scan staged contents for secrets (git diff --cached)
    try {
      const diffContent = await new Promise<string>((resolve) => {
        const proc = spawn("git", ["diff", "--cached"], { cwd: vaultPath, shell: false });
        let output = "";
        proc.stdout.on("data", (data) => {
          output += data.toString("utf8");
        });
        proc.on("close", () => resolve(output));
        proc.on("error", () => resolve(""));
      });

      const secretRegex = /\b(sk-[a-zA-Z0-9]{30,}|gsk_[a-zA-Z0-9]{30,}|bearer\s+[a-zA-Z0-9_.-]{20,})\b/i;
      if (secretRegex.test(diffContent)) {
        result.push({
          status: "⚠️",
          path: "暂存内容 (Staged Diff)",
          isSensitive: true,
          reason: "暂存的修改内容中疑似包含 API 密钥 (sk-... / gsk_... / Bearer Token)",
        });
      }
    } catch (e) {}

    // 5. Verify Remote / Network status
    let hasRemote = false;
    try {
      const configPath = path.join(gitDir, "config");
      if (fs.existsSync(configPath)) {
        const configText = fs.readFileSync(configPath, "utf8");
        hasRemote = configText.includes('[remote "origin"]');
      }
    } catch (e) {}

    if (hasRemote) {
      const remoteRes = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
        const p = spawn("git", ["ls-remote", "-h", "origin", "HEAD"], { cwd: vaultPath, shell: false });
        const timer = setTimeout(() => {
          p.kill();
          resolve({ ok: false, reason: "远程 origin 仓库连接超时 (4s)" });
        }, 4000);
        p.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, reason: "连接远程仓库失败 (认证失效或无网络)" });
          }
        });
        p.on("error", () => {
          clearTimeout(timer);
          resolve({ ok: false, reason: "连接远程 origin 异常" });
        });
      });

      if (!remoteRes.ok) {
        result.push({
          status: "NET",
          path: "远程连接状态",
          isSensitive: true,
          reason: remoteRes.reason || "远程仓库连接失败",
        });
      }
    } else {
      result.push({
        status: "NET",
        path: "远程连接状态",
        isSensitive: false,
        reason: "未配置远程 origin 仓库，将仅进行本地备份",
      });
    }

    return result;
  }
  runGitBackup(files: string[], commitMessage: string): Promise<boolean> {
    const vaultPath = this.getVaultPath();
    const taskType = "git";

    if (this.registry.isRunning(taskType)) {
      throw new Error("Git 备份法阵正在流转，请稍后再试。");
    }

    this.plugin.logBus.append("info", "工造局.git", "🔱 开始安全 Git 备份同步流...");

    return new Promise((resolve) => {
      const executeStep = (cmd: string, args: string[], next: () => void, onError: (msg: string) => void) => {
        this.plugin.logBus.append("info", "工造局.git", `   执行指令: ${cmd} ${args.join(" ")}`);
        const p = spawn(cmd, args, { cwd: vaultPath, shell: false });

        this.registry.register(taskType, p, cmd, args, vaultPath);

        p.stdout.on("data", (data) => {
          const text = data.toString("utf8");
          text.split("\n").forEach((line: string) => {
            const t = line.trim();
            if (t) this.plugin.logBus.append("info", "工造局.git", `[Git] ${t}`);
          });
        });

        p.stderr.on("data", (data) => {
          const text = data.toString("utf8");
          text.split("\n").forEach((line: string) => {
            const t = line.trim();
            if (t) this.plugin.logBus.append("info", "工造局.git", `[Git 提示] ${t}`);
          });
        });

        p.on("close", (code) => {
          if (code !== 0) {
            // Commit exits with 1 if there's nothing to commit. We check that separately.
            if (args[0] === "commit" && code === 1) {
              this.plugin.logBus.append("info", "工造局.git", "   无新变更需要提交，继续同步...");
              next();
              return;
            }
            onError(`Git ${args[0]} 异常退出，退出代码: ${code}`);
            return;
          }
          next();
        });

        p.on("error", (err) => {
          onError(`Git 命令执行崩溃: ${err.message}`);
        });
      };

      const handleFail = (msg: string) => {
        this.plugin.logBus.append("error", "工造局.git", `❌ Git 备份同步受阻: ${msg}`);
        resolve(false);
      };

      // Step 1: Add chosen files
      executeStep(
        "git",
        ["add", "--", ...files],
        async () => {
          this.plugin.logBus.append("info", "工造局.git", "🕵️ 正在对已暂存的文件执行密钥泄漏深度复检...");

          let diffContent = "";
          try {
            diffContent = await new Promise<string>((resolveDiff, rejectDiff) => {
              const proc = spawn("git", ["diff", "--cached"], { cwd: vaultPath, shell: false });
              let output = "";
              proc.stdout.on("data", (data) => {
                output += data.toString("utf8");
              });
              proc.on("close", (code) => {
                if (code !== 0) {
                  rejectDiff(new Error(`git diff --cached 退出异常 (${code})`));
                } else {
                  resolveDiff(output);
                }
              });
              proc.on("error", (err) => rejectDiff(err));
            });
          } catch (e: any) {
            handleFail(`无法执行暂存差异比对 (${e.message})，安全审查未通过。`);
            return;
          }

          const secretRegex = /\b(sk-[a-zA-Z0-9]{30,}|gsk_[a-zA-Z0-9]{30,}|bearer\s+[a-zA-Z0-9_.-]{20,})\b/i;
          if (secretRegex.test(diffContent)) {
            this.plugin.logBus.append("error", "工造局.git", "⚠️ 安全警报：暂存区中疑似包含 API 密钥 (sk-... / gsk_...)！启动回滚法阵...");

            // Execute rollback: git reset HEAD -- <files>
            const rollbackProc = spawn("git", ["reset", "HEAD", "--", ...files], { cwd: vaultPath, shell: false });
            rollbackProc.on("close", () => {
              handleFail("检测到敏感凭证泄漏，已撤销暂存，阻止提交！请清理后再试。");
            });
            return;
          }

          this.plugin.logBus.append("success", "工造局.git", "🛡️ 密钥复检通过，执行提交...");

          // Step 2: Commit
          executeStep(
            "git",
            ["commit", "-m", commitMessage],
            () => {
              this.plugin.logBus.append("success", "工造局.git", "❇️ 本地提交圆满完成。");
              resolve(true);
            },
            handleFail
          );
        },
        handleFail
      );
    });
  }

  /**
   * Run remote synchronization (pull + push) separated from backup.
   */
  runGitSyncRemote(): Promise<boolean> {
    const vaultPath = this.getVaultPath();
    const taskType = "git";

    if (this.registry.isRunning(taskType)) {
      throw new Error("Git 备份法阵正在流转，请稍后再试。");
    }

    return new Promise((resolve) => {
      const executeStep = (cmd: string, args: string[], next: () => void, onError: (msg: string) => void) => {
        this.plugin.logBus.append("info", "工造局.git", `   执行指令: ${cmd} ${args.join(" ")}`);
        const p = spawn(cmd, args, { cwd: vaultPath, shell: false });

        this.registry.register(taskType, p, cmd, args, vaultPath);

        p.stdout.on("data", (data) => {
          const text = data.toString("utf8");
          text.split("\n").forEach((line: string) => {
            const t = line.trim();
            if (t) this.plugin.logBus.append("info", "工造局.git", `[Git] ${t}`);
          });
        });

        p.stderr.on("data", (data) => {
          const text = data.toString("utf8");
          text.split("\n").forEach((line: string) => {
            const t = line.trim();
            if (t) this.plugin.logBus.append("info", "工造局.git", `[Git 提示] ${t}`);
          });
        });

        p.on("close", (code) => {
          if (code !== 0) {
            onError(`Git ${args[0]} 异常退出，退出代码: ${code}`);
            return;
          }
          next();
        });

        p.on("error", (err) => {
          onError(`Git 命令执行崩溃: ${err.message}`);
        });
      };

      const handleFail = (msg: string) => {
        this.plugin.logBus.append("error", "工造局.git", `❌ Git 远端同步受阻: ${msg}`);
        resolve(false);
      };

      // Step 1: Pull --rebase
      executeStep(
        "git",
        ["pull", "--rebase"],
        () => {
          // Step 2: Push
          executeStep(
            "git",
            ["push"],
            () => {
              this.plugin.logBus.append("success", "工造局.git", "❇️ Git 远端同步圆满成功！");
              resolve(true);
            },
            handleFail
          );
        },
        handleFail
      );
    });
  }
}
