const STATUS_LABELS = {
  created: '已创建',
  running: '运行中',
  stopping: '停止中',
  awaiting_review: '待验收',
  failed: '失败',
  accepted: '已验收',
  closed: '已关闭',
  cancelled: '已取消',
};

const WORKSPACE_LABELS = {
  auto: '自动隔离',
  worktree: '独立 Worktree',
  shared: '共享工作区',
  legacy: '旧版记录',
};

/**
 * Stable read-only task view contract. Adapters may format and lay out these
 * fields, but they must not invent status labels or lifecycle fields.
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function workspaceLabel(mode) {
  return WORKSPACE_LABELS[mode] ?? mode;
}

export function taskListView(task, {
  summary,
  usage,
  runtimeHealth,
  effort,
  workspaceMode,
  error = task.error ?? null,
}) {
  const item = {
    id: task.id,
    status: task.status,
    statusLabel: statusLabel(task.status),
    roundCount: task.rounds.length,
    live: task.live,
    workspace: task.workspace,
    workspaceMode,
    ...(workspaceMode ? {workspaceLabel: workspaceLabel(workspaceMode)} : {}),
    maxTokens: task.maxTokens,
    accepted: Boolean(task.acceptance),
    cleanupAuthorized: task.cleanupAuthorized,
    provider: task.provider?.name,
    model: task.model,
    error,
    runtimeHealth: runtimeHealth ?? task.runtimeHealth ?? task.runtime?.health ?? 'unknown',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    usage,
  };
  if (task.kind === 'research') {
    item.kind = 'research';
    item.batchId = task.batchId ?? null;
    item.shardId = task.shardId ?? null;
  }
  if (summary) {
    item.summary = summary.text;
    if (summary.truncated) item.summaryTruncated = true;
  }
  if (effort) item.effort = effort;
  if (task.rounds.length) item.lastRound = task.rounds.at(-1).number;
  if (summary?.truncated) item.summaryTruncated = true;
  return item;
}

export function taskSummaryView(task, {
  listView,
  usageRounds,
  statusUsage,
  resultPreview,
  resultTotalChars,
  reworkBlockedReason,
  runtimeHealth,
  effort,
  workspaceMode,
  sourceWorkspace,
  dataDirectory,
  report,
  error,
}) {
  const last = task.rounds.at(-1);
  return {
    ...listView,
    statusLabel: statusLabel(task.status),
    workspaceMode: workspaceMode ?? listView.workspaceMode ?? null,
    workspaceLabel: workspaceLabel(workspaceMode ?? listView.workspaceMode ?? 'legacy'),
    ...(sourceWorkspace ? {sourceWorkspace} : {}),
    branch: task.workspaceLease?.branch ?? null,
    baseCommit: task.workspaceLease?.baseCommit ?? null,
    worktreeStatus: task.workspaceLease?.status ?? null,
    roundId: last?.roundId ?? null,
    manualActionRequired: Boolean(task.runtime?.manualActionRequired),
    runtimePhase: task.runtime?.phase ?? null,
    sessionId: task.sessionId,
    dataDirectory,
    report,
    canRework: reworkBlockedReason === null,
    reworkBlockedReason,
    lastEvent: task.lastEvent ?? null,
    eventCount: task.eventCount ?? 0,
    runtimeReady: Boolean(task.runtimeReady),
    acceptedAt: task.acceptance?.at ?? null,
    resultPreview,
    resultPreviewChars: resultPreview.length,
    resultTotalChars,
    resultPreviewComplete: resultPreview.length >= resultTotalChars,
    resultPreviewTruncated: resultPreview.length < resultTotalChars,
    resultFinishReason: last?.result?.finishReason ?? null,
    lastRound: last ? {
      number: last.number,
      roundId: last.roundId ?? null,
      startedAt: last.startedAt ?? null,
      finishedAt: last.finishedAt ?? null,
      maxTokens: last.maxTokens ?? null,
      ...(last.effort ? {effort: last.effort} : {}),
    } : null,
    usage: statusUsage,
    usageRounds: usageRoundsForSummary(usageRounds),
  };
}

function usageRoundsForSummary(usage) {
  return Array.isArray(usage) ? usage.filter(round => round.requests > 0) : [];
}

export function taskPageView(id, view, page, extra = {}) {
  return {id, view, ...extra, ...page};
}

/**
 * Stable high-level detail contract. The manager supplies the bounded payload
 * and the adapter only adds presentation-neutral, shared fields.
 */
