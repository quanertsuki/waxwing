// Shared output-budget validation and the per-task budget file.
// Used by the manager, the worker, the DSH plugin, and tests. No credentials.
import fs from 'node:fs';
import path from 'node:path';

/** Human-readable rendering of a rejected value for error messages. */
export function describeValue(value) {
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return `number ${String(value)}`;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Accept only a positive safe integer. `0`, negatives, fractions, strings,
 * `null`, `NaN`, `Infinity`, and unsafe integers all throw. No coercion and no
 * clamping: a caller that asks for an impossible budget gets an error.
 * @param value - candidate output-token budget.
 * @param label - field name used in the error message.
 * @returns the validated number.
 */
export function assertMaxTokens(value, label = 'maxTokens') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer, got ${describeValue(value)}`);
  }
  return value;
}

/**
 * Validate an optional budget: `undefined` stays `undefined` (meaning
 * "inherit"), anything else must be a positive safe integer.
 * @param value - candidate budget or `undefined`.
 * @param label - field name used in the error message.
 * @returns the validated number or `undefined`.
 */
export function parseOptionalMaxTokens(value, label = 'maxTokens') {
  if (value === undefined) return undefined;
  return assertMaxTokens(value, label);
}

/**
 * Resolve the output budget for one round.
 * Explicit request wins, then the task's previous effective budget, then the
 * manager-wide `config.maxTokens` default. Every branch is re-validated so a
 * corrupted persisted task cannot smuggle a bad value into a request.
 * @param root0 - resolution inputs.
 * @param root0.requested - budget supplied by create/rework, or `undefined`.
 * @param root0.inherited - task's previous effective budget, or `undefined`.
 * @param root0.fallback - manager default used when neither is present.
 * @returns the effective positive safe integer budget.
 */
export function resolveRoundBudget({requested, inherited, fallback}) {
  if (requested !== undefined) return assertMaxTokens(requested, 'maxTokens');
  if (inherited !== undefined) return assertMaxTokens(inherited, 'task maxTokens');
  return assertMaxTokens(fallback, 'config.maxTokens');
}

/** Path of the per-task budget file the DSH plugin re-reads on every request. */
export function budgetFileFor(taskDir) {
  return path.join(taskDir, 'budget.json');
}

/**
 * Atomically publish the effective budget for the round about to start.
 * Validates before touching the filesystem, so a rejected value never leaves a
 * partial or stale-but-newer file behind.
 * @param file - absolute budget-file path.
 * @param maxTokens - effective round budget.
 * @returns the written budget.
 */
export function writeRoundBudget(file, maxTokens) {
  const value = assertMaxTokens(maxTokens, 'round maxTokens');
  const temp = `${file}.new`;
  fs.writeFileSync(temp, `${JSON.stringify({maxTokens: value, updatedAt: new Date().toISOString()})}\n`, {mode: 0o600});
  fs.renameSync(temp, file);
  return value;
}

/**
 * Strictly read the budget a live task runtime must honor. Any missing,
 * malformed, or invalid file throws so the request fails loudly instead of
 * silently falling back to an inherited cap.
 * @param file - absolute budget-file path.
 * @returns the validated budget.
 */
export function readRoundBudget(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`budget file is unreadable (${file}): ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`budget file is not valid JSON: ${file}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`budget file must be a JSON object: ${file}`);
  }
  return assertMaxTokens(parsed.maxTokens, `budget maxTokens in ${file}`);
}
