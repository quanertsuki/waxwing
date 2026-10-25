// PROTOTYPE — HTTP surface over the local task manager.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {config,ROOT,RUNTIME,atomicJson} from './common.mjs';
import {createManager} from './manager.mjs';

const manager = createManager();
let shuttingDown = false;
// Tokens are created only after the port is claimed, so a duplicate launch cannot invalidate clients.
let token;
async function action(name, args) {
  if (name === 'health') return {waxwing: true, prototype: true, root: ROOT, dshRepo: config.dshRepo, model: config.model, port: config.port, pid: process.pid};
  if (name === 'shutdown') { setTimeout(() => { void shutdown(); }, 100); return {stopping: true}; }
  return manager.action(name, args);
}
const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const reply = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  if (req.headers.host !== `127.0.0.1:${config.port}`) return reply(403, {error: 'Invalid host'});
  if (req.headers.origin) return reply(403, {error: 'Browser origins are not supported'});
  if (req.headers.authorization !== `Bearer ${token}`) return reply(401, {error: 'Unauthorized'});
  if (req.method !== 'POST' || req.url !== '/api') return reply(404, {error: 'Use POST /api'});
  try {
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request too large'); }
    const call = JSON.parse(body); reply(200, await action(call.action, call.args));
  } catch (e) { reply(400, {error: String(e.message)}); }
});
server.on('error', e => { console.error(e.message); process.exitCode = 1; });
server.listen(config.port, '127.0.0.1', () => {
  manager.restore();
  token = randomBytes(32).toString('hex'); fs.writeFileSync(path.join(RUNTIME, 'server-token'), token, {mode: 0o600});
  atomicJson(path.join(RUNTIME, 'daemon.json'), {pid: process.pid, port: config.port, startedAt: new Date().toISOString()});
  console.log(`Waxwing ready on 127.0.0.1:${config.port}; data: ${ROOT}`);
});
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  await manager.shutdown();
  server.close(); process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
