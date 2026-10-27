/**
 * Low-level release and exit gates used by the Runtime module. Process
 * ownership, message validation, and round state live in `module.mjs`; this
 * class only ensures a terminal message is not permission to dispatch the next
 * round and that exit is confirmed by the process handle.
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
