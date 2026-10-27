# Aetheric OS · 松果天工台

Aetheric OS is an Obsidian-based personal knowledge and agent operations workspace. It combines workspace-first Vault navigation, knowledge context, scoped relationship graphs, task and log observability, and adapters for existing automation systems in one persistent shell.

## Current capabilities

- Persistent Aetheric shell with safe restoration of the native Obsidian UI
- Workspace-first navigation, virtualized file lists, recent items, and favorites
- Knowledge-node metadata, backlinks, outgoing links, and Markdown preview
- Five graph scopes backed by `MetadataCache`, with an embedded native local graph
- Command Center for Vault search, commands, and workspace switching
- 灵感轨按分区展示收件箱卡片，并只读呈现 EvidencePacket 的封面/媒体引用（若来源已写入）
- 收件箱遵循 `aos-capture/v1` 生命周期契约；目录保留原始证据，灵感轨/日程通过 frontmatter 虚拟索引（见 [CAPTURE_LIFECYCLE_CONTRACT.md](./CAPTURE_LIFECYCLE_CONTRACT.md)）
- 总图改装方案已独立记录：先用聚合入口导航，再按需展开 MOC/聚焦关系（见 [AETHERIC_GRAPH_MAP_DESIGN.md](./AETHERIC_GRAPH_MAP_DESIGN.md)）
- 收件箱关系地图沿用二流小说家式三层语义模板，但由全宽自由力场运行时渲染：区域 → 来源簇 → 主题簇/笔记卡片；支持拖拽、缩放、平移和布局缓存（见 [AOS_INBOX_GRAPH_DESIGN.md](./AOS_INBOX_GRAPH_DESIGN.md)）
- 图谱页默认提供只读语义总览：先看工作域/主题入口，点击后再展开有限笔记聚焦；收件箱镜头支持总览/聚焦、区域/平台/status/月份筛选，按目录拆分来源簇，X Watch 定时信号默认隐藏并可按需展开，点击列表或节点可打开真实笔记
- 所有语义图作用域共用 `GraphVisibilityPolicy`：机器缓存、二进制资产和 Codex 临时产物不进入主镜头；物理导航/搜索仍可定位它们
- 模板插件产品化事项暂列后置清单，先完成地炉自身体验验收（见 [PRODUCTIZATION_BACKLOG.md](./PRODUCTIZATION_BACKLOG.md)）
- Hamasxiang health/task adapter and unified live log dock

## Development

Requirements:

- Node.js 20 or newer
- Obsidian desktop

Install and build:

```powershell
npm install
npm run build
```

The build runs TypeScript validation and bundles the plugin with esbuild. By default, artifacts are copied to the local development Vault configured in `esbuild.config.mjs`. Set `OBSIDIAN_PLUGIN_DIR` in a local `.env` file to use another plugin directory.

## Source of truth

- `src/`, `styles.css`, and `src/styles/` are authoritative source files.
- The Obsidian plugin directory contains generated deployment artifacts and should not be edited directly.
- `_baseline/` is a local pre-Git recovery snapshot and is intentionally excluded from the repository.

## Status

The project is under active development. The current focus is Phase 5 graph stability and in-place scope transitions. See [walkthrough.md](./walkthrough.md) for the implementation record and current boundaries.

## License

MIT
