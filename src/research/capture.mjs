import fs from 'node:fs';
import path from 'node:path';
import {atomicWriteText} from '../storage/durable-file.mjs';

/**
 * Capture one shard's terminal evidence: the task result when present, or the
 * workspace's research-result.md fallback. This reader only locates and stores
 * the text; `shardCapturePatch` in state.mjs decides what the evidence means.
 */
export class ResearchCapture {
  constructor({repository, files = fs}) {
    if (!repository) throw new Error('repository dependency is required');
    this.repository = repository;
    this.files = files;
  }

  async read(batch, shard, view) {
    let resultText = view?.resultText || '';
    const workspaceResult = shard.workspace
      ? path.join(shard.workspace, 'research-result.md')
      : null;
    if (!resultText && workspaceResult && this.files.existsSync(workspaceResult)) {
      resultText = this.files.readFileSync(workspaceResult, 'utf8');
    }
    if (resultText) {
      atomicWriteText(this.repository.resultFile(batch.id, shard.id), resultText, {files: this.files});
    }
    return resultText;
  }

  /** Store the error text that the state patch assigned to a failed shard. */
  writeError(batch, shard, error) {
    if (!error) return;
    atomicWriteText(this.repository.errorFile(batch.id, shard.id), error, {files: this.files});
  }
}