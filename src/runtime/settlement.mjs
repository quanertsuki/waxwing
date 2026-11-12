// RuntimeSettlement owns one rule: given a runtime fact, what becomes of the
// task record, the event journal, the workspace lease, and the owned process
// handle? It never writes files, sends messages, or forgets handles; callers
// execute the returned projection in their required order.
//
// Failure transitions go through TaskLifecycle so the status table stays the
// only rule:
//   * `fail`       running  -> failed
//   * `fail_stop`  stopping -> failed
//   * `failed` failing again only updates `error` and records the event
// A failure projected from any other status is a caller-ordering bug and
// throws instead of inventing a new state.
import {terminateVerifiedRuntime} from './identity.mjs';
import {TaskLifecycle, transition} from '../tasks/lifecycle.mjs';

export const MANUAL_RETAINED = 'locked-unverified';
export const NORMAL_RETAINED = 'retained';

const RECOVERABLE_STATUSES = new Set(['running', 'stopping']);

function validTask(task) {
  return Boolean(task) && typeof task === 'object' && Array.isArray(task.rounds);
}

function validMessage(message) {
  return Boolean(message) && typeof message === 'object' &&
    (message.kind === 'result' || message.kind === 'error');
}

function detached(task) {
  return {
    ...task,
    rounds: task.rounds.map(round => ({
      ...round,
      result: round.result && typeof round.result === 'object'
        ? {...round.result}
        : round.result,
    })),
  };
}

/**
 * Every projection has the same fields:
 *   task           next record the caller must persist
 *   action         lifecycle action applied, or null when nothing moved
 *   event          event payload to append, or null
 *   health         runtime health change, or null
 *   releaseHandle  whether a confirmed exit lets the caller forget the handle
 *   runtime        next persisted runtime record (recovery only)
 *   fallback       deferred Provider-fallback handoff, or null
 *   decision       recovery/close classification, or null
 *   lease          {status} conclusion for the workspace lease, or null
 *   error          human-readable failure text, or null
 */
export class RuntimeSettlement {
  constructor({
    terminate = record => terminateVerifiedRuntime(record),
    now = () => new Date().toISOString(),
    fallbackProvider = () => null,
    defaultModel = () => null,
    supportsEffort = () => false,
  } = {}) {
    this.terminate = terminate;
    this.now = now;
    this.fallbackProvider = fallbackProvider;
    this.defaultModel = defaultModel;
    this.supportsEffort = supportsEffort;
  }

