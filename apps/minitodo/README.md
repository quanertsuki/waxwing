# MiniTodo

零第三方依赖的本地待办清单命令行工具，面向中文用户。默认输出易读的中文文本，同时支持 `--json` 供其他 Agent 或脚本消费。

- 入口：`todo.mjs`
- 运行环境：Node.js ≥ 24.12（使用内置 `node:test`，在本机 Node 24.12 上实测通过）
- 第三方依赖：无（`package.json` 中 `dependencies` 与 `devDependencies` 均为空）
- 数据：UTF-8 JSON 文件，默认位于**程序目录**的 `data/tasks.json`

## 快速开始

```powershell
node todo.mjs add "写周报" --priority high
node todo.mjs list
node todo.mjs done 1
node todo.mjs remove 1
node todo.mjs --help
node todo.mjs --version
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `add "任务标题" [--priority high\|normal\|low]` | 添加任务，默认优先级 `normal` |
| `list [--status pending\|done\|all] [--priority high\|normal\|low\|all]` | 查看任务，默认 `--status all` |
| `done <ID>` | 完成任务 |
| `remove <ID>` | 删除任务 |
| `--help` / `-h` | 显示帮助 |
| `--version` / `-V` | 显示版本 |

全局参数 `--data <路径>` 与 `--json` 可以写在命令的前面或后面：

```powershell
node todo.mjs --data .\data\tasks.json list
node todo.mjs list --data .\data\tasks.json --json
```

### 中文与特殊标题

标题允许中文、空格、标点。若标题以 `-` 开头，请用 `--` 分隔：

```powershell
node todo.mjs add -- --priority 只是标题的一部分
```

`--` 之后的所有内容都视为位置参数，因此 `--data` / `--json` 必须写在 `--` 之前。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 存储错误：C 盘路径被拒、文件损坏、读写失败、ID 无法安全分配 |
| `2` | 输入错误：未知命令/参数、空白标题、非法优先级或过滤器、非正整数 ID |

## JSON 输出

成功时 stdout 是 JSON，并且一定包含 `ok: true`：

```jsonc
// add / done
{ "ok": true, "task": { "id": 1, "title": "写周报", "priority": "high", "done": false, "createdAt": "2026-10-09T12:00:00.000Z", "completedAt": null } }
// list
{ "ok": true, "tasks": [ /* ... */ ] }
// remove
{ "ok": true, "deletedId": 1 }
```

失败时 **stdout 保持为空**，错误 JSON 写到 **stderr**：

```jsonc
{ "ok": false, "code": "EMPTY_TITLE", "error": "任务标题不能为空或只含空白", "message": "任务标题不能为空或只含空白" }
```

常见 `code`：`EMPTY_VALUE`、`EMPTY_TITLE`、`BAD_PRIORITY`、`BAD_STATUS`、`BAD_ID`、`MISSING_ID`、`NOT_FOUND`、`UNKNOWN_ARG`、`UNKNOWN_COMMAND`、`NO_COMMAND`、`CORRUPT`、`C_DRIVE_FORBIDDEN`、`ID_EXHAUSTED`、`READ_FAILED`、`WRITE_FAILED`。

## 文本输出示例

```text
$ node todo.mjs add "写周报" --priority high
已添加 #1 [high] 写周报

$ node todo.mjs list
[ ] #1 [high] 写周报

$ node todo.mjs done 1
已完成 #1 写周报

