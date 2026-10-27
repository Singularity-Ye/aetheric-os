# 松果天工台 · 总图改装方案

> 状态：引擎改装第一阶段已完成；Aetheric Shell 已接入语义总览与收件箱地图 MVP，正式 UI 肉眼验收仍待完成。

## 0. 结论先行

二流小说家的关系图谱可以复用，但不能把 `World Lab` 的业务壳整块搬到松果天工台。可复用的是 `@erliu/force-graph` 的渲染与布局内核；AOS 需要自己的数据适配层、分层投影和导航行为。

总图也不应该等同于“全库所有笔记的关系网”。它是一个虚拟导航索引：原始 Markdown、双链和收件箱路径不搬家，图上的聚合节点只保存成员 ID/路径，点击后再展开下一层。

## 1. 三层地图

```mermaid
flowchart LR
    vault[Vault 原始笔记与双链] --> overview[总图 · 8—12 个入口]
    overview --> moc[MOC/项目层 · 24—48 个主题]
    moc --> focus[聚焦层 · 选中节点一跳/两跳]
    focus --> note[打开原始笔记或派生笔记]
```

| 层级 | 节点代表什么 | 默认预算 | 交互 |
| --- | --- | ---: | --- |
| 总图 | 收件箱、灵感轨、知识库、生活库、项目、情报雷达、归档等虚拟入口 | 12 组 / 240 条聚合边 | 点击进入对应 MOC |
| MOC | 项目、主题、工作域或灵感轨中的主题节点 | 48 组 / 320 条聚合边 | 点击进入聚焦层 |
| 聚焦 | 选中节点的 1—2 跳邻域 | 120 节点 / 240 条边 | 打开来源、展开、投喂 Agent |

“节点多了变卡”在这里被拆开处理：不是强行让一个画布承载更多 DOM，而是只在用户需要时加载更细的关系。

## 2. 已改装的通用包

位置：`a-second-rate-novelist/packages/force-graph/`

- `graph-aggregation.ts`：`aggregateGraph`、`buildOverviewGraph`、`buildMocGraph`、`buildFocusGraph`。
- `graph-stability.ts`：可见渲染数据签名，避免业务层每次创建新数组就重建仿真。
- `force-graph-svg.tsx`：仿真 tick 合并到一帧，稠密 SVG 默认暂不布局所有边标签，选中节点时按需恢复。
- `force-graph-sigma.tsx`：使用可见数据签名，避免无变化的 Sigma 拓扑重复刷新。
- `force-engine.ts`：大图使用 Barnes–Hut 斜率与距离上限，节点较多时自动降低碰撞迭代次数。

聚合节点的 metadata 会保留：`groupKey`、`memberIds`、`memberCount`、`representativeId`、`internalEdgeCount`。因此它是索引投影，不会丢失“点开后去哪儿”的依据。

## 3. AOS 接入边界

Scriptorium 目前仍有原生 Graph/Local Graph 嵌入和 SVG fallback；`VaultIndexService.getGraphData` 默认只取有限候选，不能直接把它当成总图的全量数据源。正式接线分两步，目前第一步已完成：

1. [x] 先从收件箱索引、frontmatter 和工作域配置生成 AOS 图节点，保留原始路径与来源证据。
2. [ ] 再将节点按 `area`、项目根或 MOC 规则送入共享聚合投影；只有用户点击后才拉取具体笔记关系。

原始文件仍归收件箱/项目目录管理，图谱只读展示并导航，不自动移动、复制或改写笔记。

## 4. 性能验收口径

当前已通过通用包单元测试（25 项）。浏览器肉眼验收仍需在真实工作台完成，重点观察：

- 总图首次打开是否保持可交互；
- 点击聚合节点是否只加载下一层，而不是瞬间展开全库；
- 拖拽/缩放时是否隐藏弱边与标签；
- 关闭图谱后 Obsidian 主界面是否无残留 canvas 或事件监听。

尚未宣称真实 Vault 全库图谱已经上线，也没有把二流小说家的业务颜色和详情侧栏直接复制进 AOS。

## 5. 2026-07-29 · 默认镜头改为可读语义地图

- 当前真实状态：已实现并部署。`AethericShellView` 的工作台、目录、标签与全库镜头默认使用 `buildWorkspaceSemanticGraph`，先渲染“工作域 → 主题入口”，不再把每个 Markdown 标题直接铺满画布；`current-file` 仍保留原生局部图，官方全局图谱改为明确的“对照”入口。
- 可见性规则由 `GraphVisibilityPolicy` 统一提供，并由所有语义图作用域消费；它不是二流小说家的特例。物理目录和搜索仍保留全部文件，隐藏只发生在主地图投影。
- 交互契约：`语义总览` 只负责发现入口；点击主题入口或“展开笔记”才进入有限的聚焦镜头，聚焦镜头最多展示 28 条笔记并保留列表精确打开原文。地图不搬移、不改写原始文件。
- 噪声治理：默认只把 Markdown 笔记纳入主镜头；`.git`、`.obsidian`、`.codex`、`.agents`、`node_modules`、`.staging`、`.tmp`、`tmp`、`output`、`outputs`、图片/二进制资产、缓存目录及 Codex 会话附件命名默认不进入主镜头，但仍可通过索引/搜索定位。
- 验收证据：`npm run build` 通过并同步正式插件目录；外部 `npm test` 通过 Worker 6/6、Agent Dock 13/13、Layout 10/10、Copilot 11/11、Navigation History 24/24。当前仍待用户重载 Obsidian 肉眼验收，不宣称视觉体验已最终完成。
- 风险与回滚：本轮没有移动、删除或改写 Vault 笔记；回滚可恢复 `AethericShellView.ts` 的语义镜头分流、`InboxGraphAdapter.ts` 的聚合适配器与 `shell.css` 的镜头样式，再重新构建。官方原生全局图谱仍可作为比较基准。
