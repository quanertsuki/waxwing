import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blockReason,
  completeLimits,
  decideRework,
  effectiveLimits,
  evaluateLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
} from '../../src/usage/policy.mjs';

const limits = {
  enabled: true,
  warnCostCny: 3,
  blockCostCny: 5,
  warnRequests: 100,
  blockRequests: 160,
};

test('limits default to disabled and preserve global/task inheritance', () => {
  assert.deepEqual(effectiveLimits(undefined, {...limits, enabled: false}), {
    ...limits,
    enabled: false,
  });
  assert.deepEqual(effectiveLimits({enabled: true, blockRequests: 200}, limits), {
    ...limits,
    enabled: true,
    blockRequests: 200,
  });
  assert.deepEqual(mergeLimits({warnRequests: 10}, limits), {...limits, warnRequests: 10});
  assert.equal(mergeLimits(undefined, limits), null);
  assert.throws(() => completeLimits({...limits, warnCostCny: 5}), /less than/);
  assert.throws(() => mergeLimits({unknown: 1}, limits), /not a supported field/);
});

test('the policy matrix covers disabled, unavailable, ok, warning, and blocked', () => {
  const disabled = evaluateLimits({
    available: false,
    requests: 0,
    requestsWithoutUsage: 0,
    estimatedCostCny: null,
    costComplete: false,
  }, {...limits, enabled: false});
  assert.deepEqual(disabled, {
    internalRequests: 0,
    limits: {...limits, enabled: false},
    costLimitReliable: false,
    limitState: 'disabled',
    limitWarning: false,
    limitBlocked: false,
    limitsEvaluated: false,
    message: null,
  });

  const unavailable = evaluateLimits({
    available: false,
    requests: 0,
    requestsWithoutUsage: 0,
    estimatedCostCny: null,
    costComplete: false,
  }, limits);
  assert.equal(unavailable.limitState, 'unavailable');
  assert.equal(unavailable.limitWarning, true);
  assert.equal(unavailable.limitBlocked, false);
  assert.equal(unavailable.limitsEvaluated, false);
  assert.match(unavailable.message, /not blocked/i);

  const ok = evaluateLimits({
    available: true,
    requests: 1,
    requestsWithoutUsage: 0,
    estimatedCostCny: 1,
    costComplete: true,
  }, limits);
  assert.equal(ok.limitState, 'ok');
  assert.equal(ok.internalRequests, 1);

  const warning = evaluateLimits({
    available: true,
    requests: 99,
    requestsWithoutUsage: 1,
    estimatedCostCny: 1,
    costComplete: true,
  }, limits);
  assert.equal(warning.limitState, 'warning');
  assert.equal(warning.limitWarning, true);
  assert.equal(warning.internalRequests, 100);

  const blocked = evaluateLimits({
    available: true,
    requests: 159,
    requestsWithoutUsage: 1,
    estimatedCostCny: 1,
    costComplete: true,
  }, limits);
  assert.equal(blocked.limitState, 'blocked');
  assert.equal(blocked.limitBlocked, true);
  assert.equal(blocked.internalRequests, 160);
});

test('unreliable cost cannot warn or block while the request total still can', () => {
  const incomplete = evaluateLimits({
    available: true,
    requests: 1,
    requestsWithoutUsage: 0,
    estimatedCostCny: 999,
    costComplete: false,
  }, limits);
  assert.equal(incomplete.limitState, 'ok');
  assert.equal(incomplete.costLimitReliable, false);

  const requestBlocked = evaluateLimits({
    available: true,
    requests: 160,
    requestsWithoutUsage: 0,
    estimatedCostCny: null,
    costComplete: false,
  }, limits);
  assert.equal(requestBlocked.limitState, 'blocked');
  assert.equal(requestBlocked.costLimitReliable, false);
});

test('override parsing is strict, bounded, and requires a reason', () => {
  assert.deepEqual(parseOverride({}), {enabled: false, reason: null});
  assert.deepEqual(parseOverride({overrideLimits: true, overrideReason: 'one round'}),
    {enabled: true, reason: 'one round'});
  assert.throws(() => parseOverride({overrideLimits: 'true'}), /boolean/);
  assert.throws(() => parseOverride({overrideLimits: true}), /nonempty/);
  assert.throws(() => parseOverride({overrideLimits: true, overrideReason: 'x'.repeat(1001)}), /1000/);
});

test('rework decisions preserve base refusals and override only one blocked limit', () => {
  const blockedUsage = {
    limitState: 'blocked',
    internalRequests: 160,
    estimatedCostCny: 1,
    costLimitReliable: true,
    limits,
  };
  assert.deepEqual(decideRework({
    baseBlockedReason: 'running',
    usage: blockedUsage,
    override: {enabled: true},
  }), {
    allowed: false,
    reason: 'running',
    usageBlocked: false,
    overridden: false,
  });
  assert.equal(decideRework({usage: blockedUsage}).allowed, false);
  assert.equal(decideRework({usage: blockedUsage}).usageBlocked, true);
  assert.equal(decideRework({usage: blockedUsage, override: {enabled: true}}).overridden, true);
  assert.equal(decideRework({usage: {...blockedUsage, limitState: 'warning'}}).allowed, true);
  assert.match(blockReason(blockedUsage), /overrideLimits/);
});

test('override event is a detached snapshot of usage and limits', () => {
  const usage = {
    limitState: 'blocked',
    internalRequests: 160,
    estimatedCostCny: 5.1,
    costLimitReliable: true,
  };
  const event = overrideEvent({
    at: '2026-10-27T00:00:00.000Z',
    reason: 'operator approved one round',
    usage,
    before: limits,
    after: limits,
  });
  assert.deepEqual(event.usage, {
    internalRequests: 160,
    estimatedCostCny: 5.1,
    costLimitReliable: true,
    limitState: 'blocked',
  });
  assert.notEqual(event.limitsBefore, limits);
  assert.deepEqual(event.limitsBefore, limits);
});
