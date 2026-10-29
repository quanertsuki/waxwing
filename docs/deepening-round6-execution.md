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
