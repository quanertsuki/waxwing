import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTaskDetail,
  statusLabel,
  TASK_LIST_FIELDS,
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
    workspaceMode: 'worktree',
  });
  assert.equal(list.id, task.id);
  assert.equal(list.statusLabel, '待验收');
  assert.equal(list.roundCount, 1);
  assert.equal(list.summary, 'preview');
  assert.equal(list.summaryTruncated, true);
  assert.equal(list.lastRound, 1);
  assert.equal(list.runtimeHealth, 'healthy');
  assert.equal(list.workspaceMode, 'worktree');
  assert.equal(list.workspaceLabel, '独立 Worktree');
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
  assert.equal(detail.workspaceLabel, '独立 Worktree');
});

test('page view preserves pagination and truncation semantics', () => {
  const page = {text: 'abc', offset: 0, totalChars: 4, nextOffset: 3, complete: false};
  assert.deepEqual(taskPageView('task-1', 'result', page, {round: 1}),
    {id: 'task-1', view: 'result', round: 1, ...page});
});

test('list and detail expose the same labels, nulls, and bounded preview fields', () => {
  const list = taskListView({...task, acceptance: undefined}, {
    summary: {text: 'preview', truncated: false},
    usage: {requests: 1},
    runtimeHealth: 'unknown',
    effort: null,
    workspaceMode: 'shared',
  });
  const detail = taskSummaryView(task, {
    listView: list,
    usageRounds: [],
    statusUsage: {requests: 0, limitState: 'disabled'},
    resultPreview: '',
    resultTotalChars: 0,
    reworkBlockedReason: 'closed',
    workspaceMode: 'shared',
    dataDirectory: '/runs/task',
    report: '/reports/task.md',
  });
  assert.equal(detail.workspaceMode, 'shared');
  assert.equal(detail.workspaceLabel, '共享工作区');
  assert.equal(detail.branch, 'waxwing/task-1');
  assert.equal(detail.baseCommit, null);
  assert.equal(detail.roundId, 'round-1');
  assert.equal(detail.manualActionRequired, false);
  assert.equal(detail.runtimePhase, null);
  assert.equal(detail.resultPreviewComplete, true);
  assert.equal(detail.resultPreviewTruncated, false);
  assert.equal(detail.canRework, false);
  assert.equal(detail.reworkBlockedReason, 'closed');
  assert.equal(detail.usage.requests, 0);
  assert.equal(detail.usageRounds.length, 0);
});

test('page boundaries preserve surrogate pairs and final-page markers', () => {
  const text = 'A😀B';
  const first = taskPageView('task-1', 'result', {
    text: 'A😀', offset: 0, totalChars: 4, nextOffset: 3, complete: false,
  });
  const second = taskPageView('task-1', 'result', {
    text: 'B', offset: 3, totalChars: 4, nextOffset: null, complete: true,
  });
  assert.equal(first.text + second.text, text);
  assert.equal(first.nextOffset, second.offset);
  assert.equal(second.nextOffset, null);
  assert.equal(second.complete, true);
});

test('detail normalization is a bounded whitelist and never leaks raw task fields', () => {
  const raw = {
    ...task,
    prompt: 'PROMPT_SENTINEL',
    output: 'OUTPUT_SENTINEL',
    rounds: [{
      number: 1,
      roundId: 'round-1',
      effort: 'high',
      prompt: 'ROUND_PROMPT_SENTINEL',
      result: {text: 'ROUND_RESULT_SENTINEL', finishReason: 'completed'},
    }],
    runtime: {
      pid: 4242,
      startedAt: '2026-10-28T01:00:00.000Z',
      roundId: 'round-1',
      phase: 'stopping',
      health: 'unhealthy',
      identityVerified: true,
      manualActionRequired: true,
      ownerMarker: 'PRIVATE_OWNER_MARKER',
    },
  };
  const list = taskListView(raw, {
    summary: {text: 'bounded preview', truncated: false},
    usage: {available: true, requests: 1},
    runtimeHealth: 'healthy',
    workspaceMode: 'worktree',
  });
  const summary = taskSummaryView(raw, {
    listView: list,
    usageRounds: [],
    statusUsage: {available: true, requests: 1},
    resultPreview: 'bounded result',
    resultTotalChars: 14,
    reworkBlockedReason: 'runtime stopping',
    workspaceMode: 'worktree',
    dataDirectory: '/runs/task',
    report: '/reports/task.md',
  });
  const detail = normalizeTaskDetail(raw, summary);
  const serialized = JSON.stringify(detail);
  for (const sentinel of [
    'PROMPT_SENTINEL',
    'OUTPUT_SENTINEL',
    'ROUND_PROMPT_SENTINEL',
    'ROUND_RESULT_SENTINEL',
    'PRIVATE_OWNER_MARKER',
  ]) {
    assert.ok(!serialized.includes(sentinel), `${sentinel} must not reach the detail view`);
  }
  assert.equal(detail.runtime.pid, 4242);
  assert.equal(detail.runtime.manualActionRequired, true);
  for (const field of ['id', 'status', 'statusLabel', 'roundCount', 'live',
    'workspace', 'workspaceMode', 'workspaceLabel', 'runtimeHealth', 'usage',
    'branch', 'worktreeStatus']) {
    assert.ok(field in detail, `detail must expose ${field}`);
  }
  assert.equal(detail.roundId, 'round-1');
  assert.equal(detail.sourceWorkspace, undefined);
  assert.equal(detail.lastRound.roundId, 'round-1');
  assert.equal(detail.lastRound.effort, 'high');
  assert.equal(detail.lastRound.startedAt, undefined);
  for (const field of TASK_LIST_FIELDS) {
    assert.ok(field in list, `list must expose ${field}`);
  }
});
