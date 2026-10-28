# Waxwing 第五轮深化执行记录

日期：2026-10-28

执行依据：`PLAN-WAXWING-DEEPENING-ROUND5.md`

本文件是第五轮唯一的执行与结果文档。每完成一个阶段，在本文件追加该阶段的改动、测试证据和遗留问题；全部完成后，本文件即为最终报告。

## 当前状态

第五轮深化完成。初次交付时按用户要求未提交、未推送、未发布；用户随后明确授权以 **0.2.0** 完整发布，发布准备与候选门禁已通过。

## 执行约束（覆盖计划中的提交步骤）

- 初次执行时不创建分支、不提交、不推送、不创建 tag 或 Release、不发布 npm。
- 用户后续授权 0.2.0 完整发布后，才执行分支、PR、tag、GitHub Release 与 npm 发布。
- 深化阶段的全部改动先保留在工作区，发布前统一审阅。
- 每项仍先写目标测试，再改实现，并跑完整 `npm test`。
- 每阶段结束后更新本文件；最终只输出本文件这一份报告。

## 基线

| 项 | 值 |
| --- | --- |
| HEAD | `66aa77e03ca09e999c56ce9743c6d5a0e8963ba8` |
| 分支 | `main`（与 `waxwing/main` 同步，工作区干净） |
| JavaScript | `224/224` 通过（169 s） |
| 发布树 | `235` 个文件通过 |
| Rust | `4/4` 通过（约 2 分 15 秒，含编译） |
| 远程 | `origin` 只读；`waxwing` 本轮不推送 |

## 阶段记录

### 阶段 0：基线与安全网

状态：完成。

- 计划文档已读取：`PLAN-WAXWING-DEEPENING-ROUND5.md`。
- JavaScript 基线已确认：224/224。
- 发布树基线已确认：235 个文件。
- 工作区在开始前干净；本轮所有改动不提交。
- Rust 基线：4/4 通过。

### 阶段 1：恢复判定与租约补偿

状态：完成。

#### #2 恢复流程消费终止结论

- 改动：`src/runtime/identity.mjs`、`src/runtime/lifecycle.mjs`。
- 终止适配器现在始终返回显式 `terminated` 结论；终止前再次校验身份，身份变化时返回 `terminated:false`，不再让 `recover()` 从"没抛错"推断成功。
- `recover()` 只在 `terminated === true` 时进入 `terminated`；未确认终止进入 `termination-failed`、`manualActionRequired:true`、租约 `locked-unverified`。
- 目标测试：`runtime-identity.test.mjs` 新增身份变化用例；`runtime-lifecycle.test.mjs` 新增未确认终止用例。13/13 通过。

#### #10 租约补偿只执行一次，状态只有一个来源

- 改动：`src/workspace/lease-manager.mjs`（注入 `git` 适配器、删除 `materialize()` 内的重复回滚、`rollback` 幂等、`cleanup`/`release` 消费 `locked-unverified`）。
- `acquire()` 是唯一补偿点；`materialize()` 只创建。
- `cleanup()` 对 `locked-unverified` 返回 `manualActionRequired:true`，不再尝试删除；`release()` 对人工锁定的 runtime 明确拒绝。
- 目标测试：`workspace-lease-module.test.mjs` 新增补偿次数、幂等、人工锁定用例。9/9 通过。

### 阶段 2：运行时失败投影与关闭结局

状态：完成。

#### #6 Runtime 失败投影收进 Settlement

- 改动：`src/runtime/outcome.mjs`、`prototype/manager.mjs`。
- 新增 `startFailed`、`fallbackFailed`、`stopFailed` 三个投影；manager 的三处失败写入改为调用 projection，统一事件并让事件/保存错误可观察。
- 目标测试：`runtime-outcome.test.mjs` 新增三投影用例。6/6 通过。

#### #1 关闭结局由一个模块拥有

- 新增 `src/runtime/close-outcome.mjs`；`RuntimeLifecycle.exit` 委托该模块。
- `TaskTransaction.stop()` 改为：确认退出 → 读取 close error → 投影 → 报告 + 保存终态 → 事件 → 最后 `forget`；报告或保存失败时保留句柄并调用 `abortClose`，停止可重试。
- `Runtime` 新增 close error 留存（进程退出后仍可读取，`forget` 清理）与 `abortClose`。
- 目标测试：新增 `runtime-close-outcome.test.mjs` 4 项；`task-transaction.test.mjs` 新增终态保存失败重试、close error 持久化；`runtime-module.test.mjs` 新增 `abortClose` 与 close error 存活。相关目标测试 39/39 通过。

#### 阶段 2 完整测试

- `npm test`：`239/239` 通过（163.9 s）。

### 阶段 3：持久化事务

状态：完成。

#### #3 验收产物与任务记录同一次提交

