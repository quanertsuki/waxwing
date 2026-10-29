// Research sub-modules directly: storage and restart reconciliation, evidence
// reading, and the aggregate report. No manager, runtime, or task record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ResearchRepository, ORPHANED_SHARD_ERROR} from '../../src/research/repository.mjs';
import {ResearchCapture} from '../../src/research/capture.mjs';
import {ResearchReport} from '../../src/research/report.mjs';

const BATCH = 'research-abcdefabcdef';

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-research-modules-'));
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    id: BATCH,
    title: 'Modules',
    question: 'What is true?',
    criteria: 'cite sources',
    createdAt: '2026-10-28T01:00:00.000Z',
    updatedAt: '2026-10-28T01:00:00.000Z',
    cancelRequested: false,
    status: 'running',
    reportHash: null,
    shards: [],
    ...overrides,
  };
}

function repositoryFor(dir) {
  return new ResearchRepository({
    batchesDir: path.join(dir, 'research'),
    atomicJson,
    now: () => '2026-10-28T02:00:00.000Z',
  });
}

test('the repository saves, caches, reloads, and rejects invalid IDs', () => {
  const dir = root();
  const repository = repositoryFor(dir);
  const saved = repository.save(batch());
  assert.equal(saved.updatedAt, '2026-10-28T02:00:00.000Z');
  assert.equal(repository.load(BATCH), saved);
  assert.equal(JSON.parse(fs.readFileSync(repository.batchFile(BATCH), 'utf8')).id, BATCH);

  const reloaded = repositoryFor(dir);
  assert.equal(reloaded.load(BATCH).title, 'Modules');
  assert.throws(() => reloaded.batchDirectory('research-nope'), /Invalid research batch ID/);
  assert.throws(() => reloaded.resultFile(BATCH, 'Bad Shard'), /Invalid shard ID/);
});

test('restore settles planned shards that never received a task', () => {
  const dir = root();
  const repository = repositoryFor(dir);
  repository.save(batch({
    status: 'running',
    shards: [
      {id: 'shard-one', subject: 'Never started', status: 'planned', taskId: null},
      {id: 'shard-two', subject: 'Already done', status: 'completed', taskId: 'task-0123456789ab'},
    ],
  }));

  const reloaded = repositoryFor(dir);
  assert.equal(reloaded.restore(), 1);
  const stored = reloaded.load(BATCH);
  assert.equal(stored.shards[0].status, 'failed');
  assert.equal(stored.shards[0].orphaned, true);
  assert.equal(stored.shards[0].error, ORPHANED_SHARD_ERROR);
  assert.equal(stored.shards[1].status, 'completed');
  assert.equal(stored.status, 'partial');
});

test('capture reads the task result or the workspace fallback and writes evidence', async () => {
  const dir = root();
  const repository = repositoryFor(dir);
  const capture = new ResearchCapture({repository});
  const stored = repository.save(batch());
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace, {recursive: true});
  const shard = {id: 'shard-one', workspace};

  assert.equal(await capture.read(stored, shard, {resultText: 'task evidence'}), 'task evidence');
  assert.equal(fs.readFileSync(repository.resultFile(BATCH, 'shard-one'), 'utf8'), 'task evidence');

  fs.writeFileSync(path.join(workspace, 'research-result.md'), 'workspace evidence');
  assert.equal(await capture.read(stored, shard, {resultText: ''}), 'workspace evidence');
  assert.equal(fs.readFileSync(repository.resultFile(BATCH, 'shard-one'), 'utf8'), 'workspace evidence');

  capture.writeError(stored, shard, 'provider failed');
  assert.equal(fs.readFileSync(repository.errorFile(BATCH, 'shard-one'), 'utf8'), 'provider failed');
});

test('the report is stable, paged, and shows shard errors without failing', () => {
  const dir = root();
  const repository = repositoryFor(dir);
  const report = new ResearchReport({reportsDir: path.join(dir, 'reports'), repository});
  const stored = batch({shards: [
    {id: 'shard-one', subject: 'One', status: 'completed', taskId: 'task-0123456789ab', workspace: null},
    {id: 'shard-two', subject: 'Two', status: 'failed', taskId: 'task-0123456789ac', workspace: null,
      error: 'provider failed'},
  ]});
  fs.mkdirSync(path.join(repository.batchDirectory(BATCH), 'shards'), {recursive: true});
  fs.writeFileSync(repository.resultFile(BATCH, 'shard-one'), 'usable evidence');

  const first = report.collect(stored, {limit: 40});
  const second = report.collect(stored, {limit: 40});
  assert.equal(first.reportHash, second.reportHash);
  assert.match(first.reportHash, /^[a-f0-9]{64}$/);
  assert.equal(first.page.limit, 40);
  assert.equal(first.page.text.length, 40);
  assert.equal(first.page.nextOffset, 40);
  assert.equal(first.page.complete, false);
  assert.match(fs.readFileSync(first.file, 'utf8'), /usable evidence/);
  assert.match(fs.readFileSync(first.file, 'utf8'), /provider failed/);

  const whole = report.content(stored);
  assert.match(whole, /# Waxwing research: Modules/);
  assert.match(whole, /## One/);
  assert.match(whole, /### Error/);
});
