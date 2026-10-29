# Waxwing 第六轮深化执行记录

日期：2026-10-29

执行依据：`PLAN-WAXWING-DEEPENING-ROUND6.md`

本文件是第六轮的执行与结果文档。每完成一项，追加该项目的改动、测试证据和遗留问题；本轮结束时即为最终报告。

## 当前状态

执行中。

## 起点与基线

| 项 | 值 |
| --- | --- |
| 起点分支 | `release/deepening-round6`（从 `main` 创建） |
| 起点提交 | `a04c957`（0.2.0 发布提交，`v0.2.0` tag 已存在） |
| `waxwing/main` | `a04c957`，已包含第五轮内容 |
| JavaScript | `256/256` 通过，34 个测试文件 |
| 发布树 | `248` 个文件通过 |
| Rust | `11/11` 通过 |
| 远程 | `origin` 只读，不推送；本轮不推 `waxwing/main`、不建 tag、不发布 |

## 阶段记录

### 阶段 0：安全网

#### #16 测试与发布清单自动发现

状态：完成。

- 新增 `prototype/tests/discover.mjs`：扫描 `prototype/tests/*.test.mjs`，按文件名排序。
- `prototype/tests/run.mjs` 改为导入发现结果并打印 `Test files: N`；隔离环境变量全部交给 `isolate.mjs`，runner 只强制自己的临时数据根，避免继承的 `DSH_SUBAGENT_ROOT` 把测试带到真实数据上。
- `isolate.mjs` 统一设置 `DSH_SUBAGENT_PORT` / `DSH_PROTOTYPE_PORT = 43199`，直接运行单个测试文件也不会使用配置里的真实端口。
- `scripts/check-release-tree.mjs`：`src/**/*.mjs` 由目录发现，手写列表只保留非源码文件；新增 `discoverSourceModules`。
- `scripts/prepare-desktop-resources.mjs`：prototype 文件清单从 `package.json` `files` 展开（glob 对磁盘匹配、`!` 排除、字面量必须存在），并导出 `prototypeResourceFiles` / `prepareDesktopResources`，顶层只在直接运行时执行。
- 目标测试：`test-runner.test.mjs`（4 项）、`desktop-resources.test.mjs`（3 项）、`release-tree.test.mjs` 新增 2 项。
- 完整测试：`265/265` 通过，36 个测试文件。
- 发布树：`251` 个文件通过。
- 遗留：无。

### 阶段 1：P0 正确性缺陷

#### #1 Runtime 句柄活到 `forget`

状态：完成。

- `src/runtime/module.mjs`：`onProcessExit` 不再删除记录，只把句柄标为 `exited`；新增 `isLive(id)` / `liveIds()` 区分“活着的进程”和“尚未遗忘的句柄”。`has()`/`get()`/`ids()` 现在表示保留的句柄。
- `src/tasks/transaction.mjs`：`stop()` 在退出已确认时跳过关闭消息，直接进入投影与保存。
- `prototype/manager.mjs`：`workers` 门面拆成 `live`/`held`；视图、工作区冲突、清理、预览、授权、删除、关闭全部用 `live`；`failStart` 用 `held && !hasExited` 判断“进程可能仍在运行”；rework 的“运行时已消失”改用 `live`。
- 决定：进程意外退出后，句柄由下一次 `stop`/`close` 遗忘；启动恢复只清理 `runtime.json` 对应的残留进程，不触碰句柄表（新进程里本来就是空的）。
- 目标测试：`task-transaction.test.mjs` 新增 3 项，全部使用真实 `Runtime` + 假子进程（退出后终态保存失败 → 重试成功；正常关闭遗忘句柄；意外退出保留句柄直到 close）。`runtime-module.test.mjs` 改断言为退出后保留、`forget` 后消失。
- 完整测试：`268/268` 通过，36 个测试文件。
- 发布树：`252` 个文件通过（阶段 0 为 251，新增本执行文档时逐步增加）。
- 遗留：无。

#### #2 持久化写入工具

状态：完成。

- 新增 `src/storage/durable-file.mjs`：`atomicWriteText` / `atomicWriteJson`（唯一临时名、EPERM/EACCES/EBUSY 重试、失败清理）、`beginReplace`（写新文件、旧文件改名备份、提交或回滚）、`sha256`。文件操作可注入，默认 `node:fs`。
- 调用方改为共用实现：`prototype/common.mjs`（`atomicJson`）、`prototype/budget.mjs`（`writeRoundBudget`，去掉固定 `.new` 文件名）、`prototype/usage.mjs`（索引写入与哈希）、`src/acceptance/service.mjs`（报告替换与授权文件）、`src/research/report.mjs`、`src/research/capture.mjs`、`src/research/service.mjs`、`src/usage/execution-policy.mjs`。
- 保留原有的文件路径、JSON 缩进、报告哈希算法与输入。
- 目标测试：`durable-file.test.mjs` 6 项（重试成功、永久失败清理与原文不变、并发写只有一个完整版本且无残留临时文件、提交删除备份、回滚恢复旧内容、首次回滚删除新文件、JSON 格式）。
- 完整测试：`274/274` 通过，37 个测试文件。
- 发布树：`254` 个文件通过。
- 遗留：无。

