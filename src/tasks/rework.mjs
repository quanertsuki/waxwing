import {parseOptionalMaxTokens} from './budget.mjs';
import {parseOptionalEffort} from './effort.mjs';
import {canonicalPath} from '../paths/path-utils.mjs';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pidText(value) {
  return Number.isSafeInteger(value) && value > 0 ? ` (PID ${value})` : '';
}

function pathText(value) {
  return typeof value === 'string' && value ? ` (${value})` : '';
}

/**
 * Status and closing preconditions for another round. These describe the task
 * lifecycle, not acceptance evidence, so they live beside the rest of the
 * rework decision.
 *
 * When the old Worker is gone, the same statuses accept a rework as when it is
 * live: awaiting_review, failed, and cancelled. A failed task restored after a
 * manager restart therefore qualifies, because the interrupted round never
 * wrote the conversation file; the new round continues from the last completed
 * round. Running and stopping wait for the current process, and closed or
 * accepted tasks always need a new task.
 */
export function reworkStatusRefusal(task, {closing = false} = {}) {
  if (task?.status === 'closed') return 'Task is closed; create a new task for follow-up work';
  if (task?.status === 'accepted') return 'Task is accepted; create a new task for follow-up work';
  if (task?.status === 'running') return 'Task is running; wait for the round to finish or cancel it';
  if (closing) return 'Task is stopping; runtime is closing; wait for exit confirmation';
  if (task?.status === 'stopping') return 'Task is stopping; wait for runtime exit confirmation';
  return null;
}

/**
 * One read-only answer to "may this task start another round, with which
 * limits, and what override must be recorded?". The manager calls `decide`
 * once per rework request and `blockedReason` once per status summary, so the
 * displayed refusal and the action refusal cannot drift. The result carries a
 * record patch; nothing is written until `prepareRun` accepts the round.
 *
 * Continuity without a live Worker. A provider that declares
 * `sessionContinuity: 'file'` may rework after its Worker exited, because the
 * next Worker reads the task's conversation file. That relaxation needs facts
 * the manager injects per decision: the adapter capability, whether the old
 * process is proven gone, whether it was marked untrusted before it exited,
 * and whether the task's worktree is still its own. A `'process'` provider
 * (the DSH SDK) keeps the original refusal, and a task whose runtime is still
 * alive is never reworked here.
 */
export class TaskRework {
  constructor({
    usage,
    maxPromptLength = 100000,
    maxRounds = Infinity,
    isShuttingDown = () => false,
    runtimeFacts = () => ({}),
    workspaceConflict = () => null,
    directory = () => null,
    parseBudget = parseOptionalMaxTokens,
    parseEffort = parseOptionalEffort,
    providerSupportsEffort = () => true,
    resolveBudget = ({requested, inherited, fallback}) => requested ?? inherited ?? fallback,
    resolveEffort = ({requested, inherited, fallback}) => requested ?? inherited ?? fallback,
    defaultEffort = () => null,
  } = {}) {
    if (!usage) throw new Error('usage dependency is required');
    this.usage = usage;
    this.maxPromptLength = maxPromptLength;
    this.maxRounds = typeof maxRounds === 'function' ? maxRounds : () => maxRounds;
    this.isShuttingDown = isShuttingDown;
    this.runtimeFacts = runtimeFacts;
    this.workspaceConflict = workspaceConflict;
    this.directory = directory;
    this.parseBudget = parseBudget;
    this.parseEffort = parseEffort;
    this.providerSupportsEffort = providerSupportsEffort;
    this.resolveBudget = resolveBudget;
    this.resolveEffort = resolveEffort;
    this.defaultEffort = typeof defaultEffort === 'function'
      ? defaultEffort
      : () => defaultEffort;
  }

  facts(task) {
    return this.runtimeFacts(task) ?? {};
  }

  /**
   * Original refusals are authoritative: an override may bypass only a blocked
   * cumulative limit, never shutdown, lifecycle, runtime, round, or workspace.
   */
  baseRefusal(task, facts = this.facts(task)) {
    if (this.isShuttingDown()) return 'Manager is shutting down; rework is refused';
    const statusRefusal = reworkStatusRefusal(task, {closing: Boolean(facts.closing)});
    if (statusRefusal) return statusRefusal;
    // A retained handle's recorded reason (broken IPC, protocol error, ACK
    // timeout) is more actionable than the generic "runtime is gone".
    if (facts.unreworkableReason) return facts.unreworkableReason;
    const maxRounds = this.maxRounds();
    if (maxRounds !== Infinity && (task.rounds?.length ?? 0) >= maxRounds) {
      return `Maximum ${maxRounds} rounds reached; create a new task for further work`;
    }
    if (!facts.live && (task.rounds?.length ?? 0) > 0) {
      // A file-backed conversation can continue in a freshly spawned Worker;
      // a process-held session cannot. Either way, the old runtime has to be
      // provably gone before this gate passes.
      const refusal = facts.sessionContinuity === 'file'
        ? this.#respawnRefusal(facts)
        : `Original runtime is gone; this DSH cannot resume sessionId ${task.sessionId} in a new runtime; create a new task for follow-up work`;
      if (refusal) return refusal;
    }
    const conflict = this.workspaceConflict(task.workspace, task.id);
    if (conflict) {
      return `Workspace overlaps another task (${conflict.id}) with a live runtime; close it before reworking`;
    }
    return null;
  }

  /**
   * Read-only refusal for status views. It does not parse a request or scan
   * metrics again; the caller supplies the snapshot it already computed.
   */
  blockedReason(task, usage = null, {facts} = {}) {
    const base = this.baseRefusal(task, facts ?? this.facts(task));
    if (base) return base;
    if (usage?.limitState === 'blocked') return this.usage.blockedReason(usage);
    return null;
  }

