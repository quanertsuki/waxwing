import test from 'node:test';
import assert from 'node:assert/strict';
import {
  statusLabel,
  taskListView,
  taskPageView,
  taskSummaryView,
  workspaceLabel,
} from '../../src/tasks/view.mjs';

const task = {
  id: 'task-0123456789ab',
  status: 'awaiting_review',
  rounds: [{number: 1, roundId: 'round-1', maxTokens: 4096, effort: 'high'}],
  workspace: '/workspace',
  workspaceLease: {mode: 'worktree', status: 'active', branch: 'waxwing/task-1'},
  provider: {name: 'fixture'},
  model: 'fixture-model',
  acceptance: null,
  runtimeHealth: 'healthy',
};

test('status and workspace labels are shared by every adapter', () => {
  assert.equal(statusLabel('awaiting_review'), '待验收');
  assert.equal(statusLabel('unknown'), 'unknown');
  assert.equal(workspaceLabel('worktree'), '独立 Worktree');
  assert.equal(workspaceLabel('custom'), 'custom');
});

test('list and summary views preserve old fields and add stable labels', () => {
  const list = taskListView(task, {
    summary: {text: 'preview', truncated: true},
    usage: {requests: 1},
    runtimeHealth: 'healthy',
    effort: 'high',
  });
  assert.equal(list.id, task.id);
  assert.equal(list.statusLabel, '待验收');
  assert.equal(list.roundCount, 1);
  assert.equal(list.summary, 'preview');
  assert.equal(list.summaryTruncated, true);
  assert.equal(list.lastRound, 1);
  assert.equal(list.runtimeHealth, 'healthy');
  assert.equal(taskListView({...task, error: 'raw'}, {
    summary: {text: 'x', truncated: false},
    usage: {},
    error: 'bounded',
  }).error, 'bounded');

  const detail = taskSummaryView(task, {
    listView: list,
    usageRounds: [{requests: 1}, {requests: 0}],
    statusUsage: {requests: 1, costComplete: true},
    resultPreview: 'done',
    resultTotalChars: 4,
    reworkBlockedReason: null,
    workspaceMode: 'worktree',
    dataDirectory: '/runs/task',
    report: '/reports/task.md',
  });
  assert.equal(detail.statusLabel, '待验收');
  assert.equal(detail.canRework, true);
  assert.equal(detail.resultPreviewComplete, true);
  assert.equal(detail.workspaceMode, 'worktree');
  assert.equal(detail.usage.requests, 1);
  assert.equal(detail.usageRounds.length, 1);
});

test('page view preserves pagination and truncation semantics', () => {
  const page = {text: 'abc', offset: 0, totalChars: 4, nextOffset: 3, complete: false};
  assert.deepEqual(taskPageView('task-1', 'result', page, {round: 1}),
    {id: 'task-1', view: 'result', round: 1, ...page});
});