#### #3 验收关闭报告原子提交接入生产

状态：完成。

- `src/acceptance/service.mjs`：构造时注入 `policySection(task)`，报告文本、accept/export、`writeReportAndSave` 都在模块内生成策略段；调用方不再传 `policySection`。`grant()` 先原子写授权文件，成功后才放进内存。授权恢复/删除、清单遍历、预览读取全部改走注入的 `this.files`。
- `prototype/manager.mjs`：`AcceptanceService` 注入 `executionPolicy.reportSection`，并把整个 service 交给 `TaskTransaction`（原来只传 `{revoke, report}`）。
- `src/tasks/transaction.mjs`：关闭只走 `commitFinal` 的原子分支，删除非原子路径；无 runtime 的关闭同样走原子分支。
- 目标测试：`acceptance-commit.test.mjs` 3 项——`createManager` 关闭后报告包含执行策略段且 `task.json` 哈希与报告一致；真实 `AcceptanceService` + `TaskTransaction` 的关闭保存失败会回滚报告、任务停在 `stopping` 且可重试；授权文件写入失败时授权不生效、删除被拒绝且数据保留。
- 完整测试：`277/277` 通过，38 个测试文件。
- 发布树：`255` 个文件通过。
- 遗留：无。

#### #4 文本分页只有一份实现

状态：完成。

- 新增 `src/view/page.mjs`：`DEFAULT_PAGE_LIMIT=2000`、`MAX_PAGE_LIMIT=4000`、`safeOffset`、`safePageLimit`、`pageOf`，采用 manager 的规则（越界夹到末尾、拒绝切分代理对、`limit=1` 遇到代理对明确报错、带 `complete`）。
- `prototype/manager.mjs` 删除本地实现，七个视图统一经 `taskPageView` 拼装；`src/research/report.mjs` 删除自己的一份分页，改用共享规则，因此 research collect 不再对越界 offset 抛错。
- 目标测试：`page.test.mjs` 5 项——常量；emoji 文本 limit 2/3/4 逐页翻完且拼接等于原文、`nextOffset` 严格递增；limit=1 与代理对中间 offset 明确报错；越界 offset 夹成空页；research collect 与 task status 对同一组越界/非法参数结果与错误文本一致。
- 完整测试：`282/282` 通过，39 个测试文件。
- 发布树：`257` 个文件通过。
- 遗留：无。

#### #5 Worker 每轮按任务的 Provider 建适配器

状态：完成。

- 新增 `src/providers/adapter-cache.mjs`：按 Provider 配置身份缓存适配器，Provider 变化时重建，同一 Provider 连续多轮复用同一实例；解析 `apiKeyEnv` 时先复制配置，不再修改传入的 provider 对象。
- `prototype/worker.mjs` 删除进程级 `openaiAdapter`，改用缓存模块；`createAdapter` 可注入。
- 目标测试：`provider-adapter-cache.test.mjs` 3 项——同一 Provider 复用实例且只校验一次；不同 Provider 重建且 `cache.current` 指向新实例；调用方对象不被写入解析后的密钥，换密钥会重建。
- 完整测试：`285/285` 通过，40 个测试文件。
- 发布树：`259` 个文件通过。
- 遗留：无。

#### #17 本地配置移出安装目录

状态：完成。

- `prototype/config.mjs`：新增 `resolveLocalConfigPath`，顺序为 `WAXWING_LOCAL_CONFIG` / `DSH_SUBAGENT_LOCAL_CONFIG` → `<平台数据目录>/config.local.json` → `config.json` 同目录旧文件；新位置有文件时不再读旧文件。平台数据目录只由 `WAXWING_HOME` 或系统默认值决定，不读配置里的 `root`。返回值新增 `localConfigSource`（`env`/`home`/`legacy`/`null`）。
- 相对路径按来源分层：本地文件里的 `root`、`researchRoot`、`dshRepo`、`credentialsFile`、`providersDir`、`node` 以该文件所在目录为基准；`config.json` 与环境变量保持原有基准。
- `desktop/src-tauri/src/paths.rs`：`local_config_location` 按同一顺序解析，新增 `LocalConfigSource`/`LocalConfigLocation`；`platform_data_root` 不读配置；`config_value_base` 让 `root`、`providersDir`、`node` 按来源分层解析。
- `desktop/src-tauri/src/settings.rs`：保存时读当前生效的本地文件，把其中的相对路径转成绝对路径（`node` 裸命令保持原样），写入新位置；旧文件只读、不删除。
- 目标测试：Node 5 项（共享表、新位置相对基准、旧位置基准、新文件遮蔽旧文件、显式文件独占）+ Rust 4 项（同一张共享表的本地配置路径、旧文件保存目标、迁移绝对化、裸 `node` 命令）。共享表在 `prototype/tests/fixtures/local-config-location.json`，Node 用 `loadConfiguration`、Rust 用 `local_config_location_from_parts` 各自读取。
- 完整测试：`290/290` 通过，40 个测试文件；Rust `15/15` 通过。
- 发布树：`260` 个文件通过。
- 遗留：Rust 侧没有实现 `researchRoot`/`credentialsFile` 的解析（原状），#14 会让 Rust 不再解析配置。

