# Aetheric Workbench Architecture v2

## 1. 为什么需要翻新

当前工作台功能已经超过最初的单页 Shell：导航、采集、任务、情报、灵感、图谱、日程、Agent 都集中在 `AethericShellView.ts`。该文件同时承担路由、DOM 构造、快捷键、模块状态和业务调用，已经出现三个直接后果：

- 页面容器容易跨模块残留或重复嵌套；
- 快捷键与交互规则散落，难以发现冲突，也无法稳定迁移为模板；
- 修改一个模块时必须重新理解整个 Shell，视觉与状态生命周期容易互相影响。

因此需要渐进式重构，但不能一次性推倒已经验收过的采集、日程、Hermes 与 Agent 链。

## 2. 目标分层

```text
WorkbenchShell
├─ ShellFrame                 顶栏、模块栏、主区、上下文区、日志抽屉
├─ ModuleRegistry            模块元数据、排序、显隐、生命周期
├─ WorkspaceKeymap           命令 ID、默认键位、用户改键、冲突检查
├─ SurfaceRouter             当前模块与表面策略，不让导航侧栏串入其它页面
├─ modules/
│  ├─ navigation/
│  ├─ capture/
│  ├─ schedule/
│  ├─ inspiration/
│  ├─ intelligence/
│  └─ graph/
├─ services/                 索引、历史、计划账本、图片治理、Agent 会话
└─ adapters/                 Vault、蛤蟆祥、云端任务桥、外部插件
```

模块只接收明确的 `ModuleContext`，不直接控制其它模块 DOM。跨模块动作通过稳定命令 ID 调用，例如 `module.knowledge.open`、`graph.depth.note`、`capture.submit`。

## 3. 本轮已经建立的边界

- `WorkspaceKeymap.ts` 成为工作台快捷键唯一合同：固定命令 ID、默认键位、格式化、录入、匹配和冲突检查。
- `GraphModuleState.ts` 成为图谱范围与镜头的纯状态合同：安全入口、历史恢复归一化、根目录关系拦截和关系节点预算不再散落在 Shell 条件分支中。
- `GraphStaticLayout.ts` 独立承担目录地块预算、最小可读尺寸和长尾聚合；Shell 不再了解地块几何算法。
- `GraphQuery.ts` 负责预算内候选节点的局部邻接查询；关系镜头不再为 48–160 个节点遍历全 Vault 的 `resolvedLinks`，候选文件的修改时间排序也由索引服务缓存并在文件变化时失效。
- 模块快捷键与模块视觉排序解耦；拖动左栏不会破坏肌肉记忆。
- 图谱内部快捷键只在图谱模块生效；输入框、Modal、Copilot 嵌入区不会被劫持。
- 地图视觉容器收束为一个 Shell 面板；SVG 不再绘制第二个“工作域容器”。
- 展开轨摆脱原生 `range`，使用自有指针/键盘合同，避免主题污染和过小命中区。

全局模块默认键位冻结为左手单修饰键 `Alt + QWE / ASD / ZXC` 九宫格；图谱内部 A/D 与悬停 Q/W/E/R 由作用域守卫隔离，输入框、Modal 和 Copilot 不会被劫持。`scratch/test-workspace-keymap.mjs` 已进入完整 `npm test`，验证默认键位、迁移、作用域和输入表面豁免。

关系探索已从不受节点预算严格约束的 Obsidian 原生 Graph 嵌入切换到封装的二流小说家运行时：默认 48 节点，按 32 递增，硬上限 160；点击节点可以收束为真实一跳关系。官方全库 Graph 仍作为“更多”菜单中的独立对照入口。

关系运行时现在支持 `updateData()`：预算扩展与同一范围的索引刷新复用既有 React Root、SVG 宿主、镜头和已稳定节点坐标；只有退出模块或进入空镜头才销毁。平滑视口不再常驻 60 FPS 循环，只在缩放、适配或重置动画尚未收敛时续帧，静止后完全停止 RAF。

当前阶段定义为“架构 v2 第一阶段已打包”：这些接缝已经进入生产插件，但 AethericShellView.ts 的 Graph、Schedule 与 Capture renderer 尚未抽离，不能描述为底层全面重构完成。

## 4. 渐进迁移顺序

1. **GraphModule**：先抽离目录地图、关系探索、深度轨、投放台与右侧上下文；纯状态和静态布局已经迁出，下一步迁出 DOM renderer 与右侧上下文控制器。
2. **ScheduleModule**：把时间轴手势、卡片编辑与日程快捷键移出 Shell。
3. **CaptureModule**：统一采集页面状态机和异步回执，杜绝切页后旧请求回写。
4. **ModuleRegistry**：由注册表生成左栏、命令面板和模板功能开关。
5. **Design Tokens**：统一按钮、卡片、滚动条、键帽、空状态、加载反馈，不允许模块私造一套视觉层。
6. **Template Ports**：把 Vault、采集器、Agent、计划账本定义成可替换接口，外部用户只实现适配器，不修改核心页面。

每一步均保持旧入口可回退，并以构建、契约测试和 Obsidian 实机截图为验收门；在模块完全迁移前不删除旧路径。

## 5. 模板化时必须冻结的合同

- `ModuleDescriptor`：ID、名称、图标、默认排序、是否可隐藏、能力依赖。
- `WorkbenchCommand`：稳定命令 ID、作用域、默认快捷键、冲突策略、执行函数。
- `ModuleSurface`：主面板、上下文面板、滚动所有权、最小尺寸、窄屏策略。
- `DataPort`：只读查询、可写动作、状态回执、错误语义与取消机制。
- `ThemeToken`：颜色、间距、圆角、阴影、动效、滚动条和键帽。

## 6. 风险与回滚

- 最大风险不是代码量，而是旧模块依赖 Shell 私有字段。迁移时先增加接口，再替换调用，最后删除旧字段。
- 禁止把所有模块同时改成新框架；一次只迁一个模块并保留旧渲染器回退开关。
- 数据服务和 Vault 写入协议不因 UI 重构而改变，避免视觉工程影响采集与笔记安全。
