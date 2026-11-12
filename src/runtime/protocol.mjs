import {randomUUID} from 'node:crypto';

export const ROUND_PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_STALE_MS = 20_000;
export const DEFAULT_ACK_TIMEOUT_MS = 10_000;

/** A fresh opaque identifier is allocated for every dispatched round. */
export function createRoundId() {
  return `round-${randomUUID()}`;
}

export function isRoundId(value) {
  return typeof value === 'string' && /^round-[0-9a-f-]{36}$/.test(value);
}

/**
 * These messages belong to one round lease. Control messages such as ready,
 * close, and close_error intentionally carry no round identity.
 */
export const ROUND_MESSAGE_KINDS = new Set([
  'ack',
  'event',
  'heartbeat',
  'result',
  'error',
  'worker_busy',
  'released',
]);

export const CONTROL_MESSAGE_KINDS = new Set([
  'ready',
  'close',
  'closed',
  'close_error',
  'protocol_error',
]);

export const MESSAGE_KINDS = new Set([...ROUND_MESSAGE_KINDS, ...CONTROL_MESSAGE_KINDS]);

export function isRoundMessage(message) {
  return Boolean(message) && ROUND_MESSAGE_KINDS.has(message.kind);
}

/**
 * Validate one message at the process boundary. Unknown kinds, a missing or
 * malformed roundId on a round-scoped message, and a different protocol
 * version are rejected with a reason the Runtime records as an ignored event.
 */
export function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return {ok: false, reason: 'message must be an object'};
  }
  if (!MESSAGE_KINDS.has(message.kind)) return {ok: false, reason: 'unknown message kind'};
  if (message.protocolVersion !== undefined && message.protocolVersion !== ROUND_PROTOCOL_VERSION) {
    return {ok: false, reason: `protocol version ${message.protocolVersion} is not ${ROUND_PROTOCOL_VERSION}`};
  }
  if (ROUND_MESSAGE_KINDS.has(message.kind) && !isRoundId(message.roundId)) {
    return {ok: false, reason: 'round message requires a valid roundId'};
  }
  if (message.kind === 'event' && !isNotification(message.notification)) {
    return {ok: false, reason: 'event requires a notification'};
  }
  if ((message.kind === 'error' || message.kind === 'close_error' || message.kind === 'protocol_error') &&
      typeof message.error !== 'string') {
    return {ok: false, reason: 'error message requires an error string'};
  }
  return {ok: true, reason: null};
}

function isNotification(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Boolean(value.params?.event ?? value.event);
}

/** Build the run message the manager sends. */
export function runMessage({roundId, task, prompt, maxTokens, effort = null, ownerMarker, budgetFile, conversationFile}) {
  if (!isRoundId(roundId)) throw new Error('A valid roundId is required');
  const message = {
    kind: 'run',
    roundId,
    protocolVersion: ROUND_PROTOCOL_VERSION,
    task,
    prompt,
    maxTokens,
    effort: effort ?? null,
    ownerMarker,
  };
  if (budgetFile) message.budgetFile = budgetFile;
  // Named only for a provider that keeps continuity in a file.
  if (conversationFile) message.conversationFile = conversationFile;
  return message;
}

/** Parse a run message in the Worker, rejecting a version or shape mismatch. */
export function parseRunMessage(message) {
  if (!message || message.kind !== 'run') return {ok: false, reason: 'not a run message'};
  if (message.protocolVersion !== undefined && message.protocolVersion !== ROUND_PROTOCOL_VERSION) {
    return {ok: false, reason: `protocol version ${message.protocolVersion} is not ${ROUND_PROTOCOL_VERSION}`};
  }
  if (!isRoundId(message.roundId)) return {ok: false, reason: 'run requires a valid roundId'};
  if (!message.task || typeof message.task !== 'object') return {ok: false, reason: 'run requires a task'};
  if (typeof message.prompt !== 'string') return {ok: false, reason: 'run requires a prompt'};
  if (message.conversationFile !== undefined &&
      (typeof message.conversationFile !== 'string' || !message.conversationFile)) {
    return {ok: false, reason: 'run conversationFile must be a nonempty string'};
  }
  return {ok: true, reason: null, message};
}

export function readyMessage({pid, startedAt, ownerMarker, roundId = null, protocolVersion = ROUND_PROTOCOL_VERSION}) {
  return {kind: 'ready', roundId, protocolVersion, pid, startedAt, ownerMarker};
}

export function closeMessage() {
  return {kind: 'close'};
}

export function closedMessage() {
  return {kind: 'closed'};
}

export function closeErrorMessage({error}) {
  return {kind: 'close_error', error};
}

export function protocolErrorMessage({error}) {
  return {kind: 'protocol_error', error};
}

export function ackMessage({at = new Date().toISOString()} = {}) {
  return {kind: 'ack', at};
}

export function heartbeatMessage({at = new Date().toISOString(), uptimeMs}) {
  return {kind: 'heartbeat', at, uptimeMs};
}

export function resultMessage({text, finishReason}) {
  return {kind: 'result', text, finishReason};
}

export function errorMessage({error, finishReason = 'error'}) {
  return {kind: 'error', error, finishReason};
}

export function workerBusyMessage({roundId}) {
  return {kind: 'worker_busy', roundId};
}

export function releasedMessage({roundId}) {
  return {kind: 'released', roundId};
}

/**
 * One event wrapper for both Provider paths. The Worker normalizes the raw
 * Provider event before sending, so the manager never has to guess whether it
 * received `{method, params:{event}}` or a bare event object.
 */
export function eventMessage(event) {
  const payload = event?.params?.event ?? event?.event ?? event;
  return {
    kind: 'event',
    notification: {method: 'session.event', params: {event: payload}},
  };
}


/**
 * Track one worker-side round. `send` adds the active roundId to every message
 * so the manager can reject late or duplicated work from an earlier lease.
 */
export function createRoundChannel(send, options = {}) {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let roundId = null;
  let heartbeat = null;
  let startedAt = null;

  function sendRound(kind, payload = {}) {
    if (!roundId) return false;
    send({...payload, kind, roundId});
    return true;
  }

  return {
    begin(id) {
      if (roundId) throw new Error(`round ${roundId} is still active`);
      if (!isRoundId(id)) throw new Error('A valid roundId is required');
      roundId = id;
      startedAt = Date.now();
      heartbeat = setInterval(() => {
        sendRound('heartbeat', heartbeatMessage({
          at: new Date().toISOString(),
          uptimeMs: Date.now() - startedAt,
        }));
      }, intervalMs);
      heartbeat.unref?.();
    },
    send: sendRound,
    end() {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      const finishedRound = roundId;
      roundId = null;
      startedAt = null;
      return finishedRound;
    },
    get roundId() {
      return roundId;
    },
  };
}