### 阶段 2：P1 运行时与任务写入

#### #6 Runtime 结局收进一个 Settlement Module

状态：完成。

- 新增 `src/runtime/settlement.mjs`：`RuntimeSettlement` 把终态消息、首次 fallback、启动失败、fallback 失败、停止失败、ACK 超时、`worker_busy`、缺少终态、进程错误/退出、关闭、重启恢复统一投影为同一形状 `{task, action, event, health, releaseHandle, runtime, fallback, decision, lease, error}`。
- `src/tasks/lifecycle.mjs` 新增 `fail_stop`（`stopping` → `failed`）。失败投影规则：`running` 走 `fail`，`stopping` 走 `fail_stop`，已 `failed` 再次失败只更新 `error`/`updatedAt` 并记录事件；其他状态抛 `Cannot fail task in ...`。进程退出在 `stopping`、`awaiting_review` 等期望退出的状态保持记录不变。
- `src/runtime/module.mjs`：释放/退出 gate 并回 Runtime（`settleRecordRelease` 等导出供兼容类使用）；进程错误和退出改走 Settlement 并追加 `runtime_error`/`runtime_exit` 事件。`src/runtime/supervisor.mjs` 成为委托这些 gate 的弃用类。
- `src/tasks/transaction.mjs` 直接消费 `settlement.close` 的 `releaseHandle`/`error`/`task`，不再自己判断关闭分支；`close-outcome.mjs` 删除。
- `src/runtime/lifecycle.mjs`、`src/runtime/outcome.mjs` 改为弃用兼容门面/别名（0.3.0 删除）。
- `prototype/manager.mjs` 只构造一个 `RuntimeSettlement`，同时注入 Runtime、TaskTransaction 和各 settle 回调；恢复也走同一实例。
- 目标测试：新增 `runtime-settlement.test.mjs` 16 项（失败事实 × 状态表、非法起始状态抛错、进程错误/退出、关闭三种结局、终态成功/失败、首轮 fallback、恢复五种判决与非法输入）；`task-transaction.test.mjs` 新增 1 项（关闭清理失败 → `failed`，再次 close 成功进入 `closed`）。原 `runtime-outcome`、`runtime-close-outcome`、`runtime-lifecycle` 三个测试文件迁移到共享表，覆盖场景不减少。
- 完整测试：`288/288` 通过，41 个测试文件。
- 发布树：`258` 个文件通过（`close-outcome.mjs` 删除，新增 `settlement.mjs`；三个旧测试文件合并为一个）。
- 遗留：`firstRoundFailure` 把任务失败与 fallback 决策放在同一个投影里，仍有 `fallback` 字段；#9 之后如需进一步拆分再处理。

#### #7 任务写入只有一条路径

状态：完成。

- `src/tasks/repository.mjs`：新增 `commit(task, events)`，顺序固定为“先原子保存 `task.json`，再按序号追加 `events.jsonl`”。保存失败不改索引、不追加事件；追加失败时记录已保存，错误抛出且序号已前进。每个任务一个序号计数器，`restore` 时从记录播种。索引里的记录（含 rounds、workspaceLease）深度冻结，`peek` 不能再被就地修改；`save` 成为 `commit(task, [])`。
- `prototype/manager.mjs`：删除独立的 `eventSequences` 和 `event()`，所有任务写入走一个 `commit`；失败投影、终态、`worker_busy`、ACK 超时、清理、accept、fallback 都一次提交。`restoreTasks` 改为提交恢复后的新记录；`cleanup_worktree` 提交新的 lease。
- `src/runtime/module.mjs`：健康、就绪、worker 事件、release、进程错误/退出改为提交新记录；新增 `commit` hook，旧的 `event`+`save` 只留给测试替身；重复的 `ready` 不再写盘。
- `src/tasks/transaction.mjs`：`prepareRun` 支持 `events` 和 `commit`，rework 的限额覆盖与 `round_started` 在同一次提交里写入；轮次数组改为复制后追加。`src/usage/module.mjs` 的 `applyRework` 改为返回新记录。
- `src/workspace/lease-manager.mjs`：`cleanup` 返回新的 lease，不再就地改 `lease.status`。
- 目标测试：新增 `task-repository-commit.test.mjs` 5 项（深层冻结、保存失败无事件且索引不变、追加失败后记录已存且下一序号继续、重启序号不回退、一次提交多个事件按序且带 roundId）；`runtime-module.test.mjs` 新增重复 `ready` 不写盘 1 项；冻结开启下完整套件无就地修改。
- 完整测试：`294/294` 通过，42 个测试文件。
- 发布树：`259` 个文件通过。
- 遗留：追加失败后 `task.json` 的序号会比日志领先一个（记录已落盘、事件缺失），这是“先保存后追加”的已知方向；错误会抛出，下一次提交不会复用序号。

#### #8 Rework 决策收进一个 Module

状态：完成。

