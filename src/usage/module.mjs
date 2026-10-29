import {
  blockReason,
  boundedReason,
  decideRework,
  effectiveLimits,
  evaluateLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
  unavailableUsageSnapshot,
  unavailableUsageView,
} from './policy.mjs';
import {
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
} from '../../prototype/usage.mjs';

function boundedError(error, max = 240) {
  const text = error?.message ?? String(error);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One usage seam for indexing, pricing, limits, override, and rework policy.
 * Adapters may still consume the compatibility exports below, but new callers
 * should not have to compose their internal ordering.
 */
export class UsageModule {
  constructor({
    configuration = {},
    operations = {},
    limitsForTask = task => effectiveLimits(task?.usageLimits, configuration),
    now = () => new Date().toISOString(),
  } = {}) {
    this.configuration = configuration;
    this.operations = {
      usageForTask,
      usageForList,
      usageForStatus,
      usageForView,
      ...operations,
    };
    this.limitsForTask = limitsForTask;
    this.now = now;
  }

  limits(task) {
    return this.limitsForTask(task);
  }

  blockedReason(usage) {
    return blockReason(usage);
  }

  requestedLimits(task, value) {
    return mergeLimits(value, this.limits(task));
  }

  limitsForRequest(task, value) {
    return value === undefined ? this.limits(task) : this.requestedLimits(task, value);
  }

  /**
   * Never throws: limits are resolved once and passed into the metrics
   * operation, and a damaged task limit override degrades to the configured
   * fallback instead of escaping.
   */
  snapshot(task, taskDirectory, options = {}) {
    let limits = options.limits;
    if (limits === undefined) {
      try {
        limits = this.limits(task);
      } catch {
        // A damaged task override must not hide the metrics behind a limits
        // error; continue with the configured fallback limit set.
        limits = this.fallbackLimits();
      }
    }
    try {
      return this.operations.usageForTask(task, taskDirectory, {...options, limits});
    } catch (error) {
      return unavailableUsageSnapshot({task, reason: boundedError(error), limits});
    }
  }

  fallbackLimits() {
    try {
      return this.limits({});
    } catch {
      return this.configuration ?? {};
    }
  }

  list(task, taskDirectory) {
    return this.snapshot(task, taskDirectory).listUsage;
  }

  status(task, taskDirectory) {
    const snapshot = this.snapshot(task, taskDirectory);
    return {usage: snapshot.statusUsage, usageRounds: snapshot.usageRounds};
  }

  /** Project the already-computed snapshot; never scan the event log twice. */
  view(task, taskDirectory) {
    const snapshot = this.snapshot(task, taskDirectory);
    if (snapshot.computed) {
      return this.operations.usageForView(task, taskDirectory, {result: snapshot});
    }
    return unavailableUsageView(task, snapshot.statusUsage);
  }

  /**
   * Parse override and limits before command-level validation, then evaluate
   * metrics and policy only once the caller has accepted its own inputs.
   */
  reworkInputs(task, request = {}) {
    const currentLimits = this.limits(task);
    const requestedLimits = this.requestedLimits(task, request.usageLimits);
    const override = parseOverride(request);
    return {
      task,
      request,
      currentLimits,
      requestedLimits,
      override,
    };
  }

  decideRework(task, taskDirectory, request = {}, {
    baseBlockedReason = null,
    validate = null,
    inputs = null,
    throwOnRefusal = true,
  } = {}) {
    const values = inputs ?? this.reworkInputs(task, request);
    const {currentLimits, requestedLimits, override} = values;
    const blockedReason = typeof baseBlockedReason === 'function'
      ? baseBlockedReason()
      : baseBlockedReason;
    if (blockedReason) throw new Error(blockedReason);
    if (typeof validate === 'function') {
      validate({currentLimits, requestedLimits, override});
    }
    const snapshot = this.snapshot(task, taskDirectory, {persist: false});
    const usage = snapshot.statusUsage;
    const decision = decideRework({baseBlockedReason: blockedReason, usage, override});
    if (!decision.allowed && throwOnRefusal) throw new Error(decision.reason);
    const afterLimits = requestedLimits ?? currentLimits;
    let event = null;
    let overrideAt = null;
    if (decision.overridden) {
      overrideAt = this.now();
      const template = overrideEvent({
        at: overrideAt,
        reason: override.reason,
        usage,
        before: currentLimits,
        after: afterLimits,
      });
      // The journal stamp is the repository's responsibility; the payload is
      // the operator-facing record of why this round passed the limit.
      const {at: _journalStamp, ...payload} = template;
      event = payload;
    }
    const result = {
      currentLimits,
      requestedLimits,
      afterLimits,
      override,
      usage,
      snapshot,
      decision,
      overrideAt,
      event,
    };
    return result;
  }

  /** Return the next record with the override applied; never edits its input. */
  applyRework(task, result) {
    if (!result) return task;
    const next = {...task};
    if (result.overrideAt) {
      next.lastLimitOverride = {
        at: result.overrideAt,
        reason: boundedReason(result.override.reason),
      };
    }
    if (result.requestedLimits) next.usageLimits = result.requestedLimits;
    return next;
  }
}

export {
  blockReason,
  boundedReason,
  decideRework,
  effectiveLimits,
  evaluateLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
  unavailableUsageSnapshot,
  unavailableUsageView,
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
};
