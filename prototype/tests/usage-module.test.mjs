import test from 'node:test';
import assert from 'node:assert/strict';
import {UsageModule} from '../../src/usage/module.mjs';
import {UsageService} from '../../src/usage/service.mjs';

const limits = {
  enabled: true,
  warnCostCny: 3,
  blockCostCny: 5,
  warnRequests: 2,
  blockRequests: 3,
};

function snapshot(usage) {
  return {
    statusUsage: {...usage, limits},
    usageRounds: [{number: 1, requests: usage.internalRequests ?? 0}],
    listUsage: {available: true, requests: usage.internalRequests ?? 0},
    computed: {},
  };
}

test('UsageModule composes metrics and limits behind one status/list interface', () => {
  const usage = new UsageModule({
    operations: {usageForTask: () => snapshot({
      available: true,
      internalRequests: 2,
      requests: 2,
      requestsWithoutUsage: 0,
      estimatedCostCny: 1,
      costComplete: true,
      limitState: 'warning',
    })},
  });
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  assert.equal(usage.list(task, 'unused').requests, 2);
  assert.equal(usage.status(task, 'unused').usage.limitState, 'warning');
});

test('UsageModule rejects blocked rework without changing the task', () => {
  const usage = new UsageModule({
    operations: {usageForTask: () => snapshot({
      available: true,
      internalRequests: 3,
      requests: 3,
      estimatedCostCny: 1,
      costComplete: true,
      limitState: 'blocked',
    })},
  });
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  assert.throws(() => usage.decideRework(task, 'unused'), /limit/i);
  assert.equal(task.lastLimitOverride, undefined);
  assert.equal(task.usageLimits, limits);
});

test('UsageModule parses inputs before command validation and metrics', () => {
  const calls = [];
  const usage = new UsageModule({
    configuration: limits,
    operations: {
      usageForTask() {
        calls.push('metrics');
        return snapshot({
          available: true,
          internalRequests: 1,
          requests: 1,
          estimatedCostCny: 1,
          costComplete: true,
          limitState: 'ok',
        });
      },
    },
  });
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  const inputs = usage.reworkInputs(task, {
    usageLimits: {blockRequests: 9},
    overrideLimits: true,
    overrideReason: 'one round',
  });
  assert.equal(inputs.requestedLimits.blockRequests, 9);
  assert.equal(calls.length, 0);
  usage.decideRework(task, 'unused', {
    usageLimits: {blockRequests: 9},
    overrideLimits: true,
    overrideReason: 'one round',
  }, {
    inputs,
    validate: () => calls.push('validate'),
    baseBlockedReason: () => null,
  });
  assert.deepEqual(calls, ['validate', 'metrics']);
});

test('UsageModule turns a blocked override into a detached event and explicit apply', () => {
  const usage = new UsageModule({
    operations: {usageForTask: () => snapshot({
      available: true,
      internalRequests: 3,
      requests: 3,
      estimatedCostCny: 1,
      costComplete: true,
      limitState: 'blocked',
    })},
    configuration: limits,
    now: () => '2026-10-28T00:00:00.000Z',
  });
  const task = {id: 'task-0123456789ab'};
  const decision = usage.decideRework(task, 'unused', {
    overrideLimits: true,
    overrideReason: 'operator approval',
    usageLimits: {blockRequests: 9},
  });
  assert.equal(decision.decision.overridden, true);
  assert.equal(task.lastLimitOverride, undefined);
  assert.equal(decision.event.kind, 'limit_override');
  assert.equal(decision.event.overrideAt, '2026-10-28T00:00:00.000Z');
  assert.equal(decision.requestedLimits.blockRequests, 9);
  usage.applyRework(task, decision);
  assert.equal(task.lastLimitOverride.at, '2026-10-28T00:00:00.000Z');
  assert.equal(task.usageLimits.blockRequests, 9);
});

test('UsageModule never throws for unavailable metrics', () => {
  const usage = new UsageModule({
    operations: {usageForTask: () => { throw new Error('events unavailable'); }},
  });
  const view = usage.view({id: 'task-0123456789ab', model: 'deepseek-flash'}, 'unused');
  assert.equal(view.totals.available, false);
  assert.deepEqual(view.requests, []);
  assert.match(view.totals.warnings[0], /events unavailable/);
});

test('view projects the snapshot it already computed instead of scanning twice', () => {
  const calls = [];
  const result = snapshot({
    available: true,
    internalRequests: 1,
    requests: 1,
    estimatedCostCny: 1,
    costComplete: true,
    limitState: 'ok',
  });
  const usage = new UsageModule({
    configuration: limits,
    operations: {
      usageForTask() {
        calls.push('scan');
        return result;
      },
      usageForView(task, directory, options) {
        calls.push('view');
        assert.equal(task.id, 'task-0123456789ab');
        assert.equal(directory, 'unused');
        assert.equal(options.result, result);
        return {id: task.id, totals: options.result.statusUsage};
      },
    },
  });
  const view = usage.view({id: 'task-0123456789ab', usageLimits: limits}, 'unused');
  assert.deepEqual(calls, ['scan', 'view']);
  assert.equal(view.totals.requests, 1);
});

test('a damaged task limit override falls back to the configured limits', () => {
  const task = {
    id: 'task-0123456789ab',
    usageLimits: {enabled: 'yes'},
  };
  const seen = [];
  const usage = new UsageModule({
    configuration: limits,
    operations: {
      usageForTask(taskValue, directory, options) {
        seen.push({task: taskValue, directory, limits: options.limits});
        return snapshot({
          available: true,
          internalRequests: 1,
          requests: 1,
          estimatedCostCny: 1,
          costComplete: true,
          limitState: 'ok',
        });
      },
      usageForView: taskValue => ({id: taskValue.id}),
    },
  });
  assert.equal(usage.list(task, 'unused').requests, 1);
  assert.equal(usage.status(task, 'unused').usage.available, true);
  assert.deepEqual(usage.view(task, 'unused'), {id: task.id});
  assert.deepEqual(seen.map(call => call.limits), [limits, limits, limits]);
  assert.deepEqual(seen.map(call => call.directory), ['unused', 'unused', 'unused']);
});

test('UsageService delegates to a module and keeps the operations shape', () => {
  const operations = {
    usageForTask: () => snapshot({
      available: true,
      internalRequests: 1,
      requests: 1,
      estimatedCostCny: 1,
      costComplete: true,
      limitState: 'ok',
    }),
    usageForView: task => ({id: task.id, projected: true}),
  };
  const module = new UsageModule({operations, configuration: limits});
  const delegated = new UsageService(module);
  const legacy = new UsageService(operations);
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  for (const facade of [delegated, legacy]) {
    assert.deepEqual(facade.list(task, 'unused'), module.list(task, 'unused'));
    assert.deepEqual(facade.status(task, 'unused'), module.status(task, 'unused'));
    assert.deepEqual(facade.view(task, 'unused'), module.view(task, 'unused'));
  }
});

test('UsageService and UsageModule return the same unavailable projections', () => {
  const operations = {
    usageForTask() {
      throw new Error('events unavailable');
    },
    usageForView() {
      throw new Error('must not be called');
    },
  };
  const module = new UsageModule({operations});
  const service = new UsageService(operations);
  const task = {id: 'task-0123456789ab'};
  assert.deepEqual(service.list(task, 'unused'), module.list(task, 'unused'));
  assert.deepEqual(service.status(task, 'unused'), module.status(task, 'unused'));
  assert.deepEqual(service.view(task, 'unused'), module.view(task, 'unused'));
  assert.equal(service.view(task, 'unused').totals.available, false);
});
