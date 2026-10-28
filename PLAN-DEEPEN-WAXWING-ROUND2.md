# Waxwing 深化改造第二轮执行计划

日期：2026-10-28

## 目标

继续按 `improve-codebase-architecture` 方法，把调用方必须记住的时序、授权和投影规则收进深 Module。六个阶段均已完成实现后统一跑全量门禁；仅当测试、构建、差异审查和安全检查全部通过时，推送到 GitHub `waxwing` 的专用发布分支。

本轮不新增人工请求数、工具调用数或费用上限。现有 opt-in 用量限额语义保持不变。

## 基线与安全约束

- 起点：`5776aff347404b2507a79c10ba9f39c9650d17fb`，即 `release/deepening-round1`。
- 发布分支：`release/deepening-round2`。
- GitHub `waxwing/main` 基线：`7b03ecac9503ef5c31c7a11bccece8046b1ddc13`。
- 第一轮验证基线：JavaScript 178/178，Rust 2/2，发布树 223 个文件，Vue 生产构建通过。
- 只在干净的 `I:\waxwing-release-main-sync` 工作树中修改、测试、提交和推送。
- 主工作区 `I:\waxwing` 的未提交内容不属于本轮；禁止整体暂存、提交或重置。
- 禁止 `git reset --hard`、`git restore`、`git checkout --`、`git clean`。
- 只操作远程 `waxwing`；旧远程 `origin` 保持只读。
- 不把 `RL2服务器相关/`、PDF、凭据、生成目录或测试临时目录纳入提交。

## 阶段 1：Runtime 恢复与关闭生命周期 Module

**涉及文件**

- 新增 `src/runtime/lifecycle.mjs`
- 修改 `src/app.mjs`
- 修改 `prototype/manager.mjs`
- 新增 `prototype/tests/runtime-lifecycle.test.mjs`
- 更新 `prototype/tests/run.mjs`
- 更新 `scripts/check-release-tree.mjs`
- 更新 `docs/architecture.md`

**问题**

manager 同时判断进程是否存活、身份是否匹配、任务是否可恢复、`runtime.json` 应写什么以及租约是否继续锁定。恢复、关闭和异常退出路径容易产生不同的状态解释。

**接口**

`RuntimeLifecycle` 接收运行时记录、任务记录、`verified/alive/exitConfirmed` 事实和显式终止动作，返回新的运行时/任务投影及待执行动作。manager 只执行终止并持久化结果。

**必须保住**

- 已验证 PID 才允许终止并解除租约。
- PID 存在但身份不一致时保留锁并标记人工处理。
- PID 消失时允许转为可恢复的失败终态。
- 关闭时进程退出未确认时保持 `stopping`、句柄和租约。
- 恢复不得覆盖已终结轮次的结果或事件序号。

**验收**

先跑 `node prototype/tests/run.mjs` 中的目标测试，再跑完整 `npm test`、发布树检查和差异检查。

## 阶段 2：Acceptance / Report / Deletion Authorization Module

**涉及文件**

- 修改 `src/acceptance/service.mjs`
- 修改 `prototype/manager.mjs`
- 新增 `prototype/tests/acceptance-module.test.mjs`
- 更新 `prototype/tests/run.mjs`

**问题**

报告、哈希、删除预览、授权文件和删除执行集中在 service，但 manager 仍拼接生命周期转换、保存、事件和撤销顺序；删除授权链缺少直接接口测试。

**接口**

提供拒绝删除的统一条件、授权绑定当前预览指纹、完整任务 ID 确认和撤销旧授权的高层动作。manager 只负责查询、生命周期校验、事件和持久化。

**必须保住**

- 未关闭或 Runtime 存活时拒绝预览。
- 报告缺失或哈希不一致时拒绝删除。
- 预览后清单变化导致授权指纹失效。
- 授权 scope、任务 ID 或指纹不匹配时拒绝。
- 成功删除只移除任务 scratch，保留报告、项目工作区和分支。
- 接受或返工后旧报告哈希和授权被撤销。

**验收**

直接通过 Module 测试完整授权链；现有 compact、execution-limits、reliability 回归通过。

## 阶段 3：Task 命令与持久化事务 Module

**涉及文件**

- 修改 `src/tasks/transaction.mjs`
- 修改 `prototype/manager.mjs`
- 新增或扩展 `prototype/tests/task-transaction.test.mjs`

**问题**

`executeRun` 仍自行组合旧预算/限额读取、provider 解析、验收撤销、新轮次保存和 runtime 发送；部分失败时哪些字段可写仍由 manager 记忆。

**接口**

为 `rework` 与 `run` 建立统一事务接口，接收已校验请求和环境，返回新任务记录、待写事件和派发信息。保持 provider fallback、事件序号和预算继承语义。

**必须保住**

- 非法 rework 不新增轮次、不修改预算、不撤销验收。
- 首次派发失败留下可追踪的失败任务。
- fallback 只发生一次，旧轮次结果不被覆盖。
- 事件序号单调递增。

**验收**

事务接口直接覆盖成功、拒绝和失败分支；manager、MCP 和 CLI 回归通过。

## 阶段 4：Workspace 租约占用、材料与清理生命周期 Module

**涉及文件**

- 修改 `src/workspace/lease-manager.mjs`
- 修改 `src/workspace/git.mjs`
- 修改 `prototype/manager.mjs`
- 扩展 `prototype/tests/workspace-lease-module.test.mjs`
- 回归 `prototype/tests/workspace.test.mjs`

**问题**