- 改动：`src/acceptance/service.mjs`。
- 报告写入改为 temp → backup → rename → commit/rollback；新增 `writeReportAndSave`，任务保存失败时恢复旧报告，避免"报告已换、任务仍旧"。
- 删除任务时索引写入失败返回 `indexPending:true`，不再吞掉错误。
- 目标测试：`acceptance-module.test.mjs` 新增验收保存失败恢复旧报告、重命名失败恢复、删除索引失败用例。10/10 通过。

#### #4 恢复与迁移收进 Repository

- 改动：`src/tasks/repository.mjs`、`prototype/manager.mjs`。
- `TaskRepository.restore()` 负责 ID 校验、旧租约迁移、`schemaVersion`、事件序列恢复和索引发布；manager 的 `restoreTasks()` 只负责运行时恢复、保存迁移结果和授权恢复。
- 目标测试：新增 `task-repository-restore.test.mjs` 4 项，覆盖旧记录迁移、ID 不匹配、事件缺失、runs 目录缺失。4/4 通过。

#### 阶段 3 完整测试

- `npm test`：`246/246` 通过（166.4 s）。

### 阶段 4：跨适配器契约

状态：完成。

#### #5 任务视图契约门禁

- 改动：`src/tasks/view.mjs` 定义唯一 `TASK_VIEW_CONTRACT`（list/detail 的 required/optional），删除未使用的 detail optional 常量；`normalizeTaskDetail` 保留 `lastRound` 的 `startedAt/finishedAt`，并继续省略空字段以满足响应大小目标。
- 新增 `scripts/generate-task-contract.mjs`：用真实 `taskListView`/`taskSummaryView`/`normalizeTaskDetail` 生成 `prototype/tests/fixtures/task-view-contract.json`。
- JS 测试重新生成 fixture 并逐字段比对，任何新增/删除字段都会失败；目标测试 `task-view.test.mjs` 8/8 通过。
- Rust `tasks.rs` 补齐 `error`、结果预览边界、`runtimePhase`、`sessionId`、`lastEvent`、研究分片字段；测试用 `include_str!` 读取同一 fixture 反序列化 `Task`/`TaskDetail`。
- 桌面新增 `typescript@5.9.3`、`vue-tsc@3.3.13`、`typecheck` 脚本、`env.d.ts` 与 `Page.complete`；`npm run build` 先执行 typecheck。`npm run typecheck` 与 `npm run build` 通过。
- CI 桌面 job 增加 Type-check 步骤；`scripts/check-release-tree.mjs` 收录生成脚本。

#### #9 桌面传输层统一策略

- 新增 `desktop/src-tauri/src/transport.rs`：非 2xx 解析 `{error}` 并给出稳定文本，纯文本/空 body 可读；分页 limit 夹到 1..4000，缺省 2000；健康检查返回 `running`/`unhealthy`/`notRunning` 三态。
- `tasks.rs` 的 `manager_request`、`get_task_view`、`is_manager_running`、`start_manager` 使用该策略；删除无调用方的 `get_task_usage` 命令及注册。
- `Tasks.vue` 区分"未运行"与"运行但不健康"。
- Rust 测试：`error_message` 三种 body、limit 边界、health 三态与序列化。`cargo test` 11/11 通过；Vue typecheck/build 通过。

### 阶段 5：Research 与 Usage

状态：完成。

#### #7 Research 刷新失败隔离

- 新增 `src/research/repository.mjs`（批次目录、原子保存、加载、崩溃窗口 orphan 收敛）、`capture.mjs`（分片终态捕获）、`report.mjs`（聚合、原子写、哈希、分页）；`ResearchBatchService` 保留为编排 facade。
- `refresh` 每个批次共享同一个 in-flight promise；单个 shard 的捕获异常写入 `captureError` 并标记 failed，不再让整个批次抛出；失败 shard 仍继续运行时关闭。
- 报告写入 temp + rename，重复 collect 返回相同哈希。
- 新增 `research-refresh.test.mjs` 3 项：不可读结果仍可 status/wait/collect、planned 无 task 判定 orphaned、并发 status/wait/collect 只关闭一次且哈希一致。3/3 通过；现有 research 与 research-state 9/9 通过。

#### #8 Usage 指标接缝与死面清理

- `UsageModule.snapshot` 只解析一次限额并传入指标操作；损坏的 `task.usageLimits` 回退到配置限额。
- `prototype/usage.mjs` 的 `usageForTask` 接受显式 `limits`，`effectiveLimits` 移入 never-throw 保护内；`usageForView` 接受已计算 `result`，不再二次扫描。
- 删除无调用方的 `commitRework`；`UsageService` 改为 `UsageModule` 兼容适配器（收到模块则委托，否则用注入操作构造）。
- 新增 policy `unavailableUsageView`，module 与旧路径共用不可用视图投影。
- 目标测试：`usage-module.test.mjs` 9/9、`usage.test.mjs` + `usage-policy.test.mjs` 26/26 通过。

