/**
 * Coordination primitives shared by the manager's runtime state machine.
 * Process ownership and message validation stay in the manager until the 0.2
 * extraction; this class owns the release and exit gates so a terminal message
 * can never be mistaken for permission to dispatch another round.
 */
export class RuntimeSupervisor {
  settleRelease(record, value) {
    if (!record?.releaseWaiters) return;
    const waiters = record.releaseWaiters.splice(0);
    for (const resolve of waiters) resolve(value);
  }

  waitForRelease(record) {
    if (!record || record.phase === 'idle') return Promise.resolve(true);
    if (record.phase === 'exited') return Promise.resolve(false);
    return new Promise(resolve => record.releaseWaiters.push(resolve));
  }

  hasExited(record) {
    const value = record?.w;
    return value?.exitCode !== null && value?.exitCode !== undefined
      || value?.signalCode !== null && value?.signalCode !== undefined;
  }

  /**
   * Wait for the owned process exit event, including a handle that already has
   * an exit code. Unknown exit fields are not treated as a confirmed exit.
   */
  waitForExit(record, timeoutMs) {
    return new Promise(resolve => {
      if (this.hasExited(record)) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.w.off?.('exit', onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      record.w.once?.('exit', onExit) ?? record.w.on?.('exit', onExit);
    });
  }
}
