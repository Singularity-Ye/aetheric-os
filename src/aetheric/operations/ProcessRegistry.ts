import { ChildProcess, execFile } from "child_process";

export interface ProcessRegistryEntry {
  taskType: string;
  process: ChildProcess;
  cmd: string;
  args: string[];
  cwd: string;
  startedAt: number;
  ownership: "managed" | "external";
}

export class ProcessRegistry {
  private activeProcesses = new Map<string, ProcessRegistryEntry>();

  /**
   * Registers a newly started child process.
   * If a process of the same taskType is already running, this will throw an error (mutual exclusion).
   */
  register(
    taskType: string,
    proc: ChildProcess,
    cmd: string,
    args: string[],
    cwd: string,
    ownership: "managed" | "external" = "managed"
  ): void {
    if (this.activeProcesses.has(taskType)) {
      throw new Error(`同类型法阵任务 [${taskType}] 正在运转中，请勿重复开启。`);
    }

    this.activeProcesses.set(taskType, {
      taskType,
      process: proc,
      cmd,
      args,
      cwd,
      startedAt: Date.now(),
      ownership,
    });

    proc.on("close", () => {
      const current = this.activeProcesses.get(taskType);
      // Only delete if it's the exact same process instance (avoid race conditions)
      if (current && current.process === proc) {
        this.activeProcesses.delete(taskType);
      }
    });

    proc.on("error", () => {
      const current = this.activeProcesses.get(taskType);
      if (current && current.process === proc) {
        this.activeProcesses.delete(taskType);
      }
    });
  }

  /**
   * Returns the process entry for a given task type, if running.
   */
  get(taskType: string): ProcessRegistryEntry | undefined {
    return this.activeProcesses.get(taskType);
  }

  /**
   * Checks if a process of a given task type is currently running.
   */
  isRunning(taskType: string): boolean {
    return this.activeProcesses.has(taskType);
  }

  /**
   * Lists all active registered processes.
   */
  list(): ProcessRegistryEntry[] {
    return Array.from(this.activeProcesses.values());
  }

  /**
   * Safely terminates a process and all of its subprocesses (process tree) on Windows.
   */
  kill(taskType: string): Promise<boolean> {
    const entry = this.activeProcesses.get(taskType);
    if (!entry) {
      return Promise.resolve(false);
    }

    const pid = entry.process.pid;
    if (pid === undefined) {
      try {
        entry.process.kill();
      } catch (e) {
        // ignore
      }
      this.activeProcesses.delete(taskType);
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const isWin = process.platform === "win32";
      if (isWin) {
        // Use taskkill to kill the parent and all child subprocesses (/T) forcefully (/F)
        execFile("taskkill", ["/F", "/T", "/PID", String(pid)], (err) => {
          this.activeProcesses.delete(taskType);
          resolve(!err);
        });
      } else {
        try {
          // On non-Windows platforms, fallback to process group kill if possible, or standard kill
          entry.process.kill("SIGKILL");
        } catch (e) {
          // ignore
        }
        this.activeProcesses.delete(taskType);
        resolve(true);
      }
    });
  }

  /**
   * Shuts down all running processes, e.g. when the plugin is unloaded.
   */
  async shutdownAll(): Promise<void> {
    const types = Array.from(this.activeProcesses.keys());
    for (const type of types) {
      // Keep persistent background daemons if configuration specifies, but terminate execution tasks
      if (type === "daemon") {
        // Daemons can be kept based on settings, but we terminate them here for clean shutdown
        await this.kill(type);
      } else {
        await this.kill(type);
      }
    }
  }
}
