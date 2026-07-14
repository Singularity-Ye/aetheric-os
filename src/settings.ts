import { App, PluginSettingTab, Setting } from "obsidian";
import ScriptoriumPlugin from "./main";
import {
  AethericShellState,
  AethericWorkspace,
  DEFAULT_SHELL_STATE,
  DEFAULT_WORKSPACES,
} from "./aetheric/types";

export interface ScriptoriumSettings {
  schemaVersion: number;
  personalBlogPath: string;
  todoFilePath: string;
  autoOpenShell: boolean;
  nativeUiHidden: boolean;
  hamasxiangDaemonToken: string;
  workspaces: AethericWorkspace[];
  shellState: AethericShellState;
}

export const DEFAULT_SETTINGS: ScriptoriumSettings = {
  schemaVersion: 3,
  personalBlogPath: "d:\\Yhx06\\Documents\\仙术工坊——项目集\\个人博客网站-松果阁\\personal-blog",
  todoFilePath: "08_密室/todo.md",
  autoOpenShell: true,
  nativeUiHidden: true,
  hamasxiangDaemonToken: "",
  workspaces: DEFAULT_WORKSPACES,
  shellState: DEFAULT_SHELL_STATE,
};

export function mergeSettings(raw: Partial<ScriptoriumSettings> | null | undefined): ScriptoriumSettings {
  const shellState = {
    ...structuredClone(DEFAULT_SHELL_STATE),
    ...(raw?.shellState ?? {}),
    logDock: {
      ...structuredClone(DEFAULT_SHELL_STATE.logDock),
      ...(raw?.shellState?.logDock ?? {}),
    },
  };
  // v2 changes the log dock from a permanently open panel to an opt-in drawer.
  if (!raw?.schemaVersion || raw.schemaVersion < 2) shellState.logDock.open = false;
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...(raw ?? {}),
    workspaces: (() => {
      const list = [...(raw?.workspaces ?? [])];
      for (const defaultWs of DEFAULT_WORKSPACES) {
        const idx = list.findIndex(ws => ws.id === defaultWs.id);
        if (idx >= 0) {
          list[idx] = structuredClone(defaultWs);
        } else {
          list.push(structuredClone(defaultWs));
        }
      }
      return list.length ? list : structuredClone(DEFAULT_WORKSPACES);
    })(),
    shellState,
    schemaVersion: 3,
  };
}

export class ScriptoriumSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ScriptoriumPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "松果天工台 · Aetheric OS 设置" });

    new Setting(containerEl)
      .setName("启动后自动打开 Aetheric OS")
      .setDesc("Obsidian 布局就绪后打开唯一的常驻 Shell。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoOpenShell)
        .onChange(async value => {
          this.plugin.settings.autoOpenShell = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("默认隐藏原生 Ribbon 与左右侧栏")
      .setDesc("只隐藏外观，不禁用 Obsidian 内核能力。命令面板始终保留安全恢复命令。")
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.nativeUiHidden)
        .onChange(async value => {
          this.plugin.settings.nativeUiHidden = value;
          this.plugin.nativeUi.apply(value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("蛤蟆祥 Daemon Token")
      .setDesc("仅保存在本机 Obsidian 插件 data.json 中，用于 X Watch 等写操作；不要提交到代码仓库。")
      .addText(text => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("与 hamaxiang-system/.env 保持一致")
          .setValue(this.plugin.settings.hamasxiangDaemonToken)
          .onChange(async value => {
            this.plugin.settings.hamasxiangDaemonToken = value.trim();
            this.plugin.hamasxiangAdapter.setAuthToken(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("个人博客网站路径")
      .setDesc("旧松果阁工具运行博客构建命令时使用。")
      .addText(text => text
        .setPlaceholder("D:\\...\\personal-blog")
        .setValue(this.plugin.settings.personalBlogPath)
        .onChange(async value => {
          this.plugin.settings.personalBlogPath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("待办文件路径")
      .setDesc("旧松果阁待办工具使用的 Vault 相对路径。")
      .addText(text => text
        .setPlaceholder("08_密室/todo.md")
        .setValue(this.plugin.settings.todoFilePath)
        .onChange(async value => {
          this.plugin.settings.todoFilePath = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("立即恢复 Obsidian 原生界面")
      .setDesc("移除 Aetheric 原生 UI 覆盖 class，作为故障灭火器。")
      .addButton(button => button
        .setButtonText("安全恢复")
        .onClick(() => void this.plugin.restoreNativeUi()));
  }
}
