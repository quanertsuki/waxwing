import fs from 'node:fs';
import path from 'node:path';
import {
  createWorktree,
  gitDiff,
  gitStatus,
  inspectGitWorkspace,
  removeWorktree,
  rollbackWorktree,
} from './git.mjs';
import {pathsOverlap} from '../../prototype/common.mjs';

const MODES = new Set(['auto', 'worktree', 'shared']);
const DEFAULT_GIT = {
  createWorktree,
  gitDiff,
  gitStatus,
  inspectGitWorkspace,
  removeWorktree,
  rollbackWorktree,
};

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * Resolve a workspace mode without creating anything. Creation is a separate
 * step so all request validation can finish before task data is written.
 */
export class WorkspaceLeaseManager {
  constructor(options = {}) {
    this.defaultMode = options.defaultMode ?? 'auto';
    this.worktreeContainerName = options.worktreeContainerName
      ?? options.worktreeParentName
      ?? '.waxwing-worktrees';
    this.git = {...DEFAULT_GIT, ...(options.git ?? {})};
  }

  /**
   * Project the first task that still owns a workspace. The caller supplies
   * current task snapshots plus a live predicate; this module owns the status,
   * overlap, exclusion, and manual-runtime rules.
   */
  conflictFor(workspace, tasks = [], {excludeId = null, live = () => false} = {}) {
    for (const task of tasks) {
      if (!task || task.id === excludeId || typeof task.workspace !== 'string') continue;
      const ownsRuntime = live(task.id) || task.runtime?.manualActionRequired === true;
      if (task.status !== 'running' && task.status !== 'stopping' && !ownsRuntime) continue;
      if (pathsOverlap(workspace, task.workspace)) {
        return {...task, live: live(task.id)};
      }
    }
    return null;
  }

  plan({workspace, mode = this.defaultMode, taskId}) {
    if (!MODES.has(mode)) throw new Error('workspaceMode must be one of auto, worktree, shared');
    const repository = this.git.inspectGitWorkspace(workspace);
    const requestedWorktree = mode === 'worktree';
    const shouldWorktree = requestedWorktree || (mode === 'auto' && repository.isGit);

    if (!repository.isGit) {
      if (requestedWorktree) {
        throw codedError('NOT_GIT_REPOSITORY', 'workspaceMode=worktree requires a Git repository');
      }
      return {
        mode: 'shared',
        requestedMode: mode,
        sourceWorkspace: repository.workspace,
        executionWorkspace: repository.workspace,
        repository: null,
      };
    }
    if (!shouldWorktree) {
      return {
        mode: 'shared',
        requestedMode: mode,
        sourceWorkspace: repository.workspace,
        executionWorkspace: repository.workspace,
        repository,
      };
    }
    if (repository.dirty) {
      throw codedError(
        'DIRTY_WORKSPACE',
        'Git repository has tracked or untracked changes; commit/stash them, or explicitly choose workspaceMode=shared',
      );
    }
    const branch = `waxwing/${taskId}`;
    const worktreePath = path.join(
      path.dirname(repository.repoRoot),
      this.worktreeContainerName,
      taskId,
    );
    const executionWorkspace = path.join(worktreePath, repository.workspaceRelative);
    return {
      mode: 'worktree',
      requestedMode: mode,
      sourceWorkspace: repository.workspace,
      executionWorkspace,
      repository: {
        ...repository,
        worktreePath,
        branch,
        baseCommit: repository.baseCommit,
      },
      lease: {
        mode: 'worktree',
        status: 'planned',
        sourceWorkspace: repository.workspace,
        executionWorkspace,
        repoRoot: repository.repoRoot,
        worktreePath,
        branch,
        baseCommit: repository.baseCommit,
        workspaceRelative: repository.workspaceRelative,
      },
    };
  }

  /**
   * Plan and materialize one lease as a single transaction. The caller cannot
   * accidentally create a worktree before checking occupancy, and any failure
   * after creation is rolled back here rather than in the manager.
   */
  acquire({workspace, mode = this.defaultMode, taskId, conflictFor = () => null}) {
    const plan = this.plan({workspace, mode, taskId});
    const conflict = conflictFor(plan.executionWorkspace)
      ?? (plan.mode === 'worktree' ? conflictFor(plan.sourceWorkspace) : null);
    if (conflict) {
      const error = new Error(`Workspace is occupied by task ${conflict.id} (${conflict.status}${conflict.live ? ', runtime not exited' : ''}); close it before creating a new task`);
      error.code = 'WORKSPACE_OCCUPIED';
      error.conflict = conflict;
      throw error;
    }
    let lease = null;
    try {
      lease = this.materialize(plan);
      return {plan, lease};
    } catch (error) {
      // Materialization only creates. Compensation belongs here, once, so a
      // caller never has to infer whether a rollback already happened.
      try { this.rollback(lease ?? plan.lease); } catch {}
      throw error;
    }
  }

