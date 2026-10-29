// The close path writes one report and one task record as a single commit, and
// a deletion grant only exists on disk before it exists in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFakeWorker} from './fake-worker.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Isolation must load before manager/common so the data root is fixed.
import './isolate.mjs';
import {createManager} from '../manager.mjs';
import {ROOT} from '../common.mjs';
import {AcceptanceService} from '../../src/acceptance/service.mjs';
import {TaskRepository} from '../../src/tasks/repository.mjs';
import {TaskTransaction} from '../../src/tasks/transaction.mjs';
import {sha256} from '../../src/storage/durable-file.mjs';

const ID = 'task-0123456789ab';
const POLICY = '\n## Execution policy\n\nVersion: 1\nSHA-256: test-policy\n';

function workspace(name) {
  // The manager refuses a workspace inside its managed data root, so this one
  // lives under the OS temp directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `waxwing-commit-${name}-`));
  return dir;
}

/** Worker that acknowledges, completes, and exits on close. */
function fakeFork() {
  return createFakeWorker({pid: 4343});
}

async function settle(manager, id) {
  for (let i = 0; i < 300; i += 1) {
    const status = await manager.action('status', {id});
    if (status.status !== 'running' && status.status !== 'stopping') return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task did not settle');
}

test('a manager close archives the report with the execution policy section', async () => {
  const manager = createManager({forkWorker: fakeFork});
  try {
    const created = await manager.action('create', {
      workspace: workspace('policy'),
      prompt: 'work',
      plan: 'plan',
      criteria: 'criteria',
    });
    const settled = await settle(manager, created.id);
    assert.equal(settled.status, 'awaiting_review');

    const closed = await manager.action('close', {id: created.id});
    assert.equal(closed.status, 'closed');
    const report = fs.readFileSync(path.join(ROOT, 'reports', `${created.id}.md`), 'utf8');
    assert.match(report, /## Execution policy/);
    const record = JSON.parse(fs.readFileSync(path.join(closed.dataDirectory, 'task.json'), 'utf8'));
    assert.equal(record.reportHash, sha256(report));
  } finally {
    await manager.shutdown();
  }
});

test('a failed final save restores the report and leaves the task retryable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-acceptance-commit-'));
  try {
    const reportsDir = path.join(root, 'reports');
    const grantsDir = path.join(root, 'runtime');
    const runsDir = path.join(root, 'runs');
    fs.mkdirSync(path.join(runsDir, ID), {recursive: true});
    const repository = new TaskRepository({
      runsDir,
      atomicJson: (file, value) => {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, JSON.stringify(value));
      },
    });
    const task = {id: ID, status: 'awaiting_review', rounds: []};
    repository.remember(task);

    const acceptance = new AcceptanceService({
      reportsDir,
      grantsDir,
      policySection: () => POLICY,
    });
    let records = new Map([[ID, {w: {pid: 7}, closing: false}]]);
    const runtime = {
      get: id => records.get(id) ?? null,
      has: id => records.has(id),
      hasExited: () => true,
      beginClose: id => {
        const rec = records.get(id);
        if (!rec || rec.closing) return false;
        rec.closing = true;
        return true;
      },
      sendClose: () => null,
      abortClose: id => {
        const rec = records.get(id);
        if (!rec) return false;
        rec.closing = false;
        return true;
      },
      waitForExit: async () => true,
      closeError: () => null,
      forget: id => { records.delete(id); return true; },
    };

    let failClosed = true;
    const save = value => {
      if (failClosed && value.status === 'closed') throw new Error('disk full');
      return repository.save(value);
    };
    const transaction = new TaskTransaction({runtime, repository, save, acceptance});

    await assert.rejects(() => transaction.stop(ID, {closed: true}), /disk full/);
    assert.equal(fs.existsSync(path.join(reportsDir, `${ID}.md`)), false, 'the new report is rolled back');
    assert.equal(repository.peek(ID).status, 'stopping', 'the close never reached closed');
    assert.equal(records.get(ID).closing, false, 'the close stays retryable');

    failClosed = false;
    records = new Map([[ID, {w: {pid: 7}, closing: false}]]);
    const retried = await transaction.stop(ID, {closed: true});
    assert.equal(retried.task.status, 'closed');
    const report = fs.readFileSync(path.join(reportsDir, `${ID}.md`), 'utf8');
    assert.match(report, /## Execution policy/);
    assert.equal(retried.task.reportHash, sha256(report));
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('a grant whose file cannot be written is never honored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-grant-'));
  try {
    const reportsDir = path.join(root, 'reports');
    const grantsDir = path.join(root, 'runtime');
    const directory = path.join(root, 'runs', ID);
    fs.mkdirSync(reportsDir, {recursive: true});
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'scratch.txt'), 'evidence');
    const report = '# report\n';
    fs.writeFileSync(path.join(reportsDir, `${ID}.md`), report);
    const task = {
      id: ID,
      status: 'closed',
      reportHash: sha256(report),
      workspace: path.join(root, 'workspace'),
    };

    const acceptance = new AcceptanceService({
      reportsDir,
      grantsDir,
      files: {writeFileSync: () => { throw new Error('disk full'); }},
    });
    assert.throws(
      () => acceptance.grant(task, {directory, confirmation: ID}),
      /disk full/,
    );
    assert.equal(acceptance.hasGrant(ID), false, 'a failed write leaves no usable grant');
    assert.throws(
      () => acceptance.removeTask(task, {directory}),
      /No matching human cleanup authorization/,
    );
    assert.equal(fs.existsSync(directory), true, 'nothing was deleted');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
