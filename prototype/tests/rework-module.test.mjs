// Rework is one read-only decision: status/runtime facts plus limit state in,
// an allow/refuse answer plus record patch and override event out. The status
// view and the rework action share it, so their refusal texts cannot drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFakeWorker} from './fake-worker.mjs';
import './isolate.mjs';
import {createManager} from '../manager.mjs';
import {UsageModule} from '../../src/usage/module.mjs';
import {TaskRework} from '../../src/tasks/rework.mjs';
import {TaskRepository} from '../../src/tasks/repository.mjs';
import {TaskTransaction} from '../../src/tasks/transaction.mjs';

const LIMITS = {
  enabled: true,
  warnCostCny: 3,
  blockCostCny: 5,
  warnRequests: 2,
  blockRequests: 3,
};

function snapshotFor(limitState, limits) {
  const internalRequests = limitState === 'blocked' ? 3 : limitState === 'warning' ? 2 : 1;
  return {
    statusUsage: {
      available: true,
      internalRequests,
      requests: internalRequests,
      requestsWithoutUsage: 0,
      estimatedCostCny: 1,
      costComplete: true,
      limitState,
      limits,
    },
    usageRounds: [],
    listUsage: {available: true, requests: internalRequests},
    computed: {},
  };
}

function usageFor(limitState) {
  return new UsageModule({
    configuration: LIMITS,
    operations: {
      usageForTask: (_task, _directory, options) =>
        snapshotFor(limitState, options.limits ?? LIMITS),
    },
    now: () => '2026-10-29T00:00:00.000Z',
  });
}

function baseTask(extra = {}) {
  return {
    id: 'task-0123456789ab',
    status: 'awaiting_review',
    rounds: [{number: 1}],
    workspace: 'C:/work/example',
    sessionId: 'session-1',
    provider: {name: 'test', type: 'dsh-sdk', model: 'model'},
    maxTokens: 1024,
    effort: 'high',
    ...extra,
  };
}

function reworkWith({
  usage = usageFor('ok'),
  maxRounds = 3,
  shuttingDown = false,
  conflict = null,
  facts = {},
  ...overrides
} = {}) {
  return new TaskRework({
    usage,
    maxRounds,
    isShuttingDown: () => shuttingDown,
    runtimeFacts: () => ({live: true, closing: false, ...facts}),
    workspaceConflict: () => conflict,
    directory: () => 'unused',
    ...overrides,
  });
}

