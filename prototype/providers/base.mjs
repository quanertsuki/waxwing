// Provider adapter interface.
// Every provider type must extend this class and implement the abstract methods.
// New protocol adapters (e.g. anthropic-native, openai-responses) should
// subclass ProviderAdapter and register in registry.mjs.

export class ProviderAdapter {
    /**
     * @param {object} config - Provider configuration from providers/*.json
     * @param {string} config.name - Unique provider name
     * @param {string} config.type - Provider type identifier
     */
    constructor(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Provider config must be an object');
        }
        if (!config.name || typeof config.name !== 'string') {
            throw new Error('Provider config requires a name');
        }
        this.config = config;
        this.name = config.name;
    }

    /**
     * Execute one round of conversation.
     * @param {object} params
     * @param {string} params.prompt - User prompt (may include execution policy)
     * @param {Array} params.history - Conversation history in Anthropic format
     * @param {Array} params.tools - Available tools in Anthropic format
     * @param {number} params.maxTokens - Output token budget for this round
     * @param {AbortSignal} params.signal - Cancellation signal
     * @returns {Promise<{text: string, finishReason: string, events: Array}>}
     *   text: Final assistant response text
     *   finishReason: 'completed' | 'error' | 'timeout' | etc.
     *   events: Array of DSH-format events for usage tracking
     */
    async run(params) {
        throw new Error('ProviderAdapter.run() must be implemented by subclass');
    }

    /**
     * Build DSH-format usage events from a raw API response.
     * These events are written to events.jsonl and parsed by usage.mjs.
     * @param {object} response - Raw API response
     * @returns {Array} - Array of DSH-format event objects
     */
    buildUsageEvents(response) {
        throw new Error('ProviderAdapter.buildUsageEvents() must be implemented by subclass');
    }

    /**
     * Validate that this provider is properly configured.
     * Called before first use. Should throw on invalid config.
     */
    validate() {
        // Default: no additional validation
    }
}

export default ProviderAdapter;
