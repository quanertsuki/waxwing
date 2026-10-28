# Waxwing 深化改造执行计划

## 目标

按顺序完成五项深化改造，保持 `0.1` 兼容接口不变，最终在完整验证通过后推送到 GitHub 的 `waxwing` 远程。

## 不可破坏的约束

- `prototype/manager.mjs` 继续是 `0.1.x` 兼容 facade；适配器和桌面端不直接写任务状态。
- 不修改或推送旧远程 `origin`（`DS_subagent`）。
- 不使用 `git reset --hard`、`git restore`、`git checkout --`、`git clean`。
- 不覆盖工作区已有改动；每个阶段的改动必须能在 `git diff` 中单独识别。
- 不新增人工请求数、工具调用或费用上限；现有 opt-in 限额语义保持不变。
- 所有文件使用 ASCII，除非现有文档已经使用中文。
- 阶段完成后先跑该阶段的目标测试，再跑 `npm test`；最终增加发布树、桌面构建和 Rust 检查。

## 阶段 0：基线和安全网

- 记录 `npm test`、`npm run check:release-tree` 的基线。
- 记录 `waxwing/main`、当前 `HEAD` 和 `5041e99` 的关系，避免误用旧历史。
- 为本计划涉及的模块建立最小契约测试，先在现有接口上跑绿，再重构。

## 阶段 1：Task 生命周期与持久化事务 Module

- 文件：`src/tasks/lifecycle.mjs`、`src/tasks/repository.mjs`、`prototype/manager.mjs`、相关测试。
- 深化方向：把创建、恢复、关闭/取消、返工许可所需的顺序、补偿和持久化收进一个事务 Module；manager 只保留编排接线。
- 必须保住：任务目录原子写入、失败回滚、恢复时 runtime 身份校验、现有错误文本和状态转换。
- 验收：直接通过 Module 测试成功/拒绝/崩溃恢复；manager 兼容测试不回归。

## 阶段 2：Workspace 租约全生命周期 Module

- 文件：`src/workspace/lease-manager.mjs`、`src/workspace/git.mjs`、`prototype/manager.mjs`、相关测试。
- 深化方向：统一计划、占用、材料化、失败回滚、保留和清理；manager 不再自己拼租约时序。
- 必须保住：`auto`、`worktree`、`shared` 语义；脏仓库拒绝；占用路径检查；关闭后保留分支。
- 验收：真实 Git 仓库覆盖 worktree 成功、脏仓库拒绝、共享模式、回滚和 cleanup；manager/workflow 测试不回归。

## 阶段 3：Task 只读视图契约 Module

- 文件：`src/tasks/view.mjs`（新建）、`prototype/manager.mjs`、`desktop/src-tauri/src/tasks.rs`、`desktop/src/views/*`、`desktop/src/components/TaskDetail*.vue`、相关测试。
- 深化方向：集中生成摘要、详情和分页响应契约，消除 JS、Rust、Vue 各自维护的字段和状态标签。
- 必须保住：分页边界、截断标记、空值、`cleanupAuthorized`、`runtimeHealth`、workspace/lease 字段和兼容字段。
- 验收：契约测试覆盖字段和边界；Rust 反序列化仍有测试；Vue 生产构建通过。

## 阶段 4：Usage 与执行策略 Module

- 文件：`src/usage/service.mjs`、`prototype/usage.mjs`、`prototype/manager.mjs`、相关测试。
- 深化方向：统一用量快照、限额状态、执行策略和本轮允许/警告/阻断判定；override 仍只影响本轮。
- 必须保住：限额默认关闭、不可用 usage 不阻断、成本不可靠不阻断、overridden round 的事件记录和下一轮重新评估。
- 验收：策略矩阵直接测试；现有 `execution-limits`、`usage` 和 MCP schema 测试不回归。

## 阶段 5：Research 批次编排 Module

- 文件：`src/research/service.mjs`、`prototype/manager.mjs`、`src/tasks/repository.mjs`、相关测试。
- 深化方向：明确 Research 批次与普通 Task 的关系、恢复、等待、取消和关闭规则，减少 manager 回调造成的隐式契约。
- 必须保住：每个 shard 独立 scratch workspace、部分失败保留、等待超时、取消和报告聚合。
- 验收：批次状态机测试；现有 research、manager、MCP 和 CLI 测试不回归。

## 阶段 6：最终验证

- `npm test`
- `npm run check:release-tree`
- `npm run desktop:build`
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`
- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml`
- 检查 `git diff`、未跟踪文件、秘密扫描相关路径和发布树文件总数。

## 阶段 7：GitHub 推送

只有以下条件全部满足才推送：

- 所有测试和构建通过。
- 差异只包含本计划内的改动和必要的测试/文档。
- 生成的文件没有进入发布树。
- 提交在基于 `5041e99`/`waxwing/main` 的安全分支上；不回写旧 `origin`，不强推 `main`。
- 推送目标明确为 `waxwing` 远程。

推送后记录远程分支、提交哈希和 PR 链接（如果创建 PR）。如果验证失败，停止并报告失败点，不推送。

## 完成审计

状态：已完成并推送到 `waxwing/release/deepening-round1`。

### 实施证据

- 起点：`7b03ecac9503ef5c31c7a11bccece8046b1ddc13`。
- 实现提交：`5776aff347404b2507a79c10ba9f39c9650d17fb`（`Deepen task, workspace, usage, and research modules`）。
- 阶段 1：`src/tasks/lifecycle.mjs`、`src/tasks/transaction.mjs`、`src/tasks/repository.mjs` 与 `prototype/manager.mjs` 完成创建、停止、返工和持久化事务收拢。
- 阶段 2：`src/workspace/lease-manager.mjs` 与 `prototype/manager.mjs` 完成租约占用、材料化、回滚和清理边界。
- 阶段 3：`src/tasks/view.mjs`、`desktop/src-tauri/src/tasks.rs`、桌面视图与 `prototype/manager.mjs` 完成只读视图契约。
- 阶段 4：`src/usage/policy.mjs`、`prototype/usage.mjs` 与 `prototype/manager.mjs` 完成用量、限额、override 和执行策略组合。
- 阶段 5：`src/research/state.mjs` 与 `src/research/service.mjs` 完成 Research 批次和 shard 状态机。

### 测试证据

- JavaScript：`178/178` 通过。
- Rust：`2/2` 通过。
- Vue 生产构建：通过。
- 发布树检查：`223` 个文件通过。

### 推送证据

- 分支：`waxwing/release/deepening-round1`。
- 旧远程 `origin`（`quanertsuki/DS_subagent`）未修改、未推送。
- `waxwing/main` 未被直接写入。
- 未创建 tag 或 GitHub Release，未发布 npm。