$ node todo.mjs list --status done
[x] #1 [high] 写周报 (完成于 2026-10-09T12:30:00.000Z)
```

## 数据文件格式

```jsonc
{
  "version": 1,
  "nextId": 3,          // 下一个要分配的 ID，始终大于所有已用 ID
  "tasks": [
    {
      "id": 1,
      "title": "写周报",
      "priority": "high",       // high | normal | low
      "done": false,
      "createdAt": "2026-10-09T12:00:00.000Z",
      "completedAt": null       // 完成时间为字符串，未完成时为 null
    }
  ]
}
```

要点：

- **ID 永不复用**：ID 由独立的 `nextId` 分配。删除任务（包括删除最高 ID）后 `nextId` 只增不减。
- **完成幂等**：重复执行 `done` 不会新增任务，也不会刷新 `completedAt`，重复调用不会改写数据文件。
- **安全整数**：`id` 与 `nextId` 必须是安全正整数（≤ `Number.MAX_SAFE_INTEGER` = 9007199254740991）。加载到不安全整数、或无法再安全分配下一个 ID 时，程序明确失败（退出码 1）且数据文件字节保持不变，不会静默取整或产生重复 ID。
- **原子写入**：采用同目录临时文件 + `fsync` + 原子改名，写入中断不会留下半份 JSON。写入失败或校验失败时不会覆盖原文件。
- **损坏文件不掩盖**：空文件、非法 JSON、结构或字段非法一律报错退出 1，绝不当作空清单覆盖。

## 路径与安全

- 默认数据文件是**程序目录**下的 `data/tasks.json`，与调用者的当前工作目录无关。
- `--data` 相对路径按调用者当前工作目录解析。
- Windows 上**拒绝把数据写入 C 盘**（退出码 1），并且会解析路径上最近的已存在上级路径，因此**目录联接 / 符号链接指向 C 盘**的情况同样会被拒绝。
- 非 Windows 平台不做盘符检查（该检查仅针对 Windows）。
- `--data` / `--status` / `--priority` 的取值不能是另一个选项，也不能是空白值：
  - `node todo.mjs --data --json list` → 退出 2（不会把 `--json` 当成路径）
  - `node todo.mjs --data --priority high list` → 退出 2（不会把 `--priority` 当成路径）
  - `node todo.mjs --data "" list` 与 `node todo.mjs --data= list` → 退出 2，不回退默认路径

## 测试

```powershell
node --test --test-isolation=none
# 或
npm test
```

测试特点：

- 全部使用 Node 内置测试运行器，无第三方依赖。
- 通过**真实 CLI 派生进程**验证退出码、stdout 与 stderr。
- 临时目录显式建在项目内的 `test/tmp/`（I 盘），**不使用 C 盘系统临时目录**，测试结束后清理。
- 覆盖：参数解析、过滤、持久化、中文、完成幂等、删除与 ID 不复用、非法输入、损坏数据不覆盖、C 盘与联接防护、安全整数边界、help/version 不生成数据文件。

### 关于 `--test-isolation=none`

本机 DSH 进程沙箱禁止打开命名管道，而 Node 默认的 `node --test` 会以 `stdio: 'pipe'` 派生测试进程，从而直接失败（`spawn EPERM`）。`--test-isolation=none` 让测试在同一个进程内运行、不派生额外进程，因此在受限沙箱与普通环境下都能用。

若该环境变量不易传递，也可以这样运行：

```powershell
$env:NODE_OPTIONS='--test-isolation=none'; node --test
```

测试内部另有第二处沙箱适配：CLI 派生进程的 stdout/stderr 通过**重定向到项目内的临时文件**再读回，而不是管道，因此仍然是真实派生进程、真实退出码、真实输出流内容（见 `test/helpers.mjs` 顶部注释）。

## 已知限制

1. `--test-isolation=none`：在**无沙箱限制**的普通机器上，直接 `node --test` 也能跑通；本机因沙箱不允许管道通信才需要该参数。`package.json` 的 `test` 脚本已带上它。
2. C 盘防护仅在 Windows 生效；Windows 上创建目录联接需要权限，缺少权限时相关测试会自动 `skip` 而非失败。
3. 没有文件锁：多个进程同时写同一个数据文件时，最后一次原子改名生效（后写覆盖先写）。单进程顺序调用与 `list` 读取不受影响。
4. `completedAt` 使用 UTC ISO 8601 字符串，`list` 的文本输出直接显示该字符串，未做本地时区格式化。
5. 达到 `Number.MAX_SAFE_INTEGER` 后无法继续安全分配 ID，此时 `add` 明确失败而不是复用或降级 ID。
6. 时间只有一个 `createdAt` 与 `completedAt`，没有修改时间、截止时间或标签字段。
