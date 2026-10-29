// Shared test Worker. Every test that needs a spawned-process lookalike uses
// this fixture, so messages are built by the same protocol module as the real
// Worker and a protocol change breaks one place instead of nine copies.
import {EventEmitter} from 'node:events';
import {
  ROUND_PROTOCOL_VERSION,
  ackMessage,
  closedMessage,
  closeErrorMessage,
  errorMessage,
  eventMessage,
  heartbeatMessage,
  readyMessage,
  releasedMessage,
  resultMessage,
  workerBusyMessage,
} from '../../src/runtime/protocol.mjs';

export const DEFAULT_RESULT = {text: 'done', finishReason: 'completed'};

/**
 * @param options.pid - process-like identifier.
 * @param options.protocolVersion - override for version-mismatch tests.
 * @param options.ownerMarker - ready marker; defaults to the run's marker.
 * @param options.defaultResult - result text/reason for the default run.
 * @param options.onRun - ({message, worker, reply}) => void; replaces the default.
 * @param options.onClose - ({worker}) => void; replaces exit-on-close.
 */
export function createFakeWorker({
  pid = 4400,
  protocolVersion = ROUND_PROTOCOL_VERSION,
  ownerMarker = null,
  defaultResult = DEFAULT_RESULT,
  onRun = null,
  onClose = null,
} = {}) {
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter();
  worker.stderr = new EventEmitter();
  worker.connected = true;
  worker.exitCode = null;
  worker.signalCode = null;
  worker.pid = pid;
  worker.sent = [];
  worker.runs = [];

  worker.emitMessage = message => worker.emit('message', message);
  worker.exit = (code = 0) => {
    if (worker.exitCode !== null) return;
    worker.exitCode = code;
    worker.emit('exit', code);
  };
  worker.kill = () => worker.exit(0);

  const reply = (roundId, build) => {
    const message = build();
    worker.emitMessage(roundId === undefined ? message : {...message, roundId});
  };
  const api = {
    ready: (extra = {}) => reply(undefined, () => readyMessage({
      pid: worker.pid,
      startedAt: new Date().toISOString(),
      ownerMarker: ownerMarker ?? undefined,
      protocolVersion,
      ...extra,
    })),
    ack: (roundId, extra = {}) => reply(roundId, () => ackMessage(extra)),
    heartbeat: (roundId) => reply(roundId, () => heartbeatMessage({uptimeMs: 1})),
    event: (roundId, event, extra = {}) => reply(roundId, () => ({...eventMessage(event), ...extra})),
    result: (roundId, extra = {}) => reply(roundId, () => resultMessage({...defaultResult, ...extra})),
    error: (roundId, extra = {}) => reply(roundId, () => errorMessage(extra)),
    release: (roundId, extra = {}) => reply(roundId, () => releasedMessage({roundId, ...extra})),
    busy: (roundId) => reply(roundId, () => workerBusyMessage({roundId})),
    closed: () => reply(undefined, () => closedMessage()),
    closeError: (error) => reply(undefined, () => closeErrorMessage({error})),
    exit: code => worker.exit(code),
  };

  worker.send = message => queueMicrotask(() => {
    worker.sent.push(message);
    if (message.kind === 'close') {
      if (onClose) onClose({worker, message, reply: api});
      else {
        worker.exitCode = 0;
        setImmediate(() => worker.emit('exit', 0));
      }
      return;
    }
    if (message.kind !== 'run') return;
    worker.runs.push(message);
    if (onRun) {
      onRun({message, worker, reply: api});
      return;
    }
    api.ready({roundId: message.roundId, ownerMarker: message.ownerMarker});
    api.ack(message.roundId);
    setImmediate(() => {
      api.result(message.roundId);
      api.release(message.roundId);
    });
  });
  return worker;
}