const CASES = [
  {
    name: 'a live finished round may rework with inherited limits',
    expect: {allowed: true, maxTokens: 1024, effort: 'high'},
  },
  {
    name: 'an explicit budget and effort replace the inherited values',
    request: {prompt: 'next', maxTokens: 4096, effort: 'max'},
    expect: {allowed: true, maxTokens: 4096, effort: 'max'},
  },
  {
    name: 'a running task is refused',
    task: {status: 'running'},
    expect: {allowed: false, reason: /Task is running/},
  },
  {
    name: 'a stopping task waits for exit confirmation',
    task: {status: 'stopping'},
    expect: {allowed: false, reason: /Task is stopping; wait for runtime exit confirmation/},
  },
  {
    name: 'a closing runtime is named explicitly',
    task: {status: 'stopping'},
    facts: {closing: true},
    expect: {
      allowed: false,
      reason: /Task is stopping; runtime is closing; wait for exit confirmation/,
    },
  },
  {
    name: 'a closed task is refused',
    task: {status: 'closed'},
    expect: {allowed: false, reason: /Task is closed/},
  },
  {
    name: 'an accepted task is refused',
    task: {status: 'accepted'},
    expect: {allowed: false, reason: /Task is accepted/},
  },
  {
    name: 'a missing runtime cannot resume the DSH session',
    facts: {live: false},
    expect: {allowed: false, reason: /Original runtime is gone.*session-1/},
  },
  {
    name: 'an untrusted retained handle reports its own reason',
    facts: {unreworkableReason: 'Runtime ACK timeout; the old session is untrusted'},
    expect: {allowed: false, reason: /Runtime ACK timeout/},
  },
  {
    name: 'the round ceiling is checked before the runtime',
    task: {rounds: [{number: 1}, {number: 2}, {number: 3}]},
    facts: {live: false},
    expect: {allowed: false, reason: /Maximum 3 rounds reached/},
  },
  {
    name: 'a workspace held by another live task is refused',
    conflict: {id: 'task-other'},
    expect: {allowed: false, reason: /Workspace overlaps another task \(task-other\)/},
  },
  {
    name: 'shutdown wins over every other reason',
    task: {status: 'closed'},
    shuttingDown: true,
    expect: {allowed: false, reason: /Manager is shutting down; rework is refused/},
  },
  {
    name: 'a warning limit still allows rework',
    limitState: 'warning',
    expect: {allowed: true, maxTokens: 1024, effort: 'high'},
  },
  {
    name: 'a blocked limit refuses without an override',
    limitState: 'blocked',
    expect: {allowed: false, reason: /Cumulative usage limit reached.*overrideLimits:true/},
  },
  {
    name: 'an override passes a blocked limit and records its event',
    limitState: 'blocked',
    request: {
      prompt: 'next',
      overrideLimits: true,
      overrideReason: 'operator approval',
      usageLimits: {blockRequests: 9},
    },
    expect: {
      allowed: true,
      maxTokens: 1024,
      effort: 'high',
      overridden: true,
      usageLimits: {blockRequests: 9},
    },
  },
  {
    name: 'an override cannot bypass a lifecycle refusal',
    task: {status: 'closed'},
    limitState: 'blocked',
    request: {
      prompt: 'next',
      overrideLimits: true,
      overrideReason: 'operator approval',
    },
    expect: {allowed: false, reason: /Task is closed/},
  },
];

for (const row of CASES) {
  test(`rework decision: ${row.name}`, () => {
    const task = baseTask(row.task);
    const usage = usageFor(row.limitState ?? 'ok');
    const rework = reworkWith({
      usage,
      maxRounds: 3,
      shuttingDown: row.shuttingDown ?? false,
      conflict: row.conflict ?? null,
      facts: row.facts ?? {},
    });

    const decision = rework.decide(task, row.request ?? {prompt: 'next'});

    assert.equal(decision.allowed, row.expect.allowed);
    if (!row.expect.allowed) {
      assert.match(decision.reason, row.expect.reason);
      assert.equal(task.lastLimitOverride, undefined);
      assert.equal(task.usageLimits, undefined);
      return;
    }
    assert.equal(decision.reason, null);
    assert.equal(decision.maxTokens, row.expect.maxTokens);
    assert.equal(decision.effort, row.expect.effort);
    assert.equal(decision.task, task, 'the decision never replaces the input record');
    if (row.expect.overridden) {
      assert.equal(decision.record.usageLimits.blockRequests, row.expect.usageLimits.blockRequests);
      assert.equal(decision.record.lastLimitOverride.at, '2026-10-29T00:00:00.000Z');
      assert.equal(decision.record.lastLimitOverride.reason, 'operator approval');
      assert.equal(decision.event.kind, 'limit_override');
      assert.equal(decision.event.at, undefined, 'the journal owns the event stamp');
      assert.equal(decision.event.overrideAt, undefined);
    } else {
      assert.deepEqual(decision.record, {});
      assert.equal(decision.event, null);
    }
  });
}

test('status refusal and rework refusal share the blocked limit text', () => {
  const task = baseTask();
  const usage = usageFor('blocked');
  const rework = reworkWith({usage});

  const statusReason = rework.blockedReason(task, usage.status(task, 'unused').usage);
  const decision = rework.decide(task, {prompt: 'next'});

  assert.equal(decision.allowed, false);
  assert.equal(statusReason, decision.reason);
});

