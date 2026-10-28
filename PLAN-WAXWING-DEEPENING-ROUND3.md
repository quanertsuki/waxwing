# Waxwing 深化改造第三轮执行计划

日期：2026-10-28

## 目标

按顺序完成下列五项架构深化，保持现有 CLI、MCP、桌面端和 `0.1.x` 兼容行为不变。每项先建立目标测试，再修改实现；每项通过目标测试和完整 JavaScript 测试后单独提交。全部项目完成后执行 Rust、Vue、发布树和安全门禁，只有全部门禁通过才推送到 GitHub `waxwing` 远程的第三轮发布分支。

本轮不新增人工请求数、工具调用数或费用上限，不修改或推送旧远程 `origin`（`quanertsuki/DS_subagent`）。

## 基线

- 代码起点：`release/deepening-round2` 的 `b5750ea8e58f64d94e7b408f7d9cee3ab27dc2ea`。
- 第二轮验证基线：JavaScript 205/205、Rust 4/4、发布树 228 个文件、Vue 生产构建通过。
- 独立发布工作树：只在该树中暂存和提交本轮明确文件。
- 主工作区：存在大量原有未提交改动；禁止整体暂存、提交、恢复、清理或重置。
- 所有新提交显式使用 `quanertsuki <218783771+quanertsuki@users.noreply.github.com>`。

## 阶段 0：完成审计与执行基线

- 将第一轮、第二轮计划及其完成证据纳入发布树，记录提交哈希、测试结果、发布文件数和推送状态。
- 重新确认 `waxwing/main`、第二轮分支、发布工作树 `HEAD` 与远程分支的关系。
- 先运行 `npm test` 和 `npm run check:release-tree`，确认第三轮起点与交接记录一致。
- 任何与交接记录不一致的失败都先处理，不进入后续重构。

## 阶段 1：Usage Module 深化

**涉及文件**

- `src/usage/service.mjs`
- `src/usage/policy.mjs`
- `prototype/usage.mjs`
- `prototype/manager.mjs`
- `prototype/tests/usage-policy.test.mjs`
- `prototype/tests/usage.test.mjs`
- `prototype/tests/execution-limits.test.mjs`

**问题**

`UsageService` 目前主要是转发 facade，索引、定价、用量快照、限额状态和本轮策略仍由多个调用方自行组合。调用方必须知道哪些数据可以缺失、何时降级为 `unavailable`、何时只警告、何时阻断。

**方案**

让 Usage Module 成为真实深 Module：在一个稳定接口后统一用量索引、快照投影、限额校验、override、执行策略和本轮决策。manager 只传入任务/请求上下文并消费结果，不再拼装内部字段。

**必须保持**

- 限额默认关闭；usage 不可用或成本不完整不阻断。
- 任务字段继承全局字段，override 只影响本轮。
- provider 回退、事件记录和下一轮重新评估语义不变。

**验收**

- 策略矩阵覆盖 allow/warn/block、override、缺失 usage 和损坏价格。
- `usage-policy`、`usage`、`execution-limits` 目标测试及 `npm test` 通过。

## 阶段 2：Research 状态机收敛

**涉及文件**

- `src/research/service.mjs`
- `src/research/state.mjs`
- `prototype/manager.mjs`
- `prototype/tests/research-state.test.mjs`
- `prototype/tests/research.test.mjs`

**问题**

Research Service 与 Research State 各自维护 active、terminal、cancellation、capture 和 finalizing 判断。状态语义重复后，批次聚合与单个 shard 决策容易漂移。

**方案**

把状态判断、批次聚合和可执行动作收进 Research State Module。Service 只负责读取记录、调用状态机、持久化投影并执行动作；manager 不再推断 Research 内部状态。

**必须保持**

- shard 独立 scratch workspace、部分失败保留、等待超时、取消和报告聚合。
- 现有状态字段、错误模式和事件顺序兼容。

**验收**

- 状态机测试覆盖 active/terminal、cancel、capture、finalize 和部分失败。
- `research-state`、`research` 目标测试及 `npm test` 通过。

## 阶段 3：TaskRepository 持久化一致性

**涉及文件**

- `src/tasks/repository.mjs`
- `prototype/tests/task-lifecycle.test.mjs`
- 新增或扩展仓储故障测试

**问题**

`save()` 当前可能先更新内存索引，再写 `task.json`。原子写失败时，内存记录与磁盘事实会分叉，后续读取可能返回从未持久化的任务。

**方案**

把“持久化成功后再发布内存状态”设为唯一顺序；若底层需要预占索引，则在写失败时精确撤销本次改动，不触碰其他任务。为注入写失败增加最小 seam。

**必须保持**

- 原子写、事件序号、并发保存和兼容读取行为不变。
- 失败后同一仓储实例可继续正常保存其他任务。

**验收**

- 新测试证明写失败不改变 `get/list` 可见状态。
- 失败后的重试成功，且不会留下临时文件。
- `task-lifecycle` 目标测试及 `npm test` 通过。

## 阶段 4：RuntimeOutcomeSettlement Module

**涉及文件**

- `src/runtime/*`
- `prototype/manager.mjs`
- `prototype/tests/runtime-module.test.mjs`
- `prototype/tests/reliability.test.mjs`

