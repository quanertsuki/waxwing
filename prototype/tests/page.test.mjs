// One paging rule for the manager's status views and the research report.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './isolate.mjs';
import {createManager} from '../manager.mjs';
import {ResearchReport} from '../../src/research/report.mjs';
import {DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, pageOf} from '../../src/view/page.mjs';

test('paging constants keep the published bounds', () => {
  assert.equal(DEFAULT_PAGE_LIMIT, 2000);
  assert.equal(MAX_PAGE_LIMIT, 4000);
});

test('emoji text pages advance strictly and reconstruct the original', () => {
  const text = `a😀b😀c😀d`;
  for (const limit of [2, 3, 4]) {
    let offset = 0;
    let collected = '';
    const seen = [];
    for (;;) {
      const page = pageOf(text, offset, limit);
      assert.ok(page.text.length <= limit);
      if (page.nextOffset === null) {
        seen.push(offset);
        collected += page.text;
        assert.equal(page.complete, true);
        break;
      }
      assert.ok(page.nextOffset > offset, 'a page must advance');
      seen.push(offset);
      collected += page.text;
      offset = page.nextOffset;
    }
    assert.equal(collected, text);
    assert.ok(seen.every((value, index) => index === 0 || value > seen[index - 1]));
  }
});

test('a limit that cannot fit a surrogate pair fails instead of stalling', () => {
  assert.throws(() => pageOf('😀x', 0, 1), /limit is too small/);
  // A page that starts on a low surrogate is never produced by nextOffset.
  assert.throws(() => pageOf('😀x', 1, 2), /splits a surrogate pair/);
});

test('an offset past the end clamps to an empty final page', () => {
  const page = pageOf('abc', 99, 10);
  assert.equal(page.text, '');
  assert.equal(page.offset, 3);
  assert.equal(page.totalChars, 3);
  assert.equal(page.nextOffset, null);
  assert.equal(page.complete, true);
});

/** A worker that completes one round immediately. */
function fakeFork() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.connected = true;
  child.exitCode = null;
  child.pid = 4545;
  child.send = message => queueMicrotask(() => {
    if (message.kind === 'close') {
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0));
      return;
    }
    if (message.kind !== 'run') return;
    child.emit('message', {kind: 'ready', roundId: message.roundId, ownerMarker: message.ownerMarker});
    child.emit('message', {kind: 'ack', roundId: message.roundId});
    setImmediate(() => {
      child.emit('message', {kind: 'result', roundId: message.roundId, text: 'done', finishReason: 'completed'});
      child.emit('message', {kind: 'released', roundId: message.roundId});
    });
  });
  return child;
}

function researchReport(root) {
  const repository = {
    resultFile: (batch, shard) => path.join(root, batch, `${shard}.md`),
    errorFile: (batch, shard) => path.join(root, batch, `${shard}.err`),
  };
  return new ResearchReport({reportsDir: path.join(root, 'reports'), repository});
}

const BATCH = {
  id: 'research-0123456789ab',
  title: 't',
  question: 'q',
  status: 'completed',
  createdAt: '2026-10-29T00:00:00.000Z',
  shards: [{id: 'shard-one', subject: 'one', status: 'completed'}],
};

test('research collect and task status share paging bounds and errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-page-'));
  const manager = createManager({forkWorker: fakeFork});
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-page-ws-'));
  try {
    const created = await manager.action('create', {workspace, prompt: 'work', plan: 'p', criteria: 'c'});
    for (let i = 0; i < 300; i += 1) {
      const status = await manager.action('status', {id: created.id});
      if (status.status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    const statusPage = await manager.action('status', {id: created.id, view: 'result', offset: 999, limit: 10});
    const reportPage = researchReport(root).collect(BATCH, {offset: 999, limit: 10}).page;
    for (const page of [statusPage, reportPage]) {
      assert.equal(page.offset, page.totalChars);
      assert.equal(page.text, '');
      assert.equal(page.nextOffset, null);
      assert.equal(page.complete, true);
    }

    await assert.rejects(
      () => manager.action('status', {id: created.id, view: 'result', offset: -1}),
      /offset must be a non-negative safe integer/,
    );
    assert.throws(() => researchReport(root).collect(BATCH, {offset: -1}),
      /offset must be a non-negative safe integer/);

    await assert.rejects(
      () => manager.action('status', {id: created.id, view: 'result', limit: MAX_PAGE_LIMIT + 1}),
      /limit must be a safe integer between 1 and 4000/,
    );
    assert.throws(() => researchReport(root).collect(BATCH, {limit: MAX_PAGE_LIMIT + 1}),
      /limit must be a safe integer between 1 and 4000/);
  } finally {
    await manager.shutdown();
    fs.rmSync(root, {recursive: true, force: true});
    fs.rmSync(workspace, {recursive: true, force: true});
  }
});