- 新增 `src/tasks/rework.mjs`：`TaskRework.decide` 一次回答“能否 rework、下一轮限额/effort、覆盖记录与事件”，返回决策和记录补丁，不修改任务；`blockedReason` 供 `statusSummary` 使用，拒绝原因与操作共用同一套状态、运行时、轮次、工作区、限额规则。
- `reworkStatusRefusal` 从 `AcceptanceService` 移到 rework 模块；`src/tasks/command.mjs` 只保留 create 校验，删除 `validateRework`/`rework` 和未使用的默认实现，`parseBudget`/`parseEffort` 改为直接使用 `budget.mjs`/`effort.mjs` 的唯一实现。
- `src/usage/module.mjs`：`decideRework` 新增 `throwOnRefusal`，可返回被拒绝的决策；覆盖事件不再临时改名 `overrideAt`，改为决策结果上的独立 `overrideAt` 字段，事件载荷不带时间戳，由仓库统一写入。
- `prototype/manager.mjs`：删除 `baseReworkBlockedReason`/`reworkBlockedReason` 和七步 rework 序列，rework 操作只调用一次 `rework.decide`；记录补丁与覆盖事件只在 `prepareRun` 的提交里生效。
- 目标测试：新增 `rework-module.test.mjs` 21 项——状态 × 运行时 × 限额表（允许、运行中、停止中、关闭中、已关闭、已接受、运行时缺失、不可信句柄、轮次上限、工作区冲突、关停、警告、阻断、覆盖）；`statusSummary` 与 rework 操作拒绝文本一致（模块级限额 + 真实 manager 关闭态）；`prepareRun` 门禁失败后 `task.json` 与 `events.jsonl` 不变。`task-command-module.test.mjs` 改为经真实 `createManager` 验证 create 路径。
- 完整测试：`311/311` 通过，43 个测试文件。
- 发布树：`261` 个文件通过。
- 遗留：`TaskCommandModule` 是 `src/app.mjs` 的公开导出，删除其 rework 方法属于公开类的方法级变更，已在 CHANGELOG 记录；如需保留旧方法，需在 0.3.0 前加弃用转发。

### 阶段 3：P1 接口面

#### #9 操作目录：一份定义驱动网关、CLI、MCP

状态：完成。

- 新增 `src/operations/catalogue.mjs`：20 个操作（含 `health`/`shutdown`/`grant_delete`）声明字段、上下限、默认值、入口暴露（CLI/MCP/桌面/仅人工）、注解和跨字段规则；`validateOperation`、`mcpSchema`、`parseCliOperation`、`cliHelp` 都从这张表生成。
- `prototype/manager.mjs`：`action()` 先按目录统一校验，再通过按操作名索引的 handler 表分发；删除 20 个 case 的 `switch`。新增操作只需目录项和处理函数。
- `prototype/cli.mjs`：`HELP_TEXT`、`parseCommandArgs`、`parseStatusArgs`、`parseWaitArgs`、`parseResearchCollectArgs` 全部委托目录；JSON 命令（create/rework/accept/research-start）现在和 MCP 一样校验未知字段、类型、上下限。CLI 仍拒绝没有分页视图的 offset/limit，该差异写在 status 的 CLI 入口上；wait 默认仍为 `roundTimeoutSeconds + 30`，上限 86400。
- `prototype/mcp.mjs`：工具目录、schema、注解和调用校验都由目录生成；`wait`/`research_wait` 的 MCP 上限 300 是目录里的入口覆盖；`grant_delete` 标记仅人工，不出现在 MCP 目录。错误结果新增 `code` 字段，文本不变。
- `prototype/server.mjs`：导出 `createGateway`（可注入 manager、端口、token），顶层只在直接运行时启动；错误按 `classifyError` 映射状态码和稳定 `code`，响应保留 `{error}` 文本。`prototype/common.mjs` 的 `request` 把 `code`/`status` 挂到 Error 上。
- `desktop/src-tauri/src/transport.rs`：新增 `error_code` 解析响应里的稳定 `code`，`error_message` 文本不变。
- 目标测试：新增 `operations.test.mjs` 4 项——网关未授权/Host/Origin/1 MB/未知操作/未知任务/非法状态的状态码与 code；CLI、MCP、manager 对合法与非法请求的一致校验；入口差异（MCP wait 300、CLI 分页视图、human-only 不在 MCP 目录）；网关保留 OperationError 的 code/status。现有 `cli.test.mjs`、`mcp.test.mjs` 通过目录生成的解析与 schema 继续通过。
- 完整测试：`315/315` 通过，44 个测试文件。
- 发布树：`263` 个文件通过。
- 遗留：`src/app.mjs` 尚未导出目录（`prototype/` 是它的两个调用方）；`grant_delete` 是否对网关调用方额外限制，仍需权儿决定。

#### #10 轮次协议只有一个 Module

状态：完成。

