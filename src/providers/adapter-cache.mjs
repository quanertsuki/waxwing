// One adapter per Provider identity inside the Worker process.
//
// A Worker process can serve several rounds, and the Provider fallback reuses
// that process. The adapter must therefore follow the Provider the current
// round was dispatched with; caching by provider config (not by "the first
// round") keeps a fallback from silently calling the original endpoint.
import {createAdapter as createDefaultAdapter} from './registry.mjs';

/** Stable key over a provider config, so key order cannot cause a rebuild. */
function providerKey(config) {
  return JSON.stringify(Object.keys(config).sort().map(key => [key, config[key]]));
}

/**
 * @param options.createAdapter - adapter factory, injectable for tests.
 * @param options.env - environment used to resolve `apiKeyEnv`.
 * @param options.adapterOptions - constructor options passed to every adapter.
 */
export function createAdapterCache({
  createAdapter = createDefaultAdapter,
  env = process.env,
  adapterOptions = {},
} = {}) {
  let cached = null;
  const created = [];

  return {
    /**
     * Return the adapter for this Provider, reusing the previous instance when
     * the identity is unchanged. The caller's object is never modified.
     */
    adapterFor(providerConfig) {
      if (!providerConfig || typeof providerConfig !== 'object') {
        throw new Error('Provider config must be an object');
      }
      // Copy before resolving the key, so the environment-derived API key
      // never leaks back into the task record or the caller's object.
      const resolved = {...providerConfig};
      if (resolved.apiKeyEnv && !resolved.apiKey) {
        resolved.apiKey = env[resolved.apiKeyEnv];
      }
      const key = providerKey(resolved);
      if (cached?.key === key) return cached.adapter;
      const adapter = createAdapter(resolved, adapterOptions);
      adapter.validate?.();
      created.push(adapter);
      cached = {key, adapter};
      return adapter;
    },

    /** The adapter used by the last round, or null before the first one. */
    get current() {
      return cached?.adapter ?? null;
    },

    reset() {
      cached = null;
    },

    /**
     * Close every adapter this process built, oldest first. A Provider
     * fallback replaces the cached adapter, so the cache, not the current
     * entry, owns teardown.
     */
    async closeAll() {
      cached = null;
      const owned = created.splice(0);
      for (const adapter of owned.reverse()) {
        try {
          await adapter.close?.();
        } catch {
          // A failed close is not allowed to hide another adapter's teardown.
        }
      }
    },
  };
}
