// Public composition root. The 0.1 manager remains a compatibility facade while
// lifecycle, workspace, runtime, and usage responsibilities move into src/.
export {createManager} from '../prototype/manager.mjs';
export {TaskLifecycle} from './tasks/lifecycle.mjs';
export {TaskTransaction} from './tasks/transaction.mjs';
export {
  statusLabel,
  normalizeTaskDetail,
  taskListView,
  taskPageView,
  taskSummaryView,
  workspaceLabel,
} from './tasks/view.mjs';
export {WorkspaceLeaseManager} from './workspace/lease-manager.mjs';
export {Runtime, roundTimeouts} from './runtime/module.mjs';
export {RuntimeLifecycle} from './runtime/lifecycle.mjs';
export {RuntimeOutcomeSettlement} from './runtime/outcome.mjs';
export {RuntimeSupervisor} from './runtime/supervisor.mjs';
export {UsageService} from './usage/service.mjs';
export {UsageModule} from './usage/module.mjs';
export {TaskCommandModule} from './tasks/command.mjs';
export {ExecutionPolicy} from './usage/execution-policy.mjs';
export {
  blockReason,
  completeLimits,
  decideRework,
  effectiveLimits,
  evaluateLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
  unavailableUsageSnapshot,
  validateLimits,
} from './usage/policy.mjs';
export {ResearchBatchService} from './research/service.mjs';
export {
  aggregateBatchStatus,
  countByShardStatus,
  isActiveBatch,
  isTerminalBatch,
  shardTransition,
} from './research/state.mjs';
