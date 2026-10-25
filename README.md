# Waxwing

[![CI](https://github.com/quanertsuki/waxwing/actions/workflows/ci.yml/badge.svg)](https://github.com/quanertsuki/waxwing/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Waxwing is a local-first delegation manager for DeepSeek and OpenAI-compatible
coding agents. A delegating Agent defines a task and acceptance criteria, a
worker Agent implements it, and the delegating party independently inspects the
evidence before accepting the result.

CLI, MCP stdio, and the Tauri desktop app are three adapters over one manager
listening only on `127.0.0.1`. The current release is a `0.1.0` preview intended
for a trusted local user and a trusted delegating Agent, not a public or
multi-tenant service.

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

![Waxwing system architecture](docs/assets/system-architecture.svg)

## Why Waxwing

- **Delegation without a control plane.** Tasks stay on your machine.
- **Provider-neutral.** Use DeepSeek Harness or any compatible OpenAI Chat
  Completions endpoint.
- **Independent acceptance.** A model saying “done” is not acceptance. The
  delegating Agent records its own checks and evidence.
- **Durable round leases.** Results, errors, heartbeat health, fallback, and
  rework are ordered by an explicit `roundId` protocol.
- **Workspace isolation.** Clean Git repositories automatically run in sibling
  worktrees; non-Git directories use an exclusive shared lock.
- **Unlimited by default.** Request counts, tool loops, and cost limits are not
  blocked unless you explicitly configure a threshold.
- **Bounded APIs.** Default CLI/MCP responses stay small; results, reports,
  history, usage, workspace metadata, diffs, and logs are paged on demand.

## Install

Requires Node.js 20 or newer.

The npm registry publication for `0.1.0` is pending. Until it is available,
download `waxwing-0.1.0.tgz` from the
[v0.1.0 release](https://github.com/quanertsuki/waxwing/releases/tag/v0.1.0)
and install that file:

```bash
npm install -g ./waxwing-0.1.0.tgz
waxwing health
waxwing
```

`npm install -g waxwing` becomes the supported install command after the
package is published to the npm registry.

The package installs two commands:

- `waxwing` — CLI and interactive task console
- `waxwing-mcp` — MCP stdio server

You can also run from a checkout:

```bash
git clone https://github.com/quanertsuki/waxwing.git
cd waxwing
node bin/waxwing.mjs health
```

## Quick start

### 1. Choose a provider

The default public configuration expects DeepSeek Harness as a sibling
checkout:

```text
workspace/
  waxwing/
  deepseek-harness/
```

Create a local, ignored override when your paths differ:

```powershell
Copy-Item prototype/config.local.example.json prototype/config.local.json
```

For an OpenAI-compatible endpoint, copy
`examples/providers/openai-compatible.json` into your provider directory
(`<WAXWING_HOME>/providers` by default), set `apiKeyEnv`, and point
`defaultProvider` at the provider name. API keys remain in the environment and
are never copied into task data.

Request budgets are opt-in. `maxToolRequests` omitted, `null`, or `0` means no
tool-loop limit.

### 2. Create a task

```bash
waxwing create @task.json
```

Example `task.json`:

```json
{
  "workspace": "C:\\work\\my-project",
  "workspaceMode": "auto",
  "prompt": "Implement the requested feature and run the tests.",
  "plan": "Inspect, implement, test.",
  "criteria": "Independent tests pass and the diff is limited to the requested behavior."
}
```

`workspaceMode` accepts:

| Value | Behavior |
| --- | --- |
| `auto` | Clean Git repository → isolated worktree; non-Git directory → shared lock; dirty Git repository → refused |
| `worktree` | Require a clean Git repository and isolated worktree |
| `shared` | Explicitly work in the original directory |

### 3. Inspect, verify, rework, accept

```bash
waxwing status task-xxxxxxxxxxxx
waxwing status task-xxxxxxxxxxxx --view result
waxwing status task-xxxxxxxxxxxx --view report
waxwing status task-xxxxxxxxxxxx --view diff
waxwing status task-xxxxxxxxxxxx --view log
waxwing rework @rework.json
waxwing accept @acceptance.json
waxwing close task-xxxxxxxxxxxx
```

Available paginated views: `result`, `history`, `usage`, `report`, `workspace`,
`diff`, and `log`. Use `--offset` and `--limit` for large output.

Acceptance evidence must describe checks actually performed by the delegating
party, not a restatement of the worker’s claim.

## MCP

Configure your MCP client to run:

```bash
waxwing-mcp
```

Public tools use the `waxwing_*` prefix. The complete `ds_*` catalogue remains
available throughout `0.1.x` for compatibility and is scheduled for removal no
earlier than `0.2.0`.

Core tools include `create`, `list`, `status`, `rework`, `accept`, `cancel`,
`close`, `cleanup_worktree`, `export`, `preview_delete`, and `delete`.

## Desktop

Development:

```bash
cd desktop
npm ci
npm run tauri dev
```

Build a Windows portable release from the repository root:

```powershell
npm run desktop:portable
```

The Windows portable archive includes the desktop executable, backend
resources, a Node runtime, license, and unsigned-build notice. It is **not code
signed**; verify `SHA256SUMS` and expect possible SmartScreen warnings.

## Runtime protocol

```text
run → ack → events/heartbeat → result|error → released
```

A result is not a release. Rework and provider fallback wait until the previous
round is explicitly released. A busy worker returns `worker_busy`; it never
silently drops a run. Every round message carries a `roundId`, and every task
event has a monotonic sequence.

Workers heartbeat every five seconds. Twenty seconds without a heartbeat marks
the runtime unhealthy but does not kill it. On manager restart, Waxwing only
terminates a residual process when PID, task ID, owner marker, and command line
all match. Otherwise it keeps the workspace lock and reports manual action.

See [docs/architecture.md](docs/architecture.md) for the full flow.

## Data and migration

Default data roots:

- Windows: `%LOCALAPPDATA%\Waxwing`
- macOS: `~/Library/Application Support/Waxwing`
- Linux: `$XDG_DATA_HOME/waxwing` or `~/.local/share/waxwing`

`WAXWING_HOME` overrides the root. On first start, repository-local legacy data
is copied into the new root; the old directory is retained. Migration never
overwrites a non-empty target.

Task directories contain local state and must not be used as worker
workspaces. Deleting task scratch data requires a separate interactive human
authorization; project files and the external report are preserved.

## Configuration

Configuration layering:

1. `prototype/config.json` or `WAXWING_CONFIG`
2. `prototype/config.local.json` or `WAXWING_LOCAL_CONFIG`
3. environment variables

Common environment variables:

| Variable | Purpose |
| --- | --- |
| `WAXWING_HOME` | Per-user data root |
| `WAXWING_CONFIG` | Main configuration file |
| `WAXWING_LOCAL_CONFIG` | Local override file |
| `WAXWING_NODE` | Node executable for workers |
| `WAXWING_DSH_REPO` | DeepSeek Harness checkout |
| `WAXWING_CREDENTIALS_FILE` | DSH credential store |
| `WAXWING_PROVIDERS_DIR` | Provider JSON directory |
| `WAXWING_PORT` | Loopback manager port, default `43187` |
| `WAXWING_BACKEND_DIR` | Packaged/custom backend root for the desktop app |

`DSH_SUBAGENT_*` and `DSH_PROTOTYPE_*` remain supported compatibility aliases
during `0.1.x`.

## Security model

- Manager binds to `127.0.0.1` and requires a random bearer token.
- Browser origins are rejected.
- Worker credentials are read from the environment/credential store, not copied
  into arguments or task JSON.
- Workspaces overlapping the managed data root are refused.
- Only owned, identity-matched runtime processes may be terminated.
- The trust boundary is the local operating-system account. Waxwing cannot
  distinguish a human from another program running as that user.

Report vulnerabilities through GitHub Private Vulnerability Reporting as
described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm test
npm run desktop:build
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
```

Core tests do not need real model credentials. Real provider checks consume
quota and are intentionally excluded from CI.

## License

[MIT](LICENSE)
