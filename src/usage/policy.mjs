const LIMIT_FIELDS = ['enabled', 'warnCostCny', 'blockCostCny', 'warnRequests', 'blockRequests'];
const COST_FIELDS = ['warnCostCny', 'blockCostCny'];
const REQUEST_FIELDS = ['warnRequests', 'blockRequests'];
const OVERRIDE_REASON_LIMIT = 1000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Validate a whole or partial usage-limit override. The manager accepts limits
 * from HTTP, CLI, and MCP, so these checks must not depend on a client schema.
 */
export function validateLimits(value, label = 'usageLimits') {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!LIMIT_FIELDS.includes(key)) throw new Error(`${label}.${key} is not a supported field`);
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  for (const key of COST_FIELDS) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive finite number`);
    }
  }
  for (const key of REQUEST_FIELDS) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive safe integer`);
    }
  }
  return value;
}

/** Validate and copy a complete limit set, preserving warn < block. */
export function completeLimits(value, label = 'usageLimits') {
  validateLimits(value, label);
  for (const key of LIMIT_FIELDS) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
  const limits = {
    enabled: value.enabled,
    warnCostCny: value.warnCostCny,
    blockCostCny: value.blockCostCny,
    warnRequests: value.warnRequests,
    blockRequests: value.blockRequests,
  };
  if (!(limits.warnCostCny < limits.blockCostCny)) {
    throw new Error(`${label}.warnCostCny must be less than blockCostCny`);
  }
  if (!(limits.warnRequests < limits.blockRequests)) {
    throw new Error(`${label}.warnRequests must be less than blockRequests`);
  }
  return limits;
}

/** Merge a partial call override over a complete base set. */
export function mergeLimits(value, base) {
  if (value === undefined) return null;
  validateLimits(value);
  return completeLimits({...base, ...value});
}

/** Resolve the task override, then the current global limits. */
export function effectiveLimits(taskLimits, globalLimits) {
  const raw = isPlainObject(taskLimits) ? {...globalLimits, ...taskLimits} : globalLimits;
  return completeLimits(raw, 'usageLimits');
}

/**
 * Evaluate cumulative request and cost thresholds. Request counts include
 * responses without usage; cost participates only when the total is complete.
 * An unavailable metric source does not block execution.
 */
export function evaluateLimits(usage, limits) {
  const internalRequests = (usage.requests ?? 0) + (usage.requestsWithoutUsage ?? 0);
  const cost = typeof usage.estimatedCostCny === 'number' && Number.isFinite(usage.estimatedCostCny)
    ? usage.estimatedCostCny
    : null;
  const costLimitReliable = usage.available === true && usage.costComplete === true;
  const fields = {internalRequests, limits, costLimitReliable};
  if (limits.enabled !== true) {
    return {
      ...fields,
      limitState: 'disabled',
      limitWarning: false,
      limitBlocked: false,
      limitsEvaluated: false,
      message: null,
    };
  }
  if (usage.available !== true) {
    return {
      ...fields,
      limitState: 'unavailable',
      limitWarning: true,
      limitBlocked: false,
      limitsEvaluated: false,
      message: 'Usage data is unavailable; cumulative limits were not evaluated and rework is not blocked by usage',
    };
  }

  const costText = costLimitReliable && cost !== null
    ? `, ${round(cost, 6)}/${limits.blockCostCny} CNY`
    : '';
  if (internalRequests >= limits.blockRequests ||
      (costLimitReliable && cost !== null && cost >= limits.blockCostCny)) {
    return {
      ...fields,
      limitState: 'blocked',
      limitWarning: false,
      limitBlocked: true,
      limitsEvaluated: true,
      message: `Cumulative usage limit reached (${internalRequests}/${limits.blockRequests} requests${costText})`,
    };
  }

  const warnText = costLimitReliable && cost !== null
    ? `, ${round(cost, 6)}/${limits.warnCostCny} CNY`
    : '';
  if (internalRequests >= limits.warnRequests ||
      (costLimitReliable && cost !== null && cost >= limits.warnCostCny)) {
    return {
      ...fields,
      limitState: 'warning',
      limitWarning: true,
      limitBlocked: false,
      limitsEvaluated: true,
      message: `Cumulative usage warning (${internalRequests}/${limits.warnRequests} requests${warnText})`,
    };
  }

  return {
    ...fields,
    limitState: 'ok',
    limitWarning: false,
    limitBlocked: false,
    limitsEvaluated: true,
    message: null,
  };
}

