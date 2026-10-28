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

function emptyView(task, totals) {
  return {
    id: task?.id ?? null,
    model: typeof task?.model === 'string' && task.model ? task.model : null,
    pricing: null,
    totals,
    rounds: [],
    requests: [],
    missingUsage: [],
    warnings: totals?.warnings ?? [totals?.error ?? 'usage is unavailable'],
    scan: {
      eventsBytes: 0,
      indexedBytes: 0,
      bytesRead: 0,
      pendingBytes: 0,
      rebuilt: false,
      parseErrors: 0,
    },
  };
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

  /** Never throws: unreadable metrics become one explicit unavailable snapshot. */
  snapshot(task, taskDirectory, options = {}) {
    try {
      return this.operations.usageForTask(task, taskDirectory, options);
    } catch (error) {
      let limits = this.configuration;
      try { limits = this.limits(task); } catch {}
      return unavailableUsageSnapshot({task, reason: boundedError(error), limits});
    }
  }

  list(task, taskDirectory) {
    return this.snapshot(task, taskDirectory).listUsage;
  }

  status(task, taskDirectory) {
    const snapshot = this.snapshot(task, taskDirectory);
    return {usage: snapshot.statusUsage, usageRounds: snapshot.usageRounds};
  }

  view(task, taskDirectory) {
    const snapshot = this.snapshot(task, taskDirectory);
    if (snapshot.computed) return this.operations.usageForView(task, taskDirectory);
    return emptyView(task, snapshot.statusUsage);
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
    if (!decision.allowed) throw new Error(decision.reason);
    const afterLimits = requestedLimits ?? currentLimits;
    let event = null;
    if (decision.overridden) {
      const at = this.now();
      event = overrideEvent({
        at,
        reason: override.reason,
        usage,
        before: currentLimits,
        after: afterLimits,
      });
      delete event.at;
      event.overrideAt = at;
    }
    const result = {
      currentLimits,
      requestedLimits,
      afterLimits,
      override,
      usage,
      snapshot,
      decision,
      event,
    };
    return result;
  }

  /** Commit the accepted decision to the task/event stream. */
  commitRework(task, decision, notify) {
    if (!decision) return task;
    if (decision.event) {
      task.lastLimitOverride = {
        at: decision.event.overrideAt,
        reason: boundedReason(decision.override.reason),
      };
      const payload = {...decision.event};
      delete payload.overrideAt;
      notify(task, payload);
    }
    if (decision.requestedLimits) task.usageLimits = decision.requestedLimits;
    return task;
  }

  /** Apply the event projection from decideRework after all checks succeeded. */
  applyRework(task, result) {
    if (!result) return task;
    if (result.event) {
      task.lastLimitOverride = {
        at: result.event.overrideAt,
        reason: boundedReason(result.override.reason),
      };
    }
    if (result.requestedLimits) task.usageLimits = result.requestedLimits;
    return task;
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
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
};
