// Worker process: receives task runs from manager via IPC, executes one round
// of conversation through the appropriate provider adapter, and reports results.
// Two provider paths:
//   - "dsh-sdk": legacy DeepSeek via DSH SDK (stable, 34 tasks validated)
//   - "openai-chat": any OpenAI-compatible endpoint via direct HTTP

import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {config} from './common.mjs';
import {assertMaxTokens, budgetFileFor, writeRoundBudget} from './budget.mjs';
import {parseOptionalEffort} from './effort.mjs';
import {createAdapter} from '../src/providers/registry.mjs';
import {
    createRoundChannel,
    isRoundId,
} from '../src/runtime/protocol.mjs';

let harness, busy = false, closing = false;
let openaiAdapter = null; // Lazy-init per provider config
let activeAbort = null;
let closeFinished = false;

const send = data => { if (process.connected) process.send(data); };
const channel = createRoundChannel(send);
const runtimeIdentity = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ownerMarker: process.env.WAXWING_OWNER_MARKER ?? null,
    protocolVersion: 1,
};
send({kind: 'ready', ...runtimeIdentity});

async function finishClose() {
    if (closeFinished || busy) return;
    closeFinished = true;
    activeAbort?.abort();
    try {
        await harness?.close();
        send({kind: 'closed', roundId: null});
    } catch (e) {
        send({kind: 'close_error', roundId: null, error: String(e.message)});
        process.exitCode = 1;
    } finally {
        process.disconnect?.();
    }
}

function requestClose() {
    if (closing) return;
    closing = true;
    activeAbort?.abort();
    // An active provider run owns cleanup until it reaches `released`.
    // This avoids closing the harness while the provider is still writing.
    if (!busy) void finishClose();
}

process.on('disconnect', () => { if (!closeFinished) requestClose(); });
process.on('SIGTERM', () => { requestClose(); });

process.on('message', async message => {
    if (message.kind === 'close') { requestClose(); return; }
    if (message.kind !== 'run') return;
    if (!isRoundId(message.roundId)) {
        send({kind: 'protocol_error', error: 'run requires a valid roundId'});
        return;
    }
    if (busy || closing) {
        // Never drop a run silently. The manager treats this as a protocol
        // violation and keeps the previous round active until `released`.
        send({kind: 'worker_busy', roundId: message.roundId});
        return;
    }
    busy = true;
    channel.begin(message.roundId);
    try {
        channel.send('ack', {at: new Date().toISOString()});
        const task = message.task;
        const maxTokens = assertMaxTokens(
            message.maxTokens ?? task?.maxTokens ?? config.maxTokens,
            'round maxTokens'
        );
        const rawEffort = message.effort !== undefined ? message.effort : task?.effort;
        const effort = rawEffort === undefined || rawEffort === null
            ? undefined
            : parseOptionalEffort(rawEffort, 'round effort');

        // Determine provider type from task or fall back to DSH SDK
        const providerType = task?.provider?.type || 'dsh-sdk';

        if (providerType === 'openai-chat') {
            await runOpenAIChat(task, message.prompt, maxTokens, effort, message.signal);
        } else {
            await runDshSdk(task, message.prompt, maxTokens, message.budgetFile);
        }
    } catch (e) {
        for (const event of e.events ?? []) {
            channel.send('event', {notification: {params: {event}}});
        }
        channel.send('error', {
            error: String(e.message ?? e),
            finishReason: e.finishReason ?? 'error',
        });
    } finally {
        const finishedRound = channel.end();
        busy = false;
        send({kind: 'released', roundId: finishedRound});
        if (closing) await finishClose();
    }
});

// --- DSH SDK path (legacy DeepSeek, stable) ---
async function runDshSdk(task, prompt, maxTokens, budgetFile) {
    // Publish the round budget before any harness work so the mounted
    // task-budget plugin reads this round's value from the very first request.
    const bf = budgetFile ?? budgetFileFor(path.dirname(task.patch));
    writeRoundBudget(bf, maxTokens);

    if (!harness) {
        const {DeepSeekHarness} = await import(
            pathToFileURL(path.join(config.dshRepo, 'packages/sdk/client/lib/index.js')).href
        );
        harness = new DeepSeekHarness({
            dshBin: path.join(config.dshRepo, 'apps/cli/lib/bin.js'),
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
        });
        await harness.start();
        send({kind: 'ready', roundId: channel.roundId, ...runtimeIdentity});
    }

    const result = await harness.run(prompt, {
        sessionId: task.sessionId,
        onNotification: n => channel.send('event', {notification: n}),
    });

    const ending = result.events.filter(e => e.type === 'turn/end').at(-1);
    channel.send('result', {
        text: result.finalResponse,
        finishReason: ending?.data?.reason?.kind ?? 'unknown'
    });
}