/** Bound the operator-provided reason stored in the task and override event. */
export function boundedReason(value, max = 200) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Parse the one-round override intent independently of the limit values. */
export function parseOverride(args = {}) {
  if (args.overrideLimits !== undefined && typeof args.overrideLimits !== 'boolean') {
    throw new Error('overrideLimits must be a boolean');
  }
  if (args.overrideReason !== undefined && typeof args.overrideReason !== 'string') {
    throw new Error('overrideReason must be a string');
  }
  if (typeof args.overrideReason === 'string' && args.overrideReason.length > OVERRIDE_REASON_LIMIT) {
    throw new Error(`overrideReason must be at most ${OVERRIDE_REASON_LIMIT} characters`);
  }
  const enabled = args.overrideLimits === true;
  if (enabled && !(typeof args.overrideReason === 'string' && args.overrideReason.trim())) {
    throw new Error('overrideLimits requires a nonempty overrideReason');
  }
  return {
    enabled,
    reason: typeof args.overrideReason === 'string' ? args.overrideReason : null,
  };
}

/**
 * Decide whether one rework round may start. Only a blocked usage limit can be
 * overridden; all original lifecycle/runtime refusals remain authoritative.
 */
export function decideRework({baseBlockedReason = null, usage = null, override = {}} = {}) {
  if (baseBlockedReason) {
    return {allowed: false, reason: baseBlockedReason, usageBlocked: false, overridden: false};
  }
  const usageBlocked = usage?.limitState === 'blocked';
  if (usageBlocked && override.enabled !== true) {
    return {
      allowed: false,
      reason: blockReason(usage),
      usageBlocked: true,
      overridden: false,
    };
  }
  return {
    allowed: true,
    reason: null,
    usageBlocked,
    overridden: usageBlocked && override.enabled === true,
  };
}

/** Human-readable refusal for a blocked cumulative limit. */
export function blockReason(usage) {
  const parts = [];
  if (usage.internalRequests >= usage.limits.blockRequests) {
    parts.push(`${usage.internalRequests} internal requests >= blockRequests ${usage.limits.blockRequests}`);
  }
  if (usage.costLimitReliable && typeof usage.estimatedCostCny === 'number' &&
      usage.estimatedCostCny >= usage.limits.blockCostCny) {
    parts.push(`estimated cost ${usage.estimatedCostCny} CNY >= blockCostCny ${usage.limits.blockCostCny}`);
  }
  return `Cumulative usage limit reached (${parts.join('; ')}); rework requires overrideLimits:true with a nonempty overrideReason`;
}

/** Build the override event without mutating the task or usage snapshot. */
export function overrideEvent({at, reason, usage, before, after}) {
  return {
    at,
    kind: 'limit_override',
    reason,
    usage: {
      internalRequests: usage.internalRequests,
      estimatedCostCny: usage.estimatedCostCny,
      costLimitReliable: usage.costLimitReliable,
      limitState: usage.limitState,
    },
    limitsBefore: {...before},
    limitsAfter: {...after},
  };
}

/**
 * One unavailable-snapshot projection for the usage module and manager
 * fallback. A metrics failure degrades observability only: limits continue to
 * follow the opt-in policy and never block execution by themselves.
 */
export function unavailableUsageSnapshot({task = null, reason, limits}) {
  const bounded = boundedReason(reason ?? 'usage is unavailable', 240);
  const evaluation = evaluateLimits({
    available: false,
    requests: 0,
    requestsWithoutUsage: 0,
    estimatedCostCny: null,
    costComplete: false,
  }, limits);
  const {message, ...limitFields} = evaluation;
  const warnings = [`Usage data is unavailable: ${bounded}`];
  const statusUsage = {
    available: false,
    error: bounded,
    requests: 0,
    requestsWithoutUsage: 0,
    estimatedCostCny: null,
    costComplete: false,
    ...limitFields,
    warnings,
  };
  if (task && typeof task.lastLimitOverride === 'object' && task.lastLimitOverride &&
      typeof task.lastLimitOverride.at === 'string') {
    statusUsage.limitOverride = {
      at: task.lastLimitOverride.at,
      reason: boundedReason(task.lastLimitOverride.reason),
    };
  }
  return {
    available: false,
    statusUsage,
    usageRounds: [],
    listUsage: {available: false, error: bounded},
    computed: null,
    limits,
  };
}

export {LIMIT_FIELDS, OVERRIDE_REASON_LIMIT};
