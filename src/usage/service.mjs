// Usage metrics and optional cumulative thresholds. Limits stay disabled
// unless the task or configuration explicitly opts in.
export {
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
} from '../../prototype/usage.mjs';

/**
 * Small service facade for adapters that should not depend on the legacy
 * module path. The implementation remains compatible with event files written
 * by earlier 0.1 previews.
 */
export class UsageService {
  constructor(operations) {
    this.operations = operations;
  }

  snapshot(task, taskDirectory, options = {}) {
    return this.operations.usageForTask(task, taskDirectory, options);
  }

  list(task, taskDirectory) {
    return this.operations.usageForList(task, taskDirectory);
  }

  status(task, taskDirectory) {
    return this.operations.usageForStatus(task, taskDirectory);
  }

  view(task, taskDirectory) {
    return this.operations.usageForView(task, taskDirectory);
  }
}
