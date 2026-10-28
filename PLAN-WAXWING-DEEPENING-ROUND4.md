# Waxwing 深化改造第四轮计划

日期：2026-10-28

## 目标

基于第三轮完成后的真实代码，继续把分散在 manager、适配器、持久化与生命周期流程中的时序和契约收进深 Module。第四轮只写计划与候选，不在本轮立即实施；后续每项单独执行、测试、提交和推送。

本轮建议起点为 `release/deepening-round3` 推送后的 HEAD。继续遵守以下约束：

- 不在主工作区整体暂存、提交、恢复或清理。
- 不修改或推送旧远程 `origin`（`quanertsuki/DS_subagent`）。
- 不直接推送 `waxwing/main`，不创建 tag 或 GitHub Release，不发布 npm。
- 不新增人工请求数、工具调用数或费用上限；现有 opt-in 限额语义保持不变。
- 每项先建立目标测试，再做实现；每项通过目标测试和完整 JavaScript 测试后单独提交。
- 全部实现与文档完成后运行发布树、打包、桌面、Rust 和安全门禁；只有全部通过才推送专用发布分支。

## 候选 1：Task 只读视图跨适配器契约 Module

**涉及文件**

- `src/tasks/view.mjs`
- `prototype/tests/task-view.test.mjs`
- `desktop/src-tauri/src/tasks.rs`
- `desktop/src/views/Tasks.vue`
- `desktop/src/components/TaskDetail.vue`
- `desktop/src/components/TaskDetailPanel.vue`
- 可新增 `desktop/src/types/task-contract.ts` 与契约测试

**问题**

JavaScript 已有 `TASK_LIST_FIELDS` 和 `TASK_DETAIL_FIELDS`，但 Rust DTO、两个 Vue 组件的局部 `interface` 仍手工重复字段。字段可选性、空值和新增字段没有跨语言门禁；一次 JS 字段变更可能只在生产构建或手动操作时才暴露。

**方案**

把只读 task list/detail 的字段名、可空性和标签语义收进一个可生成或可校验的契约 Module。Rust 反序列化测试与 Vue 类型检查共同消费该契约；组件只负责布局，不重新声明业务字段。禁止让该 Module 获得任何写操作能力。

**收益**

- Locality：字段漂移集中在一个契约 Module 和一组门禁，而不是散落在 JS、Rust、Vue。
- Leverage：CLI、MCP、桌面端读取同一份稳定字段语义。
- 测试：新增契约消费测试、Rust 最小/完整响应测试和 Vue 类型/构建门禁。

## 候选 2：Acceptance Artifact Transaction Module

**涉及文件**

- `src/acceptance/service.mjs`
- `src/tasks/transaction.mjs`
- `prototype/manager.mjs`
- `prototype/tests/acceptance-module.test.mjs`
- `prototype/tests/task-transaction.test.mjs`

**问题**

验收与报告仍存在多步隐式顺序：`acceptAndSave` 先写报告再保存任务；报告写入本身不是原子操作；`removeTaskAndForget` 先删除 scratch 再清理索引。失败时调用方必须记住哪一侧已生效、是否回滚、如何保留有效证据。

**方案**

建立 Acceptance Artifact Transaction Module，把报告临时文件与原子替换、哈希、验收记录、grant 撤销、任务保存和删除后的索引清理收进一个显式事务。提供可注入的持久化失败 seam，定义每一步失败后的补偿与保留规则；manager 只执行模块返回的动作。

**收益**

- Locality：验收、报告、哈希、grant 和删除顺序集中在一处。
- Leverage：调用方不再自行拼装“先写哪个、失败保留什么”。
- 测试：可覆盖报告写失败、任务保存失败、删除后索引失败、grant 撤销失败和重试恢复。

## 候选 3：Research Service 拆分

**涉及文件**

- `src/research/service.mjs`
- `src/research/state.mjs`
- `prototype/manager.mjs`
- `prototype/tests/research.test.mjs`
- `prototype/tests/research-state.test.mjs`

**问题**

第三轮已收敛状态判断，但 Research Service 仍约 540 行，同时承担批次校验、持久化、refresh、capture、关闭、报告、等待和取消。状态的纯函数虽然可测，真实 bug 仍可能藏在 refresh 与关闭动作的调用顺序里。

**方案**

按真实副作用拆分 Research Batch Repository、Terminal Capture 与 Report Collection Module。保留 `ResearchBatchService` 作为兼容 facade，但让它只编排三个深 Module；状态机继续由 `state.mjs` 唯一拥有。

**收益**

- Locality：持久化、终态捕获和报告聚合各自集中，refresh 只负责顺序编排。
- Leverage：新增 Research 适配器不需要理解 batch.json、shard 文件和报告目录。
- 测试：可从接口测试部分失败、关闭竞态、重复收集和报告哈希，而不依赖完整 manager。

