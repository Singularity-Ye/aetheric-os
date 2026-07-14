# Phase 4 Adapter 数据管道交接

## 当前结果

Phase 4 已从占位页升级为真实只读数据管道。Aetheric OS 不复制蛤蟆祥的爬虫、ASR、Worker 或 X Watch 业务，只消费本地 Daemon 的稳定 HTTP 快照。

```text
hamaxiang_daemon.py
  ├─ GET /health
  ├─ GET /tasks
  ├─ GET /artifacts
  ├─ GET /intelligence
  └─ GET /logs?after=<cursor>
          ↓
HamasxiangAdapter
  ├─ getSnapshot()
  ├─ getTasks()
  ├─ getArtifacts()
  └─ getIntelligence()
          ↓
采集 / 任务 / 情报 / 日志 / 能力卡片
```

## 数据真实性边界

- 任务来自 Daemon 当前进程内的真实 `JOBS` 与 X Watch 状态。
- 情报来自 `data/intel/results/*.json`，并与 `data/intel/normalized/x/*.json` 合并。
- 产物由完成/失败的采集任务和最近情报结果组成。
- 日志是 Daemon 本次生命周期内的 500 条结构化环形缓冲，按 cursor 增量进入 Aetheric `LogBus`。
- Daemon 附属端点单独降级；某个列表失败不会把 `/health` 正常的炉火判成离线。
- Daemon 离线时清空瞬时任务，但保留最近一次成功的情报与产物快照。

当前后端没有 CPU、内存、审批、Agent 步骤或完整终端 stdout 契约。视觉层不得伪造这些数据；需要时先扩展 Daemon 契约。

## 页面与样式挂点

- 采集页：`.aos-hamasxiang-page`、`.aos-artifact-list`、`.aos-artifact-row`
- 任务页：`.aos-task-list`、`.aos-task-row`、`.aos-task-progress-track`
- 情报页：`.aos-intelligence-page`、`.aos-intelligence-list`、`.aos-intelligence-row`、`.is-relevant`
- 日志页继续复用 `.aos-task-list`，底部实时日志仍由 `LogDock` 负责。

反重力可以调整 DOM 分组和 CSS，但不要改动以下行为：

1. 不读取原控制台 DOM。
2. 不在前端重新运行爬虫或 Python 子进程。
3. 不把缺失字段补成 Mock 数据。
4. 不改变日志 cursor、附属端点独立降级和 15 秒刷新节奏。
5. 不修改已冻结的图谱筛选链路。

## 能力卡片路由

- X Watch → 情报页。
- 云端同步 / ASR 修复 → 原蛤蟆祥控制台。
- 博客发布 → 松果阁旧工具。
- 知识健康 → 知识库图谱。
- 课程导入、角色 BD、剧情路线尚无执行器：进入对应导航上下文并明确提示，不生成假结果。

## 验证命令

```powershell
cd D:\Yhx06\Documents\仙术工坊——项目集\hamaxiang-system
python -m py_compile hamaxiang_daemon.py test_phase4_api.py
python -m unittest -v test_phase4_api.py

cd D:\Yhx06\Documents\仙术工坊——项目集\obsidian-scriptorium
npm run build
node --check "C:\Users\Yhx06\Documents\Obsidian Vault\.obsidian\plugins\obsidian-scriptorium\main.js"
```

修改 Daemon 后必须重启炉火；修改插件后必须重载 Scriptorium。
