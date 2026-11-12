// Manager side of file-backed continuity: only a provider that declares
// `sessionContinuity: 'file'` receives the task's conversation file, a rework
// keeps it, and a first-round Provider fallback starts a fresh conversation.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
if (samePath(ROOT, REAL_ROOT)) throw new Error(`conversation-flow tests refused live root ${ROOT}`);
if (!samePath(ROOT, TEST_ROOT)) throw new Error(`conversation-flow tests refused non-isolated root ${ROOT}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(HERE, '.tmp', `conversation-flow-${process.pid}`);
fs.rmSync(base, {recursive: true, force: true});
fs.mkdirSync(base, {recursive: true});

const runs = [];
function forkWorker() {
  return createFakeWorker({
    pid: 5100,
    onRun: ({message, reply}) => {
      const roundId = message.roundId;
      const file = message.conversationFile ?? null;
      runs.push({
        taskId: message.task.id,
        provider: message.task.provider?.name,
        conversationFile: file,
        existedAtDispatch: file ? fs.existsSync(file) : null,
      });
      reply.ready({roundId, ownerMarker: message.ownerMarker});
      reply.ack(roundId);
      // Stand in for the adapter: it writes the round to the file before the
      // terminal message, failed rounds included.
      if (file) {
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.appendFileSync(file, `${JSON.stringify({provider: message.task.provider?.name, prompt: message.prompt})}\n`);
      }
      setImmediate(() => {
        if (message.prompt.includes('[fail]')) reply.error(roundId, {error: 'provider failed'});
        else reply.result(roundId, {text: 'done'});
        reply.release(roundId);
      });
    },
  });
}

const manager = createManager({forkWorker, config});
after(() => manager.shutdown());
let counter = 0;
const create = extra => {
  const workspace = path.join(base, `ws-${++counter}`);
  fs.mkdirSync(workspace, {recursive: true});
  return manager.action('create', {workspace, prompt: 'work', plan: 'p', criteria: 'c', ...extra});
};
const runsFor = id => runs.filter(run => run.taskId === id);
async function waitFor(predicate, label) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function settled(id) {
  let task;
  await waitFor(async () => {
    task = await manager.action('status', {id});
    return task.status !== 'running' && task.status !== 'stopping';
  }, `task ${id} to settle`);
  return task;
}

test('only a file-continuity provider receives the conversation file, and rework keeps it', async () => {
  const chat = await create({provider: 'magpie'});
  await settled(chat.id);
  const file = conversationFileFor(chat.dataDirectory);
  assert.equal(runsFor(chat.id)[0].conversationFile, file);
  assert.equal(runsFor(chat.id)[0].existedAtDispatch, false);

  await manager.action('rework', {id: chat.id, prompt: 'again'});
  await settled(chat.id);
  assert.equal(runsFor(chat.id)[1].conversationFile, file);
  assert.equal(runsFor(chat.id)[1].existedAtDispatch, true, 'a rework continues the stored conversation');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);

  const dsh = await create({provider: 'deepseek-flash'});
  await settled(dsh.id);
  assert.equal(runsFor(dsh.id)[0].conversationFile, null);

  await manager.action('close', {id: chat.id});
  await manager.action('close', {id: dsh.id});
});

test('a first-round Provider fallback starts a fresh conversation', async () => {
  const original = config.fallbackProvider;
  config.fallbackProvider = 'magpie';
  try {
    const created = await create({provider: 'rl2-kimi', prompt: '[fail] first'});
    await waitFor(() => runsFor(created.id).length === 2, 'fallback dispatch');
    await settled(created.id);
    const [failed, fallback] = runsFor(created.id);
    assert.equal(failed.provider, 'rl2-kimi');
    assert.equal(fallback.provider, 'magpie');
    assert.equal(fallback.conversationFile, failed.conversationFile);
    assert.equal(fallback.existedAtDispatch, false, 'the failed round on the other model is not continued');
    const stored = fs.readFileSync(fallback.conversationFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(stored.map(entry => entry.provider), ['magpie']);

    await manager.action('rework', {id: created.id, prompt: 'follow up'});
    await settled(created.id);
    assert.equal(runsFor(created.id)[2].existedAtDispatch, true, 'a rework after fallback continues the fallback conversation');
    await manager.action('close', {id: created.id});
  } finally {
    config.fallbackProvider = original;
  }
});
