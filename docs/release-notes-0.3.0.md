# Waxwing 0.3.0

Waxwing 0.3.0 is a preview for a trusted local user and a trusted delegating
Agent. It keeps the local-first design: one Manager process on `127.0.0.1`
serves the CLI, the MCP stdio server, and the Tauri desktop app, and all task
state, workspaces, events, acceptance evidence, and usage statistics stay on
the local machine.

## Highlights

- Architecture deepening, round six: every runtime fact projects through one
  Settlement module with legal lifecycle transitions; every task write goes
  through one commit path with deeply frozen records; rework eligibility is
  one read-only decision shared by the action and the status summary.
- One operation catalogue drives the HTTP gateway, CLI parsing and help, and
  MCP tool schemas, so the three entries cannot drift. Failures keep their
  existing text and add a stable `code` with a matching HTTP status.
- The round protocol is one definition for the manager and the Worker:
  shared constructors, validation, protocol version, and one normalized event
  wrapper. Malformed or late messages are recorded and ignored.
- The Provider seam is real: DSH is a second adapter beside openai-chat, the
  Worker resolves one adapter per round from the task's Provider, and adapters
  declare capabilities instead of being branched on by type name.
- openai-chat rework rounds continue the previous conversation from a per-task
  file (`runs/<id>/conversation.jsonl`), fitted to the provider's optional
  `contextWindow`, and a file-continuity task can rework after its Worker
  exited, including after a manager restart.
- Usage metrics and limits are separate modules; research depends on a narrow
  manager interface; the desktop no longer interprets configuration — Rust
  asks the CLI for resolved paths once, and providers and settings are read
  and validated only by Node through manager operations.
- The manager is assembled from one explicit, frozen runtime context with
  injectable file system, clock, git, and process-control dependencies; two
  managers with different data roots can run in one process.
- Correctness fixes: a runtime handle is retained until `forget` so a failed
  close save stays retryable; close reports and the task record commit
  atomically; deletion grants persist before taking effect; a fallback round
  uses the fallback Provider's endpoint; text paging has one implementation.
- The local override (`config.local.json`) lives in the per-user data
  directory, so a portable-archive or npm update cannot replace saved
  settings. The old location remains a read-only fallback.

## Breaking changes

Public exports are removed without a deprecation release:

- `RuntimeSupervisor`, `RuntimeLifecycle`, `RuntimeOutcomeSettlement`: use
  `Runtime` and the newly exported `RuntimeSettlement`.
- `UsageService`: use `UsageModule`.
- The `src/usage/execution-policy.mjs` forwarder: import `ExecutionPolicy`
  from `src/tasks/execution-policy.mjs` or the package root.
- `TaskCommandModule#validateRework` and `TaskCommandModule#rework`: rework
  decisions belong to `TaskRework`.

## Install

```bash
npm install -g @quanernya/waxwing@0.3.0
```

The package installs `waxwing` for the CLI and `waxwing-mcp` for the MCP stdio
server. The tarball `waxwing-0.3.0.tgz`, the unsigned Windows portable archive
`waxwing-0.3.0-windows-x64.zip`, and `SHA256SUMS` are attached to the `v0.3.0`
GitHub Release.

Verify downloaded files before running them:

```powershell
Get-FileHash .\waxwing-0.3.0-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

## Upgrading from 0.2.0

- Task data, workspaces, runtime records, research batches, and events keep
  their existing layout under the per-user Waxwing directory. Nothing to
  migrate.
- An existing `prototype/config.local.json` is still read when the new
  location has no file. The next settings save writes the new location and
  converts inherited relative paths to absolute ones; the old file is kept.
- Code importing the removed exports listed above must switch to the
  replacements before upgrading.
- A task whose Worker exited can now be reworked when its Provider declares
  file continuity; DSH tasks keep the original live-runtime requirement.

## Requirements and limits

- Node.js 20 or newer for the npm package.
- Windows x64 is the first desktop target. CLI and MCP are tested on Windows
  and Linux.
- The Windows executable is unsigned and may trigger Microsoft SmartScreen.
- Waxwing has no code signing, hosted service, multi-tenancy, Kanban, or
  WebSocket support.
- `waxwing_*` is the public MCP tool namespace. `ds_*` remains available as a
  compatibility alias.
- Limits default to disabled; usage that is unavailable or incomplete never
  blocks rework by itself.

## Compatibility

- `DSH_SUBAGENT_*` and `DSH_PROTOTYPE_*` remain supported environment-variable
  aliases.
- `prototype/` entry points remain available and forward to `src/`.
- A legacy runtime session ID cannot be resumed by a fresh Manager process.
- `WAXWING_RESEARCH_ROOT` moves per-shard research scratch workspaces away from
  the per-user state directory.

See `CHANGELOG.md` and `docs/architecture.md` for the full change list and
architecture details.