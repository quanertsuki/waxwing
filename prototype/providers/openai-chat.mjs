// OpenAI /v1/chat/completions provider adapter.
// Supports any OpenAI-compatible endpoint (RL2 gateway, DeepSeek official, etc.).
// Reuses conversion logic from rl2_proxy.cjs but runs in-process without HTTP proxy.

import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import {ProviderAdapter} from './base.mjs';

function genId(prefix) {
    return prefix + crypto.randomBytes(12).toString('hex');
}

function estimateTokens(obj) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return Math.max(1, Math.round(s.length / 3.2));
}

// Convert Anthropic message history to OpenAI format
function toOpenAIMessages(body) {
    const out = [];
    const sys = body.system;
    if (sys) {
        const text = typeof sys === 'string' ? sys
            : Array.isArray(sys) ? sys.map(b => (typeof b === 'string' ? b : b?.text) || '').join('\n')
            : String(sys);
        if (text.trim()) out.push({role: 'system', content: text});
    }
    for (const msg of body.messages || []) {
        const role = msg.role;
        let content = msg.content;
        if (typeof content === 'string') content = [{type: 'text', text: content}];
        if (!Array.isArray(content)) content = [];
        if (role === 'assistant') {
            const text = content.filter(b => b?.type === 'text').map(b => b.text || '').join('');
            const toolUses = content.filter(b => b?.type === 'tool_use');
            const m = {role: 'assistant', content: text || null};
            if (toolUses.length) {
                m.tool_calls = toolUses.map(tu => ({
                    id: tu.id || genId('call_'),
                    type: 'function',
                    function: {name: tu.name, arguments: JSON.stringify(tu.input || {})}
                }));
            }
            out.push(m);
        } else if (role === 'user') {
            const toolResults = content.filter(b => b?.type === 'tool_result');
            const others = content.filter(b => !b || b.type !== 'tool_result');
            for (const tr of toolResults) {
                out.push({role: 'tool', tool_call_id: tr.tool_use_id, content: stringifyToolResult(tr.content)});
            }
            const parts = contentToParts(others);
            if (parts.length) {
                const onlyText = parts.every(p => p.type === 'text');
                out.push({role: 'user', content: onlyText ? parts.map(p => p.text).join('\n') : parts});
            }
        } else if (role === 'system') {
            out.push({role: 'system', content: stringifyToolResult(msg.content)});
        }
    }
    return out;
}

function contentToParts(blocks) {
    const parts = [];
    for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') parts.push({type: 'text', text: b.text || ''});
        else if (b.type === 'image' && b.source) {
            if (b.source.type === 'base64') {
                parts.push({type: 'image_url', image_url: {url: `data:${b.source.media_type};base64,${b.source.data}`}});
            } else if (b.source.type === 'url') {
                parts.push({type: 'image_url', image_url: {url: b.source.url}});
            }
        }
    }
    return parts;
}

function stringifyToolResult(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(c => {
            if (!c || typeof c !== 'object') return '';
            if (c.type === 'text') return c.text || '';
            if (c.type === 'image') return '[image]';
            return '';
        }).filter(Boolean).join('\n');
    }
    if (content == null) return '';
    return JSON.stringify(content);
}

function toOpenAITools(tools) {
    if (!Array.isArray(tools) || !tools.length) return undefined;
    return tools.filter(t => t?.name).map(t => ({
        type: 'function',
        function: {name: t.name, description: t.description || '', parameters: t.input_schema || {type: 'object', properties: {}}}
    }));
}

function buildOpenAIRequest(body, stream) {
    const req = {
        model: body.model || 'llm-default',
        messages: toOpenAIMessages(body),
        stream
    };
    const tools = toOpenAITools(body.tools);
    if (tools) req.tools = tools;
    if (typeof body.max_tokens === 'number') req.max_tokens = body.max_tokens;
    if (typeof body.temperature === 'number') req.temperature = body.temperature;
    if (typeof body.top_p === 'number') req.top_p = body.top_p;
    if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) req.stop = body.stop_sequences;
    return req;
}

