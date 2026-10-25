# Client Integrations

Every client starts one MCP stdio process and connects to the same local
manager. The installed command is `waxwing-mcp`; a source checkout can use
`node /absolute/path/to/waxwing/bin/waxwing-mcp.mjs` instead.

## Codex

Merge [`codex-config.toml`](codex-config.toml) into `~/.codex/config.toml`:

```toml
[mcp_servers.waxwing]
command = "waxwing-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 45
```

Restart Codex and look for the `waxwing` server. Public tools use the
`waxwing_*` prefix. The `ds_*` catalogue remains available as a `0.1.x`
compatibility alias.

## Claude Code

Merge [`mcp.json`](mcp.json) into Claude Code's MCP configuration, or use:

```powershell
claude mcp add waxwing -- waxwing-mcp
```

## DeepSeek Harness

1. Copy [`waxwing-mcp.patch.json`](waxwing-mcp.patch.json).
2. Add the file to the DSH startup arguments with `--patch`.
3. Restart DSH so it refreshes the MCP tool catalogue.

[`Start-Waxwing-with-MCP.example.cmd`](Start-Waxwing-with-MCP.example.cmd)
shows the required Windows launcher structure. Replace every placeholder first.

The similarly named `dsh-mcp.patch.json` and
`Start-DSH-with-Subagent.example.cmd` files are compatibility wrappers for
existing scripts.

## Magpie

[`waxwing.agent.js`](waxwing.agent.js) resolves Waxwing's per-user data
directory and writes Magpie Provider configuration under `WAXWING_HOME`
(`%LOCALAPPDATA%\Waxwing` on Windows by default). Place the file in Magpie's
Agent plugin directory and reload plugins.

[`set-waxwing-order.cmd`](set-waxwing-order.cmd) is a Windows model-order
example. Set `MAGPIE_CLI` when the CLI is not on `PATH`.
`magpie-ds-subagent.agent.js` and `set-dssubagent-order.cmd` remain as legacy
filenames that forward to the Waxwing definitions.

## Troubleshooting

Verify the local manager and MCP process independently:

```powershell
waxwing health
waxwing list
waxwing-mcp
```

If a client cannot see the tools:

- Confirm `waxwing-mcp` is on the client's `PATH`, or use its absolute path.
- Restart the client to reload its MCP catalogue.
- Check client logs for MCP initialization timeouts.
- Make sure multiple managers are not competing for the same loopback port.
- Keep task records, runtime directories, and credentials out of client config.

See [`DELEGATION.md`](DELEGATION.md) for recommended calling behavior.
