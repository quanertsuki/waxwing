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
import {listSummaryOf, metricsForTask, usageViewFor} from './metrics.mjs';

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
  /**
   * @param configuration - the global limits object, or
   *   `{limits, providersDir, pricingFile}` for the manager.
   * @param metrics - injectable metrics operations: `metricsForTask` and
   *   `usageViewFor`; both default to the real metrics module.
   */
  constructor({
    configuration = {},
    limits = configuration?.limits ?? configuration,
    providersDir = configuration?.providersDir ?? null,
    pricingFile = configuration?.pricingFile ?? null,
    metrics = {},
    now = () => new Date().toISOString(),
  } = {}) {
    this.configuration = configuration;
    this.limitsConfig = limits;
    this.providersDir = providersDir;
    this.pricingFile = pricingFile;
    this.metrics = {metricsForTask, usageViewFor, ...metrics};
    this.now = now;
  }

  limits(task) {
    return effectiveLimits(task?.usageLimits, this.limitsConfig);
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
   * Compute metrics once, then evaluate this request's limits inside the
   * module. Never throws: a damaged limit override or an unreadable event
   * source degrades to an explicit fallback instead of escaping.
   */
  snapshot(task, taskDirectory, options = {}) {
    let limits = options.limits;
    if (limits === undefined) {
      try {
        limits = this.limits(task);
      } catch {
        limits = this.fallbackLimits();
      }
    }
    try {
      const computed = this.metrics.metricsForTask(task, taskDirectory, {
        pricingFile: this.pricingFile,
        providersDir: this.providersDir,
        ...options,
      });
      const evaluation = evaluateLimits(computed.statusUsage, limits);
      const {message, ...limitFields} = evaluation;
      // Status-only warnings (such as the last round's policy notice) join the
      // limit message here; the list summary keeps the metrics warnings alone.
      const extraWarnings = Array.isArray(options.extraWarnings) ? options.extraWarnings : [];
      const warnings = [...new Set([
        ...(computed.statusUsage.warnings ?? []),
        ...(message ? [message] : []),
        ...extraWarnings,
      ])];
      const statusUsage = {...computed.statusUsage, ...limitFields, warnings};
      if (task && typeof task.lastLimitOverride === 'object' && task.lastLimitOverride &&
          typeof task.lastLimitOverride.at === 'string') {
        statusUsage.limitOverride = {
          at: task.lastLimitOverride.at,
          reason: boundedReason(task.lastLimitOverride.reason),
        };
      }
      return {
        available: true,
        statusUsage,
        usageRounds: computed.usageRounds,
        listUsage: listSummaryOf(statusUsage, computed.statusUsage.warnings ?? []),
        computed: computed.computed,
        limits,
      };
    } catch (error) {
      return unavailableUsageSnapshot({task, reason: boundedError(error), limits});
    }
  }

  fallbackLimits() {
    try {
      return effectiveLimits(undefined, this.limitsConfig);
    } catch {
      return this.limitsConfig ?? {};
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
    if (!snapshot.computed) return unavailableUsageView(task, snapshot.statusUsage);
    const payload = this.metrics.usageViewFor(task, snapshot.computed);
    const {pricing, ...totals} = snapshot.statusUsage;
    return {...payload, totals};
  }

  /** List flags the manager would otherwise derive from a limit state. */
  listFlags(snapshot) {
    const state = snapshot?.statusUsage?.limitState;
    return {
      limitBlocked: state === 'blocked',
      limitWarning: state === 'warning' || state === 'unavailable',
    };
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
};
