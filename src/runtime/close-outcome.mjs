/**
 * Own the projection from confirmed process facts to the task the caller must
 * persist. It never writes files, forgets handles, or sends close messages;
 * `TaskTransaction` executes the returned decision in the required order.
 */
export class RuntimeCloseOutcome {
  constructor({now = () => new Date().toISOString()} = {}) {
    this.now = now;
  }

  /**
   * `exitConfirmed` is the only fact that permits forgetting the handle.
   * A close IPC error only becomes a failed task after exit is confirmed, so a
   * cleanup failure can never be mistaken for a still-running worker.
   */
  project({task, exitConfirmed, closeError = null} = {}) {
    if (!task || typeof task !== 'object') throw new Error('task record is required');
    if (exitConfirmed !== true) {
      return {
        task,
        decision: 'exit-unconfirmed',
        releaseHandle: false,
        workspaceRetained: true,
        error: `Task ${task.id}: could not confirm worker exit; data and workspace lock retained`,
      };
    }
    if (closeError) {
      const failed = {
        ...task,
        status: 'failed',
        error: `Task ${task.id} runtime cleanup failed: ${closeError}`,
        updatedAt: this.now(),
      };
      return {
        task: failed,
        decision: 'cleanup-failed',
        releaseHandle: true,
        workspaceRetained: true,
        error: failed.error,
      };
    }
    return {
      task,
      decision: 'exited',
      releaseHandle: true,
      workspaceRetained: true,
      error: null,
    };
  }
}
