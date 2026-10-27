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
  error = task.error ?? null,
}) {
  const item = {
    id: task.id,
    status: task.status,
    statusLabel: statusLabel(task.status),
    roundCount: task.rounds.length,
    live: task.live,
    workspace: task.workspace,
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
    workspaceMode,
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
