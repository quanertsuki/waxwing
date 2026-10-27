# Compatibility Runtime

`prototype/` contains Waxwing's `0.1.x` runtime implementation and legacy entry
points. The public CLI and MCP binaries call the adapters in `src/adapters/`;
new integrations should use `waxwing` and `waxwing-mcp`.

## Module boundaries

| Path | Responsibility |
| --- | --- |
| `server.mjs` | Loopback HTTP shell with Host, Origin, and bearer-token checks |
| `manager.mjs` | Coordinator for lifecycle, runtime, workspace, reports, usage, and deletion grants |
| `worker.mjs` | One Worker Agent runtime with DSH SDK or OpenAI-compatible Providers |
| `providers/` | Provider validation and OpenAI Chat Completions adapter |
| `usage.mjs` | Incremental token, latency, and estimated-cost aggregation |
| `cli.mjs` / `client.mjs` | Legacy CLI and manager bootstrap/reuse |
| `mcp.mjs` | Legacy MCP implementation exposed by `src/adapters/mcp.mjs` |
| `budget.mjs` | One-request `max_tokens` validation |
| `execution-policy.md` | Optional per-round execution policy |

The extracted public facades live under `src/tasks`, `src/workspace`,
`src/runtime`, `src/acceptance`, `src/research`, `src/usage`, `src/providers`, and
`src/adapters`. Some facades still delegate here while the manager is split
incrementally.

## Configuration

```text
prototype/config.json
  <- prototype/config.local.json
  <- WAXWING_* environment variables
  <- legacy DSH_SUBAGENT_* / DSH_PROTOTYPE_* aliases
```

Relative paths are resolved from the directory containing the selected config.
The default data root is the platform per-user Waxwing directory, not the
repository. `WAXWING_HOME` overrides it.

Important fields:

```json
{
  "dshRepo": "../deepseek-harness",
  "credentialsFile": "../deepseek-harness/data/.credentials.yaml",
  "node": "",
  "providersDir": "",
  "defaultProvider": "dsh-sdk",
  "fallbackProvider": "dsh-sdk",
  "workspaceMode": "auto",
  "worktreeContainerName": ".waxwing-worktrees"
}
```

An empty `node` uses the Node executable already running the manager. An empty
`providersDir` resolves to `<WAXWING_HOME>/providers`.
Research scratch workspaces default to `<WAXWING_HOME>-research` and can be
changed with `WAXWING_RESEARCH_ROOT` or the `researchRoot` config field.

## Task lifecycle

```text
create -> running -> awaiting_review
                      |-- accept -> accepted -> close -> closed
                      |-- rework -> running -> awaiting_review
                      |-- cancel -> cancelled
                      `-- error/timeout -> failed
```

A live task holds its workspace and overlapping containing/nested workspaces.
The lock is released only after runtime exit is confirmed. Waxwing never
terminates an unrelated process.

## Round protocol

```text
run -> ack -> events/heartbeat -> result|error -> released
```

A task event contains a monotonic sequence and `roundId`. Rework and Provider
fallback wait for `released`. Busy workers return `worker_busy`; stale,
duplicate, and late messages are recorded and rejected. Runtime identity records
allow verified recovery after a manager restart.

## Parallel research

`research_start` creates multiple shard tasks for one read-only question. Each
shard owns a separate scratch workspace and runs concurrently. Results are
captured before shard runtimes close, failed shards do not erase successful
ones, and `research_collect` writes one aggregate Markdown report.

Use CLI `research-start`, `research-wait`, `research-status`,
`research-collect`, and `research-cancel`, or the matching MCP tools with both
`waxwing_` and `ds_` prefixes. This path deliberately does not support multiple execution Agents
writing concurrently in one physical project directory; use isolated
worktrees, or serialize writes through `workspaceMode=shared`.

## Providers

`dsh-sdk` is built in and uses the global `dshRepo`, credentials file, and
model. OpenAI-compatible Providers are JSON files under the Provider directory.

```json
{
  "name": "my-provider",
  "type": "openai-chat",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "model": "your-model",
  "supportsTools": true,
  "supportsReasoning": false,
  "stream": true,
  "maxToolRequests": null
}
```

`maxToolRequests` omitted, `null`, or `0` means unlimited. A positive integer is
an explicit tool-loop limit. An empty final response returns `empty_response`;
neither condition is treated as success.

## Usage and limits

`usage.mjs` reads assistant message and round events, deduplicates by message ID,
and stores metadata-only indexes. Message bodies are not copied into the index.

`usageLimits.enabled=false` is the default. Request and cost values are still
reported, but no warning or block occurs. If explicitly enabled, a blocking
threshold refuses only later rework; it never terminates the current round.
`overrideLimits:true` plus a non-empty reason can approve one round.

Costs are local estimates from `pricing.json`, not Provider invoices.

## Response contract

Default `list`, `status`, and mutation responses are bounded summaries. Read full
content through paginated views:

```powershell
waxwing status <id> --view result
waxwing status <id> --view history
waxwing status <id> --view report
waxwing status <id> --view workspace
waxwing status <id> --view diff
waxwing status <id> --view log
waxwing status <id> --view usage
```

`offset` defaults to `0`; `limit` defaults to `2000` and is capped at `4000`.
Paging never splits a UTF-16 surrogate pair.

The HTTP API binds to `127.0.0.1`, requires a runtime bearer token, and remains
internal and unstable. Stable entry points are CLI, MCP, and the desktop app.

## Tests

```powershell
npm test
```

Tests use isolated temporary data roots, require no model credentials, and must
not touch real task data. Live Provider smoke checks may consume quota and are
excluded from CI.

## Known limitations

- A fresh runtime cannot restore an old DSH `sessionId`; create a new task.
- There is no cross-machine scheduling, distributed lock, or global quota pool.
- Acceptance evidence is stored but cannot be proven to have been executed.
- Browser origins are rejected; do not call the manager directly from a page.
- The Windows `0.1` desktop artifact is unsigned.
