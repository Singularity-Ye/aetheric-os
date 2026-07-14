# 松果天工台 · Aetheric OS 首轮实施记录

> 版本：1.3.1  
> 日期：2026-07-13  
> 范围：Phase 0 源码收口、Phase 1 常驻 Shell、Phase 2 工作域导航 MVP

## 1. 本轮结果

Aetheric OS 已从“松果阁大号 Dashboard”升级为 Obsidian 内的常驻工作壳。第一轮不复制爬虫或 Agent 后端，而是先把工作区、导航、知识节点上下文和统一日志的承载层做实。

已完成：

- 保留插件 ID `obsidian-scriptorium`，显示名升级为“松果天工台 · Aetheric OS”。
- 建立独立 `AethericStore`、`VaultIndexService`、`LogBus` 与 `NativeUiService`。
- 默认隐藏原生 Ribbon、左右侧栏；保留 Obsidian Vault、Workspace、MarkdownView 和 MetadataCache 能力。
- 提供“安全恢复 Obsidian 原生界面”和“重新启用 Aetheric OS 统一外壳”命令。
- 建立 52px 模式导航轨、顶部 Command Center、工作域导航器、中央页面、节点上下文和底部日志坞站。
- 采用“工作域 → 项目/能力 → 知识节点 → 上下文”的导航顺序；完整物理目录只按需展开。
- 建立轻量 Vault 增量索引，监听新增、修改、删除、重命名和 MetadataCache 更新。
- 文件列表采用固定行高虚拟化，避免一次向 DOM 填入整个 Vault。
- 节点上下文分为“概览 / 关联 / Agent / 预览”；没有真实 Agent 历史时明确显示为空，不制造数据。
- 正式编辑继续交给 Obsidian 原生 MarkdownView。
- 旧松果阁工具保留独立入口；旧日志补上暂停跟随、新日志计数和最大化。
- 构建时自动合并 6 份样式源，源码成为唯一真源，不再手工维护 Vault 内部署样式。

## 2. 关键源码

```text
src/
├─ main.ts                         插件生命周期、命令、视图和安全恢复
├─ settings.ts                     设置迁移与持久化
├─ aetheric/
│  ├─ AethericShellView.ts         常驻 Shell 与各页面
│  ├─ AethericStore.ts             统一界面状态
│  ├─ VaultIndexService.ts         Vault/MetadataCache 轻量索引
│  ├─ VirtualFileList.ts           虚拟化知识节点列表
│  ├─ LogBus.ts                    统一日志总线
│  ├─ LogDock.ts                   日志搜索、筛选、跟随、拖拽与最大化
│  ├─ NativeUiService.ts           原生 UI 覆盖开关
│  └─ types.ts                     工作域与 Shell 数据契约
└─ styles/
   ├─ tokens.css                   统一视觉令牌
   ├─ shell.css                    顶栏、模式轨、总览和响应式布局
   ├─ navigator.css                工作域、文件列表与节点上下文
   ├─ log-dock.css                 新旧日志体验
   └─ native-overrides.css         可撤销的原生 Obsidian 外观覆盖
```

## 3. 数据真实性边界

当前总览只显示从 Vault 真实计算的数据：

- 知识节点数量和体积
- 当日修改数量
- 最近 52 周知识活动热力图
- 文件扩展名来源分布
- 最近打开节点
- MetadataCache 的出链、反链与未解析链接数量

以下能力仍显示为规划状态，不伪装成已接通：

- 蛤蟆祥 Daemon/Worker 实时任务总线
- Agent 执行历史与审批
- MarkdownRenderer 只读预览
- 五级作用域动态图谱
- 采集、任务和情报的正式 Adapter 页面

## 4. 构建与部署

唯一源码目录：

`D:\Yhx06\Documents\仙术工坊——项目集\obsidian-scriptorium`

部署目录：

`C:\Users\Yhx06\Documents\Obsidian Vault\.obsidian\plugins\obsidian-scriptorium`

构建命令：

