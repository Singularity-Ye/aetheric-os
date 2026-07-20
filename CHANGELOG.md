---
title: AOS-08 版本更新日志与 Agent 交接
aliases:
  - 松果天工台更新日志
  - Aetheric OS Changelog
tags:
  - Aetheric-OS
  - 更新日志
  - Agent交接
status: active
date: 2026-07-19
---

# AOS-08 版本更新日志与 Agent 交接

> 这里记录已经落地并通过验证的改动。后来接手的 Agent，先看这一页，再看对应专题文档和源码差异。

## v1.3.2 · 侧栏常驻与关系索引重构（2026-07-19）

### 这版解决了什么

此前从天工台打开原生笔记时，`main.ts` 的叶子事件和 `AethericShellView.openNode()` 会同时折叠、展开侧栏并创建蒙版。Claudian、目录和大纲因此反复参与布局切换，界面虽然有蒙版遮挡，底层仍在抖。

知识列表还有另一处更隐蔽的热点：每显示一篇笔记的反链数量，都要遍历全库的 `resolvedLinks`。显示 N 篇笔记时，关系计数整体接近 O(N²)。当前 Vault 已有约 2,600 个节点，这部分会直接占用主线程。

### 已落地

- 新增 `src/aetheric/LayoutCoordinator.ts`，统一接管 Shell、Markdown 和其它原生视图之间的过渡事务。
- 工作台模式不再真正 `collapse()` 左右侧栏；Claudian、目录、大纲继续挂载，只通过零宽、透明和禁止点击进行视觉收起。
- 打开笔记时由协调器恢复原生界面与右侧栏；`openNode()` 只负责打开文件，不再和叶子事件争抢布局控制权。
- 页面蒙版移除全屏 `backdrop-filter: blur(8px)`，并在 `openFile()` 完成和连续两帧绘制后退出，不再依赖固定 180ms 猜测加载时间。
- `VaultIndexService` 一次构建出链表、反链表和未解析链接计数。单篇关系数量查询由 O(N) 降为平均 O(1)，完整列表由接近 O(N²) 降为约 O(N + E)。
- 当前文件图谱的反向邻居也直接读取缓存，不再为每个节点重新遍历全库链接。
- Vault 与 MetadataCache 在同一帧内发生的多次通知会合并，减少导航、上下文和图谱的重复重绘。
- 保留原生 Hover Preview 的“滑入阅读、滑出关闭”交互，没有加入固定按钮或额外点击步骤。
- 工造中枢已接入“导出知识镜像”，输出允许域到 `hamaxiang-system/data/knowledge/export`，默认不联网、不自动 Git 推送。

### 真实体验反馈

实机重载后，工作台与原生笔记之间的切换由明显的布局跳变变为连续过渡。用户反馈“切换竟然如此丝滑”，说明本轮优化命中了真实主线程与布局热点，而不是单纯调整动画观感。

### 验证记录

```powershell
cd D:\Yhx06\Documents\仙术工坊——项目集\obsidian-scriptorium
npm run build
npm test
node --check "C:\Users\Yhx06\Documents\Obsidian Vault\.obsidian\plugins\obsidian-scriptorium\main.js"
```

- TypeScript 检查与生产构建通过，v1.3.2 已部署至 Obsidian 插件目录。
- 部署版 `main.js` 语法检查通过。
- WorkerControlAdapter 6 项生产契约测试全部通过。
- `git diff --check` 通过。

### 风险与手动验收

- 侧栏常驻依赖 Obsidian Desktop 当前的 `.workspace-split.mod-left-split / mod-right-split` DOM 结构；Obsidian 大版本升级后需要回归。
- 进入 Claudian 写一段内容，再执行“笔记 → 天工台 → 笔记”，确认输入、滚动位置和活动面板保持。
- 快速切换多个笔记与天工台，确认没有蒙版残留或右侧栏消失。
- 抽查几篇笔记的关联数量，与 Obsidian 原生反链结果对照。

### 下一任 Agent 优先接力

1. 将索引事件改成携带 `path + changeType` 的局部失效通知，避免一次修改重画导航、主区和上下文。
2. HamasxiangAdapter 排除 `checkedAt` 后做语义比较，只有任务、在线状态、情报或日志真正变化时才通知页面。
3. VirtualFileList 使用 `requestAnimationFrame` 合并滚动事件，并复用可见行 DOM。
4. 为 Markdown 预览增加 `path + mtime` 缓存和过期渲染事务取消。

## v1.3.1 · 基础工作台与 Phase 4/5 收口（2026-07-14）

- 常驻 Aetheric Shell、工作域导航、虚拟列表、节点上下文和原生 Markdown 打开完成。
- Daemon `/health`、`/tasks`、`/artifacts`、`/intelligence`、`/logs` 接入真实页面。
- 当前文件、目录、工作域、标签和全库图谱完成实机验收。
- Claudian 嵌入、鼠标侧键历史、统一日志坞站和安全原生界面恢复可用。
- 详细阶段证据见 Obsidian：`[[AOS-06_基础工作台阶段验收与稳定化路线]]`。

## 交接规矩

以后每次版本更新至少写清楚五件事：

1. 用户真正感受到的问题。
2. 架构上为什么发生。
3. 改动文件和不可破坏的边界。
4. 自动验证命令与实机验收结果。
5. 已知风险和下一位 Agent 的接力入口。

只写“优化性能、修复若干问题”不算更新日志；没有通过的能力也不能提前写成已完成。
