// The Runtime module owns one task's single-round lifecycle. Everything that a
// round can race on lives behind this interface:
//
//   * the unique roundId allocated for every dispatch
//   * the run -> ack -> events/heartbeat -> result|error -> released ordering
//   * rejection of a busy worker and the discard of late/duplicate messages
//   * the ACK, heartbeat, and round timers
//   * the terminal and release gates, so a result is never a release
//   * process-exit confirmation plus the identity state recovery needs
//   * the Provider-fallback handoff, which only fires after `released`
//
// Callers supply a small `hooks` object for the effects the manager still owns
// (task records, lifecycle transitions, workspace-facing events, process
// forking). No filesystem, Git, acceptance, usage, or Provider discovery code
// belongs here.
import {randomUUID} from 'node:crypto';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  HEARTBEAT_STALE_MS,
  ROUND_MESSAGE_KINDS,
  closeMessage,
  createRoundId,
  isRoundId,
  runMessage,
  validateMessage,
} from './protocol.mjs';
import {RuntimeSettlement} from './settlement.mjs';

/**
 * Resolve the configured round timers into one value object. The Runtime module,
 * not the manager, owns the defaults, so a missing or nonsense config value can
 * never disable an ACK, heartbeat, or round deadline silently.
 */
export function roundTimeouts(source = {}) {
  const ackSeconds = Number(source.ackTimeoutSeconds);
  const staleMs = Number(source.heartbeatStaleMs);
  const checkMs = Number(source.heartbeatCheckMs);
  const roundSeconds = Number(source.roundTimeoutSeconds);
  return {
    ackTimeoutMs: Number.isFinite(ackSeconds) && ackSeconds > 0
      ? ackSeconds * 1000
      : DEFAULT_ACK_TIMEOUT_MS,
    heartbeatStaleMs: staleMs > 0 ? staleMs : HEARTBEAT_STALE_MS,
    heartbeatCheckMs: checkMs > 0 ? checkMs : DEFAULT_HEARTBEAT_CHECK_MS,
    roundTimeoutMs: Number.isFinite(roundSeconds) && roundSeconds > 0 ? roundSeconds * 1000 : 0,
  };
}

const ACTIVE_EVENT_PHASES = new Set(['running', 'awaiting_ack']);
const DEFAULT_HEARTBEAT_CHECK_MS = 5_000;
const DEFAULT_EXIT_TIMEOUT_MS = 14_000;
const FORCE_EXIT_TIMEOUT_MS = 5_000;

// Release and exit gates. A terminal message is not permission to dispatch the
// next round: only an explicit `released` opens the gate, and only the process
// handle can confirm an exit. `Runtime` uses these directly; the deprecated
// `RuntimeSupervisor` export delegates to them.

/** Release every waiter on the gate with one verdict. */
export function settleRecordRelease(record, value) {
  if (!record?.releaseWaiters) return;
  const waiters = record.releaseWaiters.splice(0);
  for (const resolve of waiters) resolve(value);
}

/** Resolve once the active round releases; an exited record yields false. */
export function waitForRecordRelease(record) {
  if (!record || record.phase === 'idle') return Promise.resolve(true);
  if (record.phase === 'exited') return Promise.resolve(false);
  return new Promise(resolve => record.releaseWaiters.push(resolve));
}

/** True only when the process handle reports an exit code or signal. */
export function recordHasExited(record) {
  const value = record?.w;
  return value?.exitCode !== null && value?.exitCode !== undefined
    || value?.signalCode !== null && value?.signalCode !== undefined;
}