```powershell
npm run build
```

该命令会执行 TypeScript 类型检查、esbuild 打包，并将 `manifest.json` 与合并后的 `styles.css` 部署到 Vault 插件目录。

## 5. 回滚与安全恢复

代码级回滚基线：

`_baseline/2026-07-13-pre-aetheric`

界面级灭火器：

- 命令面板执行“安全恢复 Obsidian 原生界面”。
- 或在插件设置点击“安全恢复”。
- 插件卸载或禁用时会主动移除 `aetheric-os-shell-active`。

原生覆盖规则只存在于 `src/styles/native-overrides.css`。删除该 body class 即可恢复原生 Ribbon 和侧栏，不会禁用文件、编辑器、图谱或其他插件能力。

## 6. 验收路径

1. 在 Obsidian 中重新加载社区插件，或重启 Obsidian。
2. 打开命令面板并运行“打开松果天工台 · Aetheric OS”。
3. 切换“蛤蟆祥系统 / 松果屋博客 / 课程知识库”工作域。
4. 在导航页测试当前文件夹、当前工作域和全库搜索。
5. 单击节点查看四个上下文页签；双击或点击“打开笔记”进入原生 MarkdownView。
6. 展开物理目录，测试新增、重命名、移动文件后的列表更新。
7. 在日志中测试搜索、级别筛选、暂停跟随、新日志计数、拖拽高度与最大化。
8. 执行“安全恢复 Obsidian 原生界面”，确认 Ribbon 和左右侧栏恢复；再执行“重新启用 Aetheric OS 统一外壳”。

## 7. 后续深化

- 节点关联页从“计数”升级为可点击的反链、出链和相关节点列表。
- 把蛤蟆祥 Daemon 的真实任务明细统一为 `TaskSnapshot`；没有任务明细前不推测步骤。
- 接入松果屋发布 Adapter，并保持后台构建逻辑单一来源。
- Command Center 接入 Obsidian 公共命令和经过登记的 Skill。
- 动态图谱在当前 MVP 上继续增加力导向布局、节点类型过滤、缩放和平移。

## 8. v1.3.0 交互修缮与第二阶段增量

根据首轮真实截图完成：

- 修复虚拟文件行缺少独立纵向定位导致的标题、标签和时间重叠。
- 底部日志改为默认收起的抽屉；支持展开、收起、拖拽、最大化和暂停跟随。
- Aetheric 外壳启用时隐藏 Obsidian 状态栏，释放底部视野；安全恢复时一并恢复。
- 修复窄工作域栏仍渲染完整卡片造成的竖排文字遮挡。
- 顶部按钮改为“恢复原生界面 / 隐藏原生界面”双向切换。
- 节点“预览”页签接入 Obsidian `MarkdownRenderer`，渲染真实 Markdown 正文。
- Command Center 增加真实 Vault 搜索结果浮层、命令建议和工作域切换。
- “采集”与“任务”页面接入蛤蟆祥 Daemon 的 `GET /health`，并提供显式点击触发的 `POST /x-watch/run`。
- “知识库”页面加入基于 `MetadataCache.resolvedLinks` 的五级作用域动态图谱 MVP。

本轮实测时本地 `127.0.0.1:8765` 离线，因此 Adapter 会诚实显示“本地炉火离线”；启动 Daemon 后会自动每 15 秒刷新真实状态。

### v1.3.1 收藏交互热修复

- 收藏按钮拦截 `pointerdown`、`click` 和 `dblclick`，不再把双击冒泡给知识节点行。
- 节点行在事件目标属于按钮时不会执行选择或打开笔记。
- 收藏操作不再立即重建虚拟列表，保持当前页面、筛选结果和滚动位置不变。

### v1.3.2 动态知识图谱 WebGL 级联过滤与防卡死优化 (Phase 5.1)

- **多级原生 WebGL 图谱路由**：
  - `当前文件`：调用官方轻量局部图谱 `localgraph`，避免全库开销。
  - `当前目录 / 当前工作域 / 当前标签 / 全库`：重构以接入官方 `graph` 视图，保证 WebGL 高性能渲染排版。
