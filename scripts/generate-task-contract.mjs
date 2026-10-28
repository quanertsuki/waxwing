#!/usr/bin/env node
// Generate the cross-adapter task view fixture from the real view functions.
// The JS test compares this output with the committed file, and the Rust test
// deserializes the same file, so adding or renaming a view field fails both.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  normalizeTaskDetail,
  taskListView,
  taskSummaryView,
} from '../src/tasks/view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACT_FIXTURE_PATH = path.join(
  HERE, '..', 'prototype', 'tests', 'fixtures', 'task-view-contract.json',
);

const TASK = Object.freeze({
  id: 'task-0123456789ab',
  status: 'awaiting_review',
  rounds: [{
    number: 1,
    roundId: 'round-1',
    startedAt: '2026-10-28T01:00:00.000Z',
    finishedAt: '2026-10-28T01:02:00.000Z',
    maxTokens: 4096,
    effort: 'high',
    result: {text: 'bounded result', finishReason: 'completed'},
  }],
  workspace: 'C:/work/task',
  workspaceLease: {
    mode: 'worktree',
    status: 'active',
    branch: 'waxwing/task-0123456789ab',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    sourceWorkspace: 'C:/work/source',
  },
  sourceWorkspace: 'C:/work/source',
  provider: {name: 'fixture'},
  model: 'fixture-model',
  acceptance: null,
  maxTokens: 4096,
  cleanupAuthorized: true,
  live: true,
  createdAt: '2026-10-28T00:59:00.000Z',
  updatedAt: '2026-10-28T01:02:01.000Z',
  sessionId: 'session-1',
  runtime: {pid: 4242, phase: 'running', health: 'healthy', manualActionRequired: false},
  runtimeReady: true,
  lastEvent: {sequence: 7, type: 'result'},
  eventCount: 7,
});

const LIST_USAGE = Object.freeze({
  available: true,
  requests: 2,
  inputTokens: 10,
  outputTokens: 20,
  estimatedCostCny: 0.25,
  costComplete: true,
  warnings: [],
});

const STATUS_USAGE = Object.freeze({
  ...LIST_USAGE,
  limitState: 'disabled',
});

/** Build the exact fixture object; exported so the test can regenerate it. */
export function buildTaskViewContract() {
  const list = taskListView(TASK, {
    summary: {text: 'bounded preview', truncated: false},
    usage: LIST_USAGE,
    runtimeHealth: 'healthy',
    effort: 'high',
    workspaceMode: 'worktree',
    error: null,
  });
  const listBase = taskListView(TASK, {
    summary: null,
    usage: LIST_USAGE,
    runtimeHealth: 'healthy',
    effort: 'high',
    workspaceMode: 'worktree',
    error: null,
  });
  const summary = taskSummaryView(TASK, {
    listView: listBase,
    usageRounds: [{number: 1, requests: 2, inputTokens: 10, outputTokens: 20}],
    statusUsage: STATUS_USAGE,
    resultPreview: 'bounded result',
    resultTotalChars: 100,
    reworkBlockedReason: 'runtime is live',
    runtimeHealth: 'healthy',
    effort: 'high',
    workspaceMode: 'worktree',
    sourceWorkspace: TASK.sourceWorkspace,
    dataDirectory: 'C:/data/runs/task-0123456789ab',
    report: 'C:/data/reports/task-0123456789ab.md',
    error: null,
  });
  return {list, detail: normalizeTaskDetail(TASK, summary)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = buildTaskViewContract();
  fs.writeFileSync(CONTRACT_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`Wrote ${CONTRACT_FIXTURE_PATH}\n`);
}
