# Contributing to Waxwing

Thanks for helping improve Waxwing. Read [SECURITY.md](SECURITY.md) before
reporting a vulnerability or sharing runtime data.

## Development requirements

- Node.js 20 or newer
- Git
- Rust stable and the Tauri 2 platform prerequisites for desktop work
- Your own credentials for live Provider checks; never commit them

Install desktop dependencies and verify the baseline:

```bash
npm --prefix desktop ci
npm test
npm run desktop:build
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
```

The root runtime uses only Node.js standard-library modules. Desktop packages
live under `desktop/`.

## Before opening a pull request

```bash
npm test
npm run desktop:build
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
npm run package:smoke
npm pack --dry-run --json
git diff --check
```

If a change touches a live Provider, MCP client, Tauri packaging, or Windows
portable output, describe the exact verification performed and any remaining
platform risk.

## Code guidelines

- **Portable paths.** Do not hard-code drive letters, user directories, or
  machine-specific binaries. Use `prototype/config.local.json` or `WAXWING_*`.
- **Unlimited by default.** Request, tool-loop, and cost limits must be opt-in.
  Omitted, `null`, and `0` tool-request limits mean unlimited.
- **Never terminate an unknown process.** Only a process whose PID, task ID,
  owner marker, and command line all match may be terminated.
- **No secret leakage.** Providers reference environment variables through
  `apiKeyEnv`. Logs, fixtures, task records, and documentation must not contain
  tokens, credentials, private code, or full personal paths.
- **Least privilege.** Keep the manager bound to loopback, require a bearer
  token, and reject browser-origin requests.
- **Evidence-first acceptance.** A Worker Agent completion message is never
  equivalent to human or Delegating Agent acceptance.
- **Neutral terminology.** Use "Delegating Agent" and "Worker Agent" for roles.
  For technical relationships use "containing/nested directory", "calling/spawned
  process", and "containing/nested workspace". Do not describe software roles
  with kinship terms.

## Test expectations

- Bug fixes need a regression test that fails before the fix.
- Provider-loop changes must cover omitted, `null`, `0`, and positive limits.
- Runtime changes must cover stale and duplicate `roundId` messages, ACK
  timeouts, `worker_busy`, release gating, and shutdown while a terminal message
  is pending.
- Workspace changes must cover clean and dirty Git repositories, non-Git
  directories, overlapping paths, worktree cleanup, and case/separator behavior.
- Path changes must cover relative paths, absolute paths, local overrides, and
  environment-variable precedence.

Core tests must pass through `npm test`. Do not require live model credentials
or paid quota in CI.

## Pull requests

Include:

1. The problem and user-visible behavior.
2. The design tradeoff and affected module boundary.
3. Commands run and their results.
4. Remaining risks or platform gaps.

Keep unrelated formatting, personal acceptance records, and large path cleanups
out of focused pull requests.

## License

By submitting a contribution, you agree to license it under this repository's
MIT License.