- `src/runtime/protocol.mjs`：消息分为轮次消息（`ack`/`event`/`heartbeat`/`result`/`error`/`worker_busy`/`released`）和控制消息（`ready`/`close`/`closed`/`close_error`/`protocol_error`）；每种消息都有构造器，`validateMessage` 统一检查对象形状、未知 kind、协议版本、轮次消息的合法 `roundId`、event 的 notification 和 error 字符串；`parseRunMessage` 在 Worker 侧校验 run；`eventMessage` 把 DSH SDK 的 `{method, params:{event}}` 与 OpenAI 适配器的裸事件统一成一种嵌套 `session.event`；心跳改用 `heartbeatMessage`。
- `prototype/worker.mjs`：`runtimeIdentity.protocolVersion` 取自协议模块，ready/close/closed/close_error/ack/result/error/released/worker_busy 都由构造器生成；非法 run 回 `protocol_error`，忙时回 `worker_busy`；未知或非对象消息直接忽略，和旧行为一致；错误路径不再补发 `e.events`，Provider 事件只经 `onEvent` 流式发送一次。
- `src/runtime/module.mjs`：`sendClose`、`openRound` 使用协议构造器；`onMessage` 先 `validateMessage`，非法消息记为 `runtime_message_ignored`（带 kind、roundId、期望 roundId 和原因）；`closed` 只标记 `workerClosed`，进程退出仍是唯一放行条件；轮次消息集合改由协议模块提供，删除本地 `ROUND_SCOPED_KINDS`。
- `prototype/usage.mjs`：在重复 message id 分支注明这是对旧 worker 和损坏日志的防御，正常流式路径每个 id 只出现一次。
- 目标测试：新增 `round-protocol.test.mjs` 3 项——run 消息带版本且按版本/形状解析，全部 13 种消息各有合法样例且非法样例被拒（含版本不符），两种 Provider 事件包装归一；新增 `round-flow.test.mjs` 2 项——假 Worker 走完 run → ack → events → result → released，`events.jsonl` 序号从 1 连续且不重复、每个 Provider message id 只出现一次；失败路径同样只出现一次。九个测试文件的手写假 Worker 合并为 `prototype/tests/fake-worker.mjs`，消息全部由协议构造器生成。
- 完整测试：`320/320` 通过，45 个测试文件。
- 发布树：`266` 个文件通过。
- 遗留：`validateMessage` 仍接受不带 `protocolVersion` 的消息（兼容旧 Worker），只在版本出现且不符时拒绝；若后续要求严格版本，需要同时升级 Worker 与 manager 并保留一段兼容期。

#### #11 Provider Seam 变成真实的 Seam

状态：完成。

- `prototype/providers/base.mjs`：`ProviderAdapter` 增加 `static capabilities(config)`（effort、sessionContinuity、budgetPatch），实例通过 `capabilities` getter 读取；删除抽象 `buildUsageEvents`，契约改成“每轮返回 `{text, finishReason}`，事件只经 `onEvent` 发出”，`close()` 默认空实现。
- 新增 `prototype/providers/dsh-sdk.mjs`：DSH 路径成为第二个 Adapter。它持有长期 harness 会话，`prepareTask` 静态方法负责写任务运行时 patch（含按插入方式挂载的 budget 插件），`run` 在开跑前写本轮预算文件，首次启动时调用 `onStart`，`close` 释放 harness；`createHarness` 可注入，测试不需要真实 DSH 仓库。
- `prototype/providers/openai-chat.mjs`：声明能力；HTTP 调用改为构造器注入的 `transport`（默认仍是 `http`/`https`）；`buildUsageEvents` 降为模块内 `usageEvents`；删除 `estimateTokens`、`buildOpenAIRequest`、`mapStopReason`、`openaiToAnthropic` 约 120 行死代码。
- `prototype/providers/registry.mjs`：`dsh-sdk` 与 `openai-chat` 一样注册在 `ADAPTER_TYPES`；新增 `resolveProvider`（内置 `dsh`/`dsh-sdk` 先于 provider JSON）、`capabilitiesFor`、`prepareTask`、`DEFAULT_PROVIDER_NAME`，`createAdapter` 接受构造选项；`src/providers/registry.mjs` 转出这些新接口。
- `src/providers/adapter-cache.mjs`：接受 `adapterOptions` 并传给每个 Adapter；新增 `closeAll()`，按构建顺序倒序关闭所有 Adapter（包括被 fallback 替换掉的旧 Adapter）。
- `prototype/worker.mjs`：不再按 `providerType` 分派，改为 `adapterFor(task.provider)`；只把 Adapter 声明的能力对应参数传下去；工具调用走 `src/worker/tools.mjs`；删除 `runDshSdk`、`runOpenAIChat`、内联工具实现和 `message.signal`。
- `prototype/manager.mjs`：`supportsEffort` 读能力，`providerByName` 走 `resolveProvider`；`budgetFile` 由 `capabilitiesFor(...).budgetPatch` 决定；任务 patch 由 `prepareTask` 写入；删除 `patchFor` 和 `BUDGET_PLUGIN`。源码中不再出现 Provider 类型字面量。
- 新增 `src/worker/tools.mjs`：`buildMinimalTools`、`resolveToolPath`、`executeTool`，相对路径逃逸工作区被拒，所有失败以 `{content: 'Error: ...'}` 返回。
- 目标测试：新增 `provider-contract.test.mjs` 7 项——两个 Adapter 的同一轮结果形状与事件通过协议校验；能力替代类型分支（并扫描 manager/worker 源码无类型判断）；DSH 跨轮复用 harness、只宣布一次启动、关闭释放；openai 注入传输下的工具循环、上游 500、流中断；内置 provider 解析与未知类型拒绝；`prepareTask` 只为 DSH 写 patch。新增 `worker-tools.test.mjs` 4 项——工具清单、相对路径读写、路径逃逸、bash 工作目录与错误内容；`provider-adapter-cache.test.mjs` 新增 `closeAll` 1 项。
- 完整测试：`332/332` 通过，47 个测试文件。
- 发布树：`270` 个文件通过。
- 遗留：Worker 的 `read_file`/`write_file` 仍接受任意绝对路径（与 Bash 工具同级，本身不构成额外权限边界）；是否限制在工作区内仍需权儿决定。Adapter 的 `sessionContinuity` 目前只作声明，openai-chat 不持久化跨轮历史。