export function taskDetailView(summary, extra = {}) {
  return {...summary, ...extra};
}

/**
 * Fill nullable detail fields so Rust/Vue receive one stable shape.
 * Detail is a control/status response, not a history export, so optional
 * absent fields are omitted rather than filled with dozens of nulls.
 */
export function normalizeTaskDetail(task, summary) {
  // Keep the manager's bounded projection authoritative. Spreading the full
  // task record here would leak rounds, prompts, and results into the default
  // status response, bypassing the paginated history/result views.
  const normalized = {
    ...summary,
    runtimeHealth: summary.runtimeHealth ?? 'unknown',
    cleanupAuthorized: Boolean(summary.cleanupAuthorized),
    manualActionRequired: Boolean(summary.manualActionRequired),
    canRework: Boolean(summary.canRework),
    runtimeReady: Boolean(summary.runtimeReady),
    resultPreviewComplete: Boolean(summary.resultPreviewComplete),
    resultPreviewTruncated: Boolean(summary.resultPreviewTruncated),
    usageRounds: Array.isArray(summary.usageRounds) ? summary.usageRounds : [],
  };
  if (summary.lastRound) {
    normalized.lastRound = {
      number: summary.lastRound.number,
      ...(summary.lastRound.roundId ? {roundId: summary.lastRound.roundId} : {}),
      ...(summary.lastRound.startedAt ? {startedAt: summary.lastRound.startedAt} : {}),
      ...(summary.lastRound.finishedAt ? {finishedAt: summary.lastRound.finishedAt} : {}),
      ...(summary.lastRound.effort ? {effort: summary.lastRound.effort} : {}),
    };
  }
  if (task.runtime?.pid !== null && task.runtime?.pid !== undefined) {
    normalized.runtime = {
      pid: task.runtime.pid,
      manualActionRequired: Boolean(task.runtime.manualActionRequired),
    };
  }
  return normalized;
}

/**
 * The one task-view field contract. `required` fields are present in every
 * serialized response of that shape; `optional` fields appear only when their
 * source exists (research tasks, a live PID, an alternative workspace).
 * `scripts/generate-task-contract.mjs` and the Rust fixture test read this to
 * keep JS, Rust, and Vue from drifting apart.
 */
export const TASK_VIEW_CONTRACT = Object.freeze({
  list: Object.freeze({
    required: Object.freeze([
      'id',
      'status',
      'statusLabel',
      'roundCount',
      'live',
      'workspace',
      'workspaceMode',
      'workspaceLabel',
      'maxTokens',
      'accepted',
      'cleanupAuthorized',
      'provider',
      'model',
      'error',
      'runtimeHealth',
      'createdAt',
      'updatedAt',
      'usage',
      'summary',
    ]),
    optional: Object.freeze([
      'summaryTruncated',
      'errorTruncated',
      'effort',
      'lastRound',
      'kind',
      'batchId',
      'shardId',
    ]),
  }),
  detail: Object.freeze({
    required: Object.freeze([
      'id',
      'status',
      'statusLabel',
      'roundCount',
      'live',
      'workspace',
      'workspaceMode',
      'workspaceLabel',
      'maxTokens',
      'accepted',
      'cleanupAuthorized',
      'provider',
      'model',
      'error',
      'runtimeHealth',
      'createdAt',
      'updatedAt',
      'usage',
      'branch',
      'baseCommit',
      'worktreeStatus',
      'roundId',
      'manualActionRequired',
      'runtimePhase',
      'dataDirectory',
      'report',
      'canRework',
      'reworkBlockedReason',
      'lastEvent',
      'eventCount',
      'runtimeReady',
      'acceptedAt',
      'resultPreview',
      'resultPreviewChars',
      'resultTotalChars',
      'resultPreviewComplete',
      'resultPreviewTruncated',
      'resultFinishReason',
      'lastRound',
      'usageRounds',
    ]),
    optional: Object.freeze([
      'sourceWorkspace',
      'sessionId',
      'runtime',
      'summaryTruncated',
      'errorTruncated',
      'effort',
      'kind',
      'batchId',
      'shardId',
    ]),
  }),
});

export const TASK_LIST_FIELDS = Object.freeze([
  ...TASK_VIEW_CONTRACT.list.required,
  ...TASK_VIEW_CONTRACT.list.optional,
]);

export const TASK_DETAIL_FIELDS = Object.freeze([
  ...TASK_VIEW_CONTRACT.detail.required,
  ...TASK_VIEW_CONTRACT.detail.optional,
]);
