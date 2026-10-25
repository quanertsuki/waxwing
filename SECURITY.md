# Security Policy

## Supported versions

Waxwing `0.1.x` is a preview release and receives security fixes on a
best-effort basis. Modified forks and older commits are not supported.

## Report a vulnerability privately

Use **Security > Report a vulnerability** in the
[quanertsuki/waxwing](https://github.com/quanertsuki/waxwing) repository.
Do not open a public issue for:

- bearer-token or credential disclosure
- a path that escapes the workspace boundary
- browser or local-process access that bypasses manager authorization
- arbitrary process termination, command injection, or path traversal
- Provider keys written to logs, task data, or reports

If Private Vulnerability Reporting is unavailable, contact the maintainer
through their GitHub profile with a minimal reproduction. Never include a live
API key, private source code, or personal task data in the first message.

## Threat model

Waxwing assumes:

- the operating-system account running the manager is trusted
- the Delegating Agent and programs that can read local runtime state share that
  trust boundary
- the managed data directory is not used as a Worker Agent workspace
- the Provider endpoint and local network are operated by the user

Waxwing does not assume:

- multi-user isolation
- browser pages are trusted callers
- model output is trustworthy
- acceptance evidence submitted by a Delegating Agent is inherently true
- other same-account processes are unable to read user data

## Security design

- The manager binds only to `127.0.0.1`.
- Every HTTP request requires a random bearer token.
- Requests carrying a browser `Origin` header are rejected.
- A task workspace cannot equal, contain, or be nested inside the managed data
  directory.
- Waxwing terminates only a spawned runtime whose PID, task ID, owner marker,
  and command line match the recorded identity.
- Provider API keys are resolved from environment variables and are not copied
  into task records.
- The production Tauri WebView uses a Content Security Policy.
- The Windows preview build is explicitly unsigned; verify its published
  `SHA256SUMS` before execution.

## Handling exposed secrets

Rotate an exposed key at the Provider immediately. Removing a file from the
working tree does not erase it from Git history; rewrite the history and publish
a new release if the secret was committed.
