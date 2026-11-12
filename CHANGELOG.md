# Changelog

Waxwing follows the basic structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses semantic versioning for public releases.

## [Unreleased]

### Changed

- The test runner imports every `prototype/tests/*.test.mjs` instead of a
  hand-maintained list, and test isolation (scratch root, fixtures, fixed ports)
  is defined once in `isolate.mjs`
- The release check requires every module under `src/` by discovery; the
  portable desktop backend copies exactly the `prototype/` files `package.json`
  publishes
- One `src/storage/durable-file.mjs` owns atomic writes, replace-with-backup,
  and the SHA-256 helper; common, budget, usage-index, acceptance, research
  capture, and research report writes all use it (unique temporary names,
  Windows rename retry, cleanup on failure)
- Task status views and research reports share one paging rule: an offset past
  the end clamps to an empty final page, an offset inside a surrogate pair is
  rejected, and every page reports `complete`
- Every task write now goes through `TaskRepository.commit`: the record is
  saved before its event is appended with the next monotonic sequence, indexed
  records are deeply frozen, and a failed save appends nothing. Runtime health,
  readiness, round progress, and release updates commit a new record instead of
  editing the index; a rework override is applied only inside `prepareRun`'s
  commit, a repeated `ready` message no longer writes, and worktree cleanup
  returns the updated lease instead of mutating it
- `RuntimeSettlement` is the one projection from a runtime fact (terminal
  message, startup/fallback/stop failure, ACK timeout, process error or exit,
  close, restart identity) to the task status, event, lease conclusion, and
  handle decision. Close and restart recovery now pass through the lifecycle
  table: `fail` from `running`, the new `fail_stop` from `stopping`, and a
  repeated failure only updates `error` and records its event.
  `close-outcome.mjs` is removed
- The manager, CLI, and MCP now share one operation catalogue: each operation
  declares its fields, bounds, defaults, entry exposure, annotations, and
  cross-field rules, so CLI parsing, help text, MCP tool schemas, and manager
  validation cannot drift. `wait` keeps its MCP-only 300-second ceiling, CLI
  JSON commands are validated like MCP, and the HTTP gateway exports a testable
  `createGateway`. Failures keep the existing `error` text and add a stable
  status/`code` (`INVALID_ARGUMENT`, `NOT_FOUND`, `CONFLICT`,
  `REQUEST_TOO_LARGE`, and so on); `grant_delete` is marked human-only and
  stays out of the MCP catalogue
- Rework eligibility, next-round limits, and the one-round override are one
  read-only `TaskRework` decision shared by the rework action and status
  summaries. Lifecycle, runtime, round, and workspace refusals are answered
  once per request; the record patch and override event are applied only by
  `prepareRun`'s commit, so a failed gate leaves the task and journal
  unchanged. `TaskCommandModule` now validates create only and no longer
  exposes `validateRework`/`rework`; the lifecycle status rules moved out of
  `AcceptanceService` as well
- The round protocol is one definition for both processes:
  `src/runtime/protocol.mjs` builds and validates every message (run, ready,
  ack, event, heartbeat, result, error, worker_busy, released, close, closed,
  close_error, protocol_error), checks the protocol version, and normalizes both
  Provider event wrappers into one nested `session.event`. The manager rejects
  malformed, unknown, or unversioned messages before acting and records them as
  `runtime_message_ignored`; the Worker reports a bad run message as
  `protocol_error` and no longer replays `error.events` after a failed round.
  Tests use one shared fake Worker (`prototype/tests/fake-worker.mjs`) built from
  the same constructors instead of nine hand-written fakes
- The Provider seam is real: the DSH SDK path is a second adapter
  (`prototype/providers/dsh-sdk.mjs`) instead of a Worker branch, so the Worker
  resolves one adapter from the task's Provider and never reads its type.
  Adapters declare capabilities (reasoning effort, session continuity, runtime
  patch and budget file); the manager asks for capabilities instead of naming
  `dsh-sdk`, and the DSH adapter writes its own task patch. The openai-chat
  tool loop runs on an injectable HTTP transport, the Worker tool set moved to
  `src/worker/tools.mjs`, and dead helpers (`buildOpenAIRequest`,
  `openaiToAnthropic`, `mapStopReason`, `estimateTokens`, `message.signal`) are
  removed. `AdapterCache.closeAll()` releases every adapter a Worker built,
  including one replaced by a Provider fallback
