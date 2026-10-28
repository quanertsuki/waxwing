function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Own task command validation order and the immutable inputs that the
 * persistence transaction consumes. Callers provide policy/projection
 * adapters, but must not duplicate the promise/workspace/limits ordering here.
 */
export class TaskCommandModule {
  constructor({
    maxPromptLength = 100000,
    maxRounds = Infinity,
    limitsForRequest = (_task, value) => value,
    preflight = null,
    parseBudget = null,
    parseEffort = null,
    providerSupportsEffort = () => true,
    resolveBudget = ({requested, inherited, fallback}) =>
      requested ?? inherited ?? fallback,
    resolveEffort = ({requested, inherited, fallback}) =>
      requested ?? inherited ?? fallback,
    defaultEffort = null,
    workspaceConflict = () => null,
    baseBlocked = null,
    canStart = () => null,
    now = () => new Date().toISOString(),
  } = {}) {
    this.maxPromptLength = maxPromptLength;
    this.maxRounds = typeof maxRounds === 'function' ? maxRounds : () => maxRounds;
    this.limitsForRequest = limitsForRequest;
    this.createPreflight = preflight;
    this.parseBudget = parseBudget ?? (value => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error('maxTokens must be a positive safe integer');
      }
      return value;
    });
    this.parseEffort = parseEffort ?? (value => {
      if (value === undefined) return undefined;
      if (value !== 'high' && value !== 'max') throw new Error('effort must be high or max');
      return value;
    });
    this.providerSupportsEffort = providerSupportsEffort;
    this.resolveBudget = resolveBudget;
    this.resolveEffort = resolveEffort;
    this.defaultEffort = typeof defaultEffort === 'function'
      ? defaultEffort
      : () => defaultEffort;
    this.workspaceConflict = workspaceConflict;
    this.baseBlocked = baseBlocked;
    this.canStart = canStart;
    this.now = now;
  }

  prompt(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > this.maxPromptLength) {
      throw new Error(`Nonempty prompt required (max ${this.maxPromptLength} characters)`);
    }
    return value;
  }

  limits(task, value) {
    return value === undefined ? this.limitsForRequest(task) : this.limitsForRequest(task, value);
  }

  /** Validate request-local fields before any provider, policy, or workspace work. */
  validateCreate(request = {}) {
    if (!plainObject(request)) throw new Error('Arguments must be an object');
    const blocked = this.canStart();
    if (blocked) throw new Error(blocked);
    return {
      prompt: this.prompt(request.prompt),
      usageLimits: this.limits(null, request.usageLimits),
      maxTokens: this.parseBudget(request.maxTokens),
      effort: this.parseEffort(request.effort),
    };
  }

  /** Validate create in the same order as the compatible manager interface. */
  create(request = {}, {taskId, preflight} = {}) {
    const validated = this.validateCreate(request);
    const {prompt, usageLimits} = validated;
    const resolved = (preflight ?? this.createPreflight)?.({
      request,
      taskId,
      validated,
      prompt,
      usageLimits,
    });
    if (!resolved) throw new Error('create preflight is required');
    return {
      taskId,
      prompt,
      usageLimits,
      ...resolved,
    };
  }

  /** Validate rework inputs before policy, metrics, or any task mutation. */
  validateRework(task, request = {}, {
    usageDecision = null,
  } = {}) {
    if (!task) throw new Error('Unknown task');
    if (!plainObject(request)) throw new Error('Arguments must be an object');
    const usage = usageDecision ?? {
      requestedLimits: this.limits(task, request.usageLimits),
      currentLimits: this.limits(task),
    };
    const requested = this.parseBudget(request.maxTokens);
    const requestedEffort = this.parseEffort(request.effort);
    if (requestedEffort !== undefined && !this.providerSupportsEffort(task.provider)) {
      throw new Error(`effort is not supported by provider "${task.provider?.name ?? 'unknown'}" (${task.provider?.type ?? 'unknown'})`);
    }
    const prompt = this.prompt(request.prompt);
    return {task, request, requested, requestedEffort, prompt, usage};
  }

  /** Resolve a validated rework into the inputs consumed by the transaction. */
  rework(task, request = {}, {
    usageDecision = null,
    validated = null,
    validate = null,
  } = {}) {
    const values = validated ?? this.validateRework(task, request, {usageDecision});
    const {requested, requestedEffort, prompt, usage} = values;
    const baseBlocked = typeof this.baseBlocked === 'function'
      ? this.baseBlocked(task, request)
      : this.#baseBlocked(task);
    if (baseBlocked) throw new Error(baseBlocked);
    if (usage?.decision?.allowed === false) throw new Error(usage.decision.reason);
    if (typeof validate === 'function') validate({task, request, usage});
    const maxTokens = this.resolveBudget({
      requested,
      inherited: task.maxTokens,
      fallback: undefined,
    });
    const effort = this.providerSupportsEffort(task.provider)
      ? this.resolveEffort({
        requested: requestedEffort,
        inherited: task.effort,
        fallback: this.defaultEffort(),
      })
      : null;
    return {task, request, prompt, maxTokens, effort, usage};
  }

  /** Read-only preflight for callers that need the decision without writing. */
  preflight(request = {}, {taskId} = {}) {
    return this.create(request, {taskId, preflight: this.createPreflight});
  }

  #baseBlocked(task) {
    const maxRounds = this.maxRounds();
    if (maxRounds !== Infinity && Array.isArray(task.rounds) && task.rounds.length >= maxRounds) {
      return `Maximum ${maxRounds} rounds reached; create a new task for further work`;
    }
    const conflict = this.workspaceConflict(task);
    if (conflict) {
      return `Workspace overlaps another task (${conflict.id}) with a live runtime; close it before reworking`;
    }
    return null;
  }

}
