const ALLOWED = {
  run: ['created', 'awaiting_review', 'failed', 'cancelled'],
  finish: ['running'],
  fail: ['running'],
  accept: ['awaiting_review'],
  stop: ['created', 'running', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  close: ['created', 'running', 'awaiting_review', 'failed', 'cancelled', 'accepted'],
  delete: ['closed'],
};

const NEXT_STATUS = {
  run: 'running',
  finish: 'awaiting_review',
  fail: 'failed',
  accept: 'accepted',
  stop: 'cancelled',
  close: 'closed',
  delete: 'deleted',
};

export class TaskLifecycle {
  static can(task, action) {
    return Boolean(ALLOWED[action]?.includes(task?.status));
  }

  static transition(task, action) {
    if (!TaskLifecycle.can(task, action)) {
      throw new Error(`Cannot ${action} task in ${task?.status ?? 'unknown'}`);
    }
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
