import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {canonicalExistingPath, sameOrDescendantPath} from '../../prototype/common.mjs';

function run(cwd, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message ?? '').trim(),
      error,
    };
  }
}

export function requireGit(cwd, args, label = 'Git command') {
  const result = run(cwd, args);
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout || 'unknown Git error'}`);
  }
  return result.stdout;
}

export function inspectGitWorkspace(workspace) {
  const realWorkspace = canonicalExistingPath(workspace);
  const repository = run(realWorkspace, ['rev-parse', '--show-toplevel']);
  if (!repository.ok) {
    return {isGit: false, workspace: realWorkspace};
  }
  const repoRoot = canonicalExistingPath(repository.stdout);
  if (!sameOrDescendantPath(realWorkspace, repoRoot)) {
    throw new Error(`Workspace ${realWorkspace} is not inside its reported Git root ${repoRoot}`);
  }
  const baseCommit = requireGit(repoRoot, ['rev-parse', 'HEAD'], 'Resolve Git base commit');
  const status = requireGit(
    repoRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    'Read Git workspace status',
  );
  return {
    isGit: true,
    workspace: realWorkspace,
    repoRoot,
    baseCommit,
    dirty: status.length > 0,
    status,
    workspaceRelative: path.relative(repoRoot, realWorkspace),
  };
}

export function gitStatus(cwd) {
  const result = run(cwd, ['status', '--short', '--branch', '--untracked-files=all']);
  return result.ok ? result.stdout : result.stderr;
}

export function gitDiff(cwd) {
  const result = run(cwd, ['diff', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD']);
  if (result.ok) return result.stdout;
  // A repository with no commit cannot diff HEAD. Show the staged/empty-tree
  // view instead of hiding the error behind an empty response.
  const fallback = run(cwd, ['diff', '--no-ext-diff', '--no-color']);
  return fallback.ok ? fallback.stdout : (fallback.stderr || result.stderr);
}

export function createWorktree({repoRoot, worktreePath, branch, baseCommit}) {
  fs.mkdirSync(path.dirname(worktreePath), {recursive: true});
  if (fs.existsSync(worktreePath)) {
    throw new Error(`WORKTREE_EXISTS: ${worktreePath}`);
  }
  requireGit(
    repoRoot,
    ['worktree', 'add', '-b', branch, worktreePath, baseCommit],
    'Create Git worktree',
  );
  return {worktreePath, branch, baseCommit};
}

export function removeWorktree({repoRoot, worktreePath}) {
  if (!fs.existsSync(worktreePath)) return {removed: false, reason: 'worktree path is already absent'};
  const status = requireGit(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], 'Read worktree status');
  if (status.length > 0) {
    throw new Error('WORKTREE_DIRTY: worktree has tracked or untracked changes; commit or remove them manually before cleanup');
  }
  requireGit(repoRoot, ['worktree', 'remove', worktreePath], 'Remove Git worktree');
  return {removed: true, branchRetained: true};
}

export function rollbackWorktree({repoRoot, worktreePath, branch}) {
  try { requireGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], 'Rollback Git worktree'); } catch {}
  try { requireGit(repoRoot, ['branch', '-D', branch], 'Rollback Git branch'); } catch {}
}