test('rework validates request fields before reading metrics or mutating the task', () => {
  const calls = [];
  const usage = new UsageModule({
    configuration: LIMITS,
    operations: {
      usageForTask() {
        calls.push('metrics');
        return snapshotFor('ok', LIMITS);
      },
    },
  });
  const rework = reworkWith({usage});
  const task = baseTask();

  assert.throws(() => rework.decide(null), /Unknown task/);
  assert.throws(() => rework.decide(task, []), /Arguments must be an object/);
  assert.throws(() => rework.decide(task, {prompt: '   '}), /Nonempty prompt/);
  assert.throws(() => rework.decide(task, {prompt: 'next', maxTokens: 0}), /maxTokens/);
  assert.throws(() => rework.decide(task, {prompt: 'next', effort: 'low'}), /effort must be one of high, max/);
  assert.deepEqual(calls, []);
  assert.equal(task.lastLimitOverride, undefined);
});

test('an unsupported provider refuses an explicit effort', () => {
  const rework = reworkWith({providerSupportsEffort: () => false});
  assert.throws(
    () => rework.decide(baseTask(), {prompt: 'next', effort: 'max'}),
    /effort is not supported by provider "test" \(dsh-sdk\)/,
  );
});

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.new`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

test('a prepareRun gate failure leaves the task record and journal unchanged', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-rework-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const taskDirectory = path.join(root, 'runs', 'task-0123456789ab');
  const repository = new TaskRepository({runsDir: path.join(root, 'runs'), atomicJson});
  fs.mkdirSync(taskDirectory, {recursive: true});
  const saved = repository.commit(baseTask({
    rounds: [{roundId: 'round-1', number: 1}],
  }));
  const recordBefore = fs.readFileSync(path.join(taskDirectory, 'task.json'), 'utf8');

  const transaction = new TaskTransaction({
    runtime: {
      get: () => ({phase: 'busy'}),
      waitForRelease: async () => false,
      createRoundId: () => 'round-2',
    },
    repository,
    save: task => repository.commit(task),
  });

  await assert.rejects(
    transaction.prepareRun(saved.id, {
      prompt: 'next',
      maxTokens: 2048,
      configure: value => {
        value.usageLimits = {enabled: true, blockRequests: 9};
        value.lastLimitOverride = {at: '2026-10-29T00:00:00.000Z', reason: 'override'};
      },
      events: [{kind: 'limit_override', reason: 'override'}],
    }),
    /previous runtime exited before releasing its round/,
  );

  assert.equal(fs.readFileSync(path.join(taskDirectory, 'task.json'), 'utf8'), recordBefore);
  assert.equal(fs.existsSync(path.join(taskDirectory, 'events.jsonl')), false);
});

/** Worker that acknowledges, completes, and exits on close. */
function fakeFork() {
  return createFakeWorker({pid: 4646});
}

async function settled(manager, id) {
  for (let i = 0; i < 300; i += 1) {
    const status = await manager.action('status', {id});
    if (status.status !== 'running' && status.status !== 'stopping') return status;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task did not settle');
}

test('status summary shows the exact refusal the rework action raises', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-rework-ws-'));
  t.after(() => fs.rmSync(workspace, {recursive: true, force: true}));
  const manager = createManager({forkWorker: fakeFork});
  try {
    const created = await manager.action('create', {workspace, prompt: 'work'});
    const review = await settled(manager, created.id);
    assert.equal(review.status, 'awaiting_review');
    assert.equal(review.canRework, true);
    assert.equal(review.reworkBlockedReason, null);

    await manager.action('close', {id: created.id});
    const closed = await manager.action('status', {id: created.id});
    assert.equal(closed.status, 'closed');
    assert.equal(closed.canRework, false);
    assert.match(closed.reworkBlockedReason, /Task is closed; create a new task for follow-up work/);

    await assert.rejects(
      manager.action('rework', {id: created.id, prompt: 'next'}),
      error => error.message === closed.reworkBlockedReason,
    );
  } finally {
    await manager.shutdown();
  }
});
