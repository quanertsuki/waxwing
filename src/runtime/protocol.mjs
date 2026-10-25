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

export function isRoundMessage(message) {
  return Boolean(message) && ROUND_MESSAGE_KINDS.has(message.kind);
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
        sendRound('heartbeat', {
          at: new Date().toISOString(),
          uptimeMs: Date.now() - startedAt,
        });
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
