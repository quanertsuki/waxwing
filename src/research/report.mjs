import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const DEFAULT_PAGE_LIMIT = 2000;
const MAX_PAGE_LIMIT = 4000;
let tempCounter = 0;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeOffset(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('offset must be a non-negative safe integer');
  }
  return value;
}

function safeLimit(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be a safe integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

export function pageOf(value, offset, limit) {
  const total = value.length;
  if (offset > total) throw new Error(`offset ${offset} exceeds text length ${total}`);
  let end = Math.min(total, offset + limit);
  if (end < total && end > offset && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  return {
    text: value.slice(offset, end),
    totalChars: total,
    offset,
    limit,
    nextOffset: end < total ? end : null,
  };
}

/**
 * Build and atomically write the aggregate research report. Reads are
 * best-effort: a damaged shard file is reported inside the document instead of
 * making the whole collection fail.
 */
export class ResearchReport {
  constructor({reportsDir, repository, files = fs, digestText = digest}) {
    if (!repository) throw new Error('repository dependency is required');
    this.reportsDir = path.resolve(reportsDir);
    this.repository = repository;
    this.files = files;
    this.digestText = digestText;
  }

  file(id) {
    return path.join(this.reportsDir, `${id}.md`);
  }

  content(batch) {
    const sections = batch.shards.map(shard => {
      const resultFile = this.repository.resultFile(batch.id, shard.id);
      const errorFile = this.repository.errorFile(batch.id, shard.id);
      let result = '';
      let resultError = null;
      try {
        if (this.files.existsSync(resultFile)) {
          result = this.files.readFileSync(resultFile, 'utf8').trim();
        }
      } catch (error) {
        resultError = error.message;
      }
      let error = shard.error ?? null;
      if (!error) {
        try {
          if (this.files.existsSync(errorFile)) {
            error = this.files.readFileSync(errorFile, 'utf8').trim();
          }
        } catch (readError) {
          error = `error file unreadable: ${readError.message}`;
        }
      }
      const captureError = shard.captureError
        ? `Capture error: ${shard.captureError}`
        : null;
      return [
        `## ${shard.subject}`,
        '',
        `- Shard: ${shard.id}`,
        `- Status: ${shard.status}`,
        `- Task: ${shard.taskId ?? '(not created)'}`,
        shard.url ? `- Source: ${shard.url}` : null,
        shard.workspace ? `- Scratch workspace: ${shard.workspace}` : null,
        '',
        result || (resultError ? `_Result could not be read: ${resultError}_` : '_No result captured._'),
        error ? `\n### Error\n\n${error}` : null,
        captureError ? `\n### Capture\n\n${captureError}` : null,
      ].filter(value => value !== null && value !== undefined).join('\n');
    });
    return [
      `# Waxwing research: ${batch.title}`,
      '',
      batch.question,
      '',
      `- Batch: ${batch.id}`,
      `- Status: ${batch.status}`,
      `- Created: ${batch.createdAt}`,
      `- Shards: ${batch.shards.length}`,
      '',
      sections.join('\n\n'),
      '',
    ].join('\n');
  }

  write(batch, content) {
    const file = this.file(batch.id);
    this.files.mkdirSync(this.reportsDir, {recursive: true});
    const temp = `${file}.${process.pid}.${++tempCounter}.tmp`;
    try {
      this.files.writeFileSync(temp, content);
      this.files.renameSync(temp, file);
    } catch (error) {
      try {
        this.files.rmSync(temp, {force: true});
      } catch {}
      throw error;
    }
    return file;
  }

  collect(batch, options = {}) {
    const content = this.content(batch);
    const hash = this.digestText(content);
    const file = this.write(batch, content);
    const offset = options.offset === undefined ? 0 : safeOffset(options.offset);
    const limit = options.limit === undefined ? DEFAULT_PAGE_LIMIT : safeLimit(options.limit);
    return {file, reportHash: hash, page: pageOf(content, offset, limit)};
  }
}