#### 阶段 4–5 完整测试

- `npm test`：`256/256` 通过（117.1 s）。

### 阶段 6：最终门禁

状态：完成。

| # | 门禁 | 结果 |
| --- | --- | --- |
| 1 | `npm test` | `256/256` 通过（117.1 s） |
| 2 | `npm run check:release-tree` | `247` 个文件通过（发布准备后为 `248`） |
| 3 | `npm run package:smoke` | 通过（`quanernya-waxwing-0.1.1.tgz`；临时目录清理报 EPERM，位于仓库外） |
| 4 | `npm run desktop:resources` | 通过，后端与 Node 运行时已准备 |
| 5 | `npm --prefix desktop run typecheck` | 通过 |
| 6 | `npm --prefix desktop run build` | 通过（JS 113.03 kB / CSS 16.02 kB） |
| 7 | `cargo fmt --check` | 通过 |
| 8 | `cargo check --locked` | 通过（57 个 crate） |
| 9 | `cargo test --locked` | `11/11` 通过 |
| 10 | 敏感文件/路径扫描 | 发布树路径扫描通过；改动文件凭据关键词扫描无命中 |
| 11 | `git diff --check` / 工作区审计 | 通过；staged 为 0；工作区 37 个修改 + 12 个新增 |

提交与推送步骤按用户指令全部跳过：没有创建分支、没有提交、没有推送、没有 tag/Release，也没有发布 npm。所有改动保留在工作区。

## 结果汇总

| 候选 | 名称 | 结果 | 目标测试 |
| --- | --- | --- | --- |
| #2 | 恢复流程消费终止结论 | 完成 | 身份校验 + 未确认终止；13/13 |
| #10 | 租约补偿只执行一次 | 完成 | 补偿次数、幂等、人工锁定；9/9 |
| #6 | Runtime 失败投影 | 完成 | start/fallback/stop 三投影；6/6 |
| #1 | 关闭结局单一 owner | 完成 | close-outcome 4 项 + 事务重试/close error；39/39 |
| #3 | 验收产物原子提交 | 完成 | 报告回滚、删除索引失败；10/10 |
| #4 | 恢复与迁移收进 Repository | 完成 | 迁移/ID/事件/目录；4/4 |
| #5 | 跨适配器视图契约 | 完成 | 生成 fixture 比对与字段校验；8/8；Rust fixture 解析 |
| #9 | 桌面传输策略 | 完成 | 错误 body、limit 边界、健康三态；Rust 6 项 |
| #7 | Research 刷新隔离 | 完成 | 捕获隔离、orphan、并发单次关闭；3/3 |
| #8 | Usage 指标接缝 | 完成 | 单次扫描/损坏限额/Service 一致；usage-module 9/9 |

### 总量变化

| 指标 | 基线 | 完成 |
| --- | --- | --- |
| JavaScript 测试 | 224/224 | 256/256 |
| 发布树文件 | 235 | 247 |
| Rust 测试 | 4/4 | 11/11 |

## 已知限制与说明

- 按用户指令，本轮所有改动均未提交；计划中的分支、逐项提交、推送和发布步骤未执行。
- `package:smoke` 本身通过；其临时目录清理在 Windows 上首次返回 `EPERM`，随后已手工删除。该目录位于 `I:\appcache\temp`，不在仓库内，不影响发布树。
- 最终门禁完成了 `cargo check`、`cargo test`、Vue typecheck/build 与桌面资源准备；未额外执行 `desktop:portable` 打包，因为计划第 6 阶段门禁未列出该步骤。
- 完整测试计数以单进程测试入口的汇总行为准；本次最终运行 `fail 0`。

## 0.2.0 发布准备（用户后续授权）

- 版本已统一为 `0.2.0`：`package.json`、`desktop/package.json`、
  `desktop/package-lock.json`、`desktop/src-tauri/Cargo.toml`、
  `desktop/src-tauri/Cargo.lock`、`desktop/src-tauri/tauri.conf.json`、
  `README.md`、`README.zh-CN.md`。
- `CHANGELOG.md` 增加 `[0.2.0] - 2026-10-28`；新增
  `docs/release-notes-0.2.0.md`。
- 候选门禁：`npm test` 256/256、`check:release-tree` 248、`package:smoke`
  通过、`cargo test` 11/11、桌面 typecheck/build 通过、
  `desktop:portable` 生成 `waxwing-0.2.0-windows-x64.zip`（59 个条目）、
  `git diff --check` 通过。
- 发布流程：`release/deepening-round5` 分支 → PR → CI → 合并 `main` →
  `v0.2.0` tag → Release workflow（GitHub Release 与 npm）。

## 结论

十项深化全部完成并通过对应目标测试与最终门禁；0.2.0 发布候选已通过完整门禁。
当前工作区包含可审阅的完整改动，远程与发布动作在用户授权后执行。
