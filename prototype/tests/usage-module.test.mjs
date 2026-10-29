// UsageModule composes metrics and limits: metrics supply tokens and cost, the
// module applies the request limits, and every projection comes from the same
// computed snapshot.
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

const SETTINGS = {limits, providersDir: 'providers', pricingFile: 'pricing.json'};

/** Metrics only: no limit fields; the module evaluates `limits` itself. */
function metrics(requests, extra = {}) {
  return {
    statusUsage: {
      available: true,
      requests,
      requestsWithoutUsage: 0,
      estimatedCostCny: 1,
      costComplete: true,
      warnings: [],
      ...extra,
    },
    usageRounds: [{number: 1, requests}],
    computed: {marker: requests},
  };
}

function moduleWith(requests, extra = {}) {
  return new UsageModule({
    configuration: SETTINGS,
    metrics: {metricsForTask: () => metrics(requests, extra)},
  });
}

test('UsageModule composes metrics and limits behind one status/list interface', () => {
  const usage = moduleWith(2);
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  assert.equal(usage.list(task, 'unused').requests, 2);
  assert.equal(usage.status(task, 'unused').usage.limitState, 'warning');
  assert.equal(usage.list(task, 'unused').limitState, undefined);
});

test('UsageModule rejects blocked rework without changing the task', () => {
  const usage = moduleWith(3);
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  assert.throws(() => usage.decideRework(task, 'unused'), /limit/i);
  assert.equal(task.lastLimitOverride, undefined);
  assert.equal(task.usageLimits, limits);
});

test('UsageModule parses inputs before command validation and metrics', () => {
  const calls = [];
  const usage = new UsageModule({
    configuration: limits,
    metrics: {
      metricsForTask() {
        calls.push('metrics');
        return metrics(1);
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
    configuration: limits,
    metrics: {metricsForTask: () => metrics(3)},
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
  assert.equal(decision.overrideAt, '2026-10-28T00:00:00.000Z');
  assert.equal(decision.event.at, undefined, 'the journal owns the event stamp');
  assert.equal(decision.requestedLimits.blockRequests, 9);
  const reworked = usage.applyRework(task, decision);
  assert.equal(task.lastLimitOverride, undefined, 'applyRework returns a new record');
  assert.equal(reworked.lastLimitOverride.at, '2026-10-28T00:00:00.000Z');
  assert.equal(reworked.usageLimits.blockRequests, 9);
});

test('UsageModule never throws for unavailable metrics', () => {
  const usage = new UsageModule({
    metrics: {
      metricsForTask() {
        throw new Error('events unavailable');
      },
    },
  });
  const view = usage.view({id: 'task-0123456789ab', model: 'deepseek-flash'}, 'unused');
  assert.equal(view.totals.available, false);
  assert.deepEqual(view.requests, []);
  assert.match(view.totals.warnings[0], /events unavailable/);
});

test('view projects the snapshot it already computed instead of scanning twice', () => {
  const calls = [];
  const computed = metrics(1);
  const usage = new UsageModule({
    configuration: limits,
    metrics: {
      metricsForTask() {
        calls.push('scan');
        return computed;
      },
      usageViewFor(_task, value) {
        calls.push('view');
        assert.equal(value, computed.computed);
        return {id: 'task-0123456789ab', totals: {available: true}};
      },
    },
  });
  const view = usage.view({id: 'task-0123456789ab', usageLimits: limits}, 'unused');
  assert.deepEqual(calls, ['scan', 'view']);
  // Totals come from the limit-composed status usage, so status and view agree.
  assert.equal(view.totals.requests, 1);
  assert.equal(view.totals.limitState, 'ok');
});

test('a damaged task limit override falls back to the configured limits', () => {
  const task = {
    id: 'task-0123456789ab',
    usageLimits: {enabled: 'yes'},
  };
  const seen = [];
  const usage = new UsageModule({
    configuration: SETTINGS,
    metrics: {
      metricsForTask(_task, directory, options) {
        seen.push({directory, options});
        return metrics(1);
      },
      usageViewFor: taskValue => ({id: taskValue.id}),
    },
  });
  assert.equal(usage.list(task, 'unused').requests, 1);
  assert.equal(usage.status(task, 'unused').usage.available, true);
  const view = usage.view(task, 'unused');
  assert.equal(view.id, task.id);
  assert.equal(view.totals.requests, 1);
  assert.equal(view.totals.limitState, 'ok');
  assert.deepEqual(seen.map(call => call.directory), ['unused', 'unused', 'unused']);
  for (const call of seen) {
    assert.equal(call.options.pricingFile, 'pricing.json');
    assert.equal(call.options.providersDir, 'providers');
  }
});

test('UsageService delegates to a module and accepts metrics doubles', () => {
  const module = new UsageModule({
    configuration: limits,
    metrics: {
      metricsForTask: () => metrics(1),
      usageViewFor: task => ({id: task.id, projected: true}),
    },
  });
  const delegated = new UsageService(module);
  const legacy = new UsageService({metrics: {
    metricsForTask: () => metrics(1),
    usageViewFor: task => ({id: task.id, projected: true}),
  }});
  const task = {id: 'task-0123456789ab', usageLimits: limits};
  for (const facade of [delegated, legacy]) {
    assert.deepEqual(facade.list(task, 'unused'), module.list(task, 'unused'));
    assert.deepEqual(facade.status(task, 'unused'), module.status(task, 'unused'));
    assert.deepEqual(facade.view(task, 'unused'), module.view(task, 'unused'));
  }
});

test('UsageService and UsageModule return the same unavailable projections', () => {
  const metricsDouble = {
    metricsForTask() {
      throw new Error('events unavailable');
    },
    usageViewFor() {
      throw new Error('must not be called');
    },
  };
  const module = new UsageModule({metrics: metricsDouble});
  const service = new UsageService({metrics: metricsDouble});
  const task = {id: 'task-0123456789ab'};
  assert.deepEqual(service.list(task, 'unused'), module.list(task, 'unused'));
  assert.deepEqual(service.status(task, 'unused'), module.status(task, 'unused'));
  assert.deepEqual(service.view(task, 'unused'), module.view(task, 'unused'));
  assert.equal(service.view(task, 'unused').totals.available, false);
});