  materialize(plan) {
    if (plan.mode === 'shared') {
      return {
        mode: 'shared',
        status: 'active',
        sourceWorkspace: plan.sourceWorkspace,
        executionWorkspace: plan.executionWorkspace,
        createdAt: new Date().toISOString(),
      };
    }
    const lease = {...plan.lease, status: 'active', createdAt: new Date().toISOString()};
    this.git.createWorktree({
      repoRoot: lease.repoRoot,
      worktreePath: lease.worktreePath,
      branch: lease.branch,
      baseCommit: lease.baseCommit,
    });
    if (!fs.existsSync(plan.executionWorkspace)) {
      throw codedError('WORKTREE_PATH_MISSING', `worktree subdirectory was not created: ${plan.executionWorkspace}`);
    }
    return lease;
  }

  rollback(lease) {
    if (lease?.mode !== 'worktree') return;
    if (lease.status === 'rolled_back' || lease.status === 'removed') return;
    this.git.rollbackWorktree(lease);
    lease.status = 'rolled_back';
  }

  cleanup(lease) {
    if (!lease || lease.mode !== 'worktree') {
      throw new Error('cleanup_worktree requires a task with workspaceLease.mode=worktree');
    }
    if (lease.status === 'removed') {
      return {removed: false, reason: 'worktree already removed', branchRetained: true, branch: lease.branch};
    }
    if (lease.status === 'locked-unverified') {
      return {
        removed: false,
        reason: 'Runtime identity is unverified; resolve the residual process manually before cleaning the worktree',
        manualActionRequired: true,
        branchRetained: true,
        branch: lease.branch,
        workspacePath: lease.worktreePath,
      };
    }
    const result = this.git.removeWorktree({repoRoot: lease.repoRoot, worktreePath: lease.worktreePath});
    if (result.removed) lease.status = 'removed';
    return {
      ...result,
      workspacePath: lease.worktreePath,
      branch: lease.branch,
      baseCommit: lease.baseCommit,
    };
  }

  /**
   * Cleanup is a lifecycle operation, not just a Git command: only a closed
   * task with a confirmed runtime exit may release its worktree, and a dirty
   * worktree is always retained with its branch for manual review.
   */
  release({task, live = false}) {
    if (task?.status !== 'closed') throw new Error('Close the task before cleaning its worktree');
    if (live) throw new Error('Runtime exit is not confirmed; worktree retained');
    const manual = task.runtime?.manualActionRequired === true
      || task.workspaceLease?.status === 'locked-unverified';
    if (manual) {
      throw new Error('Runtime identity is unverified; resolve the residual process manually before cleaning the worktree');
    }
    return this.cleanup(task.workspaceLease);
  }

  inspect(lease, taskWorkspace) {
    if (!lease || lease.mode === 'shared') {
      return {
        mode: lease?.mode ?? 'legacy',
        sourceWorkspace: lease?.sourceWorkspace ?? taskWorkspace,
        executionWorkspace: taskWorkspace,
        isGit: false,
        status: '',
        diff: '',
        lease: lease ?? null,
      };
    }
    const pathToInspect = lease.status === 'removed' ? null : lease.executionWorkspace;
    if (!pathToInspect || !fs.existsSync(pathToInspect)) {
      return {
        mode: lease.mode,
        sourceWorkspace: lease.sourceWorkspace,
        executionWorkspace: lease.executionWorkspace,
        worktreePath: lease.worktreePath,
        branch: lease.branch,
        baseCommit: lease.baseCommit,
        status: '',
        diff: '',
        missing: true,
        lease,
      };
    }
    return {
      mode: lease.mode,
      sourceWorkspace: lease.sourceWorkspace,
      executionWorkspace: lease.executionWorkspace,
      worktreePath: lease.worktreePath,
      branch: lease.branch,
      baseCommit: lease.baseCommit,
      status: this.git.gitStatus(pathToInspect),
      diff: this.git.gitDiff(pathToInspect),
      missing: false,
      lease,
    };
  }
}