#### #12 Usage：指标与限额分离

状态：完成。

- 新增 `src/usage/metrics.mjs`：`prototype/usage.mjs` 的定价、增量事件索引、成本投影整体迁入，不再读全局 `config`，定价文件与 Provider 定价目录由调用方传入；`metricsForTask` 只返回指标和 `computed`，不评估限额；`usageViewFor` 投影已算好的快照。`fullPricing` 改为选“认识任务模型”的定价来源，而不是永远取第一份。
- `src/usage/module.mjs`：限额评估只在 `snapshot` 里，用注入的配置（`limits`、`providersDir`、`pricingFile`）；同时负责把限额消息和非指标警告合进 status 警告、生成 list 摘要、投影 `limitOverride`；新增 `listFlags(snapshot)`，manager 不再自己判断 `limitBlocked`/`limitWarning`。删除 `limitsForTask` 参数和无人使用的指标再导出。
- `prototype/usage.mjs`：改为旧入口转发，保留 `usageForTask`/`usageForList`/`usageForStatus`/`usageForView` 的旧签名，内部构造 `UsageModule` 并注入全局配置；不再有第二份限额逻辑。
- `ExecutionPolicy` 移到 `src/tasks/execution-policy.mjs`（轮次开头与报告策略段属于任务与验收），`src/usage/execution-policy.mjs` 只做转发；manager 和 `src/app.mjs` 改指新路径。
- `prototype/manager.mjs`：UsageModule 构造改为传 `{limits, providersDir, pricingFile}`；删除未使用的 `effectiveLimits` 导入；list 标志走 `usageModule.listFlags`；执行策略警告改为 `extraWarnings` 由模块合并。
- `src/usage/service.mjs`：只接受 `UsageModule` 或新的指标替身，并标注弃用到 0.3.0。
- 目标测试：`usage.test.mjs` 新增“同一任务 list/status/usage 视图的成本与限额一致”和“多来源定价选对来源”2 项；`usage-module.test.mjs` 改为新契约（指标替身无 limit 字段，限额由模块计算）并覆盖 view 复用快照、损坏覆盖回退、Service 委托；`rework-module.test.mjs` 的替身同步改为指标形状；旧直出路径的损坏限额用例改为验证回退后指标仍可用。
- 完整测试：`334/334` 通过，47 个测试文件。
- 发布树：`272` 个文件通过。
- 遗留：`prototype/usage.mjs` 的转发入口每次调用新建一个 `UsageModule`，只在兼容期使用；按计划在 0.3.0 随兼容层一起删除。

#### #13 Research 依赖窄接口

状态：完成。

- `src/tasks/lifecycle.mjs`：导出 `ACTIVE_TASK_STATUSES`（`created`/`running`/`stopping`）和 `TERMINAL_TASK_STATUSES`（`awaiting_review`/`failed`/`cancelled`/`closed`/`accepted`）；manager 与 `src/research/state.mjs` 使用同一组集合，不再各自维护。
- 新增 `src/tasks/wait-loop.mjs`：`pollUntilSettled({timeoutSeconds, isSettled, waitForChange, now})` 统一处理截止时间、剩余时间与 `{timedOut, timeoutSeconds, waitedMs}` 结果；manager 的 `waitForTask` 和 research 的 `wait` 都改用它。
- `src/research/state.mjs`：`shardTransition` 只读窄视图；新增 `shardCapturePatch(view)`，把取消、失败（含 `finishReason: 'error'`）、完成统一映射为 `{status, error}`，证据含义不再由 capture 决定。
- `src/research/capture.mjs`：`capture()` 拆成 `read(batch, shard, view)`（读取视图结果，缺失时读工作区 `research-result.md`，有内容就写结果文件）和 `writeError(batch, shard, error)`；不再读取任务记录。
- `src/research/service.mjs`：依赖改为必需的 `shardView`、可选的 `closeShard`/`cancelTask`；刷新用视图做迁移，捕获后由 `shardCapturePatch` 定状态，`closeShard` 返回 `false` 视为仍在收尾；删除残留的 `captureTerminal` 死方法。
- `prototype/manager.mjs`：注入 `shardView`（状态、错误、最新结果文本、finishReason、idle）、`closeShard`（忙时返回 `false`，否则 `stop(id, true)`）和 `cancelTask`（`stop(id, false)`）；删除本地 `ACTIVE_TASK` 与手写等待循环。
- `src/operations/catalogue.mjs`：公开 `create` 不再声明 `kind`/`batchId`/`shardId`，网关、CLI、MCP 会以 `Invalid argument` 拒绝这些内部字段；research 内部仍通过 `createTask` 直接建任务。
- 目标测试：新增 `research-modules.test.mjs` 4 项——Repository 保存/缓存/重载/非法 ID、重启把无任务的 planned 分片收敛为孤立失败、Capture 读取任务结果与工作区回退并写证据/错误文件、Report 内容稳定哈希与分页且损坏证据不让收集失败；`research-state.test.mjs` 增加 `shardCapturePatch` 7 行表驱动和共享状态集合 1 项；`research-refresh.test.mjs` 新增取消测试 1 项（只取消未完成分片、保留已完成证据、批次进入 `partial`）；`research.test.mjs` 新增公开 `create` 拒绝研究字段 1 项。
- 完整测试：`348/348` 通过，48 个测试文件。
- 发布树：`274` 个文件通过。
- 遗留：research service 仍自行构造 repository/capture/report，装配函数未与 manager 分离；属 #15 的 manager 装配范围。

