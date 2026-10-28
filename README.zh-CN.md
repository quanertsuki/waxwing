# Waxwing

[![CI](https://github.com/quanertsuki/waxwing/actions/workflows/ci.yml/badge.svg)](https://github.com/quanertsuki/waxwing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Waxwing 是一个本地优先的委派管理器，面向 DeepSeek 和兼容 OpenAI 的编码
Agent。亲代 Agent 定义任务与验收标准，执行 Agent 实现任务，亲代 Agent
再独立检查证据，并决定返工、验收或关闭。

CLI、MCP stdio 和 Tauri 桌面端是同一管理器的三个入口。管理器只监听
`127.0.0.1`。当前 `0.1.0` 是面向可信本机用户和可信委派 Agent 的预览版，
不是多租户或公网服务。

[English](README.md) · [架构](docs/architecture.md) · [贡献](CONTRIBUTING.md) · [安全](SECURITY.md)

![Waxwing 系统架构](docs/assets/system-architecture.svg)

## 为什么选择 Waxwing

- **无需控制平面**：任务和证据留在本机，不依赖托管服务。
- **Provider 中立**：支持 DeepSeek Harness，也支持任意兼容 OpenAI Chat
  Completions 的端点。
- **独立验收**：执行 Agent 声称“完成”不等于验收通过。亲代 Agent
  必须记录自己实际执行的检查和证据。
- **可靠轮次租约**：`roundId`、ACK、心跳、终态和 `released` 组成显式协议，
  返工与 Provider 回退不会在结果刚落盘时抢占同一运行时。
- **工作区隔离**：干净的 Git 仓库默认使用独立 worktree；非 Git 目录使用共享
  工作区排他锁。
- **并行研究分片**：一个批次可把多个只读资料、网页或仓库调查并行交给不同
  执行 Agent，最后汇总为一份带来源的报告。
- **默认不限制请求和费用**：只有显式启用阈值时才告警或阻断。
- **有界接口**：默认 CLI/MCP 响应保持精简；结果、报告、历史、用量、工作区、
  Diff 和日志按需分页。

## 安装

需要 Node.js 20 或更高版本。

`0.1.0` 尚未发布到 npm registry。发布前请从
[v0.1.0 Release](https://github.com/quanertsuki/waxwing/releases/tag/v0.1.0)
下载 `waxwing-0.1.0.tgz`，再安装该文件：

```bash
npm install -g ./waxwing-0.1.0.tgz
waxwing health
waxwing
```

npm registry 发布完成后，推荐安装命令为 `npm install -g @quanernya/waxwing`。

安装包提供两个命令：

- `waxwing`：CLI 与交互式任务控制台
- `waxwing-mcp`：MCP stdio 服务

也可以直接从源码运行：

```bash
git clone https://github.com/quanertsuki/waxwing.git
cd waxwing
node bin/waxwing.mjs health
```

## 快速开始

### 1. 选择 Provider

默认配置假定 DeepSeek Harness 与 Waxwing 位于同级目录：

```text
workspace/
  waxwing/
  deepseek-harness/
```

路径不同时，创建本机覆盖文件：

```powershell
Copy-Item prototype/config.local.example.json prototype/config.local.json
```

使用 OpenAI 兼容端点时，把 `examples/providers/openai-compatible.json`
复制到 `<WAXWING_HOME>/providers`（默认目录见下文），设置 `apiKeyEnv`，
再把 `defaultProvider` 指向该 Provider。API Key 只从环境变量读取，不会复制
到任务数据中。

`maxToolRequests` 省略、为 `null` 或为 `0` 时都表示无工具循环上限。

### 2. 创建任务

```bash
waxwing create @task.json
```

`task.json` 示例：

```json
{
  "workspace": "C:\\work\\my-project",
  "workspaceMode": "auto",
  "prompt": "Implement the requested feature and run the tests.",
  "plan": "Inspect, implement, test.",
  "criteria": "Independent tests pass and the diff is limited to the requested behavior."
}
```

`workspaceMode` 取值：

| 值 | 行为 |
| --- | --- |
| `auto` | 干净 Git 仓库使用隔离 worktree；非 Git 目录使用共享锁；脏 Git 仓库拒绝创建 |
| `worktree` | 要求干净 Git 仓库并使用隔离 worktree |
| `shared` | 明确在原始目录中执行 |

### 3. 检查、验收与返工

```bash
waxwing wait task-xxxxxxxxxxxx
waxwing wait task-xxxxxxxxxxxx --timeout 300
waxwing status task-xxxxxxxxxxxx
waxwing status task-xxxxxxxxxxxx --view result
waxwing status task-xxxxxxxxxxxx --view report
waxwing status task-xxxxxxxxxxxx --view workspace
waxwing status task-xxxxxxxxxxxx --view diff
waxwing status task-xxxxxxxxxxxx --view log
waxwing rework @rework.json
waxwing accept @acceptance.json
waxwing close task-xxxxxxxxxxxx
```

可用分页视图：`result`、`history`、`usage`、`report`、`workspace`、`diff`
和 `log`。大内容使用 `--offset` 与 `--limit`。

`wait` 是管理器内的单次阻塞调用：任务停止运行时立即返回；超时则返回当前
有界摘要，并带有 `wait.timedOut: true`。默认截止时间为
`roundTimeoutSeconds + 30`。

验收证据应记录亲代 Agent 实际执行的检查，而不是重复执行 Agent
的完成声明。

### 4. 并行研究分片

当一个亲代 Agent 需要同时阅读多篇文章、网页或项目时，使用研究批次。每个
分片拥有独立 scratch 工作区，因此可以真正并发运行，不会写入源项目，也不会
互相覆盖文件。

`research.json`：

```json
{
  "title": "对比候选项目",
  "question": "哪个项目更适合，为什么？",
  "commonPrompt": "引用来源，并明确说明不确定性。",
  "shards": [
    {
      "id": "alpha",
      "subject": "分析 Project Alpha",
      "url": "https://github.com/example/alpha",
      "focus": "架构与许可证"
    },
    {
      "id": "beta",
      "subject": "分析 Project Beta",
      "url": "https://github.com/example/beta",
      "focus": "维护活跃度与测试覆盖"
    }
  ]
}
```

```bash
waxwing research-start @research.json
waxwing research-wait research-xxxxxxxxxxxx
waxwing research-status research-xxxxxxxxxxxx
waxwing research-collect research-xxxxxxxxxxxx
```

`research-wait` 用一次调用等待整个批次，也支持 `--timeout`。成功的分片
运行时会自动关闭；某个分片失败时，其他已完成结果仍会保留。
`research-collect` 把汇总报告写入 `<WAXWING_HOME>/reports`，可用 `--offset`
和 `--limit` 分页读取。scratch 工作区默认位于 `<WAXWING_HOME>-research`，
可用 `WAXWING_RESEARCH_ROOT` 覆盖。

研究批次只用于只读调查和综合。多个执行 Agent 不应在同一物理项目目录中并行
写入；需要并行写代码时，应为每个任务使用独立 worktree，或通过 `shared`
串行修改。

## MCP

让 MCP 客户端运行：

```bash
waxwing-mcp
```

公开工具使用 `waxwing_*` 前缀。完整的 `ds_*` 工具目录在 `0.1.x` 中继续
提供兼容，最早于 `0.2.0` 移除。

核心工具包括 `create`、`list`、`status`、`wait`、`rework`、`accept`、`cancel`、
`close`、`cleanup_worktree`、`export`、`preview_delete` 和 `delete`。
研究并行使用 `waxwing_research_start`、`waxwing_research_status`、
`waxwing_research_wait`、`waxwing_research_collect` 和
`waxwing_research_cancel`。

客户端配置示例见 [`integrations/`](integrations/)。

## 桌面端

开发模式：

```bash
cd desktop
npm ci
npm run tauri dev
```

在仓库根目录构建 Windows 便携版：

```powershell
npm run desktop:portable
```

压缩包包含桌面可执行文件、后端资源、Node sidecar、许可证、未签名提示和
文件校验清单。该版本**没有代码签名**，Windows SmartScreen 可能警告；运行
前应使用 Release 中的 `SHA256SUMS` 校验压缩包。

桌面端支持创建任务、返工、工作区模式选择、报告/结果分页、Git
status/diff、分支、基准提交、心跳健康、日志尾部和残留运行时状态。`0.1`
不包含 Kanban、拖拽、批量管理或 WebSocket。

## 单轮协议

```text
run → ack → events/heartbeat → result|error → released
```

结果不等于租约释放。返工与 Provider 回退都必须等待上一轮收到 `released`。
Worker 忙时返回明确的 `worker_busy`，不会静默丢弃轮次。每条轮次消息携带
`roundId`，每个任务事件带单调序号；旧轮次、重复和迟到消息不会覆盖当前结果。

Worker 每 5 秒发送心跳。20 秒无心跳只把运行时标记为 `unhealthy`，不会自动
终止进程。管理器重启后，只有 PID、任务 ID、owner marker 和命令行全部匹配时
才终止残留进程；无法确认归属时保留工作区锁并提示人工处理。

详见 [docs/architecture.md](docs/architecture.md)。

## 数据与迁移

默认数据目录：

- Windows：`%LOCALAPPDATA%\Waxwing`
- macOS：`~/Library/Application Support/Waxwing`
- Linux：`$XDG_DATA_HOME/waxwing` 或 `~/.local/share/waxwing`

`WAXWING_HOME` 可以覆盖该目录。首次启动会复制仓库内的旧数据，旧目录不会
删除；目标目录非空或复制失败时明确报错，不覆盖任何一侧。

任务目录是本地状态，不应作为 Worker Agent 的工作区。删除任务临时数据需要
独立的人类授权；项目文件和外部报告始终保留。

## 配置

配置层级：

1. `prototype/config.json` 或 `WAXWING_CONFIG`
2. `prototype/config.local.json` 或 `WAXWING_LOCAL_CONFIG`
3. 环境变量

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `WAXWING_HOME` | 每用户数据根目录 |
| `WAXWING_RESEARCH_ROOT` | 研究分片 scratch 工作区的父目录 |
| `WAXWING_CONFIG` | 主配置文件 |
| `WAXWING_LOCAL_CONFIG` | 本地覆盖文件 |
| `WAXWING_NODE` | Worker 使用的 Node 可执行文件 |
| `WAXWING_DSH_REPO` | DeepSeek Harness 检出目录 |
| `WAXWING_CREDENTIALS_FILE` | DSH 凭据存储 |
| `WAXWING_PROVIDERS_DIR` | Provider JSON 目录 |
| `WAXWING_PORT` | 回环管理器端口，默认 `43187` |
| `WAXWING_BACKEND_DIR` | 桌面端使用的自定义后端根目录 |

`0.1.x` 继续支持 `DSH_SUBAGENT_*` 和 `DSH_PROTOTYPE_*` 兼容别名。

## 安全模型

- 管理器只绑定 `127.0.0.1`，并要求随机 bearer token。
- 浏览器 Origin 请求一律拒绝。
- Worker 凭据从环境或凭据存储读取，不写入参数或任务 JSON。
- 与受管数据目录重叠的工作区会被拒绝。
- 只有身份完全匹配的 Waxwing 运行时进程可以被终止。
- 信任边界是本机操作系统账户；Waxwing 无法区分真人与同账户下的其他程序。

安全问题请通过 GitHub Private Vulnerability Reporting 上报，详见
[SECURITY.md](SECURITY.md)。

## 开发

```bash
npm test
npm run desktop:build
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
npm run package:smoke
```

核心测试不需要真实模型凭据。真实 Provider 检查会消耗额度，不进入默认 CI。

## 许可证

[MIT](LICENSE)
