import {RuntimeCloseOutcome} from './close-outcome.mjs';
import {terminateVerifiedRuntime} from './identity.mjs';

const MANUAL_RETAINED = 'locked-unverified';
const NORMAL_RETAINED = 'retained';
const RECOVERABLE_STATUSES = new Set(['running', 'stopping']);

/**
 * Own the manager-restart projection for a persisted runtime record.
 *
 * Identity inspection remains an adapter concern. This module decides what a
 * verified, unverified, or exited process means for the task record, the
 * workspace lease, and whether termination is allowed. It never overwrites the
 * persisted rounds, result, or event sequence.
 */
export class RuntimeLifecycle {
  constructor({
    terminate = record => terminateVerifiedRuntime(record),
    now = () => new Date().toISOString(),
    closeOutcome = null,
  } = {}) {
    this.terminate = terminate;
    this.now = now;
    this.closeOutcome = closeOutcome ?? new RuntimeCloseOutcome({now});
  }

  /**
   * Project one residual runtime after a manager restart.
   *
   * `identity` is the result of the identity adapter:
   *   {verified, alive, reason}
   */
  recover({task, runtime, identity} = {}) {
    if (!task || typeof task !== 'object') throw new Error('task record is required');
    if (!RECOVERABLE_STATUSES.has(task.status)) {
      return {
        task,
        runtime,
        decision: 'not-recoverable',
        workspaceStatus: task.workspaceLease?.status ?? null,
      };
    }
    if (!runtime || typeof runtime !== 'object') throw new Error('runtime record is required');
    if (!identity || typeof identity !== 'object') throw new Error('runtime identity is required');

    const at = this.now();
    const reason = typeof identity.reason === 'string' ? identity.reason : null;
    if (identity.verified === true) {
      try {
        const verdict = this.terminate(runtime, {identity}) ?? {};
        if (verdict.terminated !== true) {
          return this.#project(task, runtime, {
            at,
            phase: 'recovery-failed',
            manualActionRequired: true,
            reason: verdict.reason ?? 'termination was not confirmed',
            decision: 'termination-failed',
          });
        }
        return this.#project(task, runtime, {
          at,
          phase: 'recovered-terminated',
          manualActionRequired: false,
          reason,
          decision: 'terminated',
        });
      } catch (error) {
        return this.#project(task, runtime, {
          at,
          phase: 'recovery-failed',
          manualActionRequired: true,
          reason: `verified process could not be terminated: ${error?.message ?? String(error)}`,
          decision: 'termination-failed',
        });
      }
    }
    if (identity.alive === true) {
      return this.#project(task, runtime, {
        at,
        phase: 'orphaned-unverified',
        manualActionRequired: true,
        reason,
        decision: 'manual',
      });
    }
    return this.#project(task, runtime, {
      at,
      phase: 'exited',
      manualActionRequired: false,
      reason,
      decision: 'exited',
    });
  }

  /**
   * Project a close request after its exit wait. A confirmed exit allows the
   * owned handle to be forgotten; an unconfirmed exit keeps both the handle and
   * the workspace lease. A close IPC error becomes a failed final record only
   * after exit itself is confirmed.
   */
  exit({task, exitConfirmed, closeError = null} = {}) {
    return this.closeOutcome.project({task, exitConfirmed, closeError});
  }

  #project(task, runtime, {at, phase, manualActionRequired, reason, decision}) {
    const nextRuntime = {
      ...runtime,
      phase,
      manualActionRequired,
      recovery: {at, reason},
    };
    const nextTask = {
      ...task,
      status: 'failed',
      runtime: nextRuntime,
      error: manualActionRequired
        ? `Manager restarted with an unverified residual runtime (PID ${nextRuntime.pid}); workspace lock retained for manual resolution`
        : 'Manager restarted; the old runtime is no longer reusable, so inspect the workspace and create a new task for follow-up work',
    };
    if (task.workspaceLease) {
      nextTask.workspaceLease = {
        ...task.workspaceLease,
        status: manualActionRequired ? MANUAL_RETAINED : NORMAL_RETAINED,
      };
    }
    return {
      task: nextTask,
      runtime: nextRuntime,
      decision,
      workspaceStatus: task.workspaceLease
        ? nextTask.workspaceLease.status
        : null,
    };
  }
}

export {MANUAL_RETAINED, NORMAL_RETAINED};
