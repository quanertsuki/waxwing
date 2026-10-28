# Waxwing 0.2.0

Waxwing 0.2.0 is a preview for a trusted local user and a trusted delegating
Agent. It keeps the local-first design: one Manager process on `127.0.0.1`
serves the CLI, the MCP stdio server, and the Tauri desktop app, and all task
state, workspaces, events, acceptance evidence, and usage statistics stay on
the local machine.

## Highlights

- Close and restart recovery now share one explicit verdict. A runtime is
  treated as terminated only when that was confirmed; an unverifiable process
  keeps its workspace lock and asks for human handling.
- Task close commits the acceptance report and the final task record in one
  transaction. A failed save restores the previous report and keeps the runtime
  handle retryable instead of leaving a half-written state.
- Workspace leases compensate exactly once, and cleanup/release refuse a lease
  that still requires manual runtime handling.
- The bounded task view is generated from the real view functions and checked
  across JavaScript, a Rust fixture, and `vue-tsc`. The desktop models now read
  the complete list/detail shape, including result-preview bounds and round
  timestamps.
- The desktop transport maps manager errors consistently, clamps page limits to
  1–4000, and distinguishes "manager not running" from "manager running but
  unhealthy".
- Research refresh is isolated per shard: an unreadable result is reported as a
  capture error instead of failing the batch, crash-window shards settle as
  orphaned, concurrent callers share one refresh and one close, and reports are
  written atomically with stable hashes.
- Usage limits are resolved once per request and passed into metrics. A damaged
  task override falls back to configured limits, the full view projects the
  same snapshot instead of rescanning events, and `UsageService` delegates to
  `UsageModule`.

## Install

```bash
npm install -g @quanernya/waxwing@0.2.0
```

The package installs `waxwing` for the CLI and `waxwing-mcp` for the MCP stdio
server. The tarball `waxwing-0.2.0.tgz`, the unsigned Windows portable archive
`waxwing-0.2.0-windows-x64.zip`, and `SHA256SUMS` are attached to the `v0.2.0`
GitHub Release.

Verify downloaded files before running them:

```powershell
Get-FileHash .\waxwing-0.2.0-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

## Upgrading from 0.1.1

- Nothing to migrate. Task data, workspaces, runtime records, research batches,
  and runtime events keep their existing layout under the per-user Waxwing
  directory.
- A stored task without a workspace lease is migrated on startup; event
  sequence numbers are rebuilt from `events.jsonl` when absent.
- Existing research batches are loaded as before. A shard left `planned`
  without a task by a crash is settled as orphaned so the batch can finish.
- `UsageService` remains exported but is deprecated; use `UsageModule` for new
  code.

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
- `prototype/` entry points remain available.
- A legacy runtime session ID cannot be resumed by a fresh Manager process.
- `WAXWING_RESEARCH_ROOT` moves per-shard research scratch workspaces away from
  the per-user state directory.

See `CHANGELOG.md` and `docs/architecture.md` for the full change list and
architecture details.
