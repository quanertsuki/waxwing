// One write path: task.json first, then the event journal with the next
// sequence. The index is immutable, so every change must be committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskRepository} from '../../src/tasks/repository.mjs';

const TASK_ID = 'task-0123456789ab';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-commit-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.new`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}

function repositoryAt(root) {
  return new TaskRepository({runsDir: path.join(root, 'runs'), atomicJson});
}

function task(extra = {}) {
  return {id: TASK_ID, status: 'running', rounds: [], eventSequence: 0, ...extra};
}

function eventsFile(root) {
  return path.join(root, 'runs', TASK_ID, 'events.jsonl');
}

function eventLines(root) {
  return fs.readFileSync(eventsFile(root), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('the index is a deeply frozen snapshot, not a mutable record', t => {
  const root = temporaryRoot(t);
  const repository = repositoryAt(root);
  fs.mkdirSync(path.join(root, 'runs', TASK_ID), {recursive: true});
  const saved = repository.commit(task({
    workspaceLease: {mode: 'worktree', status: 'active'},
    rounds: [{roundId: 'round-1', number: 1}],
  }));

  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.rounds), true);
  assert.equal(Object.isFrozen(saved.rounds[0]), true);
  assert.equal(Object.isFrozen(saved.workspaceLease), true);
  assert.throws(() => { saved.status = 'failed'; }, /read only/);
  assert.throws(() => { saved.rounds.push({}); }, /read only|not extensible/);
  assert.throws(() => { saved.workspaceLease.status = 'removed'; }, /read only/);
});

test('a failed save appends no event and leaves the index unchanged', t => {
  const root = temporaryRoot(t);
  let fail = true;
  const repository = new TaskRepository({
    runsDir: path.join(root, 'runs'),
    atomicJson: (file, value) => {
      if (fail) throw new Error('disk unavailable');
      atomicJson(file, value);
    },
  });
  assert.throws(
    () => repository.commit(task(), [{kind: 'round_started', roundId: 'round-1'}]),
    /disk unavailable/,
  );
  assert.equal(repository.has(TASK_ID), false);
  assert.equal(fs.existsSync(eventsFile(root)), false);

  fail = false;
  const saved = repository.commit(task(), [{kind: 'round_started', roundId: 'round-1'}]);
  assert.equal(saved.eventSequence, 1);
  assert.deepEqual(eventLines(root).map(event => event.sequence), [1]);
});

test('an append failure keeps the saved record and the next commit continues its sequence', t => {
  const root = temporaryRoot(t);
  const repository = repositoryAt(root);
  const directory = path.join(root, 'runs', TASK_ID);
  fs.mkdirSync(directory, {recursive: true});
  // A directory at the journal path makes the append fail after the save.
  fs.mkdirSync(eventsFile(root));

  assert.throws(
    () => repository.commit(task(), [{kind: 'round_started', roundId: 'round-1'}]),
    /EISDIR|directory/i,
  );
  const saved = repository.get(TASK_ID);
  assert.equal(saved.eventSequence, 1, 'the record is durable');
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8')).eventSequence, 1);

  fs.rmdirSync(eventsFile(root));
  const next = repository.commit(saved, [{kind: 'round_finished', roundId: 'round-1'}]);
  assert.equal(next.eventSequence, 2);
  assert.deepEqual(eventLines(root).map(event => event.sequence), [2], 'no duplicate number');
});

test('restore seeds the sequence from the record so a restart never rewinds', t => {
  const root = temporaryRoot(t);
  const directory = path.join(root, 'runs', TASK_ID);
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task({eventSequence: 5})));
  fs.writeFileSync(
    eventsFile(root),
    `${JSON.stringify({sequence: 5, kind: 'round_released', roundId: 'round-1'})}\n`,
  );

  const repository = repositoryAt(root);
  const [restored] = repository.restore();
  assert.equal(restored.eventSequence, 5);
  const next = repository.commit(restored, [{kind: 'round_started', roundId: 'round-2'}]);
  assert.equal(next.eventSequence, 6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8')).eventSequence, 6);
  assert.deepEqual(eventLines(root).map(event => event.sequence), [5, 6]);
});

test('one commit can append several events in order and stamps the active round', t => {
  const root = temporaryRoot(t);
  const repository = repositoryAt(root);
  fs.mkdirSync(path.join(root, 'runs', TASK_ID), {recursive: true});
  const saved = repository.commit(task({
    rounds: [{roundId: 'round-7', number: 1}],
  }), [
    {kind: 'limit_override', reason: 'operator'},
    {kind: 'round_started', roundId: 'round-7'},
  ]);

  assert.equal(saved.eventSequence, 2);
  assert.equal(saved.lastEventSequence, 2);
  const events = eventLines(root);
  assert.deepEqual(events.map(event => event.kind), ['limit_override', 'round_started']);
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(events.map(event => event.roundId), ['round-7', 'round-7']);
});
