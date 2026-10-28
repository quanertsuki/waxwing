import fs from 'node:fs';
import path from 'node:path';
import {aggregateBatchStatus} from './state.mjs';

export const BATCH_ID = /^research-[a-f0-9]{12}$/;
export const SHARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ORPHANED_SHARD_ERROR =
  'Research shard was planned but no task was created before restart';

/**
 * Own research batch storage: directories, atomic batch.json saves, loading,
 * and startup reconciliation of shards that a crash left planned without a
 * task. Callers never touch batch files directly.
 */
export class ResearchRepository {
  constructor({
    batchesDir,
    atomicJson,
    files = fs,
    now = () => new Date().toISOString(),
  }) {
    if (typeof atomicJson !== 'function') throw new Error('atomicJson dependency is required');
    this.batchesDir = path.resolve(batchesDir);
    this.atomicJson = atomicJson;
    this.files = files;
    this.now = now;
    this.batches = new Map();
  }

  batchDirectory(id) {
    if (!BATCH_ID.test(id ?? '')) throw new Error('Invalid research batch ID');
    return path.join(this.batchesDir, id);
  }

  batchFile(id) {
    return path.join(this.batchDirectory(id), 'batch.json');
  }

  resultFile(batchId, shardId) {
    if (!SHARD_ID.test(shardId ?? '')) throw new Error('Invalid shard ID');
    return path.join(this.batchDirectory(batchId), 'shards', `${shardId}.md`);
  }

  errorFile(batchId, shardId) {
    if (!SHARD_ID.test(shardId ?? '')) throw new Error('Invalid shard ID');
    return path.join(this.batchDirectory(batchId), 'shards', `${shardId}.error.txt`);
  }

  save(batch) {
    batch.updatedAt = this.now();
    this.batches.set(batch.id, batch);
    this.atomicJson(this.batchFile(batch.id), batch);
    return batch;
  }

  load(id) {
    if (this.batches.has(id)) return this.batches.get(id);
    const file = this.batchFile(id);
    const batch = JSON.parse(this.files.readFileSync(file, 'utf8'));
    if (batch.id !== id) throw new Error(`Research batch ID mismatch in ${file}`);
    this.batches.set(id, batch);
    return batch;
  }

  /**
   * Load every stored batch and settle the crash window where a batch was
   * saved before any shard task existed. Without this, such a batch would wait
   * forever on planned shards that can never receive a task.
   */
  restore() {
    if (!this.files.existsSync(this.batchesDir)) return 0;
    let count = 0;
    for (const name of this.files.readdirSync(this.batchesDir)) {
      if (!BATCH_ID.test(name)) continue;
      const file = this.batchFile(name);
      if (!this.files.existsSync(file)) continue;
      try {
        const batch = JSON.parse(this.files.readFileSync(file, 'utf8'));
        if (batch.id !== name) continue;
        let dirty = false;
        for (const shard of batch.shards ?? []) {
          if (shard.status === 'planned' && !shard.taskId) {
            shard.status = 'failed';
            shard.orphaned = true;
            shard.error = ORPHANED_SHARD_ERROR;
            shard.resultCaptured = true;
            dirty = true;
          }
        }
        if (dirty) {
          batch.status = aggregateBatchStatus(batch);
          this.save(batch);
        } else {
          this.batches.set(name, batch);
        }
        count += 1;
      } catch {
        // A damaged batch never prevents the rest of the manager from loading.
      }
    }
    return count;
  }
}
