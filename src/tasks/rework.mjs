import {parseOptionalMaxTokens} from '../../prototype/budget.mjs';
import {parseOptionalEffort} from '../../prototype/effort.mjs';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Status and closing preconditions for another round. These describe the task
 * lifecycle, not acceptance evidence, so they live beside the rest of the
 * rework decision.
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
      return `Original runtime is gone; this DSH cannot resume sessionId ${task.sessionId} in a new runtime; create a new task for follow-up work`;
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
    };
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