/** Wait for the owned process exit event, including an already-exited handle. */
export function waitForRecordExit(record, timeoutMs) {
  return new Promise(resolve => {
    if (recordHasExited(record)) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.w.off?.('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    record.w.once?.('exit', onExit) ?? record.w.on?.('exit', onExit);
  });
}

/**
 * Hooks the manager (or a test double) implements:
 *   spawn({task, ownerMarker}) -> process handle        (required on first round)
 *   latest(id) -> task record | null                    (required)
 *   event({task, payload})                              (optional)
 *   save({task})                                        (optional)
 *   transition({task, action}) -> task                   (required for terminal/exit)
 *   persist({task, rec, extra})                          (optional; runtime.json)
 *   log({task, rec, chunk})                              (optional)
 *   untrusted({id, detail})                              (optional)
 *   terminal({task, rec, message})                       (result|error policy)
 *   terminalMissing({task, rec, message})                (released without terminal)
 *   workerBusy({task, rec, message})
 *   released({task, rec, fallback})                      (next-round handoff)
 *   ackTimeout({task, rec, roundId, timeoutMs})
 *   roundTimeout({rec, roundId, timeoutMs})
 */
export class Runtime {
  constructor(hooks = {}, options = {}) {
    this.hooks = hooks;
    // Process failures are projected through the same settlement rules the
    // manager uses for every other runtime fact.
    this.settlement = options.settlement ?? new RuntimeSettlement();
    this.records = new Map();
    // A worker can report a close error and exit immediately; keep that fact
    // until the close transaction has persisted its outcome.
    this.closeErrors = new Map();
  }

  // --- identity state --------------------------------------------------------
  /**
   * True while an owned handle is retained, including one whose process has
   * already exited. The handle outlives the exit so a failed final save can be
   * retried; only `forget` removes it.
   */
  has(id) { return this.records.has(id); }
  get(id) { return this.records.get(id) ?? null; }
  /** Every retained handle, exited-but-unforgotten ones included. */
  ids() { return [...this.records.keys()]; }
  /**
   * True only while the owned process has not been observed to exit. Callers
   * that mean "a Worker is (or may be) writing" use this instead of `has`.
   */
  isLive(id) {
    const rec = this.records.get(id);
    return Boolean(rec) && rec.phase !== 'exited';
  }
  /** Ids of processes that have not been observed to exit. */
  liveIds() { return [...this.records.values()].filter(rec => rec.phase !== 'exited').map(rec => rec.id); }
  /** Drop an owned handle once its exit is demonstrably confirmed. */
  forget(id) {
    const rec = this.records.get(id);
    if (rec && recordHasExited(rec)) {
      this.records.delete(id);
      this.closeErrors.delete(id);
      return true;
    }
    if (!rec) {
      this.closeErrors.delete(id);
      return false;
    }
    return false;
  }
  unreworkableReason(id) { return this.records.get(id)?.unreworkableReason ?? null; }

  createRoundId() { return createRoundId(); }

  deferFallback(id, payload) {
    const rec = this.records.get(id);
    if (rec) rec.pendingFallback = payload;
    return rec;
  }

  // --- gates -----------------------------------------------------------------
  /** Resolve only once the active round has released, never on a bare result. */
  waitForRelease(value) {
    return waitForRecordRelease(this.#rec(value));
  }

  waitForExit(value, timeoutMs = DEFAULT_EXIT_TIMEOUT_MS) {
    const rec = this.#rec(value);
    if (!rec) return Promise.resolve(true);
    return waitForRecordExit(rec, timeoutMs);
  }

  hasExited(value) { return recordHasExited(this.#rec(value)); }

  isClosing(id) { return Boolean(this.records.get(id)?.closing); }

  /** Mark a close in flight and stop watching the round. False when already closing. */
  beginClose(id) {
    const rec = this.records.get(id);
    if (!rec || rec.closing) return false;
    rec.closing = true;
    this.clearMonitors(rec);
    return true;
  }

  /**
   * Undo a close attempt that failed before the terminal record was durable,
   * so the caller can retry instead of being stuck behind `Already stopping`.
   */
  abortClose(id) {
    const rec = this.records.get(id);
    if (!rec || !rec.closing) return false;
    rec.closing = false;
    return true;
  }

  /** Ask the owned process to close. Returns the error when the request cannot be sent. */
  sendClose(id) {
    const rec = this.records.get(id);
    if (!rec) return null;
    try {
      if (rec.w.connected) rec.w.send(closeMessage());
      return null;
    } catch (error) {
      const detail = `close request failed: ${error.message}`;
      rec.closeError = rec.closeError ?? detail;
      this.closeErrors.set(id, rec.closeError);
      return error;
    }
  }

  /** Survives process exit so a late or final close error is never lost. */
  closeError(id) {
    return this.closeErrors.get(id) ?? this.records.get(id)?.closeError ?? null;
  }

  // --- round lifecycle -------------------------------------------------------
  /** Health is runtime state, so it is persisted and evented through the same hooks. */
  reportHealth(task, rec, health, detail = null) {
    if (!rec || rec.health === health) return;
    rec.health = health;
    const next = {...task, runtimeHealth: health};
    try {
      const runtime = this.persist(next, rec, detail ? {healthDetail: detail} : {});
      if (runtime) next.runtime = runtime;
    } catch {}
    this.#commit(next, {kind: 'runtime_health', health, detail});
  }

  /**
   * Dispatch one round: allocate or accept the roundId, attach the process
   * listeners on first use, arm every timer, then send the run message. A
   * synchronous send failure clears the monitors, marks the runtime untrusted,
   * and rethrows so the caller can record a traceable startup failure.
   * @returns {{rec: object, roundId: string}}
   */
  openRound(task, options = {}) {
    const roundId = options.roundId ?? this.createRoundId();
    if (!isRoundId(roundId)) throw new Error('A valid roundId is required');
    let rec = this.records.get(task.id);
    if (!rec) {
      const ownerMarker = randomUUID();
      const handle = this.hooks.spawn({task, ownerMarker});
      rec = this.adopt(task, handle, ownerMarker);
    }
    const timeouts = {
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      heartbeatCheckMs: DEFAULT_HEARTBEAT_CHECK_MS,
      roundTimeoutMs: null,
      ...options.timeouts,
    };
    rec.roundId = roundId;
    rec.phase = 'awaiting_ack';
    rec.health = 'starting';
    rec.lastHeartbeatAt = Date.now();
    rec.terminalMessage = null;
    rec.rejectedRound = false;
    rec.pendingFallback = null;
    this.persist(task, rec);
    this.armAckTimer(rec, roundId, timeouts.ackTimeoutMs);
    this.armHeartbeatWatch(rec, roundId, timeouts.heartbeatStaleMs, timeouts.heartbeatCheckMs);
    if (Number(timeouts.roundTimeoutMs) > 0) this.armRoundTimer(rec, roundId, timeouts.roundTimeoutMs);
    const message = runMessage({
      roundId,
      task,
      prompt: options.prompt,
      maxTokens: options.maxTokens,
      effort: options.effort ?? null,
      ownerMarker: rec.ownerMarker,
      budgetFile: options.budgetFile,
    });
    try {
      rec.w.send(message);
    } catch (error) {
      this.clearMonitors(rec);
      this.hooks.untrusted?.({id: task.id, detail: 'IPC send failure'});
      throw error;
    }
    return {rec, roundId};
  }

  /** Register a freshly spawned handle and start listening for its messages. */
  adopt(task, handle, ownerMarker) {
    const rec = {
      id: task.id,
      w: handle,
      ownerMarker,
      startedAt: new Date().toISOString(),
      timer: null,
      ackTimer: null,
      heartbeatWatch: null,
      closing: false,
      closeError: null,
      unreworkableReason: null,
      logBytes: 0,
      roundId: null,
      phase: 'idle',
      health: 'starting',
      lastHeartbeatAt: null,
      terminalMessage: null,
      pendingFallback: null,
      releaseWaiters: [],
      rejectedRound: false,
      identityVerified: false,
    };
    this.records.set(task.id, rec);
    this.closeErrors.delete(task.id);
    const next = {...task, runtimeHealth: rec.health};
    try {
      const runtime = this.persist(next, rec);
      if (runtime) next.runtime = runtime;
    } catch {}
    this.#commit(next);
    for (const stream of [handle.stdout, handle.stderr]) {
      stream?.on?.('data', chunk => this.hooks.log?.({
        task: this.hooks.latest?.(task.id) ?? task,
        rec,
        chunk,
      }));
    }
    handle.on?.('message', message => this.onMessage(task.id, message));
    handle.on?.('error', error => this.onProcessError(task.id, error));
    handle.on?.('exit', code => this.onProcessExit(task.id, code));
    return rec;
  }

  /** Route one worker message. Late, duplicate, and out-of-order work is discarded. */
  onMessage(taskId, msg) {
    const task = this.hooks.latest?.(taskId);
    if (!task || !msg) return;
    const rec = this.records.get(taskId);
    if (!rec) return;

    const checked = validateMessage(msg);
    if (!checked.ok) {
      this.noteIgnored(task, rec, msg, checked.reason);
      return;
    }
    if (msg.kind === 'closed') {
      // The Worker finished its own close; process exit remains the gate.
      rec.workerClosed = true;
      return;
    }

    if (msg.kind === 'ready') {
      if (msg.ownerMarker && msg.ownerMarker !== rec.ownerMarker) {
        rec.unreworkableReason = 'Runtime identity marker did not match; create a new task';
        this.reportHealth(task, rec, 'unhealthy', 'owner marker mismatch');
        return;
      }
      const identityVerified = Boolean(msg.ownerMarker === rec.ownerMarker);
      // The Worker re-sends `ready` on every openai-chat round. An unchanged
      // state is not a write.
      if (task.runtimeReady === true && rec.identityVerified === identityVerified) return;
      rec.identityVerified = identityVerified;
      const next = {...task, runtimeReady: true};
      try {
        const runtime = this.persist(next, rec, {
          workerPid: msg.pid ?? rec.w.pid ?? null,
          workerStartedAt: msg.startedAt ?? null,
          identityVerified,
        });
        if (runtime) next.runtime = runtime;
      } catch {}
      this.#commit(next);
      return;
    }

    if (msg.kind === 'worker_busy') {
      if (msg.roundId === rec.roundId) {
        rec.rejectedRound = true;
        rec.unreworkableReason = 'Worker rejected a run because its previous round was not released';
        this.clearAckTimer(rec);
        this.hooks.workerBusy?.({task, rec, message: msg});
      }
      return;
    }

    if (msg.kind === 'protocol_error') {
      rec.unreworkableReason = `Worker protocol error: ${msg.error}`;
      this.reportHealth(task, rec, 'unhealthy', msg.error);
      return;
    }

    if (ROUND_MESSAGE_KINDS.has(msg.kind)) {
      if (!isRoundId(msg.roundId) || msg.roundId !== rec.roundId) {
        this.noteIgnored(task, rec, msg, 'roundId does not match the active round');
        return;
      }
    }

    if (msg.kind === 'ack') {
      if (rec.phase !== 'awaiting_ack' || rec.rejectedRound) {
        this.noteIgnored(task, rec, msg, 'ack arrived outside awaiting_ack');
        return;
      }
      this.clearAckTimer(rec);
      rec.phase = 'running';
      rec.lastHeartbeatAt = Date.now();
      this.reportHealth(task, rec, 'healthy');
      this.#commit(task, {kind: 'round_ack', roundId: msg.roundId});
      return;
    }

    if (msg.kind === 'heartbeat') {
      if (rec.phase !== 'running') return;
      rec.lastHeartbeatAt = Date.now();
      if (rec.health !== 'healthy') this.reportHealth(task, rec, 'healthy');
      return;
    }

    if (msg.kind === 'event') {
      if (task.status !== 'running' || !ACTIVE_EVENT_PHASES.has(rec.phase)) {
        this.noteIgnored(task, rec, msg, 'task is not accepting round events');
        return;
      }
      const notification = msg.notification;
      const next = {
        ...task,
        lastEvent: notification.params?.event?.type ?? notification.method,
        eventCount: (task.eventCount ?? 0) + 1,
      };
      this.#commit(next, msg);
      return;
    }

    if (msg.kind === 'close_error') {
      rec.closeError = msg.error;
      this.closeErrors.set(taskId, msg.error);
    }

    if (msg.kind === 'result' || msg.kind === 'error') {
      if (rec.terminalMessage) {
        this.noteIgnored(task, rec, msg, 'duplicate terminal message');
        return;
      }
      if (task.status !== 'running') {
        this.noteIgnored(task, rec, msg, 'task is not accepting a terminal message');
        return;
      }
      if (rec.phase !== 'running') {
        this.noteIgnored(task, rec, msg, 'terminal message arrived before ack');
        return;
      }
      this.clearAckTimer(rec);
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      rec.phase = 'finished';
      rec.terminalMessage = msg;
      this.hooks.terminal?.({task, rec, message: msg});
      return;
    }

    if (msg.kind === 'released') {
      if (rec.phase === 'idle' || rec.phase === 'exited') {
        this.noteIgnored(task, rec, msg, 'release arrived while runtime was idle');
        return;
      }
      if (!rec.terminalMessage) {
        rec.unreworkableReason = 'Worker released a round without a terminal message';
        this.hooks.terminalMissing?.({task, rec, message: msg});
      }
      // The protocol-error transition may have replaced the record. Re-read
      // before persisting release metadata so an older object cannot overwrite
      // the failure or reuse an earlier event sequence.
      const released = this.hooks.latest?.(taskId) ?? task;
      this.clearMonitors(rec);
      rec.phase = 'idle';
      rec.roundId = null;
      rec.terminalMessage = null;
      rec.rejectedRound = false;
      rec.lastHeartbeatAt = null;
      rec.health = 'idle';
      const next = {...released, runtimeHealth: 'idle'};
      try {
        const runtime = this.persist(next, rec);
        if (runtime) next.runtime = runtime;
      } catch {}
      this.#commit(next, {kind: 'round_released', roundId: msg.roundId});
      // Releasing the gate is what lets a queued rework or Provider fallback
      // dispatch; nothing may start a new round before this point.
      settleRecordRelease(rec, true);
      const fallback = rec.pendingFallback;
      rec.pendingFallback = null;
      this.hooks.released?.({task: next, rec, fallback});
      return;
    }
  }

  onProcessError(taskId, error) {
    const rec = this.records.get(taskId);
    if (!rec) return;
    this.hooks.untrusted?.({id: taskId, detail: 'process error'});
    this.clearMonitors(rec);
    rec.phase = 'exited';
    settleRecordRelease(rec, false);
    const task = this.hooks.latest?.(taskId);
    if (!task) return;
    let runtime = null;
    try { runtime = this.persist(task, rec, {exitReason: `Task ${taskId} worker error: ${error.message}`}); } catch {}
    const outcome = this.settlement.processError({task, error});
    if (runtime) outcome.task = {...outcome.task, runtime};
    this.#settle(outcome);
  }

  onProcessExit(taskId, code) {
    const rec = this.records.get(taskId);
    if (!rec) return;
    this.clearMonitors(rec);
    rec.phase = 'exited';
    // A runtime that exited before releasing its round may never resume, so
    // whoever waits at the gate gets false rather than a silent stall.
    settleRecordRelease(rec, false);
    // The handle stays until `forget`: a terminal record that failed to save
    // must still find a retryable `stopping` task. `isLive` reports the exit.
    const task = this.hooks.latest?.(taskId);
    let runtime = null;
    try { if (task) runtime = this.persist(task, rec, {exitCode: code}); } catch {}
    if (!task) return;
    const outcome = this.settlement.processExited({task, code});
    if (runtime) outcome.task = {...outcome.task, runtime};
    this.#settle(outcome);
  }

  // --- internals -------------------------------------------------------------
  #rec(value) {
    if (typeof value === 'string') return this.records.get(value) ?? null;
    return value ?? null;
  }

  /** Execute the journal and persistence order for a settlement result. */
  #settle(outcome) {
    if (outcome?.event) this.#commit(outcome.task, outcome.event);
  }

  /**
   * One write for the task record and its event. `commit` is the manager's
   * single path; the older event/save pair remains only for test doubles.
   */
  #commit(task, payload = null) {
    try {
      if (typeof this.hooks.commit === 'function') {
        this.hooks.commit({task, payload});
        return;
      }
      if (payload) this.hooks.event?.({task, payload});
      this.hooks.save?.({task});
    } catch {}
  }

  persist(task, rec, extra) {
    return this.hooks.persist?.({task, rec, extra});
  }

  noteIgnored(task, rec, msg, reason) {
    this.#commit(task, {
      kind: 'runtime_message_ignored',
      messageKind: msg?.kind ?? null,
      messageRoundId: msg?.roundId ?? null,
      expectedRoundId: rec.roundId,
      reason,
    });
  }

  clearAckTimer(rec) {
    if (rec.ackTimer) clearTimeout(rec.ackTimer);
    rec.ackTimer = null;
  }

  clearMonitors(rec) {
    this.clearAckTimer(rec);
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.heartbeatWatch) clearInterval(rec.heartbeatWatch);
    rec.heartbeatWatch = null;
  }

  armAckTimer(rec, roundId, timeoutMs) {
    rec.ackTimer = setTimeout(() => {
      if (rec.roundId !== roundId || rec.phase !== 'awaiting_ack') return;
      rec.rejectedRound = true;
      rec.unreworkableReason = `Worker did not acknowledge round ${roundId}; the runtime state is untrusted`;
      this.clearAckTimer(rec);
      const latest = this.hooks.latest?.(rec.id);
      // The process is deliberately retained: an unacknowledged round is
      // untrusted, not dead, and the workspace lock must hold until exit.
      if (latest?.status === 'running') this.hooks.ackTimeout?.({task: latest, rec, roundId, timeoutMs});
    }, timeoutMs);
    rec.ackTimer.unref?.();
  }

  armHeartbeatWatch(rec, roundId, staleMs, checkMs) {
    rec.heartbeatWatch = setInterval(() => {
      if (rec.roundId !== roundId || rec.phase !== 'running' || !rec.lastHeartbeatAt) return;
      if (Date.now() - rec.lastHeartbeatAt < staleMs) return;
      const latest = this.hooks.latest?.(rec.id);
      if (latest) {
        this.reportHealth(latest, rec, 'unhealthy', `heartbeat stale for ${staleMs}ms; process retained`);
      }
    }, checkMs);
    rec.heartbeatWatch.unref?.();
  }

  armRoundTimer(rec, roundId, timeoutMs) {
    rec.timer = setTimeout(() => {
      this.hooks.roundTimeout?.({rec, roundId, timeoutMs});
    }, timeoutMs);
    rec.timer.unref?.();
  }
}

export {DEFAULT_EXIT_TIMEOUT_MS, FORCE_EXIT_TIMEOUT_MS};