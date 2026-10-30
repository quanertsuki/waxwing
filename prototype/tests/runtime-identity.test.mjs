// Runtime recovery must never terminate a process based only on a reused PID.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {
  killOwnedRuntime,
  terminateVerifiedRuntime,
  verifyOwnedRuntime,
} from '../../src/runtime/identity.mjs';

test('a live PID without the expected task and owner marker is not trusted', () => {
  const identity = verifyOwnedRuntime({
    pid: process.pid,
    taskId: 'task-0123456789ab',
    ownerMarker: `missing-${randomUUID()}`,
  }, {
    inspect: pid => ({pid, commandLine: 'node unrelated.mjs'}),
  });
  assert.equal(identity.alive, true);
  assert.equal(identity.verified, false);
  assert.match(identity.reason, /does not match/i);
});

test('a live PID that cannot be inspected stays unverified and is not terminated', () => {
  let terminated = false;
  const identity = terminateVerifiedRuntime({
    pid: process.pid,
    taskId: 'task-0123456789ab',
    ownerMarker: randomUUID(),
  }, {
    inspect: pid => ({pid, commandLine: null, inspectionError: true}),
    terminate: () => { terminated = true; },
  });
  assert.equal(identity.alive, true);
  assert.equal(identity.verified, false);
  assert.match(identity.reason, /could not be verified/i);
  assert.equal(terminated, false);
});

test('an identity that changes before termination is not reported as terminated', () => {
  let terminateCalls = 0;
  const result = terminateVerifiedRuntime({
    pid: process.pid,
    taskId: 'task-0123456789ab',
    ownerMarker: randomUUID(),
  }, {
    identity: {verified: true, alive: true, reason: 'verified when recovery started'},
    inspect: pid => ({pid, commandLine: 'node unrelated.mjs'}),
    terminate: () => { terminateCalls += 1; },
  });

  assert.equal(result.verified, false);
  assert.equal(result.terminated, false);
  assert.equal(terminateCalls, 0);
  assert.match(result.reason, /does not match/i);
});

test('a matching task and owner marker is verified before termination', () => {
  const taskId = 'task-0123456789ab';
  const ownerMarker = randomUUID();
  let terminated = false;
  const commandLine = [
    process.execPath,
    'worker.mjs',
    `--waxwing-task=${taskId}`,
    `--waxwing-owner=${ownerMarker}`,
  ].join(' ');
  const result = terminateVerifiedRuntime({pid: process.pid, taskId, ownerMarker}, {
    inspect: pid => ({pid, commandLine}),
    terminate: () => { terminated = true; },
  });
  assert.equal(result.verified, true);
  assert.equal(result.terminated, true);
  assert.equal(terminated, true);
});

test('an owned handle is killed directly, as a tree on Windows', async () => {
  const spawned = [];
  const spawnProcess = (command, args) => {
    spawned.push([command, ...args]);
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0));
    return child;
  };
  await killOwnedRuntime({pid: 4242, kill: () => assert.fail('Windows must not signal the handle')},
    {platform: 'win32', spawnProcess});
  assert.deepEqual(spawned, [['taskkill', '/PID', '4242', '/T', '/F']]);

  const signals = [];
  await killOwnedRuntime({pid: 4242, kill: signal => signals.push(signal)},
    {platform: 'linux', spawnProcess: () => assert.fail('POSIX must not spawn a killer')});
  assert.deepEqual(signals, ['SIGKILL']);

  await assert.rejects(() => killOwnedRuntime({pid: null}), /no PID/);
});
