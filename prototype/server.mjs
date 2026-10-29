// PROTOTYPE - HTTP surface over the local task manager.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {atomicJson,runtimeContext} from './common.mjs';
import {createManager} from './manager.mjs';
import {OperationError,validateOperation} from '../src/operations/catalogue.mjs';

/** Map a manager failure to a stable code and HTTP status, keeping its text. */
export function classifyError(error) {
  if (error instanceof OperationError) {
    return {status: error.status, code: error.code, message: error.message};
  }
  const message = String(error?.message ?? error);
  if (message === 'Unknown task') return {status: 404, code: 'NOT_FOUND', message};
  if (message === 'Request too large') return {status: 413, code: 'REQUEST_TOO_LARGE', message};
  if (/^(Cannot (?:accept|close|cancel|stop|fail) task|Task is (?:running|stopping|closed|accepted)|Task .* has no owned runtime|Task .* has an unverified residual runtime|Workspace overlaps|Maximum \d+ rounds|Original runtime is gone|Already stopping|Runtime .*; the old session state is untrusted)/.test(message)) {
    return {status: 409, code: 'CONFLICT', message};
  }
  return {status: 400, code: 'BAD_REQUEST', message};
}

/**
 * Build the loopback gateway without starting it. Token creation, restore, and
 * process exit stay in `start()` so tests can bind an ephemeral port.
 */
export function createGateway({
  manager = createManager(),
  port = null,
  host = '127.0.0.1',
  token = null,
  root = null,
  dshRepo = null,
  model = null,
  pid = process.pid,
  context = runtimeContext(),
} = {}) {
  // Launchers choose the context; the gateway never re-derives it so the
  // health answer and the manager it fronts cannot disagree.
  let currentToken = token;
  let boundPort = port ?? context.port;
  let closing = false;
  const reply = (res, status, value) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  async function action(name, args) {
    if (name === 'health') {
      validateOperation(name, args);
      return {waxwing: true, prototype: true, root, dshRepo, model, port: boundPort, pid};
    }
    if (name === 'shutdown') {
      validateOperation(name, args);
      setTimeout(() => { void close(); }, 100);
      return {stopping: true};
    }
    return manager.action(name, args);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (req.headers.host !== `${host}:${boundPort}`) {
      return reply(res, 403, {error: 'Invalid host', code: 'FORBIDDEN_HOST'});
    }
    if (req.headers.origin) {
      return reply(res, 403, {error: 'Browser origins are not supported', code: 'ORIGIN_NOT_ALLOWED'});
    }
    if (req.headers.authorization !== `Bearer ${currentToken}`) {
      return reply(res, 401, {error: 'Unauthorized', code: 'UNAUTHORIZED'});
    }
    if (req.method !== 'POST' || req.url !== '/api') {
      return reply(res, 404, {error: 'Use POST /api', code: 'NOT_FOUND'});
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new OperationError('Request too large', {
          code: 'REQUEST_TOO_LARGE',
          status: 413,
        });
      }
      const call = JSON.parse(body);
      reply(res, 200, await action(call.action, call.args));
    } catch (error) {
      const mapped = classifyError(error);
      reply(res, mapped.status, {error: mapped.message, code: mapped.code});
    }
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });

  function listen({onListening} = {}) {
    return new Promise((resolve, reject) => {
      const onError = error => reject(error);
      server.once('error', onError);
      server.listen(boundPort, host, () => {
        server.off('error', onError);
        const address = server.address();
        boundPort = typeof address === 'object' && address ? address.port : port;
        manager.restore?.();
        onListening?.();
        resolve(address);
      });
    });
  }

  async function close() {
    if (closing) return;
    closing = true;
    await manager.shutdown();
    await new Promise(resolve => server.close(() => resolve()));
  }

  return {
    server,
    action,
    listen,
    close,
    shutdown: close,
    setToken(value) { currentToken = value; },
    get token() { return currentToken; },
    get port() { return boundPort; },
  };
}

async function start() {
  const context = runtimeContext();
  const manager = createManager({context});
  const gateway = createGateway({
    manager,
    context,
    root: context.root,
    dshRepo: context.config.dshRepo,
    model: context.config.model,
  });
  await gateway.listen({
    onListening() {
      const token = randomBytes(32).toString('hex');
      gateway.setToken(token);
      fs.writeFileSync(path.join(context.runtimeDir, 'server-token'), token, {mode: 0o600});
      atomicJson(path.join(context.runtimeDir, 'daemon.json'), {
        pid: process.pid,
        port: gateway.port,
        startedAt: new Date().toISOString(),
      });
      console.log(`Waxwing ready on 127.0.0.1:${gateway.port}; data: ${context.root}`);
    },
  });
  const stop = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
const isMain = entryPath !== undefined && (process.platform === 'win32'
  ? selfPath.toLowerCase() === entryPath.toLowerCase()
  : selfPath === entryPath);
if (isMain) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