#### #14 Desktop 通过 Manager 读写配置

状态：完成。

- 新增 `src/config/paths.mjs`：`managerPaths({here, env})` 一次给出数据根、runs/reports/runtime/research/providers 目录、后端与本地配置文件、Node、端口、manager 脚本与服务 URL；`prototype/config.mjs` 导出 `platformDataRoot`。
- `prototype/cli.mjs`：新增 `paths` 子命令，在 `ensureServer()` 之前处理并以 JSON 输出；帮助文本附一行说明。
- 新增 `src/config/service.mjs`：`ConfigurationService` 独占 provider 文件与可编辑设置的解析、校验和写入。`providers()` 同时返回无效文件，`saveProvider` 按名字更新声明该名字的文件（保留 `apiKey` 等未知字段，新名字写 `<name>.json`，拒绝路径分隔符），`deleteProvider` 只删对应文件；`settings()` 合并默认限额，`saveSettings` 校验 provider 引用、把旧版 `prototype/config.local.json` 迁到 `platformDataRoot` 并把相对路径转绝对；`DEFAULT_LIMITS` 与 `absolutizeLocalPaths` 导出。
- `src/operations/catalogue.mjs`：新增 `config_info`、`providers_list`、`provider_validate`、`provider_save`、`provider_delete`、`settings_get`、`settings_save`，只对 server/desktop 入口开放；`provider_save` 要求 `config` 为对象，`settings_save` 三个字段必填；`provider_delete` 标为 destructive。
- `prototype/manager.mjs`：构造 `ConfigurationService`（可注入），把七个操作接到它；启动时把 `config.usageLimits` 规范成对象，并注明 `UsageModule` 持有构造时的那份限额。`settings_save` 返回 `{saved, restartRequired: true, localConfigPath, settings}`，不再在进程内改全局配置。
- `prototype/common.mjs` 导出 `LOCAL_CONFIG_SOURCE`。
- Rust：`paths.rs` 只保留后端根、Node 命令与 `ManagerPaths`，通过 `node cli.mjs paths` 解析并缓存一次，删除所有 config/providers/settings 文件解析；新增 `manager.rs` 统一请求与健康检查；`settings.rs`、`providers.rs` 改为转发 manager 操作，`tasks.rs` 的 token/请求/健康检查改用 `manager`。`manager_script` 死字段删除。
- 桌面契约：`scripts/generate-task-contract.mjs` 导出 `renderContractTypes` 与 `CONTRACT_TYPES_PATH`，从任务视图 fixture 推出 `desktop/src/contract.generated.ts`（Task、TaskDetail、TaskUsage、TaskDetailUsage、UsageRound、TaskRound、TaskRuntime）；新增 `desktop/src/api.ts` 作为唯一调用层，同时定义 provider/settings/健康检查形状。
- Vue：`Tasks.vue`、`CreateTask.vue`、`TaskDetailPanel.vue`、`Providers.vue`、`Settings.vue` 改用 `api` 与生成的类型；Provider 页渲染 `invalid` 列表，设置页展示“已保存，重启生效”，删除未被引用的 `TaskDetail.vue`。
- 目标测试：新增 `config-service.test.mjs` 9 项——provider 列表与无效文件、保存保留未知字段并按名更新、校验与删除、设置合并与引用校验、旧版迁移、manager 转发设置并返回 `restartRequired`、manager 路径、路径 fixture 字段契约、catalogue 入口暴露；新增 `contract-types.test.mjs` 3 项——已提交类型与生成器一致、fixture 每个字段出现在类型中、`api.ts` 不重复定义。Rust 侧 `paths.rs` 校验共享 fixture 与字段集合，`tasks.rs` 双向字段表比对 fixture，`settings.rs` 往返形状。
- 调整：设置保存原本尝试即时生效，但 `UsageModule` 持有构造时的限额对象，且并发测试下改全局配置会串扰其他用例（全量跑出现 2 项只有并发时失败的用例），因此改为明确回复“重启后生效”。旧版本地配置迁移也从 Rust 移到 Node。
- 完整测试：`360/360` 通过，48 个测试文件。
- 发布树：`281` 个文件通过。Rust `cargo test --locked` 19/19。
- 遗留：`desktop/src-tauri/src/tasks.rs` 仍自行解释任务视图字段（以 fixture 双向比对约束）；若要彻底单一来源，可让桌面直接消费生成的 JSON Schema，属后续工作。

