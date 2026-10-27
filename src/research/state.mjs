const TERMINAL_TASK = new Set(['awaiting_review', 'failed', 'cancelled', 'closed', 'accepted']);
const ACTIVE_TASK = new Set(['created', 'running', 'stopping']);
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
 * Classify one task record for a shard. `capture` is the only state that may
 * write evidence; `finalize` means evidence is safe and runtime release is
 * still pending, so a batch must not become terminal yet.
 */
export function shardTransition(shard, task) {
  if (!task) {
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
  if (shard.taskStatus !== task.status) {
    patch.taskStatus = task.status;
    dirty = true;
  }
  if (TERMINAL_TASK.has(task.status)) {
    const capture = !shard.resultCaptured;
    const finalize = task.status !== 'closed' && !shard.runtimeReleased;
    if (capture) dirty = true;
    if (finalize && !shard.finalizing) {
      patch.finalizing = true;
      dirty = true;
    }
    return {dirty, patch, capture, finalize, terminal: true};
  }
  if (ACTIVE_TASK.has(task.status) && shard.status !== 'cancelled') {
    if (shard.status !== 'running') {
      patch.status = 'running';
      dirty = true;
    }
    return {dirty, patch, capture: false, finalize: false, terminal: false};
  }
  return {dirty, patch, capture: false, finalize: false, terminal: false};
}

export function isTerminalBatch(status) {
  return TERMINAL_BATCH.has(status);
}

export function isActiveBatch(status) {
  return status === 'running' || status === 'cancelling' || status === 'finalizing';
}

export {ACTIVE_TASK, TERMINAL_BATCH, TERMINAL_TASK, countByShardStatus};
