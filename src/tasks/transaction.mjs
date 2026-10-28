import {RuntimeCloseOutcome} from '../runtime/close-outcome.mjs';
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
    runtimeLifecycle = null,
    closeOutcome = null,
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
    this.runtimeLifecycle = runtimeLifecycle;
    this.closeOutcome = closeOutcome
      ?? (runtimeLifecycle ? {project: args => runtimeLifecycle.exit(args)} : new RuntimeCloseOutcome({now}));
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
        if (!gone) {
          this.runtime.abortClose?.(taskId);
          const outcome = this.closeOutcome.project({
            task: this.repository.peek(taskId) ?? stopping,
            exitConfirmed: false,
          });
          throw new Error(outcome.error
            ?? `Task ${taskId}: could not confirm worker exit; data and workspace lock retained`);
        }
      }

      const closeError = this.runtime.closeError(taskId);
      const outcome = this.closeOutcome.project({
        task: this.repository.peek(taskId) ?? stopping,
        exitConfirmed: true,
        closeError,
      });
      if (outcome.releaseHandle === false) {
        this.runtime.abortClose?.(taskId);
        throw new Error(outcome.error);
      }

      if (closeError) {
        // The handle may be forgotten only after the failed terminal record is
        // durable; otherwise a retry would find `stopping` with no handle.
        try {
          this.save(outcome.task);
        } catch (error) {
          this.runtime.abortClose?.(taskId);
          throw error;
        }
        this.runtime.forget(taskId);
        throw new Error(outcome.error);
      }

      const latest = this.repository.peek(taskId) ?? outcome.task;
      const transitioned = transition(latest, action);
      const finalTask = {...transitioned, error: reason ?? transitioned.error};
      let savedTask = finalTask;
      try {
        if (closed && typeof this.acceptance.writeReportAndSave === 'function') {
          savedTask = this.acceptance.writeReportAndSave(finalTask, {save: this.save}).task ?? finalTask;
        } else {
          if (closed && typeof this.acceptance.report === 'function') {
            const report = this.acceptance.report(finalTask);
            finalTask.reportHash = report.hash;
          }
          savedTask = this.save(finalTask) ?? finalTask;
        }
      } catch (error) {
        this.runtime.abortClose?.(taskId);
        throw error;
      }
      try {
        this.event(savedTask, {kind: closed ? 'closed' : 'cancelled'});
      } catch (error) {
        // The task is already durable; do not strand the owned handle.
        this.runtime.forget(taskId);
        throw error;
      }
      const forgotten = this.runtime.forget(taskId);
      if (!forgotten && this.runtime.has(taskId)) {
        throw new Error(`Task ${taskId}: worker exit was confirmed but the runtime handle could not be released`);
      }
      return {task: savedTask, unchanged: false};
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

  /**
   * Prepare the next round after the previous runtime has explicitly released.
   * The caller supplies a fully-validated prompt/budget/effort and a policy
   * snapshot; this method owns read-after-gate, lifecycle transition,
   * acceptance revocation, round numbering, and the persisted round record.
   */
  async prepareRun(taskId, {
    prompt,
    maxTokens,
    effort = null,
    policy = {meta: {}, text: null},
    configure,
  } = {}) {
    const startedAt = this.now();
    let current = this.repository.peek(taskId);
    if (!current) throw new Error('Unknown task');
    const active = this.runtime.get(taskId);
    if (active && active.phase !== 'idle') {
      const released = await this.runtime.waitForRelease(taskId);
      current = this.repository.peek(taskId) ?? current;
      if (!released) {
        throw new Error(`Task ${taskId}: previous runtime exited before releasing its round; create a new task`);
      }
      if (current.status === 'running') {
        throw new Error('Task is already running; wait for the current round to finish');
      }
    }
    if (current.status === 'running') {
      throw new Error('Task is already running; wait for the current round to finish');
    }
    const roundId = this.runtime.createRoundId();
    const next = this.beginRun(current, value => {
      value.error = null;
      value.output = null;
      value.maxTokens = maxTokens;
      value.effort = effort;
      value.runtimeHealth = 'starting';
      if (typeof configure === 'function') configure(value);
    });
    if (policy?.meta?.applied) {
      next.policySnapshot = {
        version: policy.meta.version,
        sha256: policy.meta.sha256,
        text: policy.text,
      };
    }
    const number = next.rounds.length + 1;
    next.rounds.push({
      roundId,
      number,
      prompt,
      startedAt,
      maxTokens,
      effort,
      policy: policy?.meta ?? {},
    });
    this.save(next);
    this.event(next, {kind: 'round_started', roundId, number, maxTokens, effort});
    return {task: next, roundId, number, startedAt};
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
