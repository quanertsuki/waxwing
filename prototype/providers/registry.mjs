// Compatibility wrapper. Provider discovery and adapter registration live in
// src/providers/registry.mjs.
export {
  DEFAULT_PROVIDER_NAME,
  capabilitiesFor,
  createAdapter,
  createAdapterFromDir,
  listProviderNames,
  loadProvider,
  loadProviders,
  prepareTask,
  resolveProvider,
  validateProviderConfig,
} from '../../src/providers/registry.mjs';
