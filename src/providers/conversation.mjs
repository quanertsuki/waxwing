// Durable conversation for adapters that keep continuity in a file
// (`sessionContinuity: 'file'`), so a rework round sees what earlier rounds did
// even when it runs in a new Worker process or after a manager restart.
//
// Ownership. The manager owns the task run directory and decides whether a
// round continues: it names `runs/<id>/conversation.jsonl` in the run message
// and removes the file before a first-round Provider fallback, which starts a
// fresh conversation on a different model. The adapter owns what was said: it
// reads the file at round start and rewrites it once at round end, failed
// rounds included. Writing on the Worker side keeps full transcripts (tool
// output included) off the IPC channel and out of `task.json`, which feeds
// bounded status views. The release gate lets only one round per task touch the
// file, and the adapter writes before the Worker sends `result`, so the next
// round reads a complete file.
//
// Format. One JSON line per finished round, the whole file replaced atomically:
//   {"version":1,"roundId":"round-…","provider":"magpie","model":"m",
//    "finishReason":"completed","messages":[…OpenAI chat messages…]}
// `messages` starts with the round's user prompt and holds complete
// tool-call/tool-result pairs only. A file that does not parse or breaks that
// shape is reported and treated as empty; it is never partly trusted.
//
// Window. A request is fitted to the provider's `contextWindow` with a
// deliberately high estimate (UTF-8 bytes / 3). Whole rounds go first, oldest
// first; then the oldest tool exchanges of the current round, never its prompt
// or latest exchange. A system note says how much was left out. When the prompt
// plus the latest exchange still cannot fit, the round fails with
// `context_overflow` rather than sending a request that cannot succeed. The
// file itself keeps every round; only the request is bounded.
import path from 'node:path';
import {DEFAULT_FILES, atomicWriteText} from '../storage/durable-file.mjs';

export const CONVERSATION_FILE_NAME = 'conversation.jsonl';
const VERSION = 1;
const ROLES = new Set(['user', 'assistant', 'tool', 'system']);

export function conversationFileFor(taskDirectory) {
  return path.join(taskDirectory, CONVERSATION_FILE_NAME);
}

/**
 * Keep the longest prefix in which every assistant tool call has its result.
 * A round that failed between a tool call and its results ends cleanly at the
 * last complete exchange; a stray tool result ends the prefix as well.
 */
export function completePairs(messages) {
  let kept = 0;
  let open = new Set();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === 'tool') {
      if (!open.delete(message.tool_call_id)) break;
    } else {
      if (open.size) break;
      if (message?.role === 'assistant' && message.tool_calls?.length) {
        open = new Set(message.tool_calls.map(call => call.id));
      }
    }
    if (!open.size) kept = index + 1;
  }
  return messages.slice(0, kept);
}

function validRound(value) {
  if (!value || typeof value !== 'object' || value.version !== VERSION) return false;
  const {messages} = value;
  if (!Array.isArray(messages) || messages[0]?.role !== 'user') return false;
  if (!messages.every(message => ROLES.has(message?.role))) return false;
  return completePairs(messages).length === messages.length;
}

/** @returns {{rounds: object[], error: string|null}} */
export function readConversation(file, {files = DEFAULT_FILES} = {}) {
  let text;
  try {
    text = files.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {rounds: [], error: null};
    return {rounds: [], error: `conversation file unreadable: ${error.message}`};
  }
  const rounds = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { value = null; }
    if (!validRound(value)) {
      return {rounds: [], error: `conversation file line ${index + 1} is not a valid round; starting fresh`};
    }
    rounds.push(value);
  }
  return {rounds, error: null};
}

export function saveConversation(file, rounds, {files = DEFAULT_FILES} = {}) {
  const text = rounds.map(round => `${JSON.stringify({version: VERSION, ...round})}\n`).join('');
  return atomicWriteText(file, text, {files});
}

/** A fresh conversation: the next round starts without history. */
export function resetConversation(file, {files = DEFAULT_FILES} = {}) {
  files.rmSync(file, {force: true});
}

/** Deliberately high token estimate: real tokenizers average more bytes per token. */
export function estimateTokens(value) {
  if (value === undefined || value === null) return 0;
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

function overflow(message) {
  const error = new Error(message);
  error.finishReason = 'context_overflow';
  return error;
}

/** Split a round body (everything after its prompt) into indivisible exchanges. */
function exchanges(messages) {
  const groups = [];
  for (const message of messages) {
    if (message.role === 'tool' && groups.length) groups.at(-1).push(message);
    else groups.push([message]);
  }
  return groups;
}

function omissionNote(rounds, exchangeCount) {
  const parts = [];
  if (rounds) parts.push(`${rounds} earlier round${rounds === 1 ? '' : 's'}`);
  if (exchangeCount) parts.push(`${exchangeCount} earlier tool exchange${exchangeCount === 1 ? '' : 's'} of this round`);
  return {
    role: 'system',
    content: `${parts.join(' and ')} of this conversation were left out to fit the context window. ` +
      'Re-read files or rerun commands if you need that information.',
  };
}

/** Upper bound for the note, so adding it can never push a fitted request over. */
const NOTE_RESERVE = estimateTokens(omissionNote(999, 999));

/**
 * Build the messages for one request.
 * @param history - stored rounds, oldest first
 * @param current - this round so far: its prompt, then complete exchanges
 * @param contextWindow - provider window in tokens; absent means no trimming
 * @param maxTokens - output budget reserved inside the window
 * @param tools - the request's tool schema, which also occupies the window
 * @returns {{messages: object[], omitted: {rounds: number, exchanges: number}}}
 */
export function fitConversation({history = [], current, contextWindow, maxTokens = 0, tools}) {
  const [prompt, ...body] = current;
  if (!contextWindow) {
    return {
      messages: [...history.flatMap(round => round.messages), ...current],
      omitted: {rounds: 0, exchanges: 0},
    };
  }
  const limit = contextWindow - maxTokens - estimateTokens(tools);
  const rounds = history.map(round => ({messages: round.messages, tokens: estimateTokens(round.messages)}));
  const groups = exchanges(body).map(messages => ({messages, tokens: estimateTokens(messages)}));
  const promptTokens = estimateTokens(prompt);
  const sum = items => items.reduce((total, item) => total + item.tokens, 0);
  let omittedRounds = 0, omittedExchanges = 0;
  const size = () => sum(rounds) + promptTokens + sum(groups) +
    (omittedRounds || omittedExchanges ? NOTE_RESERVE : 0);

  while (size() > limit && rounds.length) { rounds.shift(); omittedRounds++; }
  while (size() > limit && groups.length > 1) { groups.shift(); omittedExchanges++; }
  if (size() > limit) {
    throw overflow(`Request needs about ${size()} input tokens but the context window of ${contextWindow} ` +
      `leaves ${Math.max(0, limit)} after the ${maxTokens}-token output budget and tool schema`);
  }
  const messages = [
    ...rounds.flatMap(round => round.messages),
    prompt,
    ...groups.flatMap(group => group.messages),
  ];
  if (omittedRounds || omittedExchanges) messages.unshift(omissionNote(omittedRounds, omittedExchanges));
  return {messages, omitted: {rounds: omittedRounds, exchanges: omittedExchanges}};
}
