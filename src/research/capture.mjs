import fs from 'node:fs';
import path from 'node:path';

/**
 * Capture one shard's terminal evidence: the task result when present, or the
 * workspace's research-result.md fallback. File reads and writes live here so
 * refresh can isolate a single unreadable shard from the rest of the batch.
 */
export class ResearchCapture {
  constructor({repository, files = fs}) {
    if (!repository) throw new Error('repository dependency is required');
    this.repository = repository;
    this.files = files;
  }

  async capture(batch, shard, task) {
    if (shard.resultCaptured) return shard;
    let resultText = task.output || task.rounds?.at(-1)?.result?.text || '';
    const workspaceResult = shard.workspace
      ? path.join(shard.workspace, 'research-result.md')
      : null;
    if (!resultText && workspaceResult && this.files.existsSync(workspaceResult)) {
      resultText = this.files.readFileSync(workspaceResult, 'utf8');
    }
    if (resultText) {
      const file = this.repository.resultFile(batch.id, shard.id);
      this.files.mkdirSync(path.dirname(file), {recursive: true});
      this.files.writeFileSync(file, resultText);
    }
    const finishReason = task.finishReason ?? task.rounds?.at(-1)?.result?.finishReason ?? null;
    if (task.status === 'cancelled') {
      shard.status = 'cancelled';
      shard.error = task.error ?? 'Research shard cancelled';
    } else if (task.status === 'failed' || finishReason === 'error') {
      shard.status = 'failed';
      shard.error = task.error ?? 'Research shard failed without an error message';
      if (task.error) {
        const file = this.repository.errorFile(batch.id, shard.id);
        this.files.mkdirSync(path.dirname(file), {recursive: true});
        this.files.writeFileSync(file, task.error);
      }
    } else {
      shard.status = 'completed';
      shard.error = null;
    }
    shard.resultCaptured = true;
    shard.tasksAtCapture = task.status;
    return shard;
  }
}
