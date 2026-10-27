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

const MODES = new Set(['auto', 'worktree', 'shared']);

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
  }

  plan({workspace, mode = this.defaultMode, taskId}) {
    if (!MODES.has(mode)) throw new Error('workspaceMode must be one of auto, worktree, shared');
    const repository = inspectGitWorkspace(workspace);
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
  acquire({workspace, mode = this.defaultMode, taskId, conflictFor = () => null}, {deferRollback = false} = {}) {
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
      if (!deferRollback) {
        try { this.rollback(lease ?? plan.lease); } catch {}
      }
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
    createWorktree({
      repoRoot: lease.repoRoot,
      worktreePath: lease.worktreePath,
      branch: lease.branch,
      baseCommit: lease.baseCommit,
    });
    if (!fs.existsSync(plan.executionWorkspace)) {
      rollbackWorktree(lease);
      throw codedError('WORKTREE_PATH_MISSING', `worktree subdirectory was not created: ${plan.executionWorkspace}`);
    }
    return lease;
  }

  rollback(lease) {
    if (lease?.mode === 'worktree' && lease.status !== 'removed') {
      rollbackWorktree(lease);
      lease.status = 'rolled_back';
    }
  }

  cleanup(lease) {
    if (!lease || lease.mode !== 'worktree') {
      throw new Error('cleanup_worktree requires a task with workspaceLease.mode=worktree');
    }
    if (lease.status === 'removed') {
      return {removed: false, reason: 'worktree already removed', branchRetained: true, branch: lease.branch};
    }
    const result = removeWorktree({repoRoot: lease.repoRoot, worktreePath: lease.worktreePath});
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
      status: gitStatus(pathToInspect),
      diff: gitDiff(pathToInspect),
      missing: false,
      lease,
    };
  }
}
