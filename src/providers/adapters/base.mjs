// Provider adapter interface.
// Every provider type implements this class and registers in registry.mjs.
// New protocol adapters (e.g. anthropic-native, openai-responses) should
// subclass ProviderAdapter and register in registry.mjs.

export class ProviderAdapter {
    /**
     * Declarative capabilities for one provider config. The manager reads these
     * instead of branching on a provider type name, and the Worker passes only
     * the options the adapter declares.
     *
     * effort: reasoning effort is sent to the endpoint
     * sessionContinuity: how a rework round sees earlier rounds — false (it
     *   does not), 'process' (a session held by this Worker process), or
     *   'file' (the task's conversation file, which any Worker can read; the
     *   manager names it in the run message)
     * budgetPatch: the task needs a runtime patch plus a per-round budget file
     */
    static capabilities() {
        return {effort: false, sessionContinuity: false, budgetPatch: false};
    }

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

    /** Capabilities of this instance, resolved from its config. */
    get capabilities() {
        return this.constructor.capabilities(this.config);
    }

    /**
     * Execute one round of conversation.
     * @param {object} params
     * @param {string} params.prompt - User prompt (may include execution policy)
     * @param {string} [params.conversationFile] - The task's conversation
     *   file, when the provider declares sessionContinuity 'file'
     * @param {string} [params.roundId] - The round being run
     * @param {Array} params.tools - Available tools in Anthropic format
     * @param {number} params.maxTokens - Output token budget for this round
     * @param {AbortSignal} params.signal - Cancellation signal
     * @param {object} params.task - The task record the round belongs to
     * @param {string} [params.budgetFile] - Per-round budget file, when the
     *   provider declares budgetPatch
     * @param {function} [params.onEvent] - Receives one bare DSH-format event
     *   per Provider activity. The Worker wraps it for the round protocol.
     * @param {function} [params.onToolCall] - Executes one tool call
     * @param {function} [params.onStart] - Called once when a session starts
     * @returns {Promise<{text: string, finishReason: string}>}
     *   text: Final assistant response text
     *   finishReason: 'completed' | 'error' | 'max_tokens' | etc.
     */
    async run(params) {
        throw new Error('ProviderAdapter.run() must be implemented by subclass');
    }

    /**
     * Release any process, socket, or session this adapter owns. Called once
     * when the Worker closes; the default does nothing.
     */
    async close() {
        // Nothing to release.
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
