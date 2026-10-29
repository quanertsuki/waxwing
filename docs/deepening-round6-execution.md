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
