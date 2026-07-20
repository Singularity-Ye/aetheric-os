# 蛤蟆祥工造司融合与重置方案 (Revised Implementation Plan)

本方案详述了如何将旧 `hamasxiang-console` 插件的功能与状态管理重构并入 `obsidian-scriptorium`（松果天工台）的“采集”栏目中，并在设计与性能上进行系统性重置。

---

## 1. 架构改造与分域服务

为避免 `main.ts` 成为臃肿的巨石代码，我们将所有业务逻辑解耦，放置在 `src/aetheric/operations/` 目录下：

* **`ProcessRegistry.ts` [NEW]**：统一进程注册表。
  * 强制设置 `{ shell: false }`，对执行命令与参数执行严格的白名单校验，杜绝注入攻击。
  * 记录每个进程的 PID、启动时间、任务类型（`sync`、`repair`、`git`、`preview`、`daemon`）及所有权。
  * 实现同类型任务的进程互斥（例如，同时只能运行一个 `repair` 任务）。
  * 完善 Windows 下的安全杀进程逻辑：通过 `taskkill /F /T /PID` 树状关闭主进程及所有衍生子进程，避免残留孤儿进程。
  * 当用户关闭 Aetheric OS 视图时，**不终止**后台任务；当插件卸载时，非危险（如 `preview`）进程可在二次确认后保持运行。
* **`HamasxiangOperationsService.ts` [NEW]**：仙术指令调度中心。
  * 封装云端同步、各类深度修复（全局/平台定向）、隔离、还原等指令调用。
  * 管理当前任务队列 of the UI 状态。
* **`AnalyticsService.ts` [NEW]**：增量数据统计引擎。
  * 摒弃任何主动的文件爬网。订阅 `VaultIndexService`，在其就绪后从内存缓存中获取数据。
  * **增量监听**：在首次加载时使用 `requestAnimationFrame` 分批分块（Yield）计算分布与 30 天归流图，避免一次性卡死主线程。后续只响应 `create`、`modify`、`delete`、`rename` 及 `metadataCache` 触发的增量变更。
  * **按需计算**：工造司视图未激活时，绝不生成 SVG 节点、不计算指标或创建相关 DOM 节点。
* **`WorkerControlAdapter.ts` [NEW]**：收集箱 Worker 交互适配器。
  * 管理去重锁（GET/POST `/toggle-dedup`），实施 Token 校验、防抖拦截与异常回退。
  * 绝不在日志或控制台输出中泄露 Bearer Token 等敏感凭证。
* **`ProgressParser.ts` [NEW]**：结构化进度解析器。
  * 优先解析 Python 端输出的结构化 JSONL（例如：`{"event":"progress","current":12,"total":50,"stage":"repair"}`）。
  * 兼容解析传统的 `12/50` 文本格式作为后备。

---

## 2. 🛡️ 稳健安全的 Git 备份工作流

严禁使用盲目的 `git add .`。Git 备份将重构为多阶段显式流转：
1. **状态检查**：调用 `git status --porcelain` 检查工作区状态。
2. **过滤审查**：扫描即将暂存的文件，如果检测到 `.env`、敏感 Token、大型未注册二进制资产或测试临时文件夹，立即弹出警告。
3. **确认面板**：向用户展示待提交列表，并由用户进行二次确认。
4. **异常分支保护**：如果检测到冲突（Conflict）、未关联的分支（detached HEAD）或正在进行的 rebase，一律阻止提交。
5. **解除捆绑**：将 `git pull --rebase` 与 `git push` 作为高级同步指令与普通备份按钮解耦，防止因网络阻塞导致卡死备份状态。

---

## 3. 🎨 视觉风格：松烟蓝图工造局 (Pine Ink & Blueprint Works)

在保持“青玉金线”基本美学的前提下，为工造司引入专属的“松烟蓝图”变体，提供明确的换场感与专业感：
* **55% 象牙纸与松烟墨**（#fbfaf7 / #1c2826 / #07100e）：作为背景底色和主要文本颜色，字迹如松烟墨落于熟宣。
* **20% 青玉绿**（#dfedde / #28583a）：用作系统在线状态标识、激活页签、操作成功反馈。
* **15% 蓝图青**（#0369a1 / #155e75）：绘制精密的分析图表、SVG 数据折线、数据流动参数指示。
* **10% 旧黄铜**（#c58b2b）：作为细边框、刻度线、页签选中短线及卡片编号铭牌。
* **严禁滥用 Emoji**：除了品牌专属的 “🐸 蛤蟆祥” 之外，其余所有图标完全替换为 Lucide 线性高精图标。
* **动效克制**：动效仅用于真实进程流转、网络连通和进度条填充，消除无意义的旋转与闪烁。

---

## 4. 拟议文件变更

### [NEW] [ProcessRegistry.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/operations/ProcessRegistry.ts)
### [NEW] [HamasxiangOperationsService.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/operations/HamasxiangOperationsService.ts)
### [NEW] [AnalyticsService.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/operations/AnalyticsService.ts)
### [NEW] [WorkerControlAdapter.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/operations/WorkerControlAdapter.ts)
### [NEW] [ProgressParser.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/operations/ProgressParser.ts)

### [MODIFY] [AethericShellView.ts](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/aetheric/AethericShellView.ts)
* 渲染“采集舱”下的“工造中枢”与“卷宗分析”两个新增页签。
* 样式适配“松烟蓝图”底色及黄铜刻度。

### [MODIFY] [shell.css](file:///d:/Yhx06/Documents/仙术工坊——项目集/obsidian-scriptorium/src/styles/shell.css)
* 增加 `.blueprint-view` 的数据色谱和蓝图背景网格（1px 的细淡蓝网格背景）。

---

## 5. 验证与测试计划

### 5.1 自动化测试
* 编写 mock 契约测试验证 `WorkerControlAdapter`：
  * 确保请求头正确附带 `Bearer Token`，日志中无 Token 输出。
  * 模拟 500 网络异常，测试 UI 状态自动回滚。
  * 模拟并发点击，测试防抖机制。
* 编写测试确保 `ProgressParser` 对 JSONL 进度与传统 `X/Y` 格式的安全解析。

### 5.2 手动集成测试
1. **进程隔离测试**：在工造中枢启动 `npm run dev`，关闭 Aetheric OS，重新打开天工台，检查是否成功连接到该 PID，并能通过“⏹️ 终止”按钮正常销毁。
2. **性能与卡顿测试**：监控首次进入“卷宗分析”页签时的 UI 线程开销，对比旧版，并输出 `console.time` 计算耗时以数字说话。
3. **安全 Git 测试**：修改 `.env` 并尝试提交，确认系统拦截并报错；点击普通备份按钮，验证冲突下的强力阻断。
