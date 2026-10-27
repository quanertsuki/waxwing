import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blockReason,
  completeLimits,
  decideRework,
  effectiveLimits,
  evaluateLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
  unavailableUsageSnapshot,
} from '../../src/usage/policy.mjs';
import {
  DEFAULT_POLICY_FILE,
  ExecutionPolicy,
  digestText,
} from '../../src/usage/execution-policy.mjs';

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

test('an unavailable usage snapshot degrades observability without blocking rework', () => {
  const task = {
    lastLimitOverride: {
      at: '2026-10-27T00:00:00.000Z',
      reason: 'operator approval',
    },
  };
  const snapshot = unavailableUsageSnapshot({
    task,
    reason: 'events.jsonl is a directory',
    limits,
  });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.computed, null);
  assert.deepEqual(snapshot.usageRounds, []);
  assert.deepEqual(snapshot.listUsage, {
    available: false,
    error: 'events.jsonl is a directory',
  });
  assert.deepEqual(snapshot.limits, limits);
  assert.equal(snapshot.statusUsage.available, false);
  assert.equal(snapshot.statusUsage.error, 'events.jsonl is a directory');
  assert.equal(snapshot.statusUsage.limitState, 'unavailable');
  assert.equal(snapshot.statusUsage.limitWarning, true);
  assert.equal(snapshot.statusUsage.limitBlocked, false);
  assert.equal(snapshot.statusUsage.limitsEvaluated, false);
  assert.deepEqual(snapshot.statusUsage.warnings, [
    'Usage data is unavailable: events.jsonl is a directory',
  ]);
  assert.deepEqual(snapshot.statusUsage.limitOverride, {
    at: '2026-10-27T00:00:00.000Z',
    reason: 'operator approval',
  });
  assert.equal(decideRework({usage: snapshot.statusUsage}).allowed, true);

  const disabled = unavailableUsageSnapshot({
    reason: 'metrics unavailable',
    limits: {...limits, enabled: false},
  });
  assert.equal(disabled.statusUsage.limitState, 'disabled');
  assert.equal(disabled.statusUsage.limitWarning, false);
  assert.equal(disabled.statusUsage.limitBlocked, false);
});

test('the execution policy defaults to disabled when configuration is absent or invalid', () => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-policy-'));
  try {
    for (const configuration of [undefined, null, [], 'enabled']) {
      const policy = new ExecutionPolicy({configuration, baseDirectory});
      assert.deepEqual(policy.settings(), {enabled: false, version: null, file: null});
      assert.equal(policy.filePath(), path.join(baseDirectory, DEFAULT_POLICY_FILE));
      assert.deepEqual(policy.round(), {
        meta: {
          enabled: false,
          version: null,
          sha256: null,
          applied: false,
        },
        text: null,
      });
    }
  } finally {
    fs.rmSync(baseDirectory, {recursive: true, force: true});
  }
});

test('execution policy reads versioned text, hashes it, and appends it once', () => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-policy-'));
  const file = path.join(baseDirectory, 'rules.md');
  const policyText = 'Do not delete evidence.';
  try {
    fs.writeFileSync(file, policyText);
    const policy = new ExecutionPolicy({
      configuration: {enabled: true, version: 7, file: 'rules.md'},
      baseDirectory,
    });
    assert.equal(policy.filePath(), file);
    const round = policy.round();
    assert.deepEqual(round, {
      meta: {
        enabled: true,
        version: 7,
        sha256: digestText(policyText),
        applied: true,
      },
      text: policyText,
    });
    const prompt = policy.prompt('Implement it.', round);
    assert.equal(prompt, `Implement it.\n---\n${policyText}`);
    assert.equal(prompt.split(policyText).length - 1, 1);
  } finally {
    fs.rmSync(baseDirectory, {recursive: true, force: true});
  }
});

test('a missing or empty policy file warns but never becomes applied', () => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-policy-'));
  try {
    const missing = new ExecutionPolicy({
      configuration: {enabled: true, version: 1, file: 'missing.md'},
      baseDirectory,
    });
    const missingRound = missing.round();
    assert.equal(missingRound.meta.applied, false);
    assert.equal(missingRound.meta.sha256, null);
    assert.match(missingRound.meta.warning, /unavailable/i);
    assert.equal(missing.prompt('unchanged', missingRound), 'unchanged');

    fs.writeFileSync(path.join(baseDirectory, 'empty.md'), ' \r\n');
    const empty = new ExecutionPolicy({
      configuration: {enabled: true, version: 1, file: 'empty.md'},
      baseDirectory,
    });
    const emptyRound = empty.round();
    assert.equal(emptyRound.meta.applied, false);
    assert.equal(emptyRound.meta.sha256, null);
    assert.match(emptyRound.meta.warning, /empty/i);
    assert.equal(empty.prompt('unchanged', emptyRound), 'unchanged');
  } finally {
    fs.rmSync(baseDirectory, {recursive: true, force: true});
  }
});

test('the report uses the applied round snapshot even after the policy changes', () => {
  const baseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-policy-'));
  const file = path.join(baseDirectory, 'rules.md');
  const appliedText = 'Rule A';
  try {
    fs.writeFileSync(file, appliedText);
    const policy = new ExecutionPolicy({
      configuration: {enabled: true, version: 3, file: 'rules.md'},
      baseDirectory,
    });
    const applied = policy.round();
    const task = {
      rounds: [
        {number: 1, policy: {enabled: true, version: 2, sha256: 'old', applied: true}},
        {number: 2, policy: applied.meta},
      ],
      policySnapshot: {
        version: applied.meta.version,
        sha256: applied.meta.sha256,
        text: applied.text,
      },
    };
    fs.writeFileSync(file, 'Rule B');
    const section = policy.reportSection(task);
    assert.match(section, /Version: 3/);
    assert.match(section, new RegExp(applied.meta.sha256));
    assert.match(section, new RegExp(digestText('Rule B')));
    assert.match(section, /policy changed after the applied round/);
    assert.match(section, /Rule A/);
    assert.doesNotMatch(section, /Rule B/);

    fs.rmSync(file);
    const missing = policy.reportSection(task);
    assert.match(missing, new RegExp(applied.meta.sha256));
    assert.match(missing, /Rule A/);
  } finally {
    fs.rmSync(baseDirectory, {recursive: true, force: true});
  }
});
