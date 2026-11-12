// DSH SDK provider adapter.
//
// The DSH harness is a long-lived child process: one Worker process keeps one
// session for the task, so a rework round resumes the same session. The task's
// runtime patch and the per-round budget file exist only because this provider
// needs them; both are declared through capabilities and written here rather
// than in the manager.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {ProviderAdapter} from './base.mjs';
import {budgetFileFor, writeRoundBudget} from '../../tasks/budget.mjs';

// `src/providers/budget-plugin.mjs`, mounted by absolute path. The plugin reads
// only the task's own budget file; it does not touch the DSH installation.
const BUDGET_PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'budget-plugin.mjs')
    .replaceAll('\\', '/');

export class DshSdkAdapter extends ProviderAdapter {
    static capabilities() {
        return {effort: false, sessionContinuity: true, budgetPatch: true};
    }

    /**
     * Write the runtime patch list this task's harness starts with. No
     * credential copying: the runtime reads the configured credential store.
     */
    static prepareTask(task, {directory, credentialsFile}) {
        const patch = [
            {id: 'credentials', config: {path: path.resolve(credentialsFile), watch: false}},
            {id: 'session-log-deepseek', config: {enabled: false}},
            {id: 'session-telemetry-otel', disabled: true},
            {id: 'session-title-llm', disabled: true},
            {id: 'spill-local', config: {root: path.join(directory, 'tmp', 'spill')}},
            {id: 'sdk-jsonrpc-server', config: {maxTokensAsSuccess: false}},
            // A new plugin row must be inserted; a flat {id} row would be an
            // override targeting an existing entry and would never mount.
            {insert: [
                {id: 'task-budget', name: BUDGET_PLUGIN,
                    config: {budgetFile: budgetFileFor(directory).replaceAll('\\', '/')}},
            ]},
        ];
        fs.writeFileSync(task.patch, JSON.stringify(patch, null, 2)); // JSON is a valid YAML patch list.
    }

    /**
     * @param options.dshRepo - DSH checkout that contains the SDK client
     * @param options.createHarness - injectable harness factory for tests
     */
    constructor(config, {dshRepo, createHarness} = {}) {
        super(config);
        this.dshRepo = dshRepo;
        this.createHarness = createHarness ?? null;
        this.harness = null;
    }

    async #harness(task, maxTokens) {
        if (this.harness) return this.harness;
        if (!this.dshRepo && !this.createHarness) {
            throw new Error('dshRepo is required for the DSH SDK provider');
        }
        const options = {
            dshBin: this.dshRepo && path.join(this.dshRepo, 'apps/cli/lib/bin.js'),
            profile: 'sdk',
            dshHome: task.home,
            cwd: task.workspace,
            processCwd: task.workspace,
            provider: 'deepseek-official',
            model: task.model,
            maxTokens,
            patches: [task.patch],
            env: {...process.env, DSH_HOME: task.home},
            initializeTimeoutMs: 60000,
            shutdownTimeoutMs: 4000,
            disposeEofGraceMs: 6000,
        };
        const create = this.createHarness ?? (async value => {
            const {DeepSeekHarness} = await import(
                pathToFileURL(path.join(this.dshRepo, 'packages/sdk/client/lib/index.js')).href
            );
            return new DeepSeekHarness(value);
        });
        const harness = await create(options);
        await harness.start();
        this.harness = harness;
        return harness;
    }

    async run({prompt, maxTokens, task, budgetFile, onEvent, onStart}) {
        if (!task || typeof task !== 'object') throw new Error('DSH SDK run requires a task record');
        // Publish the round budget before any harness work so the mounted
        // task-budget plugin reads this round's value from the first request.
        writeRoundBudget(budgetFile ?? budgetFileFor(path.dirname(task.patch)), maxTokens);

        const firstStart = !this.harness;
        const harness = await this.#harness(task, maxTokens);
        if (firstStart) onStart?.();

        const result = await harness.run(prompt, {
            sessionId: task.sessionId,
            onNotification: n => onEvent?.(n?.params?.event ?? n?.event ?? n),
        });
        const ending = result.events?.filter(event => event.type === 'turn/end').at(-1);
        return {
            text: result.finalResponse,
            finishReason: ending?.data?.reason?.kind ?? 'unknown',
        };
    }

    async close() {
        const harness = this.harness;
        this.harness = null;
        if (harness) await harness.close();
    }
}

export default DshSdkAdapter;
