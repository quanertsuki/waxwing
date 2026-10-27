import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskRepository} from '../../src/tasks/repository.mjs';
import {TaskTransaction} from '../../src/tasks/transaction.mjs';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-transaction-'));
}

function repositoryAt(root, atomicJson) {
  return new TaskRepository({runsDir: path.join(root, 'runs'), atomicJson});
}

function memoryRuntime(records = new Map()) {
  const events = [];
  return {
    events,
    records,
    get: id => records.get(id) ?? null,
    has: id => records.has(id),
    beginClose(id) {
      const rec = records.get(id);
      if (!rec || rec.closing) return false;
      rec.closing = true;
      events.push(['beginClose', id]);
      return true;
    },
    sendClose(id) {
      events.push(['sendClose', id]);
      return null;
    },
    waitForExit: async id => {
      events.push(['waitForExit', id]);
      return true;
    },
    forget(id) {
      records.delete(id);
      events.push(['forget', id]);
      return true;
    },
    closeError: () => null,
  };
}

test('create rolls back the index, directory, and workspace lease after a failed save', () => {
  const root = temporaryRoot();
  try {
    const writes = [];
    const repository = repositoryAt(root, (file, value) => {
      writes.push(file);
      throw new Error('atomic write failed');
    });
    const rolledBack = [];
    const transaction = new TaskTransaction({
      runtime: memoryRuntime(),
      repository,
      save: task => repository.save(task),
      workspace: {
        materialize: () => ({mode: 'shared', executionWorkspace: root}),
        rollback: lease => rolledBack.push(lease),
      },
    });
    const taskId = 'task-0123456789ab';
    const directory = path.join(root, 'runs', taskId);
    assert.throws(() => transaction.create({
      taskId,
      request: {},
      directory,
      makeDirectories: () => fs.mkdirSync(directory, {recursive: true}),
      removeDirectory: () => fs.rmSync(directory, {recursive: true, force: true}),
      preflight: {workspacePlan: {mode: 'shared'}},
      buildRecord: () => ({id: taskId, status: 'created'}),
    }), /atomic write failed/);
    assert.equal(repository.has(taskId), false);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(rolledBack.length, 1);
    assert.equal(writes.length, 1);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('stop without a runtime handle closes directly and records the final event', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'accepted', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const events = [];
    const transaction = new TaskTransaction({
      runtime: memoryRuntime(),
      repository,
      save: value => repository.save(value),
      event: (value, payload) => events.push({status: value.status, ...payload}),
      acceptance: {report: () => ({hash: 'report-hash'})},
    });
    const result = await transaction.stop(task.id, {closed: true});
    assert.equal(result.task.status, 'closed');
    assert.equal(result.task.reportHash, 'report-hash');
    assert.deepEqual(events.map(value => value.kind), ['closed']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('stop with a live runtime persists stopping before confirming exit and merges the latest record', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const records = new Map([[task.id, {w: {pid: 7}}]]);
    const runtime = memoryRuntime(records);
    const statuses = [];
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => {
        statuses.push(value.status);
        return repository.save(value);
      },
      event: () => {},
      terminate: async () => {},
    });
    runtime.waitForExit = async () => {
      repository.remember({...repository.peek(task.id), output: 'latest', status: 'awaiting_review'});
      return true;
    };
    const result = await transaction.stop(task.id, {closed: false, reason: 'test'});
    assert.deepEqual(statuses.slice(0, 2), ['stopping', 'cancelled']);
    assert.equal(result.task.output, 'latest');
    assert.equal(result.task.error, 'test');
    assert.equal(runtime.has(task.id), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a failed force-exit leaves the runtime handle and status for manual recovery', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'running', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const records = new Map([[task.id, {w: {pid: 7}, closing: false}]]);
    const runtime = memoryRuntime(records);
    runtime.waitForExit = async () => false;
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => repository.save(value),
      event: () => {},
      terminate: async () => {},
    });
    await assert.rejects(() => transaction.stop(task.id, {closed: true}),
      /could not confirm worker exit/);
    assert.equal(repository.peek(task.id).status, 'stopping');
    assert.equal(runtime.has(task.id), true);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('prepareRun waits at the release gate before numbering and saving the next round', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {
      id: 'task-0123456789ab',
      status: 'awaiting_review',
      rounds: [{number: 1, roundId: 'round-1'}],
      acceptance: {evidence: 'old'},
      reportHash: 'old-hash',
    };
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    let release;
    const records = new Map([[task.id, {
      phase: 'finished',
      w: {},
    }]]);
    const runtime = memoryRuntime(records);
    runtime.createRoundId = () => 'round-00000000-0000-4000-8000-000000000002';
    runtime.waitForRelease = async () => {
      await new Promise(resolve => { release = resolve; });
      repository.remember({...repository.peek(task.id), output: 'latest-result'});
      return true;
    };
    const events = [];
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => repository.save(value),
      event: (value, payload) => events.push({task: value, payload}),
      acceptance: {revoke: value => ({...value, acceptance: null, reportHash: null})},
    });

    const pending = transaction.prepareRun(task.id, {
      prompt: 'second',
      maxTokens: 2048,
      effort: 'high',
      policy: {meta: {applied: true, version: 1, sha256: 'policy-hash'}, text: 'policy'},
    });
    assert.equal(repository.peek(task.id).rounds.length, 1, 'no round may appear before released');
    release();
    const prepared = await pending;
    assert.equal(prepared.number, 2);
    assert.equal(prepared.task.status, 'running');
    assert.equal(prepared.task.output, null);
    assert.equal(prepared.task.rounds.length, 2);
    assert.equal(prepared.task.rounds[1].roundId, 'round-00000000-0000-4000-8000-000000000002');
    assert.equal(prepared.task.rounds[1].prompt, 'second');
    assert.equal(prepared.task.rounds[1].maxTokens, 2048);
    assert.equal(prepared.task.rounds[1].effort, 'high');
    assert.equal(prepared.task.acceptance, null);
    assert.equal(prepared.task.reportHash, null);
    assert.deepEqual(prepared.task.policySnapshot, {
      version: 1,
      sha256: 'policy-hash',
      text: 'policy',
    });
    assert.equal(events.at(-1).payload.kind, 'round_started');
    assert.equal(events.at(-1).payload.number, 2);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('prepareRun refuses a running task and an un-released previous runtime without mutation', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const running = {id: 'task-0123456789ab', status: 'running', rounds: [{number: 1}]};
    repository.remember(running);
    fs.mkdirSync(path.join(root, 'runs', running.id), {recursive: true});
    const runtime = memoryRuntime();
    let saved = 0;
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => { saved += 1; return repository.save(value); },
      acceptance: {revoke: value => ({...value, acceptance: null, reportHash: null})},
    });
    await assert.rejects(
      () => transaction.prepareRun(running.id, {prompt: 'next', maxTokens: 1024}),
      /already running/,
    );
    assert.equal(saved, 0);

    running.status = 'awaiting_review';
    runtime.records.set(running.id, {phase: 'finished', w: {}});
    runtime.waitForRelease = async () => false;
    await assert.rejects(
      () => transaction.prepareRun(running.id, {prompt: 'next', maxTokens: 1024}),
      /previous runtime exited before releasing/,
    );
    assert.equal(saved, 0);
    assert.equal(repository.peek(running.id).rounds.length, 1);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
