// DSH profile plugin mounted into each task runtime by the manager's patch.
// It overrides the output budget of every conversation-model request with the
// task's own budget.json, which the worker atomically updates before each
// round. Strict by design: an unreadable or invalid budget file rejects the
// request instead of silently inheriting the SDK value or clamping it.
import {readRoundBudget} from './budget.mjs';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'task-budget';

/**
 * Register the request waterfall override.
 * @param ctx - Cordis context of the mounted plugin.
 * @param config - plugin config carrying the absolute `budgetFile` path.
 * @returns nothing; the listener lives with the plugin fiber.
 */
export function apply(ctx, config) {
  const budgetFile = config?.budgetFile;
  if (typeof budgetFile !== 'string' || budgetFile.trim() === '') {
    throw new Error('task-budget: config.budgetFile must be a nonempty path');
  }
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next();
    // Re-read and strictly validate on every request so a worker-published
    // budget always wins, including after the SDK handshake fixed its own cap.
    return {...resolved, maxTokens: readRoundBudget(budgetFile)};
  });
}