**问题**

`settleTerminal`、`settleMissingTerminal`、`settleWorkerBusy`、`settleAckTimeout` 分散组合任务状态、运行时记录、事件、持久化和 fallback 交接。manager 必须理解进程结局与任务结局之间的隐式时序。

**方案**

建立 RuntimeOutcomeSettlement Module，输入已确认的运行时事实与当前任务，输出新的任务/运行时投影、事件和待执行动作。manager 只负责持久化和执行动作。

**必须保持**

- 已验证退出、PID 身份不一致、PID 消失、worker busy、ack timeout 的现有语义。
- 已终结轮次结果不被覆盖，事件序号保持单调。

**验收**

- 每个结局分支可直接通过 Module 接口测试。
- `runtime-module`、`reliability` 目标测试及 `npm test` 通过。

## 阶段 5：TaskCommand Module

**涉及文件**

- `src/tasks/*`
- `prototype/manager.mjs`
- `prototype/tests/task-transaction.test.mjs`
- `prototype/tests/manager.test.mjs`

**问题**

`createTask`、`rework`、`preflightCreate` 仍由 manager 同时完成请求校验、策略判定和事务输入构造。命令意图、拒绝原因与副作用边界没有集中在一个 Module。

**方案**

把命令解析、校验、preflight 结果和事务输入构造收进 TaskCommand Module。manager 只负责查询必要上下文、调用命令 Module、执行事务并返回兼容响应。

**必须保持**

- 非法请求不写任务、不新增轮次、不消耗预算。
- 现有错误文本、provider fallback、workspace 策略和兼容字段不变。

**验收**

- 命令 Module 覆盖 create/rework/preflight 的允许与拒绝矩阵。
- 非法命令无副作用；合法命令生成的持久化投影与旧接口一致。
- `task-transaction`、`manager` 目标测试及 `npm test` 通过。

## 每阶段提交门禁

- 先运行目标测试，再运行 `npm test`。
- 运行 `npm run check:release-tree`；发布清单必须包含新增 Module 和测试。
- 检查 `git diff --check`、`git diff --stat`、`git status --short` 和 staged 文件清单。
- 只暂存本阶段明确文件；禁止整体暂存或提交主工作区。
- 使用显式 noreply 身份提交，提交信息说明对应深化 Module。
- 提交后推送到 `waxwing/release/deepening-round3`，但不推送 `waxwing/main`。

## 最终验证

- `npm test`
- `npm run check:release-tree`
- `npm run package:smoke`
- `npm run desktop:resources`
- `npm --prefix desktop run build`
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`
- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml`
- 敏感文件名与内容扫描，排除凭据、令牌、私钥、个人路径和生成目录。
- `git diff --check`、提交内容审计、远程分支与提交哈希核对。

## 推送条件与收尾

只有以下条件全部满足才推送：

- 五个阶段和完成审计均已提交。
- JavaScript、Rust、Vue、发布树、冒烟、桌面资源与安全检查全部通过。
- 差异只包含本轮计划、实现、测试和必要文档。
- 旧远程 `origin` 未被修改或推送，`waxwing/main` 未被直接写入。
- 分支基于 `b5750ea8e58f64d94e7b408f7d9cee3ab27dc2ea` 或明确记录的后续提交。

推送后记录分支名、远程 SHA、提交链和测试结果。如果任何门禁失败，停止推送并报告失败点。

## 完成审计

状态：已完成并推送到 `waxwing/release/deepening-round3`。

### 实施证据

- Usage Module：`src/usage/module.mjs`，统一用量快照、限额、override 与返工决策；manager 改用该 Module。
- Research 状态机收敛：`src/research/service.mjs` 复用 `src/research/state.mjs`，删除重复的 active、terminal、聚合与 shard 判断。
- TaskRepository 一致性：`save()` 改为先原子持久化，再发布内存索引；失败不会污染 `get/list`。
- RuntimeOutcomeSettlement：`src/runtime/outcome.mjs` 统一终态、首轮 fallback、缺失终态、worker busy 和 ACK timeout 投影。
- TaskCommand Module：`src/tasks/command.mjs` 统一 create/rework 校验顺序、preflight 输入和事务输入。
- 公共导出与发布清单：`src/app.mjs`、`scripts/check-release-tree.mjs` 已接入三个新 Module。

### 测试证据

- JavaScript：`222/222` 通过。
- Rust：`4/4` 通过；`cargo fmt` 与 `cargo check` 通过。
- Vue 生产构建：通过。
- 打包冒烟与桌面资源准备：通过。
- 发布树检查：`236` 个文件通过。
- `git diff --check`：通过。

### 发布证据

- 分支：`release/deepening-round3`。
- 实现起点：`b5750ea8e58f64d94e7b408f7d9cee3ab27dc2ea`。
- 远程 SHA：`fc6dbf8cfe5617690918ed7c1a17b6af3668ce22`。
- 旧远程 `origin`（`quanertsuki/DS_subagent`）未修改、未推送。
- `waxwing/main` 未被直接写入。
- 未创建 tag 或 GitHub Release，未发布 npm。
