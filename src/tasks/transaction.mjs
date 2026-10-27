import {TaskLifecycle, transition} from './lifecycle.mjs';

/**
 * Own task lifecycle transactions that span more than one side effect. The
 * repository persists records; this module owns validation order, the optional
 * `stopping` state, and rollback after a failed create or stop.
 *
 * Hooks are deliberately narrow:
 *   runtime.has/get/beginClose/sendClose/waitForExit/forget/closeError
 *   save(task), event(task, payload), untrusted(id, detail)
 *   workspace.materialize/rollback
 *   acceptance.report(task)
 */
export class TaskTransaction {
  constructor({
    runtime,
    repository,
    save,
    event = () => {},
    workspace = {},
    acceptance = {},
    now = () => new Date().toISOString(),
    gracefulExitTimeoutMs,
    forceExitTimeoutMs,
    terminate = null,
    untrusted = () => {},
  } = {}) {
    if (!runtime) throw new Error('runtime dependency is required');
    if (!repository) throw new Error('repository dependency is required');
    if (typeof save !== 'function') throw new Error('save dependency is required');
    this.runtime = runtime;
    this.repository = repository;
    this.save = save;
    this.event = event;
    this.workspace = workspace;
    this.acceptance = acceptance;
    this.now = now;
    this.gracefulExitTimeoutMs = gracefulExitTimeoutMs;
    this.forceExitTimeoutMs = forceExitTimeoutMs;
    this.terminate = terminate;
    this.onUntrusted = untrusted;
  }

  /**
   * Execute the create transaction. The caller supplies a fully validated
   * request and a record builder; directory creation and record persistence
   * are rolled back together if either workspace materialization or the first
   * save fails.
   */
  create({
    taskId,
    request,
    directory,
    makeDirectories,
    removeDirectory,
    preflight,
    buildRecord,
  }) {
    makeDirectories();
    let lease = null;
    let task = null;
    try {
      lease = typeof this.workspace.acquire === 'function'
        ? this.workspace.acquire({
          workspace: preflight.workspace,
          mode: preflight.workspaceMode,
          taskId,
          conflictFor: preflight.conflictFor,
        }).lease
        : this.workspace.materialize(preflight.workspacePlan);
      task = buildRecord({request, lease, directory});
      this.save(task);
      return {task, lease};
    } catch (error) {
      try { this.workspace.rollback?.(lease); } catch {}
      try { removeDirectory(); } catch {}
      try { this.repository.delete(task?.id ?? taskId); } catch {}
      throw error;
    }
  }

  /**
   * Cancel or close one task. The final action is validated before runtime is
   * touched. A runtime-backed task enters `stopping`, sends close, waits for
   * confirmed exit, and then merges the final lifecycle fields into the latest
   * record so a terminal round cannot be overwritten by a stale snapshot.
   */
  async stop(taskId, {closed = false, reason} = {}) {
    const existing = this.repository.get(taskId);
    if (existing.status === 'closed') return {task: existing, unchanged: true};
    const action = closed ? 'close' : 'stop';
    TaskLifecycle.assertStop(existing, action);
    if (existing.runtime?.manualActionRequired) {
      throw new Error(`Task ${taskId} has an unverified residual runtime; confirm PID ${existing.runtime.pid} manually before closing`);
    }

    let rec = this.runtime.get(taskId);
    if (!rec && ['running', 'stopping'].includes(existing.status)) {
      throw new Error(`Task ${taskId} has no owned runtime handle; exit is unconfirmed, refusing to change state`);
    }

    if (rec) {
      if (!this.runtime.beginClose(taskId)) throw new Error('Already stopping; refresh state');
      const stopping = existing.status === 'stopping'
        ? existing
        : transition(existing, 'begin_stop');
      this.save(stopping);
      this.event(stopping, {kind: 'stop_requested', closed});
      if (this.runtime.sendClose(taskId)) this.untrusted(taskId, 'close IPC send failure');

      const graceful = await this.runtime.waitForExit(taskId, this.gracefulExitTimeoutMs);
      if (!graceful) {
        await this.forceExit(taskId, rec);
        const gone = await this.runtime.waitForExit(taskId, this.forceExitTimeoutMs);
        if (!gone) throw new Error(`Task ${taskId}: could not confirm worker exit; data and workspace lock retained`);
      }

      const closeError = this.runtime.closeError(taskId);
      const forgotten = this.runtime.forget(taskId);
      if (!forgotten && this.runtime.has(taskId)) {
        throw new Error(`Task ${taskId}: worker exit could not be confirmed; data and workspace lock retained`);
      }
      if (closeError) {
        const failed = {
          ...stopping,
          status: 'failed',
          error: `Task ${taskId} runtime cleanup failed: ${closeError}`,
          updatedAt: this.now(),
        };
        this.save(failed);
        throw new Error(failed.error);
      }
    }

    const latest = this.repository.peek(taskId) ?? existing;
    const transitioned = transition(latest, action);
    const finalTask = {...transitioned, error: reason ?? transitioned.error};
    if (closed && typeof this.acceptance.report === 'function') {
      const report = this.acceptance.report(finalTask);
      finalTask.reportHash = report.hash;
    }
    this.event(finalTask, {kind: closed ? 'closed' : 'cancelled'});
    return {task: this.save(finalTask), unchanged: false};
  }

  /**
   * Apply a rework/run transition and the acceptance revocation in one
   * mutation. The caller has already run its policy checks; this method keeps
   * the ordering and source immutability in one place.
   */
  beginRun(task, configure) {
    const next = transition(task, 'run');
    if (typeof this.acceptance.revoke === 'function') {
      const revoked = this.acceptance.revoke(next);
      next.acceptance = revoked.acceptance;
      next.reportHash = revoked.reportHash;
    }
    if (typeof configure === 'function') configure(next);
    return next;
  }

  async forceExit(taskId, rec) {
    if (typeof this.terminate !== 'function') {
      throw new Error('terminate dependency is required to force runtime exit');
    }
    await this.terminate({taskId, rec});
  }

  untrusted(taskId, detail) {
    this.onUntrusted(taskId, detail);
  }
}
