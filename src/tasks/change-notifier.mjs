/**
 * Wake one or more waiters when a keyed record changes. Version snapshots are
 * captured before a waiter is registered, so a save racing with wait() cannot
 * be lost.
 */
export class ChangeNotifier {
  constructor() {
    this.versions = new Map();
    this.waiters = new Map();
  }

  version(key) {
    return this.versions.get(key) ?? 0;
  }

  touch(key) {
    const version = this.version(key) + 1;
    this.versions.set(key, version);
    const listeners = this.waiters.get(key);
    if (listeners) {
      for (const finish of [...listeners]) finish(true);
    }
    return version;
  }

  async wait(keys, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error('wait timeout must be a non-negative finite number');
    }
    const unique = [...new Set(keys)];
    const snapshot = new Map(unique.map(key => [key, this.version(key)]));
    const changed = () => unique.some(key => this.version(key) !== snapshot.get(key));
    if (changed()) return true;
    if (timeoutMs === 0) return false;

    return new Promise(resolve => {
      let settled = false;
      let timer;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const key of unique) {
          const listeners = this.waiters.get(key);
          if (!listeners) continue;
          listeners.delete(finish);
          if (listeners.size === 0) this.waiters.delete(key);
        }
        resolve(value);
      };
      for (const key of unique) {
        let listeners = this.waiters.get(key);
        if (!listeners) {
          listeners = new Set();
          this.waiters.set(key, listeners);
        }
        listeners.add(finish);
      }
      timer = setTimeout(() => finish(false), timeoutMs);
      // Re-check after registration to close the registration/save race.
      if (changed()) finish(true);
    });
  }

  waiterCount(key) {
    return this.waiters.get(key)?.size ?? 0;
  }
}
