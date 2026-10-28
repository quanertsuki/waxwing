# Waxwing 0.1.1

Waxwing 0.1.1 is the first release cut from `main` and published to the npm
registry. It keeps the local-first design of 0.1.0: one Manager process on
`127.0.0.1` serves the CLI, the MCP stdio server, and the Tauri desktop app,
and all task state, workspaces, events, acceptance evidence, and usage
statistics stay on the local machine.

## Highlights

- Deepening round three is merged: task lifecycle transactions, workspace-lease
  acquisition/release, one usage-policy module, and a research batch state
  module now back the JavaScript, Rust, and Vue layers.
- Server-side `wait` and `research_wait` come with CLI commands and the
  `waxwing_wait` / `waxwing_research_wait` MCP tools, so callers stop polling
  and get a bounded summary.
- Research batches fan out to one scratch workspace per shard, release the
  shard runtime automatically, keep partial evidence on failure, and return a
  single aggregate report.
- `npm run check:release-tree` now also passes inside an installed package: it
  validates the subset the tarball ships instead of the repository-only
  desktop sources.
- Test runs keep `prototype/tests/.tmp` bounded by reaping scratch roots left
  behind by earlier runs.

## Install

```bash
npm install -g @quanernya/waxwing@0.1.1
```

The package installs `waxwing` for the CLI and `waxwing-mcp` for the MCP stdio
server. The tarball `waxwing-0.1.1.tgz`, the unsigned Windows portable archive
`waxwing-0.1.1-windows-x64.zip`, and `SHA256SUMS` are attached to the `v0.1.1`
GitHub Release.

Verify downloaded files before running them:

```powershell
Get-FileHash .\waxwing-0.1.1-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

## Upgrading from 0.1.0

- Nothing to migrate. Task data, workspaces, and runtime events keep their
  existing layout under the per-user Waxwing directory.
- The `0.1.0` tarball was published from the deepening branch before it
  reached `main`; `0.1.1` is the version that matches the released source tree.
- `0.1.0` shipped no `scripts/`, so the release check named in its manifest
  failed after installation. `0.1.1` ships the script and the packaged check
  passes.

## Requirements and limits

- Node.js 20 or newer for the npm package.
- Windows x64 is the first desktop target. CLI and MCP are tested on Windows
  and Linux.
- The Windows executable is unsigned and may trigger Microsoft SmartScreen.
- Version 0.1 has no code signing, hosted service, multi-tenancy, Kanban, or
  WebSocket support.
- `waxwing_*` is the public MCP tool namespace. `ds_*` remains as a
  compatibility alias through `0.1.x`.

## Compatibility

- `DSH_SUBAGENT_*` and `DSH_PROTOTYPE_*` remain supported environment-variable
  aliases.
- `prototype/` entry points remain available through `0.1.x`.
- A legacy runtime session ID cannot be resumed by a fresh Manager process.
- `WAXWING_RESEARCH_ROOT` moves per-shard research scratch workspaces away from
  the per-user state directory.

See `CHANGELOG.md` and `docs/architecture.md` for the full change list and
architecture details.
