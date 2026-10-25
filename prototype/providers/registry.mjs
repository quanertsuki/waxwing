// Provider registry: enumerate, load, and validate provider configurations.
// Provider configs are stored as individual JSON files in providersDir.

import fs from 'node:fs';
import path from 'node:path';
import {OpenAIChatAdapter} from './openai-chat.mjs';

const ADAPTER_TYPES = {
    'openai-chat': OpenAIChatAdapter,
    // DSH SDK is handled natively in worker.mjs, not through an adapter
    // Future adapters register here:
    // 'anthropic-native': AnthropicNativeAdapter,
    // 'openai-responses': OpenAIResponsesAdapter,
};

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
    // dsh-sdk is handled natively in worker.mjs
    if (config.type !== 'dsh-sdk' && !ADAPTER_TYPES[config.type]) {
        throw new Error(`Provider ${config.name}: unknown type "${config.type}". Supported: ${Object.keys(ADAPTER_TYPES).join(', ')}, dsh-sdk`);
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
 * Create a provider adapter instance from a config.
 */
export function createAdapter(config) {
    validateProviderConfig(config);
    const AdapterClass = ADAPTER_TYPES[config.type];
    return new AdapterClass(config);
}

/**
 * Create a provider adapter by name from a directory.
 */
export function createAdapterFromDir(providersDir, name) {
    const config = loadProvider(providersDir, name);
    return createAdapter(config);
}

/**
 * List all available provider names.
 */
export function listProviderNames(providersDir) {
    return [...loadProviders(providersDir).keys()];
}