// --- OpenAI-compatible HTTP path ---
async function runOpenAIChat(task, prompt, maxTokens, effort, signal) {
    // Lazy-init adapter from provider config
    if (!openaiAdapter) {
        const providerConfig = task.provider;
        // Resolve API key from environment variable if specified
        if (providerConfig.apiKeyEnv && !providerConfig.apiKey) {
            providerConfig.apiKey = process.env[providerConfig.apiKeyEnv];
        }
        openaiAdapter = createAdapter(providerConfig);
        openaiAdapter.validate();
    }

    send({kind: 'ready', roundId: channel.roundId, ...runtimeIdentity});

    // Build minimal tool set: Bash + file I/O
    const tools = buildMinimalTools();

    // Tool executor: runs inside worker process with task workspace as cwd
    const onToolCall = async (name, args) => executeTool(name, args, task.workspace);

    const controller = new AbortController();
    activeAbort = controller;
    try {
        const onEvent = event => channel.send('event', {notification: {params: {event}}});
        const result = await openaiAdapter.run({
            prompt,
            history: task.history || [],
            tools,
            maxTokens,
            effort,
            signal: signal ?? controller.signal,
            onToolCall,
            onEvent
        });

        channel.send('result', {
            text: result.text,
            finishReason: result.finishReason
        });
    } finally {
        if (activeAbort === controller) activeAbort = null;
    }
}

// Minimal tool set for OpenAI-compatible providers
function buildMinimalTools() {
    return [
        {
            name: 'bash',
            description: 'Execute a shell command and return its output. Runs in the task workspace directory.',
            input_schema: {
                type: 'object',
                properties: {
                    command: {type: 'string', description: 'The shell command to execute'}
                },
                required: ['command']
            }
        },
        {
            name: 'read_file',
            description: 'Read contents of a file (relative to workspace or absolute path)',
            input_schema: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: 'File path to read'}
                },
                required: ['path']
            }
        },
        {
            name: 'write_file',
            description: 'Write content to a file (relative to workspace or absolute path)',
            input_schema: {
                type: 'object',
                properties: {
                    path: {type: 'string', description: 'File path to write'},
                    content: {type: 'string', description: 'Content to write'}
                },
                required: ['path', 'content']
            }
        }
    ];
}

// Execute a tool call inside the worker process
import {exec} from 'node:child_process';
import {promisify} from 'node:util';
const execAsync = promisify(exec);

async function executeTool(name, args, workspace) {
    try {
        if (name === 'bash') {
            const cmd = args.command;
            if (!cmd || typeof cmd !== 'string') return {content: 'Error: command is required'};
            const {stdout, stderr} = await execAsync(cmd, {
                cwd: workspace,
                timeout: 60000,
                maxBuffer: 1024 * 1024,
                windowsHide: true
            });
            return {content: stdout + (stderr ? `\n[stderr]\n${stderr}` : '')};
        }
        if (name === 'read_file') {
            const p = args.path;
            if (!p || typeof p !== 'string') return {content: 'Error: path is required'};
            const fs = await import('node:fs');
            const path = await import('node:path');
            const fullPath = path.isAbsolute(p) ? p : path.join(workspace, p);
            // Prevent reading outside workspace unless absolute path given
            if (!path.isAbsolute(p) && !fullPath.startsWith(path.resolve(workspace))) {
                return {content: 'Error: path must stay inside the workspace'};
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            // Truncate large files
            return {content: content.length > 50000 ? content.slice(0, 50000) + '\n...[truncated]' : content};
        }
        if (name === 'write_file') {
            const p = args.path;
            if (!p || typeof p !== 'string') return {content: 'Error: path is required'};
            const fs = await import('node:fs');
            const path = await import('node:path');
            const fullPath = path.isAbsolute(p) ? p : path.join(workspace, p);
            if (!path.isAbsolute(p) && !fullPath.startsWith(path.resolve(workspace))) {
                return {content: 'Error: path must stay inside the workspace'};
            }
            fs.mkdirSync(path.dirname(fullPath), {recursive: true});
            fs.writeFileSync(fullPath, args.content || '', 'utf8');
            return {content: `Written ${args.content?.length || 0} bytes to ${p}`};
        }
        return {content: `Error: unknown tool "${name}"`};
    } catch (e) {
        return {content: `Error executing ${name}: ${e.message}`};
    }
}
