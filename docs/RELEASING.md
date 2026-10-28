# Releasing Waxwing

A Waxwing release is a `v*` tag on `main` at `quanertsuki/waxwing`. The tag runs
the `Release` workflow, which builds the artifacts, publishes the npm package
when the repository is configured to, and creates the GitHub Release.

The `waxwing` remote points at `https://github.com/quanertsuki/waxwing.git`. The
older `origin` remote is the legacy internal repository: do not push to it.

## 1. Prepare the version

Cut the version everywhere it is recorded, so the package, desktop app, Rust
crate, and Tauri bundle all agree:

- `package.json` (`version`)
- `desktop/package.json` (`version`)
- `desktop/src-tauri/Cargo.toml` (`version`), plus the matching
  `waxwing-desktop` entry in `desktop/src-tauri/Cargo.lock`
- `desktop/src-tauri/tauri.conf.json` (`version`)
- the "current release is a `x.y.z` preview" line in `README.md` and
  `README.zh-CN.md`

`prototype/mcp.mjs` reads the version from `package.json`, so the MCP
`serverInfo.version` needs no separate edit. `scripts/package-smoke.mjs` fails
when the two disagree.

Then move the `[Unreleased]` entries in `CHANGELOG.md` into a dated `[x.y.z]`
section and add `docs/release-notes-x.y.z.md` describing the release.

## 2. Verify the candidate

Run from a clean checkout of the candidate tree:

```powershell
npm test
npm run check:release-tree
npm pack --dry-run --json
npm run package:smoke
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path desktop/src-tauri/Cargo.toml
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml
npm run desktop:portable
git diff --check
```

`npm run check` is a shortcut for the release-tree check, the JavaScript suite,
and the desktop build.

Inspect the packed output before publishing:

- `npm pack --dry-run --json` lists only shipped files: no task data, runtime
  data, test scratch, credentials, local archive, or machine-specific paths
- the tarball contains `scripts/`, because the manifest advertises
  `npm run check:release-tree`
- the portable archive contains the executable, `resources/backend`,
  `resources/node`, the license, both README files, `UNSIGNED.txt`, and an inner
  `SHA256SUMS`
- `package.json` name, repository, homepage, `bin`, `files`, and `engines`

The release is unsigned. Do not describe the Windows archive as signed or free
of warnings.

## 3. Merge to main

`main` is guarded by two rulesets:

- `Main quality gate` requires linear history, blocks force pushes and branch
  deletion, and requires eight status checks on an up-to-date head: four `Core`
  jobs, two `Package smoke` jobs, `Desktop and Windows portable`, and
  `Secret scan`.
- `Protect release tags` blocks deletion and updates of `v*` tags, so a pushed
  tag can never be moved.

Open a pull request and merge only once every check is green. Linear history
means `Rebase and merge` or `Squash and merge`; GitHub disables
`Create a merge commit`.

## 4. Tag and publish

```powershell
git switch main
git pull --ff-only waxwing main
git tag -a vx.y.z -m "Waxwing x.y.z"
git push waxwing vx.y.z
```

Pushing the tag starts the `Release` workflow:

1. `Build npm tarball` packs the package. A scoped package packs as
   `<scope>-<name>-<version>.tgz`, so the file is renamed to
   `waxwing-x.y.z.tgz`, and the build fails when `package.json` and the tag
   disagree.
2. `Build Windows preview` builds the unsigned portable archive.
3. `Publish npm package` publishes the tarball when the repository variable
   `PUBLISH_NPM` is `true` and the `NPM_TOKEN` secret is set. Otherwise it logs
   that the GitHub Release is the only install source.
4. `Publish GitHub release` uploads `waxwing-x.y.z.tgz`,
   `waxwing-x.y.z-windows-x64.zip`, and a combined `SHA256SUMS`, then creates the
   release with generated notes.

The publish job needs two repository settings under
Settings -> Secrets and variables -> Actions:

- variable `PUBLISH_NPM` = `true`
- secret `NPM_TOKEN` = an npm **automation** token for the publishing account.
  An interactive token is blocked by two-factor auth in CI.

### Re-running a release

Because `Protect release tags` forbids tag deletion and updates, a release that
failed can be rebuilt without touching the tag:

```powershell
gh workflow run release.yml --repo quanertsuki/waxwing --ref main -f tag=vx.y.z
```

or Actions -> Release -> Run workflow, with the tag as the input. The run checks
out the tag, so the artifacts still come from the tagged commit, while the
workflow definition comes from the branch you dispatch.

## 5. Verify the published release

```powershell
npm view @quanernya/waxwing version
npm install --global --prefix ./waxwing-prefix @quanernya/waxwing@x.y.z
./waxwing-prefix/waxwing help
```

On the release page, confirm that `SHA256SUMS` lists both artifacts, that the
tarball asset and the npm tarball share one SHA-256, and that the Windows
archive matches its recorded hash:

```powershell
Get-FileHash .\waxwing-x.y.z-windows-x64.zip -Algorithm SHA256
Get-Content .\SHA256SUMS
```

## 6. Release notes checklist

State explicitly:

- Waxwing `x.y.z` is a preview for a trusted local user.
- The Windows executable is unsigned and may trigger SmartScreen.
- Verify `SHA256SUMS` before running downloaded artifacts.
- CLI and MCP support Windows and Linux CI; Windows desktop is the first desktop
  target.
- There is no hosted service, multi-tenancy, Kanban, or WebSocket support.
- `waxwing_*` is the public MCP namespace; `ds_*` remains through `0.1.x` only.

## 7. Repository settings

- keep both rulesets, `Main quality gate` and `Protect release tags`, active
- enable Private Vulnerability Reporting
- enable Dependabot alerts and security updates
- add `bug`, `enhancement`, `documentation`, `good first issue`, `help wanted`,
  and `security` labels
- confirm the repository description and topics: `local-first`, `mcp`,
  `deepseek`, `openai-compatible`, `tauri`, `agent-orchestration`
- check that secret scanning and code scanning are enabled where the account's
  GitHub plan supports them

## 8. Actions that cannot be undone

- A published npm version cannot be re-published or edited: release a new patch
  version instead.
- A pushed `v*` tag cannot be moved or deleted while `Protect release tags` is
  active. Disable that ruleset only as a deliberate, temporary step.

`scripts/create-orphan-release.ps1` belongs to the historical 0.1.0
publication, which seeded the public repository from a snapshot. Releases from
0.1.1 onwards are cut from `main`.
