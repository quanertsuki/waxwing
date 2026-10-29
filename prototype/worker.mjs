// Worker process: receives task runs from manager via IPC, executes one round
// of conversation through the Provider adapter that task names, and reports
// results. The Worker never branches on a provider type: the registry resolves
// the adapter, and the adapter's capabilities decide what a round receives.

import {getConfig} from './common.mjs';
import {assertMaxTokens} from './budget.mjs';
import {parseOptionalEffort} from './effort.mjs';
import {createAdapterCache} from '../src/providers/adapter-cache.mjs';
import {DEFAULT_PROVIDER_NAME, resolveProvider} from './providers/registry.mjs';
import {buildMinimalTools, executeTool} from '../src/worker/tools.mjs';
import {
    ROUND_PROTOCOL_VERSION,
    ackMessage,
    closeErrorMessage,
    closedMessage,
    createRoundChannel,
    errorMessage,
    eventMessage,
    parseRunMessage,
    protocolErrorMessage,
    readyMessage,
    releasedMessage,
    resultMessage,
    workerBusyMessage,
} from '../src/runtime/protocol.mjs';

let busy = false, closing = false;
// Keyed by the current round's Provider: a fallback in the same Worker process
// must not keep calling the Provider that just failed. The cache is built on
// first use so importing this process's helpers never reads configuration.
let adapters = null;
const adapterCache = () => adapters ??= createAdapterCache({adapterOptions: {dshRepo: getConfig().dshRepo}});
let activeAbort = null;
let closeFinished = false;

const send = data => { if (process.connected) process.send(data); };
const channel = createRoundChannel(send);
const runtimeIdentity = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ownerMarker: process.env.WAXWING_OWNER_MARKER ?? null,
    protocolVersion: ROUND_PROTOCOL_VERSION,
};
send(readyMessage(runtimeIdentity));

async function finishClose() {
    if (closeFinished || busy) return;
    closeFinished = true;
    activeAbort?.abort();
    try {
        await adapters?.closeAll();
        send(closedMessage());
    } catch (e) {
        send(closeErrorMessage({error: String(e.message)}));
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
    if (!message || typeof message !== 'object') return;
    if (message.kind === 'close') { requestClose(); return; }
    // The manager only dispatches `run` and `close`; an unknown kind is ignored
    // rather than answered, so a stray message cannot disturb the open round.
    if (message.kind !== 'run') return;
    const run = parseRunMessage(message);
    if (!run.ok) {
        send(protocolErrorMessage({error: run.reason}));
        return;
    }
    if (busy || closing) {
        // Never drop a run silently. The manager treats this as a protocol
        // violation and keeps the previous round active until `released`.
        send(workerBusyMessage({roundId: message.roundId}));
        return;
    }
    busy = true;
    channel.begin(message.roundId);
    try {
        channel.send('ack', ackMessage());
        const task = message.task;
        const maxTokens = assertMaxTokens(
            message.maxTokens ?? task?.maxTokens ?? getConfig().maxTokens,
            'round maxTokens'
        );
        const rawEffort = message.effort !== undefined ? message.effort : task?.effort;
        const effort = rawEffort === undefined || rawEffort === null
            ? undefined
            : parseOptionalEffort(rawEffort, 'round effort');

        const provider = task?.provider
            ?? resolveProvider(getConfig().providersDir, DEFAULT_PROVIDER_NAME, {model: getConfig().model});
        const adapter = adapterCache().adapterFor(provider);
        const capabilities = adapter.capabilities ?? {};
        const controller = new AbortController();
        activeAbort = controller;
        try {
            const result = await adapter.run({
                prompt: message.prompt,
                history: task?.history || [],
                tools: buildMinimalTools(),
                maxTokens,
                // Only a provider that declares effort receives it.
                effort: capabilities.effort ? effort : undefined,
                signal: controller.signal,
                task,
                budgetFile: message.budgetFile,
                onToolCall: (name, args) => executeTool(name, args, task?.workspace),
                onEvent: event => channel.send('event', eventMessage(event)),
                // The DSH harness starts its session lazily on the first round.
                onStart: () => send(readyMessage({...runtimeIdentity, roundId: channel.roundId})),
            });
            channel.send('result', resultMessage({
                text: result.text,
                finishReason: result.finishReason,
            }));
        } finally {
            if (activeAbort === controller) activeAbort = null;
        }
    } catch (e) {
        // Provider events are streamed exactly once through onEvent; do not
        // replay `e.events` here or the journal sees each message twice.
        channel.send('error', errorMessage({
            error: String(e.message ?? e),
            finishReason: e.finishReason ?? 'error',
        }));
    } finally {
        const finishedRound = channel.end();
        busy = false;
        send(releasedMessage({roundId: finishedRound}));
        if (closing) await finishClose();
    }
});
