// Public composition root. `createManager` assembles the deepened modules
// exported below; the prototype/ paths remain only as entry-point forwarders.
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
export {RuntimeSettlement} from './runtime/settlement.mjs';
export {UsageModule} from './usage/module.mjs';
export {TaskCommandModule} from './tasks/command.mjs';
export {TaskRework} from './tasks/rework.mjs';
export {ExecutionPolicy} from './tasks/execution-policy.mjs';
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
