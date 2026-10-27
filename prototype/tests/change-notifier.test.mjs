import test from 'node:test';
import assert from 'node:assert/strict';
import {ChangeNotifier} from '../../src/tasks/change-notifier.mjs';

test('ChangeNotifier wakes a waiter when any watched key changes', async () => {
  const changes = new ChangeNotifier();
  const waiting = changes.wait(['task-a', 'task-b'], 1000);
  assert.equal(changes.waiterCount('task-a'), 1);
  changes.touch('task-b');
  assert.equal(await waiting, true);
  assert.equal(changes.waiterCount('task-a'), 0);
  assert.equal(changes.waiterCount('task-b'), 0);
});

test('ChangeNotifier returns false at its timeout without leaking listeners', async () => {
  const changes = new ChangeNotifier();
  assert.equal(await changes.wait(['task-a'], 10), false);
  assert.equal(changes.waiterCount('task-a'), 0);
});

test('ChangeNotifier rejects a changed key before registration is observed', async () => {
  const changes = new ChangeNotifier();
  const waiting = changes.wait(['task-a'], 1000);
  queueMicrotask(() => changes.touch('task-a'));
  assert.equal(await waiting, true);
});
