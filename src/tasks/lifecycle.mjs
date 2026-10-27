const ALLOWED = {
  run: ['created', 'awaiting_review', 'failed', 'cancelled'],
  finish: ['running'],
  fail: ['running'],
  begin_stop: ['created', 'running', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  accept: ['awaiting_review'],
  stop: ['created', 'stopping', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  close: ['created', 'stopping', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  delete: ['closed'],
};

const NEXT_STATUS = {
  run: 'running',
  finish: 'awaiting_review',
  fail: 'failed',
  begin_stop: 'stopping',
  accept: 'accepted',
  stop: 'cancelled',
  close: 'closed',
  delete: 'deleted',
};

export class TaskLifecycle {
  static can(task, action) {
    return Boolean(ALLOWED[action]?.includes(task?.status));
  }

  /**
   * Validate an action against a status without applying it. A close operation
   * that must pass through `stopping` uses this before it changes any runtime
   * state, so an illegal request has no side effects.
   */
  static assert(task, action) {
    if (!TaskLifecycle.can(task, action)) {
      throw new Error(`Cannot ${action} task in ${task?.status ?? 'unknown'}`);
    }
    return task;
  }

  /**
   * A stop/close intent may begin from `running` even though the final
   * `cancelled`/`closed` transition is only legal after a confirmed runtime
   * exit. This check belongs before touching a runtime handle.
   */
  static assertStop(task, action) {
    if (action !== 'stop' && action !== 'close') {
      throw new Error(`Unsupported stop action: ${action}`);
    }
    if (task?.status === 'running' || TaskLifecycle.can(task, action)) return task;
    throw new Error(`Cannot ${action} task in ${task?.status ?? 'unknown'}`);
  }

  static transition(task, action) {
    TaskLifecycle.assert(task, action);
    return {
      ...task,
      schemaVersion: Math.max(2, task.schemaVersion ?? 0),
      status: NEXT_STATUS[action],
      updatedAt: new Date().toISOString(),
    };
  }
}

export function transition(task, action) {
  return TaskLifecycle.transition(task, action);
}
