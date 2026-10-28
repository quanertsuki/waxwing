// Research refresh isolation: one unreadable shard must not fail the batch,
// crash-window planned shards must converge, and concurrent callers must share
// one refresh/close and produce an idempotent report.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {TEST_ROOT} from './isolate.mjs';
import {ResearchBatchService} from '../../src/research/service.mjs';

const BATCH = 'research-abcdefabcdef';
let sequence = 0;

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function batchFile(shards) {
  return {
    schemaVersion: 1,
    id: BATCH,
    title: 'Contract research',
    question: 'What is true?',
    commonPrompt: null,
    criteria: 'cite sources',
    provider: null,
    createdAt: '2026-10-28T01:00:00.000Z',
    updatedAt: '2026-10-28T01:00:00.000Z',
    cancelRequested: false,
    status: 'running',
    reportHash: null,
    shards,
  };
}

function workspaceRoot() {
  const root = path.join(TEST_ROOT, `research-refresh-${process.pid}-${++sequence}`);
  fs.mkdirSync(root, {recursive: true});
  return root;
}

function serviceFor(root, options = {}) {
  return new ResearchBatchService({
    batchesDir: path.join(root, 'research'),
    scratchRoot: path.join(root, 'scratch'),
    reportsDir: path.join(root, 'reports'),
    atomicJson,
    createTask: async () => ({id: 'task-unused'}),
    getTask: options.getTask,
    closeTask: options.closeTask ?? (async () => {}),
    cancelTask: async () => {},
    canCloseTask: () => true,
    now: () => '2026-10-28T02:00:00.000Z',
    makeId: () => BATCH,
    files: options.files,
  });
}

function writeBatch(service, batch) {
  fs.mkdirSync(service.batchDirectory(batch.id), {recursive: true});
  fs.writeFileSync(service.batchFile(batch.id), JSON.stringify(batch, null, 2));
}

const task = {
  id: 'task-0123456789ab',
  status: 'awaiting_review',
  output: 'usable evidence',
  rounds: [],
};

test('an unreadable shard result marks captureError but status, wait, and collect still work', async () => {
  const root = workspaceRoot();
  const workspace = path.join(root, 'scratch', BATCH, 'shard-one');
  const unreadable = path.join(workspace, 'research-result.md');
  const files = new Proxy(fs, {
    get(target, property) {
      if (property === 'existsSync') {
        return file => path.resolve(file) === path.resolve(unreadable) || fs.existsSync(file);
      }
      if (property === 'readFileSync') {
        return (file, ...args) => {
          if (path.resolve(file) === path.resolve(unreadable)) throw new Error('EACCES: result unreadable');
          return fs.readFileSync(file, ...args);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const service = serviceFor(root, {
    files,
    getTask: () => ({...task, output: ''}),
  });
  writeBatch(service, batchFile([{
    id: 'shard-one',
    subject: 'Unreadable source',
    url: null,
    focus: null,
    taskId: task.id,
    taskStatus: 'awaiting_review',
    status: 'running',
    workspace,
  }]));

  const status = await service.status(BATCH);
  assert.match(status.shards[0].captureError, /EACCES/);
  assert.equal(status.shards[0].status, 'failed');
  assert.equal(status.status, 'failed');

  const waited = await service.wait(BATCH, {timeoutSeconds: 1});
  assert.equal(waited.wait.timedOut, false);

  const collected = await service.collect(BATCH);
  assert.ok(collected.reportHash);
  assert.ok(fs.existsSync(collected.report));
  assert.match(fs.readFileSync(collected.report, 'utf8'), /Capture error/);
});

test('a crash-window planned shard becomes an orphaned terminal shard', async () => {
  const root = workspaceRoot();
  const service = serviceFor(root, {getTask: () => task});
  writeBatch(service, batchFile([{
    id: 'shard-one',
    subject: 'Never started',
    url: null,
    focus: null,
    taskId: null,
    taskStatus: null,
    status: 'planned',
  }]));

  assert.equal(service.restore(), 1);
  const status = await service.status(BATCH);
  assert.equal(status.status, 'failed');
  assert.equal(status.shards[0].status, 'failed');
  assert.equal(status.shards[0].orphaned, true);
  assert.match(status.shards[0].error, /before restart/);

  const waited = await service.wait(BATCH, {timeoutSeconds: 1});
  assert.equal(waited.wait.timedOut, false);
  assert.equal(waited.wait.waitedMs < 1000, true);
});

test('concurrent status, wait, and collect share one refresh and one close', async () => {
  const root = workspaceRoot();
  let closes = 0;
  const service = serviceFor(root, {
    getTask: () => task,
    closeTask: async () => {
      closes += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
    },
  });
  writeBatch(service, batchFile([{
    id: 'shard-one',
    subject: 'Concurrent source',
    url: null,
    focus: null,
    taskId: task.id,
    taskStatus: 'awaiting_review',
    status: 'running',
    workspace: null,
  }]));

  const [status, waited, first, second] = await Promise.all([
    service.status(BATCH),
    service.wait(BATCH, {timeoutSeconds: 1}),
    service.collect(BATCH),
    service.collect(BATCH),
  ]);
  assert.equal(closes, 1);
  assert.equal(status.status, 'completed');
  assert.equal(waited.wait.timedOut, false);
  assert.equal(first.reportHash, second.reportHash);

  const repeat = await service.collect(BATCH);
  assert.equal(repeat.reportHash, first.reportHash);
  assert.ok(fs.existsSync(repeat.report));
});
