// Provider discovery remains compatible with legacy provider JSON files.
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
} from '../../prototype/providers/registry.mjs';
