// Reasoning effort for openai-chat rounds. The Waxwing group offers high and
// max; high is the default, max is the per-round escalation for a task that
// keeps failing. Values are validated before any task or round is written.
export const EFFORTS = ['high', 'max'];
export const DEFAULT_EFFORT = 'high';

/** Validate one effort value. */
export function assertEffort(value, label = 'effort') {
  if (typeof value !== 'string' || !EFFORTS.includes(value)) {
    throw new Error(`${label} must be one of ${EFFORTS.join(', ')}`);
  }
  return value;
}

/** Undefined means "not supplied"; any other value must be a supported effort. */
export function parseOptionalEffort(value, label = 'effort') {
  if (value === undefined) return undefined;
  return assertEffort(value, label);
}

/**
 * Explicit request wins, then the task's previous effort, then the configured
 * default. Every branch is re-validated so a corrupted record cannot smuggle an
 * unsupported level into a request.
 */
export function resolveRoundEffort({requested, inherited, fallback = DEFAULT_EFFORT}) {
  if (requested !== undefined) return assertEffort(requested, 'effort');
  if (inherited !== undefined) return assertEffort(inherited, 'task effort');
  return assertEffort(fallback, 'default effort');
}