- Usage metrics and limits are separate: `src/usage/metrics.mjs` owns pricing,
  the incremental event index, and cost projection, while `UsageModule` is the
  only place a request limit is evaluated and now also answers the list flags
  and status warnings the manager used to derive. `prototype/usage.mjs` is a
  forwarding legacy entry point, `ExecutionPolicy` moved to
  `src/tasks/execution-policy.mjs`, and `fullPricing` now selects the pricing
  source that knows the task model instead of the first source
- Research depends on a narrow manager interface instead of task records and
  runtime handles: the manager supplies `shardView`, `closeShard`, and
  `cancelTask`, while `shardTransition` and the new `shardCapturePatch` in
  `src/research/state.mjs` decide shard state and evidence classification. The
  active/terminal status sets move to `src/tasks/lifecycle.mjs`, both wait
  paths share `src/tasks/wait-loop.mjs`, the capture module only reads the
  view and writes evidence, and the public `create` operation no longer accepts
  internal research fields (`kind`, `batchId`, `shardId`)
- The desktop no longer interprets configuration. Rust locates the backend and
  Node, then runs `node prototype/cli.mjs paths` once to get the data root,
  token file, HTTP URL, and manager script, so the desktop and the manager
  cannot resolve different paths. Providers, editable settings, and their
  validation move behind manager operations (`providers_list`, `provider_save`,
  `provider_delete`, `settings_get`, `settings_save`, `config_info`), and a
  settings save reports `restartRequired` because the manager reads its limits
  at startup. Provider file changes stay live. Desktop task, usage, round, and
  runtime types are generated from the task-view contract fixture
  (`desktop/src/contract.generated.ts`), every manager call goes through
  `desktop/src/api.ts`, and the unused `TaskDetail.vue` is removed
- The manager is assembled from one explicit, frozen runtime context instead
  of importing global configuration. `src/config/load.mjs` resolves the
  configuration, `src/config/context.mjs` derives every directory, and
  `createManager` accepts that context plus optional `fs`, `clock`, `git`, and
  `terminateRuntime` implementations; the shared config is never mutated, and
  two managers with different data roots no longer interfere. Path utilities
  move to `src/paths/path-utils.mjs`, and `src/workspace/*` no longer imports
  `prototype/`. A forced stop kills through the child-process handle the
  manager spawned (a process tree on Windows, `SIGKILL` elsewhere); a runtime
  known only from its recorded PID after a restart is still terminated only
  after identity verification.
  Configuration loading, CLI, MCP, loopback client, provider adapters, the
  provider registry, the DSH budget plugin, and the budget/effort rules move
  to `src/`; the `prototype/` files at those paths forward to them, and the
  unused `prototype/state.mjs` is deleted
- The local override (`config.local.json`) now lives in the per-user data
  directory instead of beside `config.json`, so a portable-archive or npm
  update cannot replace saved settings. `WAXWING_LOCAL_CONFIG` still wins, and
  an older `prototype/config.local.json` remains a read-only fallback. Relative
  paths in the override resolve against the file that contains them; a settings
  save from any client moves a legacy file to the new location with its relative
  paths made absolute

- The Worker's `write_file` tool only writes inside the task workspace; an
  absolute path elsewhere is refused with a workspace-relative hint, so a copied
  path cannot bypass worktree isolation. `read_file` may still read outside the
  workspace
- `SECURITY.md` states what a deletion grant protects against and that the
  operating-system account is the trust boundary for `grant_delete`

### Removed

The next release is 0.3.0: these public exports and modules are removed
without a deprecation release.

- `RuntimeSupervisor`, `RuntimeLifecycle`, and `RuntimeOutcomeSettlement`
  (`src/runtime/supervisor.mjs`, `lifecycle.mjs`, `outcome.mjs`); use
  `Runtime` and the newly exported `RuntimeSettlement`
- `UsageService` (`src/usage/service.mjs`); use `UsageModule`
- The `src/usage/execution-policy.mjs` forwarder; import `ExecutionPolicy` from
  `src/tasks/execution-policy.mjs` or the package root
- `TaskCommandModule#validateRework` and `TaskCommandModule#rework`; rework
  decisions belong to `TaskRework`

### Fixed

- A process exit no longer drops the Runtime handle immediately: the handle is
  retained until `forget`, so a failed final close save can be retried instead
  of leaving the task stuck in `stopping`
- Closing a task now writes the report and the task record that carries its
  hash as one atomic commit: a failed task save restores the previous report,
  and the close reports can no longer lose the execution-policy appendix
- A deletion grant is persisted before it is honored in memory, so a failed
  grant write cannot authorize a deletion that disappears on restart
- The Worker builds its Provider adapter from the current round's Provider, so
  a fallback reusing the same Worker process no longer calls the failed
  Provider's endpoint; the provider config is copied instead of mutated

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