  decide(task, request = {}, {facts} = {}) {
    const validated = this.#validate(task, request);
    const currentFacts = facts ?? this.facts(task);
    const base = this.baseRefusal(task, currentFacts);
    if (base) return {allowed: false, reason: base, task, facts: currentFacts};

    const usageResult = this.usage.decideRework(task, this.directory(task.id), request, {
      inputs: validated.inputs,
      baseBlockedReason: null,
      throwOnRefusal: false,
    });
    if (!usageResult.decision.allowed) {
      return {
        allowed: false,
        reason: usageResult.decision.reason,
        task,
        facts: currentFacts,
        usage: usageResult.usage,
      };
    }

    const maxTokens = this.resolveBudget({
      requested: validated.requested,
      inherited: task.maxTokens,
      fallback: undefined,
    });
    const effort = this.providerSupportsEffort(task.provider)
      ? this.resolveEffort({
        requested: validated.requestedEffort,
        inherited: task.effort,
        fallback: this.defaultEffort(),
      })
      : null;

    // The usage module returns the next record; extract only the fields this
    // round changes so `prepareRun` can apply them inside its single commit.
    const applied = this.usage.applyRework(task, usageResult);
    const record = {};
    if (usageResult.requestedLimits) record.usageLimits = usageResult.requestedLimits;
    if (usageResult.overrideAt) record.lastLimitOverride = applied.lastLimitOverride;

    return {
      allowed: true,
      reason: null,
      task,
      facts: currentFacts,
      prompt: validated.prompt,
      maxTokens,
      effort,
      record,
      event: usageResult.event ? {...usageResult.event} : null,
      usage: usageResult.usage,
      // The manager must drop a confirmed-exited handle before openRound, or
      // the Runtime would reuse the dead Worker instead of spawning one.
      respawn: !currentFacts.live && (task.rounds?.length ?? 0) > 0 &&
        currentFacts.sessionContinuity === 'file',
    };
  }

  /**
   * Refusals specific to continuing a file-backed conversation in a new
   * Worker. `facts.continuation` is the manager's evidence about the old
   * runtime; anything it cannot prove keeps the task resumable only as a new
   * task. The order is: an untrusted verdict, an unverified residual process,
   * an alive process, an unconfirmed exit, and finally the worktree.
   */
  #respawnRefusal(facts) {
    const continuation = facts.continuation ?? {};
    if (continuation.unreworkableReason) return continuation.unreworkableReason;
    if (continuation.manualActionRequired) {
      return `The old runtime is unverified${pidText(continuation.pid)}; resolve that process manually before reworking this task`;
    }
    const identity = continuation.identity;
    if (identity?.alive === true) {
      const known = Number.isSafeInteger(identity.actual?.pid) ? identity.actual.pid
        : Number.isSafeInteger(continuation.pid) ? continuation.pid : null;
      if (identity.verified === true) {
        return `The original runtime is still running${pidText(known)}; close it before reworking this task`;
      }
      return `Cannot confirm the original runtime exited: ${known ? `PID ${known} is running` : 'the recorded PID is running'} but its identity could not be verified; create a new task or resolve that process manually`;
    }
    if (continuation.exitConfirmed !== true) {
      return 'Cannot confirm the original runtime exited (no verifiable runtime record); create a new task for follow-up work';
    }
    return this.#leaseRefusal(continuation.lease);
  }

  /**
   * An isolated task's worktree has to still be this task's own checkout. A
   * dirty worktree is expected (it holds the task's uncommitted work), but a
   * removed path, a different Git root, or another branch means a new Worker
   * would write somewhere the task no longer owns.
   */
  #leaseRefusal(lease) {
    if (!lease || lease.mode !== 'worktree') return null;
    if (lease.missing || lease.status === 'removed') {
      return `The task's worktree is gone${pathText(lease.expectedRoot)}; create a new task for follow-up work`;
    }
    if (lease.rootError || !lease.root || !lease.branch) {
      return `The task's worktree could not be verified as this task's checkout${pathText(lease.expectedRoot)}; create a new task for follow-up work`;
    }
    if (lease.expectedRoot && canonicalPath(lease.root) !== canonicalPath(lease.expectedRoot)) {
      return `The task's worktree is no longer this task's checkout${pathText(lease.root)}; create a new task for follow-up work`;
    }
    if (lease.expectedBranch && lease.branch !== lease.expectedBranch) {
      return `The task's worktree is on branch ${lease.branch} instead of ${lease.expectedBranch}; create a new task for follow-up work`;
    }
    return null;
  }

  /**
   * Parse every request-local field before metrics or any task mutation. The
   * order matches the compatible create/rework interface: limits, budget,
   * effort/provider, then prompt.
   */
  #validate(task, request) {
    if (!task) throw new Error('Unknown task');
    if (!plainObject(request)) throw new Error('Arguments must be an object');
    const inputs = this.usage.reworkInputs(task, request);
    const requested = this.parseBudget(request.maxTokens);
    const requestedEffort = this.parseEffort(request.effort);
    if (requestedEffort !== undefined && !this.providerSupportsEffort(task.provider)) {
      throw new Error(`effort is not supported by provider "${task.provider?.name ?? 'unknown'}" (${task.provider?.type ?? 'unknown'})`);
    }
    return {
      inputs,
      requested,
      requestedEffort,
      prompt: this.#prompt(request.prompt),
    };
  }

  #prompt(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > this.maxPromptLength) {
      throw new Error(`Nonempty prompt required (max ${this.maxPromptLength} characters)`);
    }
    return value;
  }
}