#### #15 Manager 组装：去掉导入期副作用，依赖可注入

状态：完成（按计划允许的范围）。

- 新增 `src/config/load.mjs`：配置分层（`config.json`、本地覆盖、环境别名）从 `prototype/config.mjs` 迁入，增加 `platform` 参数，导入时不读文件；`prototype/config.mjs` 改为转发。
- 新增 `src/config/context.mjs`：`createRuntimeContext({here, env, platform})` 返回冻结的上下文（配置、配置路径、数据根、runs/reports/runtime/research/providers/pricing/node/port）；`runtimeContext()` 懒加载进程默认上下文，`getConfig()` 供兼容入口使用。`src/config/paths.mjs`、`service.mjs` 改从新模块导入。
- 新增 `src/config/data-root.mjs`：`migrateLegacyData` 与 `ensureDataDirs(context)`，旧数据一次性复制保持原语义。
- 新增 `src/paths/path-utils.mjs`：路径比较函数迁入 `src/`，`src/workspace/git.mjs`、`lease-manager.mjs` 不再导入 `prototype/`。
- `prototype/common.mjs` 改为兼容外观：不再在导入时加载配置，不再导出可变的 `config`/`ROOT`/`RUNS`/`REPORTS`/`RUNTIME`；保留 `HERE`、`atomicJson`、`ensureDirs`、路径工具与客户端转出。
- `prototype/manager.mjs`：`createManager({context, config, forkWorker, fs, clock, git, terminateRuntime, configurationService})`。所有 `config`、`ROOT`、`RUNS`、`REPORTS`、`RUNTIME`、`HERE` 改为上下文局部值；`usageLimits` 不再写回配置；`createdAt`/`updatedAt` 使用注入时钟；文件操作走注入的 `fs`；`WorkspaceLeaseManager` 收到 `git` 选项（此前遗漏）；`TaskRepository` 新增 `fs` 选项，`AcceptanceService` 收到 `now`。
- 杀进程只剩一条路径：`TaskTransaction` 的强制退出改为调用 `terminateVerifiedRuntime({taskId, pid, ownerMarker})`，与恢复路径共用同一函数；身份无法验证且进程仍存活时明确报错，进程已消失时视为无需终止。删除 manager 里直连 `taskkill`/`SIGKILL` 的分支。
- 实现迁入 `src/`、`prototype/` 转发：CLI（`src/adapters/cli.mjs`）、MCP（`src/adapters/mcp.mjs`）、回环客户端（`src/adapters/client.mjs`）、Provider registry 与三个 adapter（`src/providers/adapters/`）、DSH budget plugin（`src/providers/budget-plugin.mjs`）、budget/effort（`src/tasks/`）。`prototype/cli.mjs`、`prototype/mcp.mjs` 保留入口判断，`node prototype/...`、`bin/` 和 `package.json` 的 exports 路径不变。
- `prototype/server.mjs`：`createGateway` 接受上下文；修复 `listen` 用未解析的 `port`（`start()` 不传端口时绑定随机端口）的问题，改为 `boundPort`；token、daemon.json 与健康响应都来自同一上下文。
- `prototype/worker.mjs`：adapter 缓存与配置读取改为首次使用时执行，导入 worker 不再读配置。
- 删除 `prototype/state.mjs`（无导入者，仅出现在发布清单，随文件删除自动消失）。
- 测试：`runtime-protocol`、`reliability`、`execution-limits` 改用测试自己的配置对象并传给 `createManager`，不再改写共享全局配置；其余测试改为从 `runtimeContext()` 取根目录和配置。
- 目标测试：新增 `manager-assembly.test.mjs` 3 项——同一进程内两个不同数据根的 manager 任务互不可见、文件互不写入；注入的时钟、文件系统、git 确实被使用（`createdAt` 等于固定时钟，`mkdirSync` 被调用，worktree 走注入实现）；默认上下文与配置被冻结。
- 完整测试：`363/363` 通过，49 个测试文件。
- 发布树：`292` 个文件通过；`package:smoke` 通过；Rust `cargo test --locked` 19/19。
- 遗留：`src/usage/service.mjs` 仍导入 `prototype/usage.mjs`，随兼容层在 0.3.0 一起删除。`server.mjs`、`worker.mjs`、`manager.mjs` 仍在 `prototype/`（进程入口与组装处）；Worker 仍自行加载配置中的 providersDir/model，而不是从 manager 接收，跨上下文运行真实 Worker 时这一点仍需后续处理。