function mapStopReason(r, hasToolUse) {
    if (hasToolUse) return 'tool_use';
    switch (r) {
        case 'length': return 'max_tokens';
        case 'tool_calls': return 'tool_use';
        case 'content_filter': return 'end_turn';
        default: return 'end_turn';
    }
}

function normalizeFinishReason(reason) {
    switch (reason) {
        case undefined:
        case null:
        case '':
        case 'stop':
        case 'end_turn': return 'completed';
        case 'length': return 'max_tokens';
        case 'content_filter': return 'content_filtered';
        case 'tool_calls':
        case 'function_call': return 'tool_use';
        default: return String(reason);
    }
}

function messageText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (Array.isArray(message?.content)) {
        return message.content.map(part => {
            if (typeof part === 'string') return part;
            return part?.type === 'text' ? part.text || '' : '';
        }).join('');
    }
    return '';
}

function providerError(message, finishReason, events) {
    const error = new Error(message);
    error.finishReason = finishReason;
    error.events = events;
    return error;
}

function endpointUrl(baseUrl) {
    const base = baseUrl.replace(/\/+$/, '');
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function applyStreamEvent(state, event, onActivity) {
    if (event.error) throw new Error(event.error.message || 'Provider streaming error');
    state.id = event.id || state.id;
    state.created = event.created || state.created;
    state.model = event.model || state.model;
    const choice = event.choices?.[0];
    if (choice) {
        const delta = choice.delta || {};
        if (delta.content) state.content += messageText({content: delta.content});
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string') state.reasoning += reasoning;
        for (const toolCall of delta.tool_calls || []) {
            const index = Number.isInteger(toolCall.index) ? toolCall.index : state.toolCalls.size;
            const accumulated = state.toolCalls.get(index) || {
                id: '',
                type: 'function',
                function: {name: '', arguments: ''},
            };
            if (toolCall.id) accumulated.id = toolCall.id;
            if (toolCall.type) accumulated.type = toolCall.type;
            if (toolCall.function?.name) accumulated.function.name += toolCall.function.name;
            if (toolCall.function?.arguments) accumulated.function.arguments += toolCall.function.arguments;
            state.toolCalls.set(index, accumulated);
            state.toolCallDeltas++;
        }
        state.finishReason = choice.finish_reason ?? state.finishReason;
    }
    state.usage = event.usage ?? state.usage;
    onActivity?.();
}

function responseFromStream(state) {
    const toolCalls = [...state.toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => ({
            ...toolCall,
            id: toolCall.id || genId('call_'),
        }));
    const message = {content: state.content || null};
    if (state.reasoning) message.reasoning_content = state.reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
        id: state.id || genId('msg_'),
        model: state.model || undefined,
        created: state.created || undefined,
        choices: [{message, finish_reason: state.finishReason}],
        usage: state.usage || {},
    };
}

function openaiToAnthropic(json, modelName) {
    const choice = json.choices?.[0] || {};
    const message = choice.message || {};
    const content = [];
    if (message.reasoning_content) {
        content.push({type: 'thinking', thinking: message.reasoning_content, signature: 'openai-chat'});
    }
    if (message.content) content.push({type: 'text', text: message.content});
    let hasToolUse = false;
    for (const tc of message.tool_calls || []) {
        hasToolUse = true;
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
        content.push({type: 'tool_use', id: tc.id || genId('toolu_'), name: tc.function.name, input});
    }
    const usage = json.usage || {};
    return {
        id: json.id || genId('msg_'),
        type: 'message',
        role: 'assistant',
        model: modelName,
        content,
        stop_reason: mapStopReason(choice.finish_reason, hasToolUse),
        stop_sequence: null,
        usage: {
            input_tokens: usage.prompt_tokens || 0,
            output_tokens: usage.completion_tokens || 0,
            ...(usage.prompt_tokens_details?.cached_tokens ? {cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens} : {})
        }
    };
}

