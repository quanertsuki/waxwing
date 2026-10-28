import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TaskRepository} from '../../src/tasks/repository.mjs';

const ID = 'task-0123456789ab';
const OTHER = 'task-bbbbbbbbbbbb';

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-restore-'));
}

function repositoryAt(root) {
  return new TaskRepository({
    runsDir: path.join(root, 'runs'),
    atomicJson: (file, value) => {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, JSON.stringify(value));
    },
  });
}

function writeTask(runs, id, task, events = null) {
  const directory = path.join(runs, id);
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  if (events) {
    fs.writeFileSync(
      path.join(directory, 'events.jsonl'),
      events.map(record => JSON.stringify(record)).join('\n'),
    );
  }
  return directory;
}

test('restore migrates legacy leases and rebuilds the event sequence', () => {
  const root = temporaryRoot();
  try {
    const runs = path.join(root, 'runs');
    writeTask(runs, ID, {
      id: ID,
      status: 'closed',
      workspace: 'C:/work/project',
      rounds: [],
    }, [{sequence: 3}, {sequence: 7}]);
    const repository = repositoryAt(root);

    const [task] = repository.restore();
    assert.equal(task.schemaVersion, 2);
    assert.deepEqual(task.workspaceLease, {
      mode: 'legacy',
      status: 'retained',
      sourceWorkspace: 'C:/work/project',
      executionWorkspace: 'C:/work/project',
    });
    assert.equal(task.sourceWorkspace, 'C:/work/project');
    assert.equal(task.eventSequence, 7);
    assert.equal(repository.has(ID), true);
    assert.equal(repository.get(ID), task);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('restore refuses a task whose ID disagrees with its directory', () => {
  const root = temporaryRoot();
  try {
    const runs = path.join(root, 'runs');
    writeTask(runs, ID, {id: OTHER, status: 'closed', workspace: 'C:/work', rounds: []});
    const repository = repositoryAt(root);

    assert.throws(() => repository.restore(), /Task ID mismatch/);
    assert.equal(repository.has(ID), false);
    assert.equal(repository.has(OTHER), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('restore tolerates a missing event file and counts sequence-less lines', () => {
  const root = temporaryRoot();
  try {
    const runs = path.join(root, 'runs');
    writeTask(runs, ID, {id: ID, status: 'closed', workspace: 'C:/work', rounds: []});
    writeTask(runs, OTHER, {id: OTHER, status: 'closed', workspace: 'C:/work', rounds: []},
      [{kind: 'one'}, {kind: 'two'}]);
    const repository = repositoryAt(root);

    const restored = repository.restore();
    assert.equal(restored.find(task => task.id === ID).eventSequence, 0);
    assert.equal(restored.find(task => task.id === OTHER).eventSequence, 2);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('restore returns an empty list when the runs directory does not exist', () => {
  const root = temporaryRoot();
  try {
    assert.deepEqual(repositoryAt(root).restore(), []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});