- **高性能实例复用与防卡死 (Instance Reuse)**：
  - 彻底解决由于 `setState` 重载造成的全局图谱卡死问题。在复用 `"graph"` 视图类型时，**完全绕过官方 `setState` 接口**，避免其在主线程重新拉取并重构全库数千个节点连接导致的主线程冻结。
  - 仅静默修改局部选项，并在 50ms 延迟消抖后执行 `engine.onOptionsChange()`，实现 WebGL Worker 线程内的异步秒级重绘，切换帧率保持 60fps。
- **“受控模式”零污染筛选**：
  - 弃用不受控的 DOM 定时器输入与回车事件模拟，根除了随机弹出的检索下拉建议框，UI 极度干净。
  - 移除了调试文件 `graph_state_debug.txt` 的写入逻辑，切断了 `写文件 -> 索引变动 -> 重绘` 导致主界面无限重绘卡死的死循环。
  - 不修改官方全局插件配置，不保存全局 settings，绝不污染用户官方全局大图配置。
- **检索逻辑闭环**：
  - `当前目录`：精确生成 `path:"..."` 查询，节点收敛。
  - `当前工作域`：精确生成对应工作域路径组合的多 path 查询（如博德之门3工作域）。
  - `当前标签`：根据当前选中笔记的 tags 列表动态生成 `tag:#tag1 OR tag:#tag2` 关联图谱；若无 tags 则自动禁用并提示，防止空检索导致意外全库加载。

### Phase 4 Adapter 真实数据管道补完

- Daemon 新增只读 `/tasks`、`/artifacts`、`/intelligence` 和增量 `/logs` 端点。
- `HamasxiangAdapter` 现在消费真实任务、最近产物、X Watch 分类结果和结构化 Daemon 日志。
- 采集页展示真实任务与最近产物；任务页不再把健康状态冒充完整任务队列。
- 情报页已替换占位内容，读取 `data/intel/results` 的真实分类结果。
- Daemon 日志通过 cursor 增量汇入统一 `LogBus`；不读取终端 DOM，不轮询 Vault 文件。
- 能力卡片已按现有真实入口路由；没有执行器的角色 BD、剧情路线和课程导入保持诚实提示。
- 后端契约测试位于 `hamaxiang-system/test_phase4_api.py`，视觉交接边界见 `PHASE4_ADAPTER_HANDOFF.md`。

### v1.3.3 节点快捷键、Claudian 上下文与鉴权收口

- 新增 Obsidian 命令“复制当前节点的 Vault 相对路径”，默认快捷键为 `Ctrl+Shift+C`；复制对象是天工台当前选中的节点，不依赖顶部原生 Markdown 标签页。
- 快捷键在输入框、可编辑区域和 Claudian 嵌入终端聚焦时自动让行，避免抢占正常复制与终端按键。
- 鼠标侧键 3/4 继续负责天工台历史后退/前进，但在 Claudian 嵌入区域内不拦截跨插件事件。
- Claudian 上下文改为只调用其活动标签页的 `FileContextManager.setCurrentNote()`；不再伪造全局 `file-open` 事件污染其它插件的最近记录或生命周期。
- X Watch 写操作的 Bearer Token 已从 TypeScript 源码移除，改由插件设置中的密码框读取；值仅保存在本机插件 `data.json`，不会进入源代码。
- 已进入 Git 历史的旧 Token 必须在 Daemon/Worker 端轮换；新提交只能移除当前版本，不能抹除已公开的历史。

验收：重载插件后，在设置中填写与 `HAMAXIANG_DAEMON_TOKEN` 一致的新值；单击任意节点后按 `Ctrl+Shift+C`，粘贴结果应为该节点的 Vault 相对路径。进入 Agent 页时，Claudian 当前笔记胶囊应切换为该节点，且不改变 Obsidian 顶部活动笔记。