function callEndpoint(url, body, apiKey, signal, onProgress) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const parsed = new URL(url);
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        const startedAt = Date.now();
        let settled = false;
        let lastProgressAt = 0;
        let request;
        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const succeed = value => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const onAbort = () => {
            fail(new Error('Aborted'));
            request?.destroy();
        };
        if (signal?.aborted) {
            fail(new Error('Aborted'));
            return;
        }
        signal?.addEventListener?.('abort', onAbort, {once: true});

        request = mod.request({
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            timeout: 600000,
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Accept': body.stream ? 'text/event-stream, application/json' : 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            const contentType = String(res.headers['content-type'] || '');
            const streaming = contentType.includes('text/event-stream');
            res.setEncoding('utf8');
            if (!streaming) {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => succeed({status: res.statusCode, raw, json: null}));
                res.on('error', fail);
                return;
            }

            const state = {
                id: null,
                created: null,
                model: null,
                content: '',
                reasoning: '',
                toolCalls: new Map(),
                toolCallDeltas: 0,
                finishReason: null,
                usage: null,
            };
            let pending = '';
            const reportProgress = force => {
                if (!onProgress) return;
                const now = Date.now();
                if (!force && now - lastProgressAt < 2000) return;
                lastProgressAt = now;
                onProgress({
                    elapsedMs: now - startedAt,
                    reasoningChars: state.reasoning.length,
                    contentChars: state.content.length,
                    toolCallDeltas: state.toolCallDeltas,
                });
            };
            const consumeLine = line => {
                if (!line.startsWith('data:')) return;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') return;
                try {
                    applyStreamEvent(state, JSON.parse(payload), () => reportProgress(false));
                } catch (error) {
                    throw new Error(`Invalid streaming response: ${error.message}`);
                }
            };
            res.on('data', chunk => {
                pending += chunk;
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || '';
                try {
                    for (const line of lines) consumeLine(line);
                } catch (error) {
                    fail(error);
                    res.destroy();
                }
            });
            res.on('end', () => {
                try {
                    if (pending.trim()) consumeLine(pending.trim());
                    succeed({status: res.statusCode, raw: null, json: responseFromStream(state)});
                } catch (error) {
                    fail(error);
                }
            });
            res.on('error', fail);
        });
        request.on('timeout', () => {
            fail(new Error('Request timeout'));
            request.destroy();
        });
        request.on('error', fail);
        request.write(data);
        request.end();
    });
}

export class OpenAIChatAdapter extends ProviderAdapter {
    constructor(config) {
        super(config);
        this.baseUrl = config.baseUrl;
        this.apiKey = config.apiKey;
        this.model = config.model || 'llm-default';
        this.stream = config.stream !== false;
        this.maxToolRequests = config.maxToolRequests ?? null;
        if (this.maxToolRequests !== null &&
            (!Number.isSafeInteger(this.maxToolRequests) || this.maxToolRequests < 0)) {
            throw new Error('maxToolRequests must be a nonnegative safe integer');
        }
        if (this.maxToolRequests === 0) this.maxToolRequests = null;
    }

    validate() {
        if (!this.baseUrl) throw new Error('baseUrl is required');
        if (!this.apiKey) throw new Error('apiKey is required');
    }

