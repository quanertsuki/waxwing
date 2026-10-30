// Rework after the Worker exited: a provider that keeps its conversation in a
// file may continue in a freshly spawned Worker once the old process is proven
// gone and trusted. Everything else keeps refusing with a specific reason, and
// the status summary shows exactly the message the rework action raises.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFakeWorker} from './fake-worker.mjs';
import {REAL_ROOT, TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {runtimeContext} from '../common.mjs';
import {conversationFileFor} from '../../src/providers/conversation.mjs';

const ROOT = runtimeContext().root;
const config = {...runtimeContext().config};
const samePath = (a, b) => {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};
if (samePath(ROOT, REAL_ROOT)) throw new Error(`rework-respawn tests refused live root ${ROOT}`);
if (!samePath(ROOT, TEST_ROOT)) throw new Error(`rework-respawn tests refused non-isolated root ${ROOT}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(HERE, '.tmp', `rework-respawn-${process.pid}`);
fs.rmSync(base, {recursive: true, force: true});
fs.mkdirSync(base, {recursive: true});

const managers = [];
after(() => Promise.allSettled(managers.map(manager => manager.shutdown())));

function manage(options = {}) {
  const manager = createManager({...options, config: options.config ?? config});
  managers.push(manager);
  return manager;
}

let counter = 0;
const newWorkspace = () => {
  const dir = path.join(base, `ws-${++counter}`);
  fs.mkdirSync(dir, {recursive: true});
  return dir;
};

/**
 * One fake Worker per spawn. `[exit]` finishes the round and then exits,
 * `[hold]` stays busy, `[no-ack]` never acknowledges and exits after the ACK
 * timeout has fired. A file-continuity run appends to its conversation file.
 */
function workerFactory(sightings) {
  let pid = 5200;
  return function forkWorker() {
    return createFakeWorker({
      pid: pid++,
      onRun: ({message, worker, reply}) => {
        const roundId = message.roundId;
        const file = message.conversationFile ?? null;
        sightings.push({
          taskId: message.task.id,
          conversationFile: file,
          existedAtDispatch: file ? fs.existsSync(file) : null,
        });
        reply.ready({roundId, ownerMarker: message.ownerMarker});
        if (message.prompt.includes('[no-ack]')) {
          setTimeout(() => worker.exit(0), 120);
          return;
        }
        reply.ack(roundId);
        if (message.prompt.includes('[hold]')) return;
        if (file) {
          fs.mkdirSync(path.dirname(file), {recursive: true});
          fs.appendFileSync(file, `${JSON.stringify({prompt: message.prompt})}\n`);
        }
        setImmediate(() => {
          reply.result(roundId, {text: 'done'});
          reply.release(roundId);
          if (message.prompt.includes('[exit]')) setImmediate(() => worker.exit(0));
        });
      },
    });
  };
}

const createTask = (manager, extra = {}) => manager.action('create', {
  workspace: extra.workspace ?? newWorkspace(),
  prompt: 'work',
  plan: 'p',
  criteria: 'c',
  ...extra,
});

async function waitFor(predicate, label) {
  for (let i = 0; i < 400; i += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Wait until the task left running/stopping and, optionally, its Worker exited. */
function settled(manager, id, {live = null} = {}) {
  return waitFor(async () => {
    const task = await manager.action('status', {id});
    const quiet = task.status !== 'running' && task.status !== 'stopping';
    if (quiet && (live === null || task.live === live)) return task;
    return null;
  }, `task ${id} to settle`);
}

const readRecord = directory => JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'));
const readRuntime = directory => JSON.parse(fs.readFileSync(path.join(directory, 'runtime.json'), 'utf8'));
const readEvents = directory => fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const roundsOf = (sightings, id) => sightings.filter(entry => entry.taskId === id);

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', windowsHide: true}).trim();
}

test('a file-continuity task reworks in a new Worker after its Worker exited', async () => {
  const sightings = [];
  const manager = manage({forkWorker: workerFactory(sightings)});

  const created = await createTask(manager, {provider: 'magpie', prompt: 'work [exit]'});
  const stopped = await settled(manager, created.id, {live: false});
  assert.equal(stopped.status, 'awaiting_review');
  assert.equal(stopped.reworkBlockedReason, null);
  assert.equal(stopped.canRework, true);

  const file = conversationFileFor(stopped.dataDirectory);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.equal(roundsOf(sightings, created.id).length, 1);

  await manager.action('rework', {id: created.id, prompt: 'again'});
  const finished = await settled(manager, created.id);
  assert.equal(finished.status, 'awaiting_review');

  const rounds = roundsOf(sightings, created.id);
  assert.equal(rounds.length, 2, 'the rework spawned a second Worker');
  assert.equal(rounds[1].conversationFile, file, 'the run message names the same conversation file');
  assert.equal(rounds[1].existedAtDispatch, true, 'the new Worker starts from the stored conversation');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.ok(
    readEvents(stopped.dataDirectory).some(event => event.kind === 'runtime_respawned'),
    'the journal records that this round continues in a new Worker',
  );
});

test('a restart proves the old process dead through runtime.json and identity', async () => {
  const sightings = [];
  const first = manage({forkWorker: workerFactory(sightings)});
  const created = await createTask(first, {provider: 'magpie', prompt: 'work [exit]'});
  const stopped = await settled(first, created.id, {live: false});

  const runtime = readRuntime(stopped.dataDirectory);
  assert.ok(Number.isSafeInteger(runtime.pid));
  assert.equal(runtime.phase, 'exited');

  const restarted = [];
  const second = manage({
    forkWorker: workerFactory(restarted),
    verifyRuntimeIdentity: () => ({verified: false, alive: false, reason: 'recorded PID is not running'}),
  });
  second.restore();
  const status = await second.action('status', {id: created.id});
  assert.equal(status.live, false);
  assert.equal(status.reworkBlockedReason, null);

  await second.action('rework', {id: created.id, prompt: 'after restart'});
  const finished = await settled(second, created.id);
  assert.equal(finished.status, 'awaiting_review');

  const rounds = roundsOf(restarted, created.id);
  assert.equal(rounds.length, 1, 'the restarted manager spawned one Worker');
  assert.equal(rounds[0].conversationFile, conversationFileFor(finished.dataDirectory));
  assert.equal(rounds[0].existedAtDispatch, true);
});

test('an alive or unverifiable old runtime refuses with that exact reason', async () => {
  const sightings = [];
  const first = manage({forkWorker: workerFactory(sightings)});
  const created = await createTask(first, {provider: 'magpie', prompt: 'work [exit]'});
  const stopped = await settled(first, created.id, {live: false});

  const aliveSightings = [];
  const alive = manage({
    forkWorker: workerFactory(aliveSightings),
    verifyRuntimeIdentity: () => ({verified: true, alive: true, actual: {pid: 9999}, reason: 'match'}),
  });
  alive.restore();
  const aliveStatus = await alive.action('status', {id: created.id});
  assert.match(aliveStatus.reworkBlockedReason, /original runtime is still running \(PID 9999\)/);
  await assert.rejects(
    () => alive.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === aliveStatus.reworkBlockedReason,
  );
  assert.equal(roundsOf(aliveSightings, created.id).length, 0);

  const unverified = manage({
    forkWorker: workerFactory([]),
    verifyRuntimeIdentity: () => ({verified: false, alive: true, actual: {pid: 9999}, reason: 'command line unreadable'}),
  });
  unverified.restore();
  const unverifiedStatus = await unverified.action('status', {id: created.id});
  assert.match(unverifiedStatus.reworkBlockedReason, /could not be verified/);
  await assert.rejects(
    () => unverified.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === unverifiedStatus.reworkBlockedReason,
  );

  // The old handle still belongs to the first manager; forget it through a
  // close so the task does not linger in the suite's shared data root.
  await alive.action('close', {id: created.id});
  assert.equal(readRecord(stopped.dataDirectory).status, 'closed');
});

test('a missing runtime record cannot prove the old process exited', async () => {
  const sightings = [];
  const first = manage({forkWorker: workerFactory(sightings)});
  const created = await createTask(first, {provider: 'magpie', prompt: 'work [exit]'});
  const stopped = await settled(first, created.id, {live: false});
  fs.rmSync(path.join(stopped.dataDirectory, 'runtime.json'));

  const restarted = manage({
    forkWorker: workerFactory([]),
    verifyRuntimeIdentity: () => {
      throw new Error('identity must not be inspected without a runtime record');
    },
  });
  restarted.restore();
  const status = await restarted.action('status', {id: created.id});
  assert.match(status.reworkBlockedReason, /Cannot confirm the original runtime exited/);
  await assert.rejects(
    () => restarted.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === status.reworkBlockedReason,
  );
});

test('a restart that found an unverified residual process keeps refusing', async () => {
  const sightings = [];
  const first = manage({forkWorker: workerFactory(sightings)});
  const created = await createTask(first, {provider: 'magpie', prompt: 'work [hold]'});
  assert.equal((await first.action('status', {id: created.id})).status, 'running');

  const restarted = manage({
    forkWorker: workerFactory([]),
    verifyRuntimeIdentity: () => ({verified: false, alive: true, actual: {pid: 6100}, reason: 'command line unreadable'}),
  });
  restarted.restore();
  const status = await restarted.action('status', {id: created.id});
  assert.equal(status.status, 'failed');
  assert.equal(status.manualActionRequired, true);
  assert.match(status.reworkBlockedReason, /old runtime is unverified \(PID \d+\)/);
  await assert.rejects(
    () => restarted.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === status.reworkBlockedReason,
  );

  await first.action('close', {id: created.id});
});

test('an untrusted runtime stays refused after its process exits', async () => {
  const sightings = [];
  const manager = manage({
    forkWorker: workerFactory(sightings),
    config: {...config, ackTimeoutSeconds: 0.02},
  });
  const created = await createTask(manager, {provider: 'magpie', prompt: 'work [no-ack]'});
  const failed = await settled(manager, created.id, {live: false});
  assert.equal(failed.status, 'failed');
  assert.match(failed.reworkBlockedReason, /did not acknowledge round/);
  assert.match(readRuntime(failed.dataDirectory).unreworkableReason, /did not acknowledge round/);

  await assert.rejects(
    () => manager.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === failed.reworkBlockedReason,
  );

  const restarted = manage({
    forkWorker: workerFactory([]),
    verifyRuntimeIdentity: () => ({verified: false, alive: false, reason: 'recorded PID is not running'}),
  });
  restarted.restore();
  const afterRestart = await restarted.action('status', {id: created.id});
  assert.match(afterRestart.reworkBlockedReason, /did not acknowledge round/);
  await assert.rejects(
    () => restarted.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === afterRestart.reworkBlockedReason,
  );
});

test('a workspace taken by another live task is still refused', async () => {
  const sightings = [];
  const manager = manage({forkWorker: workerFactory(sightings)});
  const workspace = newWorkspace();

  const first = await createTask(manager, {provider: 'magpie', workspace, prompt: 'work [exit]'});
  await settled(manager, first.id, {live: false});
  const second = await createTask(manager, {provider: 'magpie', workspace, prompt: 'work [hold]'});
  assert.equal((await manager.action('status', {id: second.id})).status, 'running');

  const blocked = await manager.action('status', {id: first.id});
  assert.match(blocked.reworkBlockedReason, /Workspace overlaps another task/);
  await assert.rejects(
    () => manager.action('rework', {id: first.id, prompt: 'again'}),
    error => error.message === blocked.reworkBlockedReason,
  );

  await manager.action('close', {id: second.id});
  await manager.action('close', {id: first.id});
});

test('a removed or repurposed worktree refuses rework', async () => {
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, {recursive: true});
  git(repo, ['init']);
  fs.writeFileSync(path.join(repo, 'readme.md'), 'x\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'init']);

  const sightings = [];
  const manager = manage({
    forkWorker: workerFactory(sightings),
    config: {...config, workspaceMode: 'worktree'},
  });

  const removed = await createTask(manager, {provider: 'magpie', workspace: repo, prompt: 'work [exit]'});
  await settled(manager, removed.id, {live: false});
  const removedLease = readRecord(removed.dataDirectory).workspaceLease;
  assert.ok(fs.existsSync(removedLease.worktreePath));
  git(repo, ['worktree', 'remove', '--force', removedLease.worktreePath]);

  const gone = await manager.action('status', {id: removed.id});
  assert.match(gone.reworkBlockedReason, /worktree is gone/);
  await assert.rejects(
    () => manager.action('rework', {id: removed.id, prompt: 'again'}),
    error => error.message === gone.reworkBlockedReason,
  );

  const repurposed = await createTask(manager, {provider: 'magpie', workspace: repo, prompt: 'work [exit]'});
  await settled(manager, repurposed.id, {live: false});
  const lease = readRecord(repurposed.dataDirectory).workspaceLease;
  git(lease.worktreePath, ['checkout', '-b', 'manual-branch']);

  const moved = await manager.action('status', {id: repurposed.id});
  assert.match(moved.reworkBlockedReason, /on branch manual-branch instead of waxwing\//);
  await assert.rejects(
    () => manager.action('rework', {id: repurposed.id, prompt: 'again'}),
    error => error.message === moved.reworkBlockedReason,
  );
});

test('a process-continuity provider keeps the original refusal', async () => {
  const sightings = [];
  const manager = manage({forkWorker: workerFactory(sightings)});
  const created = await createTask(manager, {provider: 'deepseek-flash', prompt: 'work [exit]'});
  const stopped = await settled(manager, created.id, {live: false});

  assert.match(
    stopped.reworkBlockedReason,
    /Original runtime is gone; this DSH cannot resume sessionId .*create a new task/,
  );
  await assert.rejects(
    () => manager.action('rework', {id: created.id, prompt: 'again'}),
    error => error.message === stopped.reworkBlockedReason,
  );
  assert.equal(roundsOf(sightings, created.id).length, 1);
  assert.equal(roundsOf(sightings, created.id)[0].conversationFile, null);
});
