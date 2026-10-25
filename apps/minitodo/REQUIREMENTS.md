# MiniTodo 实战任务与验收计划

任务日期：2026-10-09。程序、测试和使用文档均由 Worker Agent 编写；Delegating Agent（Codex）只提出要求、查看结果、运行命令并给出验收意见。

实现一个零第三方依赖的 Node.js 本地待办清单 CLI。程序入口为 `todo.mjs`，在 Windows PowerShell 中可以直接运行。面向中文用户，默认文本输出易读，同时支持 `--json` 供其他 Agent 使用。

功能：

1. `node todo.mjs add "任务标题" --priority high|normal|low` 添加任务，默认优先级 normal。
2. `node todo.mjs list` 查看全部任务；支持 `--status pending|done|all` 和 `--priority` 过滤。
3. `node todo.mjs done ID` 完成任务；重复完成不创建新任务、不重复修改完成时间。
4. `node todo.mjs remove ID` 删除任务；删除不存在 ID 应报错。
5. `node todo.mjs --help` 和 `node todo.mjs --version`。

全局参数 `--data 路径` 和 `--json` 在命令前后均可使用。默认数据位于程序目录的 `data/tasks.json`，不能依赖调用者当前工作目录。Windows 上拒绝把数据写入 C 盘，也要处理目录联接或符号链接指向 C 盘的情况。项目默认处于 I 盘。

数据采用 UTF-8 JSON 文件持久化。ID 为正整数，跨进程调用保留；删除最高 ID 的任务后不得重用该 ID，使用单独的 nextId。任务包含 id、title、priority、done、createdAt 和完成时间。支持中文、空格及标题中以连字符开头的文本（必要时提供 `--` 参数分隔）。空白标题、非法优先级/过滤器、未知命令/参数和非正整数 ID 均明确报错。

成功 JSON 输出包含 `ok: true`；添加/完成返回 task；列表返回 tasks；删除返回 deletedId。JSON 错误写 stderr，包含 `ok: false` 和明确错误信息；stdout 保持为空。输入错误退出 2，存储错误退出 1，成功退出 0。不得把被损坏的数据文件当成空清单覆盖；验证文件结构；采用同目录临时文件加原子替换，避免写入中断留下半份 JSON。

请完成入口、必要的辅助模块、README.md、package.json（无依赖）和 `test/*.test.mjs`。测试使用 Node 内置测试运行器，临时目录显式设在项目下；验证真实 CLI 派生进程和退出码，覆盖持久化、中文、过滤、完成幂等、删除与 ID 不复用、非法参数、损坏数据不覆盖、help/version 不生成数据文件。不要修改本需求文件或项目外任何文件，也不要安装依赖。

完成前由 Worker Agent 自行运行 `node --test` 并修复失败，最终报告实际执行命令、测试数量、实现文件和已知限制。

Delegating Agent 验收步骤：

- 自己重新运行测试，核实结果。
- 在 Delegating Agent 独立的 `.acceptance` 数据路径上，逐个 CLI 进程进行添加、过滤、完成、删除、再次添加，查看文件与 JSON 输出。
- 核实空标题、非法优先级、非法 ID、未知参数和损坏数据的退出行为及数据未被改写。
- 从项目外工作目录执行入口，核实默认数据位置仍为程序目录。
- 未通过则向同一 Subagent 会话提出具体返工；通过后提交验收证据、导出记录并关闭。没有用户的清理授权时保留会话信息。
