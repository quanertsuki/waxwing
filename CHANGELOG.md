# Changelog

Waxwing follows the basic structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for public releases.

## [Unreleased]

## [0.2.0] - 2026-10-28

### Changed

- Task close now projects one explicit outcome: a verified process exit, the
  stored close error, the final task/report commit, and handle release all
  happen in order, and a failed save keeps the handle retryable
- Restart recovery consumes an explicit termination verdict, so an unverified
  process is retained with its workspace lock instead of being treated as
  terminated
- Workspace lease acquisition compensates exactly once and refuses to clean or
  release a lock that requires manual runtime handling
- Acceptance reports and task records commit together; a failed task save
  restores the previous report
- Task restoration validates IDs and applies legacy lease/event migrations in
  the repository instead of the coordinator
- The task view contract is generated from the real view functions and checked
  by JS, Rust fixture, and `vue-tsc`; Rust/Vue models now read the full bounded
  list/detail shape, including result preview bounds and round timestamps
- Desktop manager requests share one transport policy: structured errors,
  1–4000 page limits, and a running/unhealthy/not-running health probe
- Research refresh shares one in-flight pass per batch, isolates unreadable
  shards with `captureError`, settles crash-window planned shards as orphaned,
  serializes close, and writes reports atomically with stable hashes
- Usage limits are resolved once per request and passed into metrics; a damaged
  task limit override falls back to configured limits, `view` projects the same
  snapshot instead of rescanning, and `UsageService` delegates to `UsageModule`

## [0.1.1] - 2026-10-28

### Added

- Shared task lifecycle transactions, workspace-lease acquisition/release, and
  a read-only task view contract used by the JavaScript, Rust, and Vue layers
- One usage-policy module for limit inheritance, threshold evaluation, and
  one-round override decisions
- A research batch state module that keeps cancellation, partial evidence, and
  runtime finalization decisions consistent
- Server-side `wait` and `research_wait` actions, CLI commands, and
  `waxwing_wait` / `waxwing_research_wait` MCP tools
- Parallel research batches with one scratch workspace per shard, automatic
  shard-runtime release, partial-failure retention, and one aggregate report
- `waxwing_research_*` MCP tools and `research-*` CLI commands for read-only
  fan-out across articles, web pages, and repositories
- `WAXWING_RESEARCH_ROOT` for moving per-shard scratch workspaces away from the
  per-user state directory
- The npm package ships `scripts/`, so the release check its manifest advertises
  runs after installation

### Changed

- Routine npm, Cargo, Tauri, and GitHub Actions updates are grouped while
  semantic-major upgrades remain individually reviewable
- GitHub Actions use checkout/setup-node v7, upload-artifact v7,
  download-artifact v8, and gitleaks-action v3
- Tauri desktop dependencies use tauri 2.12.5, tauri-build 2.7.4, and Tauri CLI
  2.12.4
- npm package, desktop package, Rust crate, and Windows bundle metadata
  attribute the release to `quanertsuki`
- The npm package is published as `@quanernya/waxwing` and installs the
  `waxwing` and `waxwing-mcp` commands
- `@quanernya/waxwing@0.1.0` was published from the deepening branch during
  round three; `0.1.1` is the first registry release cut from `main`

### Fixed

- A failed worktree materialization now rolls back its lease before a task
  record is created
- The release-tree check requires every module exported by the public
  composition root, including the task lifecycle module
- The release-tree check includes non-ignored working files, skips deleted
  tracked files, and still fails when a required release file is absent
- `prototype/tests/.tmp` stays bounded: a run reaps the scratch roots abandoned
  by earlier runs instead of keeping every `data-<pid>` directory forever
- `npm run check:release-tree` passes inside an installed package by validating
  the shipped subset instead of the repository-only desktop sources

## [0.1.0] - 2026-10-25

### Added

- Waxwing CLI (`waxwing`) and MCP server (`waxwing-mcp`)
- `waxwing_*` MCP tools with `ds_*` compatibility aliases
- Explicit `run -> ack -> events/heartbeat -> result|error -> released` rounds
- Unique `roundId`, monotonic task events, `worker_busy`, ACK timeout, heartbeat
  health, and verified residual-runtime recovery
- Isolated Git worktrees, shared-workspace locks, Git status/diff, log views,
  and safe `cleanup_worktree`
- Paginated result, history, usage, report, workspace, diff, and log views
- Tauri task creation, rework, Diff, report, log, heartbeat, and cleanup views
- Per-user Waxwing data root with copy-only legacy migration
- Public npm package metadata, isolated install smoke test, Windows portable
  archive, unsigned-build notice, and checksums
- English and Chinese documentation, Mermaid architecture source, CI, release
  workflow, Dependabot, contribution guide, and security policy
- Waxwing bird icon for desktop and platform assets

### Changed

- Renamed the public product, npm package, CLI, MCP server, data directory,
  desktop app, and documentation to Waxwing
- Request, tool-loop, and cost limits are disabled by default
- Clean Git repositories use worktrees automatically; non-Git directories use
  a shared lock
- Acceptance and close retain worktrees and branches
- Runtime recovery terminates only an identity-matched process; unverifiable
  processes keep the workspace lock
- Release builds locate backend resources only beside the executable
- Desktop icons use an abstract three-plane waxwing feather mark that remains
  legible at small Windows taskbar sizes
- Desktop build tooling uses Vite 8 and the matching Vue plugin, clearing the
  previous npm audit warnings

### Fixed

- Rework and Provider fallback no longer race a just-finished result
- Repeated terminal messages cannot overwrite task state or move event
  sequences backwards
- Close requests preserve a completed result while runtime release is pending
- Empty Provider responses remain typed failures instead of successful results
- Sources and documentation use neutral Delegating Agent / Worker Agent
  terminology
- Portable Manager startup passes Node a relative entry point instead of
  Rust's Windows verbatim canonical path, which could be misread as the `I:`
  drive root

### Compatibility

- `DSH_SUBAGENT_*` and `DSH_PROTOTYPE_*` environment variables remain aliases
- Legacy `prototype/` entry points remain through `0.1.x`
- `ds_*` MCP tools remain through `0.1.x` and may be removed in `0.2.0`
