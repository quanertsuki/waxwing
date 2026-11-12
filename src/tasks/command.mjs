import {parseOptionalMaxTokens} from './budget.mjs';
import {parseOptionalEffort} from './effort.mjs';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Own the create command's validation order and the immutable inputs that the
 * create transaction consumes. Rework eligibility and limits live in
 * `TaskRework`; this module no longer decides whether another round may start.
 */
export class TaskCommandModule {
  constructor({
    maxPromptLength = 100000,
    limitsForRequest = (_task, value) => value,
    preflight = null,
    parseBudget = parseOptionalMaxTokens,
    parseEffort = parseOptionalEffort,
    canStart = () => null,
  } = {}) {
    this.maxPromptLength = maxPromptLength;
    this.limitsForRequest = limitsForRequest;
    this.createPreflight = preflight;
    this.parseBudget = parseBudget;
    this.parseEffort = parseEffort;
    this.canStart = canStart;
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
}
