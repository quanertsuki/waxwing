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
