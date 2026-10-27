import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskLifecycle, transition} from '../../src/tasks/lifecycle.mjs';

const TASK = Object.freeze({
  id: 'task-0123456789ab',
  schemaVersion: 2,
  status: 'created',
});

test('TaskLifecycle exposes the legal action set for every status', () => {
  const expected = {
    created: ['run', 'begin_stop', 'stop', 'close'],
    running: ['finish', 'fail', 'begin_stop'],
    stopping: ['stop', 'close'],
    awaiting_review: ['run', 'begin_stop', 'accept', 'stop', 'close'],
    failed: ['run', 'begin_stop', 'stop', 'close'],
    cancelled: ['run', 'begin_stop', 'stop', 'close'],
    accepted: ['begin_stop', 'stop', 'close'],
    closed: ['delete'],
    deleted: [],
  };
  const actions = ['run', 'finish', 'fail', 'begin_stop', 'accept', 'stop', 'close', 'delete'];
  for (const [status, allowed] of Object.entries(expected)) {
    const task = {...TASK, status};
    assert.deepEqual(actions.filter(action => TaskLifecycle.can(task, action)), allowed, status);
  }
  assert.deepEqual(
    ['created', 'running', 'awaiting_review', 'failed', 'cancelled', 'accepted'].map(status =>
      TaskLifecycle.assertStop({...TASK, status}, 'close')?.status),
    ['created', 'running', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  );
  assert.throws(() => TaskLifecycle.assertStop({...TASK, status: 'closed'}, 'close'),
    /Cannot close task in closed/);
});

test('transition returns a new record with the next status and schema version', () => {
  const before = {...TASK, updatedAt: '2020-01-01T00:00:00.000Z'};
  const after = transition(before, 'run');
  assert.notEqual(after, before);
  assert.equal(after.status, 'running');
  assert.equal(after.schemaVersion, 2);
  assert.notEqual(after.updatedAt, before.updatedAt);
  assert.equal(before.status, 'created', 'transition must not mutate the source record');
});

test('transition rejects illegal actions without changing the source', () => {
  const before = {...TASK, status: 'closed'};
  assert.equal(TaskLifecycle.can(before, 'run'), false);
  assert.throws(() => transition(before, 'run'), /Cannot run task in closed/);
  assert.deepEqual(before, {...TASK, status: 'closed'});
  assert.throws(() => transition({}, 'unknown'), /Cannot unknown task in unknown/);
});

test('an older schema record is upgraded to schema version 2 on any legal transition', () => {
  const after = transition({...TASK, schemaVersion: 1, status: 'running'}, 'finish');
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.status, 'awaiting_review');
});

test('begin_stop records the stopping state without allowing a second begin', () => {
  const stopping = transition({...TASK, status: 'running'}, 'begin_stop');
  assert.equal(stopping.status, 'stopping');
  assert.equal(TaskLifecycle.can(stopping, 'begin_stop'), false);
  assert.throws(() => transition(stopping, 'begin_stop'), /Cannot begin_stop task in stopping/);
  assert.equal(transition(stopping, 'close').status, 'closed');
});
