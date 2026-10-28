// Usage metrics and optional cumulative thresholds. Limits stay disabled
// unless the task or configuration explicitly opts in.
import {UsageModule} from './module.mjs';

export {
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
} from '../../prototype/usage.mjs';

/**
 * Compatibility facade for 0.1 adapters. New callers use `UsageModule`
 * directly; this class keeps the old construction shape working and gives it
 * the same never-throw behaviour.
 *
 * @deprecated Use `UsageModule`; this export remains through 0.1.x.
 */
export class UsageService {
  constructor(operations = {}) {
    this.module = operations instanceof UsageModule
      ? operations
      : new UsageModule({operations});
  }

  snapshot(task, taskDirectory, options = {}) {
    return this.module.snapshot(task, taskDirectory, options);
  }

  list(task, taskDirectory) {
    return this.module.list(task, taskDirectory);
  }

  status(task, taskDirectory) {
    return this.module.status(task, taskDirectory);
  }

  view(task, taskDirectory) {
    return this.module.view(task, taskDirectory);
  }
}
