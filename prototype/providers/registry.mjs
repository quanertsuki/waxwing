// Provider registry: enumerate, load, resolve, and validate provider
// configurations. Adapter types register here; everything else asks the
// registry for an adapter, its capabilities, or its task preparation.
// Provider configs are stored as individual JSON files in providersDir.

import fs from 'node:fs';
import path from 'node:path';
import {DshSdkAdapter} from './dsh-sdk.mjs';
import {OpenAIChatAdapter} from './openai-chat.mjs';

const ADAPTER_TYPES = {
    'openai-chat': OpenAIChatAdapter,
    'dsh-sdk': DshSdkAdapter,
    // Future adapters register here:
    // 'anthropic-native': AnthropicNativeAdapter,
    // 'openai-responses': OpenAIResponsesAdapter,
};

/** Built-in names that need no provider JSON file, mapped to their type. */
const BUILTIN_PROVIDERS = new Map([
    ['dsh-sdk', 'dsh-sdk'],
    ['dsh', 'dsh-sdk'],
]);

/** The built-in DSH SDK provider: the default when a task names no provider. */
export const DEFAULT_PROVIDER_NAME = 'dsh-sdk';

/**
 * Validate a provider configuration object.
 * Throws on invalid config.
 */
export function validateProviderConfig(config) {
    if (!config || typeof config !== 'object') {
        throw new Error('Provider config must be an object');
    }
    if (!config.name || typeof config.name !== 'string') {
        throw new Error('Provider config requires a name');
    }
    if (!config.type || typeof config.type !== 'string') {
        throw new Error(`Provider ${config.name}: type is required`);
    }
    if (!ADAPTER_TYPES[config.type]) {
        throw new Error(`Provider ${config.name}: unknown type "${config.type}". Supported: ${Object.keys(ADAPTER_TYPES).join(', ')}`);
    }
    if (config.maxToolRequests !== undefined && config.maxToolRequests !== null) {
        if (!Number.isSafeInteger(config.maxToolRequests) || config.maxToolRequests < 0) {
            throw new Error(`Provider ${config.name}: maxToolRequests must be a nonnegative safe integer`);
        }
    }
    if (config.stream !== undefined && typeof config.stream !== 'boolean') {
        throw new Error(`Provider ${config.name}: stream must be a boolean`);
    }
    return config;
}

/**
 * Load all provider configs from a directory.
 * Returns a Map of provider name -> config object.
 */
export function loadProviders(providersDir) {
    const dir = path.resolve(providersDir);
    if (!fs.existsSync(dir)) return new Map();

    const providers = new Map();
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
            const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            validateProviderConfig(config);
            providers.set(config.name, config);
        } catch (error) {
            // Skip invalid provider files but don't fail the whole load
            console.warn(`Skipping invalid provider ${file}: ${error.message}`);
        }
    }
    return providers;
}

/**
 * Load a single provider config by name.
 * Throws if not found or invalid.
 */
export function loadProvider(providersDir, name) {
    const providers = loadProviders(providersDir);
    const config = providers.get(name);
    if (!config) {
        throw new Error(`Provider "${name}" not found in ${providersDir}`);
    }
    return config;
}

/**
 * Resolve a provider name to its config: a built-in provider first, then the
 * provider directory. `model` fills the built-in model, which follows the
 * manager configuration rather than a provider file.
 */
export function resolveProvider(providersDir, name, {model} = {}) {
    const builtin = BUILTIN_PROVIDERS.get(name);
    if (builtin) return {name: builtin, type: builtin, model};
    return loadProvider(providersDir, name);
}

/**
 * Capabilities declared by the adapter for this provider config. The manager
 * reads these instead of branching on a provider type name.
 */
export function capabilitiesFor(config) {
    validateProviderConfig(config);
    return ADAPTER_TYPES[config.type].capabilities(config);
}

/**
 * Let the provider write the files a task needs before its first round.
 * Providers without task preparation return null.
 */
export function prepareTask(config, task, context) {
    validateProviderConfig(config);
    return ADAPTER_TYPES[config.type].prepareTask?.(task, context) ?? null;
}

/**
 * Create a provider adapter instance from a config.
 * @param options - adapter options, such as the DSH checkout or a test transport
 */
export function createAdapter(config, options = {}) {
    validateProviderConfig(config);
    return new ADAPTER_TYPES[config.type](config, options);
}

/**
 * Create a provider adapter by name from a directory.
 */
export function createAdapterFromDir(providersDir, name, {model, options} = {}) {
    const config = resolveProvider(providersDir, name, {model});
    return createAdapter(config, options);
}

/**
 * List all available provider names.
 */
export function listProviderNames(providersDir) {
    return [...loadProviders(providersDir).keys()];
}