manager 的 `workspaceConflict` 仍自行遍历任务并判断用户态观察到的 runtime 句柄；占用规则同时散落在 manager 与租约 Module。

**接口**

把当前任务快照到可占用冲突的投影收进 Module，提供 `conflictFor(workspace)`；`acquire` 组合占用检查、材料化和失败回滚。清理返回可观察结果：已移除、脏保留、Runtime 保留、路径缺失。

**必须保住**

- `auto`、`worktree`、`shared` 语义与脏仓库拒绝。
- 相同、包含、嵌套和大小写变体路径判定一致。
- 运行中、停止中或仍有 runtime 句柄的任务继续锁定租约。
- 材料化失败回滚工作树，不遗留目录。
- dirty worktree 拒绝清理，分支保留。

**验收**

真实 Git 仓库和注入任务快照直接覆盖 Module；workspace 与管理器回归通过。

## 阶段 5：Task 只读视图契约（CLI / MCP / Rust / Vue）

**涉及文件**

- 修改 `src/tasks/view.mjs`
- 修改 `prototype/manager.mjs`
- 修改 `prototype/cli.mjs` 和 `prototype/mcp.mjs`（仅契约接线）
- 修改 `desktop/src-tauri/src/tasks.rs`
- 修改 `desktop/src/views/Tasks.vue` 和 `desktop/src/components/TaskDetailPanel.vue`
- 扩展 `prototype/tests/task-view.test.mjs`

**问题**

JS 列表、summary、分页字段与 Rust 结构及 Vue 局部接口各自维护；详情接口仍是 `serde_json::Value`。

**接口**

在 `src/tasks/view.mjs` 定义稳定只读 list/summary/detail/page 契约，Rust 使用类型化结构接收对应字段，Vue 类型跟随同一语义。禁止改变生命周期写操作。

**必须保住**

- 列表、摘要、详情对同一任务产生一致状态和工作区标签。
- 空结果、截断标记、分页末页和 surrogate pair 边界。
- Rust 能反序列化新字段，旧响应缺少可选字段仍可用。
- Vue 生产构建通过。

**验收**

JS 契约测试、Rust 反序列化测试、`npm run desktop:resources`、Vue 构建、`cargo fmt/check/test`。

## 阶段 6：Usage 与执行策略 Module 第二阶段

**涉及文件**

- 修改 `src/usage/policy.mjs`
- 修改 `src/usage/service.mjs`
- 修改 `prototype/usage.mjs`
- 修改 `prototype/manager.mjs`
- 扩展 `prototype/tests/usage-policy.test.mjs`

**问题**

usage snapshot 的 unavailable 降级仍在 manager 和 `prototype/usage.mjs` 重复构造；执行策略读取、附加文本和报告快照也仍由 manager 拼接。

**接口**

让 Usage 策略 Module 提供完整快照投影，统一 `available`、`costComplete`、`limits`、`limitState` 和告警字段。把执行策略读取、本轮附加文本与报告快照收进一个小 Module。

**必须保住**

- 限额默认关闭。
- 用量或费用不可靠时不阻断。
- 任务级字段继承全局字段。
- override 只影响本轮，下一轮重新评估。
- 策略文件缺失、为空或变化时警告与报告哈希保持历史一致性。

**验收**

直接策略矩阵测试；usage、execution-limits、MCP 和 CLI 回归通过。

## 最终门禁

1. `npm test`
2. `npm run check:release-tree`
3. `npm run package:smoke`
4. `npm run desktop:resources`
5. `npm --prefix desktop run build`
6. `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`
7. `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`
8. `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml`
9. 审查 `git diff --check`、完整 staged/unstaged 清单、未跟踪文件和敏感路径。

## 推送条件

只有全部门禁通过、差异只含本计划范围、发布树不含生成物或秘密时才推送。推送目标为 `waxwing` 的 `release/deepening-round2`，并记录提交哈希与远程分支。

不创建 tag 或 GitHub Release；不发布 npm。若 GitHub 权限或分支保护阻止创建/合并 PR，保留已推送分支并报告，不绕过保护。

## 完成审计

状态：已完成并推送到 `waxwing/release/deepening-round2`。

### 实施证据

- 起点：`5776aff347404b2507a79c10ba9f39c9650d17fb`。
- 阶段 1：`bd93e7f`（`Deepen runtime recovery and close lifecycle`）。
- 阶段 2：`6a471b2`（`Deepen acceptance and deletion authorization`）。
- 阶段 3：`c614413`（`Deepen task dispatch transactions`）。
- 阶段 4：`85a38c5`（`Deepen workspace conflict projection`）。
- 阶段 5：`481d5d0`（`Deepen task read view contract`）。
- 阶段 6：`b5750ea8e58f64d94e7b408f7d9cee3ab27dc2ea`（`Deepen usage and execution policy`）。
- 计划提交：`33f3b9f`（`Add second deepening execution plan`）。

### 测试证据

- JavaScript：`205/205` 通过。
- Rust：`4/4` 通过；`cargo fmt` 与 `cargo check` 通过。
- Vue 生产构建：通过。
- 打包冒烟与桌面资源准备：通过。
- 发布树检查：`228` 个文件通过。
- 敏感文件扫描与 `git diff --check`：通过。

### 推送证据

- 分支：`waxwing/release/deepening-round2`。
- HEAD：`b5750ea8e58f64d94e7b408f7d9cee3ab27dc2ea`。
- 旧远程 `origin`（`quanertsuki/DS_subagent`）未修改、未推送。
- `waxwing/main` 未被直接写入。
- 未创建 tag 或 GitHub Release，未发布 npm。
