#!/usr/bin/env node
// Generate the cross-adapter task view fixture from the real view functions.
// The JS test compares this output with the committed file, the Rust test
// deserializes the same file, and the desktop types are generated from the
// same field lists, so adding or renaming a view field fails all three.
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
export const CONTRACT_TYPES_PATH = path.join(
  HERE, '..', 'desktop', 'src', 'contract.generated.ts',
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

// Fields the views always render; everything else is optional so an older
// manager response stays readable.
const TASK_LIST_REQUIRED = ['id', 'status', 'roundCount', 'live', 'workspace', 'summary', 'accepted'];
const TASK_DETAIL_REQUIRED = ['id', 'status', 'live', 'workspace', 'accepted'];

// Named objects inside the list and detail shapes. Anything else is inferred
// from the generated fixture, so the desktop types cannot lag the manager.
const NAMED_OBJECTS = Object.freeze({
  'list.usage': 'TaskUsage',
  'detail.usage': 'TaskDetailUsage',
  'detail.lastRound': 'TaskRound',
  'detail.runtime': 'TaskRuntime',
  'detail.usageRounds[]': 'UsageRound',
});

function inferredType(value) {
  if (value === null) return 'unknown';
  if (Array.isArray(value)) {
    return value.length > 0 && typeof value[0] === 'object' && value[0] !== null
      ? 'Record<string, unknown>[]'
      : `${inferredType(value[0])}[]`;
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'Record<string, unknown>';
}

function interfaceFor(name, shape, value, required = []) {
  const lines = [`export interface ${name} {`];
  for (const [key, field] of Object.entries(value)) {
    const named = NAMED_OBJECTS[`${shape}.${key}${Array.isArray(field) ? '[]' : ''}`];
    const type = named ? (Array.isArray(field) ? `${named}[]` : named) : inferredType(field);
    lines.push(`  ${key}${required.includes(key) ? '' : '?'}: ${type};`);
  }
  lines.push('}', '');
  return lines;
}

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

/** Render the shared TypeScript contracts; the desktop imports these. */
export function renderContractTypes(contract = buildTaskViewContract()) {
  const blocks = [
    '// Generated by scripts/generate-task-contract.mjs from the real view output.',
    '// Do not edit by hand; regenerate after changing src/tasks/view.mjs.',
    '// The Rust contract test requires every field here to be declared there.',
    '',
    'export interface TaskEvent {',
    '  [key: string]: unknown;',
    '}',
    '',
    ...interfaceFor('TaskUsage', 'list.usage', contract.list.usage),
    ...interfaceFor('TaskDetailUsage', 'detail.usage', contract.detail.usage),
    ...interfaceFor('UsageRound', 'detail.usageRounds[]', contract.detail.usageRounds[0] ?? {}),
    ...interfaceFor('TaskRound', 'detail.lastRound', contract.detail.lastRound ?? {}),
    ...interfaceFor('TaskRuntime', 'detail.runtime', contract.detail.runtime ?? {}),
    ...interfaceFor('Task', 'list', contract.list, TASK_LIST_REQUIRED),
    ...interfaceFor('TaskDetail', 'detail', contract.detail, TASK_DETAIL_REQUIRED),
  ];
  return blocks.join(String.fromCharCode(10));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = buildTaskViewContract();
  fs.writeFileSync(CONTRACT_FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  fs.writeFileSync(CONTRACT_TYPES_PATH, renderContractTypes(fixture));
  process.stdout.write(`Wrote ${CONTRACT_FIXTURE_PATH}\n`);
  process.stdout.write(`Wrote ${CONTRACT_TYPES_PATH}\n`);
}