## 候选 4：Runtime / Workspace Close Outcome Module

**涉及文件**

- `src/tasks/transaction.mjs`
- `src/runtime/lifecycle.mjs`
- `src/runtime/module.mjs`
- `src/workspace/lease-manager.mjs`
- `prototype/manager.mjs`
- `prototype/tests/task-transaction.test.mjs`
- `prototype/tests/runtime-lifecycle.test.mjs`
- `prototype/tests/workspace-lease-module.test.mjs`

**问题**

`TaskTransaction.stop()` 约 70 行，混合 graceful close、force exit、退出确认、runtime 记录清理、最终任务转换、报告写入和租约保留。调用方必须理解进程事实与任务终态之间的时序。

**方案**

建立 Runtime / Workspace Close Outcome Module，输入已确认的优雅退出、强制退出、退出未确认、close error 和租约事实，输出任务投影、待执行动作与明确保留理由。`TaskTransaction` 只执行动作和持久化，不再自行组合进程与租约语义。

**收益**

- Locality：关闭时的进程、任务与租约决策集中。
- Leverage：cancel、close、shutdown 和超时停止共享同一结局解释。
- 测试：可直接覆盖每个退出分支、锁保留和 force-exit 失败，不依赖长时进程。

## 候选 5：Workspace Lease Lifecycle Module 再深化

**涉及文件**

- `src/workspace/lease-manager.mjs`
- `src/workspace/git.mjs`
- `prototype/manager.mjs`
- `prototype/tests/workspace-lease-module.test.mjs`
- `prototype/tests/workspace.test.mjs`

**问题**

Lease Manager 已集中 plan/acquire/rollback/release，但仍同时承担路径占用、Git 材料化、租约持久化和清理策略。第四轮应先做删除测试：如果拆分只移动代码而不提高 Locality，则保留现状；若清理与材料化的失败补偿继续增长，再拆出 Workspace Materialization 与 Lease Release Module。

**方案**

先用失败注入测试找出 acquire/release 的真实补偿缺口，再决定是否拆 Module。新 Module 只有在调用方不再需要知道中间文件、rollback 顺序或 dirty 判定时才算深化；否则记录为不建议拆分。

**收益**

- Locality：所有材料化与清理失败都落在同一补偿模型。
- Leverage：manager 只看到租约结果和保留原因。
- 测试：覆盖材料化中途失败、清理竞态、路径消失和分支保留。

## 候选 6：UsageService 兼容 Adapter 清理

**涉及文件**

- `src/usage/service.mjs`
- `src/usage/module.mjs`
- `src/app.mjs`
- `prototype/tests/usage-module.test.mjs`
- `prototype/tests/usage.test.mjs`

**问题**

`UsageService` 目前只有转发方法，生产调用方已改用 `UsageModule`。它作为公开兼容导出仍有价值，但若不再被真实适配器使用，就是浅 facade；保留与删除需要由删除测试决定。

**方案**

审计所有外部导出与文档引用。若存在第二个真实 Adapter，则让 `UsageService` 成为 `UsageModule` 的兼容 Adapter 并测试相同语义；若只有一个假想 Seam，则在 `0.2.0` 兼容窗口内标记弃用，而不是继续扩展它的接口。

**收益**

- Locality：避免同一用量语义维护两套实现。
- Leverage：兼容调用方获得与主 Module 相同的降级和限额行为。
- 测试：比较兼容 Adapter 与主 Module 的 allow/warn/block/unavailable 结果。

## 执行顺序建议

1. 候选 1：先建立跨 JS/Rust/Vue 契约门禁，风险低、收益直接。
2. 候选 2：处理验收报告的原子性与补偿，优先消除数据一致性风险。
3. 候选 4：收敛关闭流程，复用已有的 RuntimeLifecycle 事实。
4. 候选 3：拆分 Research Service，保持兼容 facade。
5. 候选 5：先以失败注入测试判断是否需要拆分。
6. 候选 6：最后处理公开兼容层，避免在活跃迁移期删除 Seam。

每项均使用独立任务串行执行，`workspaceMode: "shared"`，避免自动工作树和并行修改冲突。完成后运行目标测试、`npm test`、发布树检查和 `git diff`，再决定是否进入下一项。

## 最终门禁

- `npm test`
- `npm run check:release-tree`
- `npm run package:smoke`
- `npm run desktop:resources`
- `npm --prefix desktop run build`
- `cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check`
- `cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml`
- `cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml`
- 敏感文件名与内容扫描，排除凭据、令牌、私钥、个人路径和生成目录。
- `git diff --check`、完整 staged 文件清单、远程分支与提交哈希核对。

只有以上门禁全部通过、差异只包含第四轮计划范围、旧远程 `origin` 未被触碰且 `waxwing/main` 未被直接写入时，才推送 `waxwing/release/deepening-round4`。如果任何门禁失败，停止推送并报告失败点。
