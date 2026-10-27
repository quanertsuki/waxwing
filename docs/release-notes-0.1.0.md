# Waxwing 0.1.0

Waxwing is a local-first delegation manager for running coding tasks through
DeepSeek, OpenAI-compatible endpoints, and other configured Provider Agents. It
keeps task state, workspaces, runtime events, acceptance evidence, and usage
statistics on the local machine.

## Highlights

- CLI, MCP, and desktop entry points share one local Manager.
- Every delegated round follows
  `run -> ack -> events/heartbeat -> result|error -> released`.
- Git repositories get isolated worktrees by default; non-Git directories use
  explicit shared-workspace locks.
- One read-only research question can fan out to multiple execution Agents,
  each with a separate scratch workspace and one aggregate report.
- Status exposes bounded workspace, diff, log, report, usage, and history views.
- Request, tool-loop, and cost limits are opt-in and disabled by default.
- Waxwing data lives under the per-user Waxwing directory, with copy-only
  migration from the legacy location.

## Downloads

- `waxwing-0.1.0.tgz`: npm package artifact for the `waxwing` CLI and MCP server.
- `waxwing-0.1.0-windows-x64.zip`: unsigned portable Windows desktop build.
- `SHA256SUMS`: checksums for the release artifacts.

The npm registry publication is pending. Install the tarball above until
`npm install -g waxwing` becomes available.

Verify downloaded files before running them:

```powershell
Get-FileHash .\waxwing-0.1.0-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

## Requirements and limits

- Node.js 20 or newer for the npm package.
- Windows x64 is the first desktop target. CLI and MCP are tested on Windows and
  Linux.
- The Windows executable is unsigned and may trigger Microsoft SmartScreen.
- Version 0.1 does not include code signing, a hosted service, multi-tenancy,
  Kanban, or WebSocket support.
- `waxwing_*` is the public MCP tool namespace. `ds_*` remains as a compatibility
  alias through `0.1.x`.

## Compatibility

- `DSH_SUBAGENT_*` and `DSH_PROTOTYPE_*` remain supported environment-variable
  aliases.
- `prototype/` entry points remain available through `0.1.x`.
- A legacy runtime session ID cannot be resumed by a fresh Manager process.

See `CHANGELOG.md` and `docs/architecture.md` for the full change list and
architecture details.
