# Releasing Waxwing 0.1

This checklist prepares the first public release at
`quanertsuki/waxwing`. Do not push the old internal history or modify the
existing `quanertsuki/DS_subagent` remote.

## 1. Verify the candidate

Run from a clean checkout of the candidate tree:

```powershell
npm test
npm run desktop:build
npm run desktop:resources
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
npm run package:smoke
npm pack --dry-run --json
npm run desktop:portable
git diff --check
```

Then inspect the npm package and Windows archive:

- no task data, runtime data, test temp files, credentials, local archive, or
  machine-specific paths
- `package.json` name, repository, homepage, `bin`, `files`, and `engines`
- portable archive contains the executable, `resources/backend`,
  `resources/node`, license, README files, `UNSIGNED.txt`, and inner
  `SHA256SUMS`
- outside `SHA256SUMS` matches the zip
- start the portable executable from a directory with no source checkout and
  confirm data is created under `%LOCALAPPDATA%\Waxwing`

The release is unsigned. Do not describe the Windows archive as signed or warn
free.

## 2. Create a new public history

The release snapshot is built through a temporary Git index. This creates an
orphan commit without switching branches or touching the current working tree.
Ignored internal reports, task data, archives, and build output stay out of the
commit.

```powershell
powershell -NoProfile -File scripts/create-orphan-release.ps1
git show --stat waxwing-0.1.0
```

Before staging, confirm `git check-ignore` covers each internal record. Do not
use `git switch --orphan`, `git reset --hard`, `git checkout --`, or `git clean`:
those commands can remove or overwrite the live working tree.

## 3. Push the new repository

Create or confirm an empty public GitHub repository at
`quanertsuki/waxwing`. Add it under a new remote name; leave `origin` alone.

```powershell
git remote add waxwing https://github.com/quanertsuki/waxwing.git
git push waxwing waxwing-0.1.0:main
git tag -a v0.1.0 -m "Waxwing 0.1.0"
git push waxwing v0.1.0
```

The `Release` workflow builds the npm tarball and unsigned Windows archive,
combines their SHA-256 checksums, and creates the GitHub Release for tags
matching `v*`.

## 4. Publish npm

The release workflow publishes the tarball only when the repository variable
`PUBLISH_NPM` is `true` and the repository secret `NPM_TOKEN` exists. The
default for a new repository is no registry publication. A first manual publish
can be performed instead:

```bash
npm publish @quanernya/waxwing@0.1.0 --access public
```

Verify in a clean temporary prefix:

```bash
npm install --global --prefix ./waxwing-prefix @quanernya/waxwing@0.1.0
./waxwing-prefix/bin/waxwing health
./waxwing-prefix/bin/waxwing-mcp
```

`npm run package:smoke` already performs this flow, including MCP
initialization and manager shutdown.

## 5. Repository settings

After the new repository is visible:

- enable Private Vulnerability Reporting
- enable Dependabot alerts and security updates
- protect `main`, require CI, and disallow force pushes and deletion
- set Actions to read-only by default and confirm job-level permissions
- add `bug`, `enhancement`, `documentation`, `good first issue`,
  `help wanted`, and `security` labels
- confirm the repository description and topics: `local-first`, `mcp`,
  `deepseek`, `openai-compatible`, `tauri`, `agent-orchestration`
- check that secret scanning alerts and code scanning are enabled where the
  account's GitHub plan supports them

## 6. Release notes

State explicitly:

- Waxwing `0.1.0` is a preview for a trusted local user.
- The Windows executable is unsigned and may trigger SmartScreen.
- Verify `SHA256SUMS` before running downloaded artifacts.
- CLI and MCP support Windows and Linux CI; Windows desktop is the first desktop
  target.
- There is no hosted service, multi-tenancy, Kanban, or WebSocket support.
- `waxwing_*` is the public MCP namespace; `ds_*` remains through `0.1.x` only.