    async run({prompt, history, tools, maxTokens, effort, signal, onToolCall, onEvent}) {
        this.validate();

        // Build OpenAI-format message array from Anthropic history
        const messages = toOpenAIMessages({
            system: '',
            messages: [...(history || []), {role: 'user', content: prompt}]
        });
        const openaiTools = toOpenAITools(tools || []);

        const url = endpointUrl(this.baseUrl);
        const allEvents = [];
        let requestCount = 0;
        const emit = event => onEvent?.(event);

        for (;;) {
            if (this.maxToolRequests !== null && requestCount >= this.maxToolRequests) {
                throw providerError(
                    `OpenAI tool call limit reached after ${requestCount} requests without a final assistant message`,
                    'tool_call_limit',
                    allEvents,
                );
            }
            requestCount++;

            const req = {
                model: this.model,
                messages,
                max_tokens: maxTokens,
                stream: this.stream
            };
            if (this.stream) req.stream_options = {include_usage: true};
            if (this.config.supportsReasoning && effort) req.reasoning_effort = effort;
            if (openaiTools) req.tools = openaiTools;

            const requestStartedAt = Date.now();
            emit({type: 'provider/request-start', time: requestStartedAt,
                data: {request: requestCount, stream: this.stream}});
            let result;
            try {
                result = await callEndpoint(url, req, this.apiKey, signal, progress => {
                    emit({type: 'provider/progress', time: Date.now(),
                        data: {request: requestCount, ...progress}});
                });
            } catch (error) {
                emit({type: 'provider/request-failed', time: Date.now(),
                    data: {request: requestCount, elapsedMs: Date.now() - requestStartedAt,
                        error: error.message}});
                throw error;
            }
            if (result.status !== 200) {
                const detail = result.raw?.slice(0, 500) ?? JSON.stringify(result.json).slice(0, 500);
                emit({type: 'provider/request-failed', time: Date.now(),
                    data: {request: requestCount, elapsedMs: Date.now() - requestStartedAt, status: result.status}});
                throw new Error(`OpenAI API error ${result.status}: ${detail}`);
            }

            let json = result.json;
            if (!json) {
                try {
                    json = JSON.parse(result.raw);
                } catch (error) {
                    emit({type: 'provider/request-failed', time: Date.now(),
                        data: {request: requestCount, elapsedMs: Date.now() - requestStartedAt,
                            error: 'Response is not valid JSON'}});
                    throw new Error(`OpenAI response is not valid JSON: ${error.message}`);
                }
            }
            const usageEvents = this.buildUsageEvents(json);
            for (const event of usageEvents) {
                allEvents.push(event);
                emit(event);
            }

            const choice = json.choices?.[0] || {};
            const msg = choice.message || {};
            emit({type: 'provider/request-complete', time: Date.now(),
                data: {request: requestCount, elapsedMs: Date.now() - requestStartedAt,
                    finishReason: choice.finish_reason ?? null,
                    toolCalls: msg.tool_calls?.length ?? 0}});

            // No tool calls: done
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                const finalText = messageText(msg) || msg.reasoning_content || '';
                const finalStopReason = normalizeFinishReason(choice.finish_reason);
                if (!finalText.trim()) {
                    const reason = finalStopReason === 'completed' ? 'empty_response' : finalStopReason;
                    throw providerError(
                        `OpenAI returned an empty final assistant message (finish_reason=${choice.finish_reason ?? 'missing'})`,
                        reason,
                        allEvents,
                    );
                }
                return {
                    text: finalText,
                    finishReason: finalStopReason,
                    events: allEvents
                };
            }

            // Tool calls: append assistant message with tool_calls, then execute tools
            messages.push({
                role: 'assistant',
                content: msg.content || null,
                tool_calls: msg.tool_calls
            });

            for (const tc of msg.tool_calls) {
                const fnName = tc.function?.name || 'unknown';
                let fnArgs = {};
                try { fnArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                // onToolCall must return {content: string} or string
                const toolResult = onToolCall ? await onToolCall(fnName, fnArgs) : {content: `[Tool ${fnName} not executed: no handler]`};
                const content = typeof toolResult === 'string' ? toolResult : (toolResult?.content || '');
                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content
                });
            }
        }
    }

    buildUsageEvents(response) {
        const usage = response.usage || {};
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
        const uncachedInput = (usage.prompt_tokens || 0) - cachedTokens;

        return [{
            type: 'assistant/message',
            time: (response.created || Math.floor(Date.now() / 1000)) * 1000,
            data: {
                usage: {
                    inputTokens: Math.max(0, uncachedInput),
                    cacheReadTokens: cachedTokens,
                    cacheWriteTokens: 0,
                    outputTokens: usage.completion_tokens || 0,
                    totalTokens: usage.total_tokens || 0
                },
                message: {
                    id: response.id || genId('msg_'),
                    source: {provider: this.name, model: response.model || this.model}
                }
            }
        }];
    }
}

export default OpenAIChatAdapter;
