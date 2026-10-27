// Research fan-out: one batch, multiple scratch workspaces, concurrent shard
// tasks, automatic runtime release, partial failure, and one aggregate report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {ROOT} from '../common.mjs';

if (path.resolve(ROOT) === path.resolve(REAL_ROOT)) throw new Error(`research tests refused live root ${ROOT}`);
if (path.resolve(ROOT) !== path.resolve(TEST_ROOT)) throw new Error(`research tests refused non-isolated root ${ROOT}`);

const BATCHES = path.join(ROOT, 'research');
const scratchRoot = path.resolve(`${ROOT}-research`);

let pid = 7300;
function researchFork({failShard = null, hold = false} = {}) {
  const pending = [];
  const stats = {active: 0, maxActive: 0, started: []};
  const finish = message => {
    const child = message.child;
    const id = message.taskId;
    const shardId = message.shardId;
    if (hold) return;
    stats.active -= 1;
    if (failShard === shardId) {
      child.emit('message', {kind: 'error', roundId: message.roundId, error: `research failure: ${shardId}`});
    } else {
      child.emit('message', {
        kind: 'result',
        roundId: message.roundId,
        text: `## Result ${shardId}\n\nSource: https://example.invalid/${shardId}`,
        finishReason: 'completed',
      });
    }
    child.emit('message', {kind: 'released', roundId: message.roundId});
  };
  const factory = task => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.connected = true;
    child.exitCode = null;
    child.signalCode = null;
    child.pid = ++pid;
    child.send = message => queueMicrotask(() => {
      if (message.kind === 'close') {
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', 0));
        return;
      }
      if (message.kind !== 'run') return;
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      stats.started.push(message.task.id);
      child.emit('message', {kind: 'ready', roundId: message.roundId, ownerMarker: message.ownerMarker});
      child.emit('message', {kind: 'ack', roundId: message.roundId});
      pending.push({
        child,
        taskId: message.task.id,
        shardId: message.task.shardId,
        roundId: message.roundId,
      });
      if (pending.length === 2) {
        for (const entry of pending.splice(0)) finish(entry);
      }
    });
    child.kill = () => {
      child.exitCode = 0;
      child.emit('exit', 0);
    };
    return child;
  };
  return {factory, stats};
}

test('research_start fans out concurrent tasks in unique scratch workspaces and collects one report', async () => {
  const worker = researchFork();
  const manager = createManager({forkWorker: worker.factory});
  try {
    const started = await manager.action('research_start', {
      title: 'Parallel source review',
      question: 'Compare two candidate projects.',
      shards: [
        {id: 'alpha', subject: 'Project Alpha', url: 'https://example.invalid/alpha'},
        {id: 'beta', subject: 'Project Beta', url: 'https://example.invalid/beta', focus: 'licensing'},
      ],
      provider: 'deepseek-flash',
      maxTokens: 2048,
    });
    assert.equal(started.kind, 'research');
    assert.equal(started.shards.length, 2);
    assert.ok(started.shards.every(shard => shard.taskId?.startsWith('task-')));
    assert.equal(new Set(started.shards.map(shard => shard.workspace)).size, 2);
    assert.ok(started.shards.every(shard => path.resolve(shard.workspace).startsWith(path.resolve(scratchRoot))));
    assert.equal(worker.stats.maxActive, 2, 'both research shards must be active at the same time');

    const finished = await manager.action('research_wait', {id: started.id, timeoutSeconds: 5});
    assert.equal(finished.status, 'completed');
    assert.equal(finished.wait.timedOut, false);
    assert.equal(finished.counts.completed, 2);
    assert.ok(finished.shards.every(shard => shard.taskStatus === 'closed'));

    for (const shard of finished.shards) {
      const task = await manager.action('status', {id: shard.taskId});
      assert.equal(task.kind, 'research');
      assert.equal(task.batchId, started.id);
      assert.equal(task.shardId, shard.id);
      assert.equal(task.live, false);
      assert.equal(task.usage.limits.enabled, false);
      assert.equal(fs.existsSync(shard.workspace), true);
    }

    const collected = await manager.action('research_collect', {id: started.id, offset: 0, limit: 4000});
    assert.equal(collected.status, 'completed');
    assert.match(collected.text, /Waxwing research: Parallel source review/);
    assert.match(collected.text, /## Project Alpha/);
    assert.match(collected.text, /Source: https:\/\/example\.invalid\/alpha/);
    assert.match(collected.text, /## Project Beta/);
    assert.match(collected.text, /Source: https:\/\/example\.invalid\/alpha[\s\S]*\n\n## Project Beta/);
    assert.equal(collected.reportHash.length, 64);
    assert.equal(fs.existsSync(collected.report), true);
  } finally {
    await manager.shutdown();
  }
});

test('research batches retain completed shards and collect partial failures', async () => {
  const worker = researchFork({failShard: 'bad'});
  const manager = createManager({forkWorker: worker.factory});
  try {
    const started = await manager.action('research_start', {
      title: 'Partial review',
      question: 'Review one good and one inaccessible source.',
      shards: [{id: 'good', subject: 'Good source'}, {id: 'bad', subject: 'Bad source'}],
      provider: 'deepseek-flash',
      maxTokens: 1024,
    });
    const finished = await manager.action('research_wait', {id: started.id, timeoutSeconds: 5});
    assert.equal(finished.status, 'partial');
    assert.equal(finished.wait.timedOut, false);
    assert.deepEqual(finished.counts, {
      total: 2,
      planned: 0,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 0,
    });
    const collected = await manager.action('research_collect', {id: started.id, offset: 0, limit: 4000});
    assert.match(collected.text, /## Good source/);
    assert.match(collected.text, /## Bad source/);
    assert.match(collected.text, /research failure: bad/);
  } finally {
    await manager.shutdown();
  }
});

test('research_wait returns a timeout summary while shards remain managed', async () => {
  const worker = researchFork({hold: true});
  const manager = createManager({forkWorker: worker.factory});
  try {
    const started = await manager.action('research_start', {
      question: 'Wait for a held shard.',
      shards: [{id: 'held', subject: 'Held source'}],
      provider: 'deepseek-flash',
      maxTokens: 1024,
    });
    const startedAt = Date.now();
    const pending = await manager.action('research_wait', {id: started.id, timeoutSeconds: 1});
    assert.equal(pending.status, 'running');
    assert.equal(pending.wait.timedOut, true);
    assert.ok(Date.now() - startedAt >= 900);
    await manager.action('research_cancel', {id: started.id});
    assert.equal((await manager.action('research_status', {id: started.id})).status, 'cancelled');
  } finally {
    await manager.shutdown();
  }
});

test('research validation rejects duplicate shard IDs before creating a batch', async () => {
  const worker = researchFork();
  const manager = createManager({forkWorker: worker.factory});
  const before = fs.existsSync(BATCHES) ? fs.readdirSync(BATCHES).length : 0;
  try {
    await assert.rejects(
      () => manager.action('research_start', {
        question: 'Duplicate shards',
        shards: [{id: 'same', subject: 'One'}, {id: 'same', subject: 'Two'}],
      }),
      /Duplicate research shard ID/,
    );
    const after = fs.existsSync(BATCHES) ? fs.readdirSync(BATCHES).length : 0;
    assert.equal(after, before);
    assert.equal(worker.stats.started.length, 0);
  } finally {
    await manager.shutdown();
  }
});
