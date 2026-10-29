// Compatibility facade for 0.1 callers. New callers use `UsageModule`; the
// module owns both metrics and limit evaluation, so this class only forwards.
import {UsageModule} from './module.mjs';

export {
  usageForList,
  usageForStatus,
  usageForTask,
  usageForView,
} from '../../prototype/usage.mjs';

/**
 * @deprecated Use `UsageModule`; this export remains until 0.3.0.
 */
export class UsageService {
  /**
   * @param usage - a `UsageModule`, or `{metricsForTask, usageViewFor}` for a
   *   test double. The old snapshot-shaped operations are no longer accepted.
   */
  constructor(usage = {}) {
    this.module = usage instanceof UsageModule ? usage : new UsageModule({metrics: usage.metrics ?? usage});
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