  // --- terminal round --------------------------------------------------------
  terminal({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!validMessage(message)) throw new Error('terminal runtime message is required');
    const ok = message.kind === 'result' && message.finishReason === 'completed';
    const finishReason = message.finishReason ?? (ok ? 'completed' : 'error');
    const error = ok ? null : message.error ?? `Provider ended with ${finishReason}`;
    const action = ok ? 'finish' : 'fail';
    const changed = transition(detached(task), action);
    changed.updatedAt = this.now();
    changed.output = message.text ?? '';
    changed.finishReason = finishReason;
    changed.error = error;
    const last = changed.rounds.at(-1);
    if (last) {
      last.result = {
        text: changed.output,
        finishReason: changed.finishReason,
        error,
      };
      last.finishedAt = this.now();
    }
    return this.#result({
      task: changed,
      action,
      event: {
        kind: 'round_finished',
        roundId: message.roundId,
        status: changed.status,
      },
      error,
    });
  }

  /**
   * Decide first-round fallback before the normal terminal projection. The
   * handoff is a deferred action; this module never dispatches it.
   */
  firstRoundFailure(task, message, fallbackName = null) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!validMessage(message)) throw new Error('terminal runtime message is required');
    const ok = message.kind === 'result' && message.finishReason === 'completed';
    if (ok || task.rounds.length !== 1 || !fallbackName ||
        task.provider?.name === fallbackName) {
      return null;
    }
    const provider = this.fallbackProvider(fallbackName);
    if (!provider) return null;
    const candidate = detached(task);
    const round = candidate.rounds[0];
    const at = this.now();
    round.result = {
      text: message.text ?? '',
      finishReason: message.finishReason ?? 'error',
      error: message.error || `Provider ended with ${message.finishReason ?? 'error'}`,
    };
    round.finishedAt = at;
    const action = this.#failAction(candidate);
    const failed = action ? transition(candidate, action) : {...candidate, updatedAt: at};
    failed.updatedAt = at;
    failed.provider = provider;
    failed.model = provider.model || this.defaultModel();
    failed.error = null;
    return this.#result({
      task: failed,
      action,
      event: {
        kind: 'provider_fallback',
        from: task.provider?.name ?? null,
        to: fallbackName,
        error: message.error || message.finishReason,
      },
      fallback: {
        taskId: task.id,
        prompt: round.prompt,
        maxTokens: round.maxTokens,
        effort: this.supportsEffort(provider) ? round.effort ?? null : null,
        providerName: fallbackName,
      },
    });
  }

  // --- failure facts ---------------------------------------------------------
  startFailed({task, error = null, message, runtimeUnconfirmed = false} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (typeof message !== 'string' || !message) throw new Error('failure message is required');
    return this.#fail(task, message, {
      kind: 'start_failed',
      error: error ?? message,
      runtimeUnconfirmed: Boolean(runtimeUnconfirmed),
    });
  }

  fallbackFailed({task, providerName = null, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (typeof message !== 'string' || !message) throw new Error('failure message is required');
    return this.#fail(task, message, {
      kind: 'provider_fallback_failed',
      provider: providerName,
      error: message,
    });
  }

  stopFailed({task, timeoutMs = null, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (typeof message !== 'string' || !message) throw new Error('failure message is required');
    return this.#fail(task, message, {
      kind: 'round_stop_failed',
      timeoutMs,
      error: message,
    });
  }

  missingTerminal({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    return this.#fail(
      task,
      `Task ${task.id}: worker released ${message?.roundId} without a result or error`,
      {
        kind: 'round_protocol_error',
        roundId: message?.roundId,
        reason: 'missing terminal message',
      },
    );
  }

  workerBusy({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    return this.#fail(
      task,
      `Task ${task.id}: worker_busy for ${message?.roundId}; the previous round is still active`,
      {kind: 'worker_busy', reportedRoundId: message?.roundId},
      {health: {health: 'unhealthy', detail: 'worker_busy'}},
    );
  }

  ackTimeout({task, roundId, timeoutMs} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    return this.#fail(
      task,
      `Task ${task.id}: worker did not acknowledge round ${roundId} within ${timeoutMs / 1000}s; the process was not terminated`,
      {kind: 'round_ack_timeout', roundId},
      {health: {health: 'unhealthy', detail: 'ack timeout'}},
    );
  }

  /**
   * A process-level failure is a failed round while it is running, or an
   * updated error after an earlier failure. During stopping and after review
   * the exit is an expected event, not a failure, so the record is untouched.
   */
  processError({task, error} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    const detail = error?.message ?? String(error ?? 'unknown error');
    if (!this.#projectsProcessFailure(task.status)) return this.#result({task});
    return this.#fail(task, `Task ${task.id} worker error: ${detail}`, {
      kind: 'runtime_error',
      error: detail,
    });
  }

  processExited({task, code = null} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!this.#projectsProcessFailure(task.status)) return this.#result({task});
    return this.#fail(
      task,
      `Task ${task.id} worker exited (${code}); inspect runtime.log`,
      {kind: 'runtime_exit', exitCode: code},
    );
  }

  // --- close -----------------------------------------------------------------
  /**
   * `exitConfirmed` is the only fact that permits forgetting the handle. A
   * close IPC error only becomes a failed task after exit is confirmed, so a
   * cleanup failure can never be mistaken for a still-running worker.
   */
  close({task, exitConfirmed, closeError = null} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (exitConfirmed !== true) {
      return this.#result({
        task,
        decision: 'exit-unconfirmed',
        error: `Task ${task.id}: could not confirm worker exit; data and workspace lock retained`,
      });
    }
    if (closeError) {
      const failed = this.#fail(task, `Task ${task.id} runtime cleanup failed: ${closeError}`);
      return {...failed, decision: 'cleanup-failed', releaseHandle: true};
    }
    return this.#result({task, decision: 'exited', releaseHandle: true});
  }

  // --- restart recovery ------------------------------------------------------
  /**
   * Project one residual runtime after a manager restart. `identity` is the
   * identity adapter's verdict: {verified, alive, reason}. The persisted
   * rounds, result, and event sequence are never overwritten.
   */
  recover({task, runtime, identity} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!RECOVERABLE_STATUSES.has(task.status)) {
      return this.#result({task, runtime, decision: 'not-recoverable'});
    }
    if (!runtime || typeof runtime !== 'object') throw new Error('runtime record is required');
    if (!identity || typeof identity !== 'object') throw new Error('runtime identity is required');

    const at = this.now();
    const reason = typeof identity.reason === 'string' ? identity.reason : null;
    if (identity.verified === true) {
      try {
        const verdict = this.terminate(runtime, {identity}) ?? {};
        if (verdict.terminated !== true) {
          return this.#recovered(task, runtime, {
            at,
            phase: 'recovery-failed',
            manualActionRequired: true,
            reason: verdict.reason ?? 'termination was not confirmed',
            decision: 'termination-failed',
          });
        }
        return this.#recovered(task, runtime, {
          at,
          phase: 'recovered-terminated',
          manualActionRequired: false,
          reason,
          decision: 'terminated',
        });
      } catch (error) {
        return this.#recovered(task, runtime, {
          at,
          phase: 'recovery-failed',
          manualActionRequired: true,
          reason: `verified process could not be terminated: ${error?.message ?? String(error)}`,
          decision: 'termination-failed',
        });
      }
    }
    if (identity.alive === true) {
      return this.#recovered(task, runtime, {
        at,
        phase: 'orphaned-unverified',
        manualActionRequired: true,
        reason,
        decision: 'manual',
      });
    }
    return this.#recovered(task, runtime, {
      at,
      phase: 'exited',
      manualActionRequired: false,
      reason,
      decision: 'exited',
    });
  }

  // --- internals -------------------------------------------------------------
  #projectsProcessFailure(status) {
    return status === 'running' || status === 'failed';
  }

  /** `fail` from running, `fail_stop` from stopping, or null when already failed. */
  #failAction(task) {
    if (task.status === 'running') return 'fail';
    if (task.status === 'stopping') return 'fail_stop';
    if (task.status === 'failed') return null;
    // A projection from any other status is a caller-ordering bug; let the
    // lifecycle table raise the canonical error.
    TaskLifecycle.assert(task, 'fail');
    return null;
  }

  #fail(task, message, event = null, {health = null} = {}) {
    const action = this.#failAction(task);
    const next = action ? transition(task, action) : {...task};
    next.updatedAt = this.now();
    next.error = message;
    return this.#result({task: next, action, event, health, error: message});
  }

  #recovered(task, runtime, {at, phase, manualActionRequired, reason, decision}) {
    const nextRuntime = {
      ...runtime,
      phase,
      manualActionRequired,
      recovery: {at, reason},
    };
    const action = task.status === 'stopping' ? 'fail_stop' : 'fail';
    const nextTask = transition(task, action);
    nextTask.updatedAt = at;
    nextTask.runtime = nextRuntime;
    nextTask.error = manualActionRequired
      ? `Manager restarted with an unverified residual runtime (PID ${nextRuntime.pid}); workspace lock retained for manual resolution`
      : 'Manager restarted; the old runtime is no longer reusable, so inspect the workspace and create a new task for follow-up work';
    if (task.workspaceLease) {
      nextTask.workspaceLease = {
        ...task.workspaceLease,
        status: manualActionRequired ? MANUAL_RETAINED : NORMAL_RETAINED,
      };
    }
    return this.#result({
      task: nextTask,
      action,
      runtime: nextRuntime,
      decision,
      error: nextTask.error,
    });
  }

  #result({
    task,
    action = null,
    event = null,
    health = null,
    releaseHandle = false,
    runtime = null,
    fallback = null,
    decision = null,
    error = null,
  } = {}) {
    return {
      task,
      action,
      event,
      health,
      releaseHandle,
      runtime,
      fallback,
      decision,
      lease: task?.workspaceLease ? {status: task.workspaceLease.status} : null,
      error,
    };
  }
}
