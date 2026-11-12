import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskRepository} from '../../src/tasks/repository.mjs';
import {TaskTransaction} from '../../src/tasks/transaction.mjs';
import {transition as applyTransition} from '../../src/tasks/lifecycle.mjs';
import {Runtime} from '../../src/runtime/module.mjs';
import {AcceptanceService} from '../../src/acceptance/service.mjs';
import {killOwnedRuntime} from '../../src/runtime/identity.mjs';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-transaction-'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value));
}

/** A child-process stand-in that exits when it receives the close message. */
function fakeChild({exitOnClose = true} = {}) {
  const handle = new EventEmitter();
  handle.stdout = new EventEmitter();
  handle.stderr = new EventEmitter();
  handle.pid = 4242;
  handle.connected = true;
  handle.exitCode = null;
  handle.signalCode = null;
  handle.sent = [];
  handle.send = message => {
    handle.sent.push(message);
    if (!exitOnClose || message.kind !== 'close') return;
    setImmediate(() => {
      handle.connected = false;
      handle.exitCode = 0;
      handle.emit('exit', 0);
    });
  };
  return handle;
}

/** Real Runtime and lifecycle over one retained fake handle. */
function realRuntime({repository, handle, save}) {
  return new Runtime({
    spawn: () => handle,
    latest: id => repository.peek(id) ?? null,
    event: () => {},
    save: ({task}) => save(task),
    transition: ({task, action}) => applyTransition(task, action),
    persist: () => {},
  });
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
    abortClose(id) {
      const rec = records.get(id);
      if (!rec || !rec.closing) return false;
      rec.closing = false;
      events.push(['abortClose', id]);
      return true;
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

test('a failed atomic write never publishes a task into the repository index', () => {
  const root = temporaryRoot();
  try {
    let fail = true;
    const repository = repositoryAt(root, (file, value) => {
      if (fail) throw new Error('disk unavailable');
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'created', rounds: []};
    assert.throws(() => repository.save(task), /disk unavailable/);
    assert.equal(repository.has(task.id), false);
    assert.throws(() => repository.get(task.id), /Unknown task/);
    assert.deepEqual(repository.ids(), []);

    fail = false;
    const saved = repository.save(task);
    assert.notEqual(saved, task, 'commit stores an immutable snapshot');
    assert.equal(saved.eventSequence, 0);
    assert.equal(Object.isFrozen(saved), true);
    assert.equal(repository.get(task.id), saved);
    assert.deepEqual(repository.ids(), [task.id]);
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
      acceptance: {
        writeReportAndSave: (value, {save}) => ({task: save({...value, reportHash: 'report-hash'})}),
      },
    });
    const result = await transaction.stop(task.id, {closed: true});
    assert.equal(result.task.status, 'closed');
    assert.equal(result.task.reportHash, 'report-hash');
    assert.deepEqual(events.map(value => value.kind), ['closed']);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a close cleanup failure fails the stopping task and the next close can finish it', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const runtime = memoryRuntime(new Map([[task.id, {w: {pid: 7}}]]));
    runtime.closeError = () => 'close request failed: pipe broke';
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => repository.save(value),
      event: () => {},
      acceptance: {
        writeReportAndSave: (value, {save}) => ({task: save({...value, reportHash: 'report-hash'})}),
      },
    });

    await assert.rejects(
      transaction.stop(task.id, {closed: true}),
      /runtime cleanup failed: close request failed/,
    );
    const failed = repository.get(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /runtime cleanup failed/);

    const retried = await transaction.stop(task.id, {closed: true});
    assert.equal(retried.task.status, 'closed');
    assert.equal(retried.task.reportHash, 'report-hash');
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

test('a failed terminal save after exit keeps the handle and allows another stop', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const records = new Map([[task.id, {w: {pid: 7}, closing: false}]]);
    const runtime = memoryRuntime(records);
    runtime.waitForExit = async () => true;
    let failFinal = true;
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => {
        if (failFinal && value.status === 'cancelled') throw new Error('disk full');
        return repository.save(value);
      },
      acceptance: {report: () => ({hash: 'report-hash'})},
    });

    await assert.rejects(() => transaction.stop(task.id), /disk full/);
    assert.equal(repository.peek(task.id).status, 'stopping');
    assert.equal(runtime.has(task.id), true, 'the handle must survive a failed final save');
    assert.equal(records.get(task.id).closing, false, 'the close attempt must be retryable');

    failFinal = false;
    const result = await transaction.stop(task.id);
    assert.equal(result.task.status, 'cancelled');
    assert.equal(result.task.reportHash, undefined);
    assert.equal(runtime.has(task.id), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a real runtime retains an exited handle so a failed close save can retry', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, writeJson);
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: [{number: 1}]};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const handle = fakeChild();
    let failClosed = true;
    const save = value => {
      if (failClosed && value.status === 'closed') throw new Error('disk full');
      return repository.save(value);
    };
    const runtime = realRuntime({repository, handle, save});
    runtime.adopt(task, handle, 'owner-marker');
    const acceptance = new AcceptanceService({
      reportsDir: path.join(root, 'reports'),
      grantsDir: path.join(root, 'runtime'),
    });
    const transaction = new TaskTransaction({runtime, repository, save, event: () => {}, acceptance});

    await assert.rejects(() => transaction.stop(task.id, {closed: true}), /disk full/);
    assert.equal(repository.peek(task.id).status, 'stopping', 'the final state was never made durable');
    assert.equal(runtime.has(task.id), true, 'the handle outlives the exit for the retry');
    assert.equal(runtime.isLive(task.id), false, 'the process itself is gone');

    failClosed = false;
    const result = await transaction.stop(task.id, {closed: true});
    assert.equal(result.task.status, 'closed');
    assert.equal(runtime.has(task.id), false);
    assert.deepEqual(runtime.ids(), []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a worker that ignores close is force-killed through its owned handle', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, writeJson);
    const task = {id: 'task-0123456789ac', status: 'awaiting_review', rounds: [{number: 1}]};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const handle = fakeChild({exitOnClose: false});
    const signals = [];
    handle.kill = signal => {
      signals.push(signal);
      setImmediate(() => {
        handle.exitCode = null;
        handle.signalCode = signal;
        handle.emit('exit', null);
      });
    };
    const save = value => repository.save(value);
    const runtime = realRuntime({repository, handle, save});
    runtime.adopt(task, handle, 'owner-marker');
    const acceptance = new AcceptanceService({
      reportsDir: path.join(root, 'reports'),
      grantsDir: path.join(root, 'runtime'),
    });
    // POSIX branch on every OS: no command-line inspection is involved, which
    // is what keeps forced exit working where /proc does not exist.
    const transaction = new TaskTransaction({
      runtime, repository, save, event: () => {}, acceptance,
      gracefulExitTimeoutMs: 20,
      forceExitTimeoutMs: 1_000,
      terminate: ({rec}) => killOwnedRuntime(rec.w, {platform: 'darwin'}),
    });

    const result = await transaction.stop(task.id, {closed: true});
    assert.deepEqual(signals, ['SIGKILL']);
    assert.equal(result.task.status, 'closed');
    assert.equal(runtime.has(task.id), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a real runtime forgets the handle after a normal confirmed close', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, writeJson);
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: [{number: 1}]};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const handle = fakeChild();
    const save = value => repository.save(value);
    const runtime = realRuntime({repository, handle, save});
    runtime.adopt(task, handle, 'owner-marker');
    const transaction = new TaskTransaction({runtime, repository, save, event: () => {}});

    const result = await transaction.stop(task.id, {closed: false});
    assert.equal(result.task.status, 'cancelled');
    assert.equal(runtime.has(task.id), false);
    assert.deepEqual(runtime.ids(), []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('an unexpected exit fails the task and the next close forgets the handle', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, writeJson);
    const task = {id: 'task-0123456789ab', status: 'running', rounds: [{number: 1}]};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const handle = fakeChild({exitOnClose: false});
    const save = value => repository.save(value);
    const runtime = realRuntime({repository, handle, save});
    runtime.adopt(task, handle, 'owner-marker');

    handle.exitCode = 1;
    handle.emit('exit', 1);
    const failed = repository.peek(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /worker exited \(1\)/);
    assert.equal(runtime.has(task.id), true, 'the handle is retained until someone closes the task');
    assert.equal(runtime.isLive(task.id), false);
    assert.deepEqual(runtime.liveIds(), []);

    const transaction = new TaskTransaction({
      runtime,
      repository,
      save,
      event: () => {},
      acceptance: new AcceptanceService({
        reportsDir: path.join(root, 'reports'),
        grantsDir: path.join(root, 'runtime'),
      }),
    });
    const result = await transaction.stop(task.id, {closed: true});
    assert.equal(result.task.status, 'closed');
    assert.equal(runtime.has(task.id), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a close error is persisted before the handle is forgotten', async () => {
  const root = temporaryRoot();
  try {
    const repository = repositoryAt(root, (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    });
    const task = {id: 'task-0123456789ab', status: 'awaiting_review', rounds: []};
    repository.remember(task);
    fs.mkdirSync(path.join(root, 'runs', task.id), {recursive: true});
    const records = new Map([[task.id, {w: {pid: 7}, closing: false}]]);
    const runtime = memoryRuntime(records);
    runtime.waitForExit = async () => true;
    runtime.closeError = () => 'harness close failed';
    const transaction = new TaskTransaction({
      runtime,
      repository,
      save: value => repository.save(value),
    });

    await assert.rejects(() => transaction.stop(task.id, {closed: true}),
      /runtime cleanup failed: harness close failed/);
    assert.equal(repository.peek(task.id).status, 'failed');
    assert.match(repository.peek(task.id).error, /runtime cleanup failed/);
    assert.equal(runtime.has(task.id), false, 'a confirmed exit may release the handle');
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

    const review = repository.remember({...running, status: 'awaiting_review'});
    runtime.records.set(review.id, {phase: 'finished', w: {}});
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
