# Security Policy

## Supported versions

Waxwing `0.x` releases are previews and receive security fixes on a
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
- Waxwing terminates only its own runtimes. A forced stop kills through the
  child-process handle the manager spawned, which cannot point at a recycled
  PID. After a restart, a runtime known only from its recorded PID is
  terminated only when its PID, task ID, owner marker, and command line match;
  otherwise its workspace lock is retained for manual handling.
- The Worker's `write_file` tool writes only inside the task workspace, so a
  copied absolute path cannot bypass worktree isolation. This is a guard
  against mistakes, not a sandbox: the Worker also has a shell tool and can
  read files outside the workspace.

## Deletion authorization

Deleting a task's scratch records requires a grant recorded by `grant_delete`.
The grant protects against a well-behaved Delegating Agent deleting records by
mistake:

- the MCP catalogue does not offer `grant_delete`
- `waxwing grant-delete` refuses to run without an interactive terminal and
  asks the human to type the complete task ID
- the grant is written to disk before it takes effect

It is not a defence against a hostile process in the same operating-system
account. Such a process can read the manager's bearer token and call
`grant_delete` over HTTP, and it can also delete the data directory directly.
That is inside the trust boundary described above.
- Provider API keys are resolved from environment variables and are not copied
  into task records.
- The production Tauri WebView uses a Content Security Policy.
- The Windows preview build is explicitly unsigned; verify its published
  `SHA256SUMS` before execution.

## Handling exposed secrets

Rotate an exposed key at the Provider immediately. Removing a file from the
working tree does not erase it from Git history; rewrite the history and publish
a new release if the secret was committed.
