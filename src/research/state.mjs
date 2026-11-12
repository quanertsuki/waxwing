import {ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES} from '../tasks/lifecycle.mjs';

const TERMINAL_TASK = TERMINAL_TASK_STATUSES;
const ACTIVE_TASK = ACTIVE_TASK_STATUSES;
const TERMINAL_BATCH = new Set(['completed', 'partial', 'failed', 'cancelled']);

function countByShardStatus(shards) {
  return shards.reduce((counts, shard) => {
    counts.total += 1;
    counts[shard.status] = (counts[shard.status] ?? 0) + 1;
    return counts;
  }, {
    total: 0,
    planned: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });
}

/**
 * Project the shard set into the batch state. A cancel request wins only after
 * active shards settle; completed evidence therefore becomes `partial` rather
 * than being discarded. Runtime finalization is visible but not terminal.
 */
export function aggregateBatchStatus(batch) {
  const counts = countByShardStatus(batch.shards);
  const active = counts.planned + counts.running;
  if (batch.cancelRequested && active === 0) {
    return counts.completed > 0 ? 'partial' : 'cancelled';
  }
  if (active > 0) return batch.cancelRequested ? 'cancelling' : 'running';
  if (batch.shards.some(shard => shard.finalizing)) return 'finalizing';
  if (counts.completed === counts.total) return 'completed';
  if (counts.completed > 0) return 'partial';
  if (counts.cancelled > 0 && counts.failed === 0) return 'cancelled';
  return 'failed';
}

/**
 * Classify one narrow shard view for a shard. `capture` is the only state that
 * may write evidence; `finalize` means evidence is safe and runtime release is
 * still pending, so a batch must not become terminal yet. The research service
 * never reads a task record or a runtime handle.
 */
export function shardTransition(shard, view) {
  if (!view) {
    return {
      dirty: shard.status !== 'failed',
      patch: {status: 'failed', error: `Task record is missing: ${shard.taskId}`},
      capture: false,
      finalize: false,
      terminal: false,
    };
  }
  const patch = {};
  let dirty = false;
  if (shard.taskStatus !== view.status) {
    patch.taskStatus = view.status;
    dirty = true;
  }
  if (TERMINAL_TASK.has(view.status)) {
    const capture = !shard.resultCaptured;
    const finalize = view.status !== 'closed' && !shard.runtimeReleased;
    if (capture) dirty = true;
    if (finalize && !shard.finalizing) {
      patch.finalizing = true;
      dirty = true;
    }
    return {dirty, patch, capture, finalize, terminal: true};
  }
  if (ACTIVE_TASK.has(view.status) && shard.status !== 'cancelled') {
    if (shard.status !== 'running') {
      patch.status = 'running';
      dirty = true;
    }
    return {dirty, patch, capture: false, finalize: false, terminal: false};
  }
  return {dirty, patch, capture: false, finalize: false, terminal: false};
}

/**
 * The shard status and error a captured view implies. Evidence classification
 * lives here, not in the capture reader, so every consumer sees one rule.
 */
export function shardCapturePatch(view) {
  const finishReason = view?.finishReason ?? null;
  if (view?.status === 'cancelled') {
    return {status: 'cancelled', error: view.error ?? 'Research shard cancelled'};
  }
  if (view?.status === 'failed' || finishReason === 'error') {
    return {status: 'failed', error: view.error ?? 'Research shard failed without an error message'};
  }
  return {status: 'completed', error: null};
}

export function isTerminalBatch(status) {
  return TERMINAL_BATCH.has(status);
}

export function isActiveBatch(status) {
  return status === 'running' || status === 'cancelling' || status === 'finalizing';
}

export {ACTIVE_TASK, TERMINAL_BATCH, TERMINAL_TASK, countByShardStatus};
