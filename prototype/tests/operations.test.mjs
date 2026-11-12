// One operation table drives the manager, CLI, MCP, and HTTP gateway. These
// cases pin the shared validation, the declared per-entry differences, and the
// gateway's status/code mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import './isolate.mjs';
import {createGateway} from '../server.mjs';
import {catalogue} from '../mcp.mjs';
import {
  OperationError,
  operationByName,
  parseCliOperation,
  validateOperation,
} from '../../src/operations/catalogue.mjs';

const ID = 'task-0123456789ab';

function rawRequest(port, {body, headers = {}}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api', method: 'POST',
      headers: {'content-type': 'application/json', ...headers},
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(text)}));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the gateway maps auth, host, origin, size, unknown operation, and task/state errors', async t => {
  const manager = {
    restore() {},
    async shutdown() {},
    async action(name, args) {
      validateOperation(name, args);
      if (name === 'list') return [];
      if (name === 'status') {
        if (args.id === ID) return {id: ID, status: 'running'};
        throw new Error('Unknown task');
      }
      if (name === 'accept') throw new Error('Cannot accept task in running');
      throw new Error(`Unhandled ${name}`);
    },
  };
  const gateway = createGateway({manager, port: 0, token: 'test-token'});
  await gateway.listen();
  t.after(() => gateway.close());
  const port = gateway.port;
  const url = `http://127.0.0.1:${port}/api`;
  const auth = {authorization: 'Bearer test-token'};

  const unauthorized = await rawRequest(port, {
    body: JSON.stringify({action: 'list', args: {}}),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.code, 'UNAUTHORIZED');

  const badHost = await rawRequest(port, {
    body: JSON.stringify({action: 'list', args: {}}),
    headers: {...auth, host: 'evil.example'},
  });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.body.code, 'FORBIDDEN_HOST');

  const origin = await rawRequest(port, {
    body: JSON.stringify({action: 'list', args: {}}),
    headers: {...auth, origin: 'https://evil.example'},
  });
  assert.equal(origin.status, 403);
  assert.equal(origin.body.code, 'ORIGIN_NOT_ALLOWED');

  const tooLarge = await rawRequest(port, {
    body: JSON.stringify({action: 'list', args: {}, pad: 'x'.repeat(1024 * 1024)}),
    headers: auth,
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, 'REQUEST_TOO_LARGE');

  const unknownOperation = await rawRequest(port, {
    body: JSON.stringify({action: 'bogus', args: {}}),
    headers: auth,
  });
  assert.equal(unknownOperation.status, 404);
  assert.equal(unknownOperation.body.code, 'UNKNOWN_OPERATION');
  assert.match(unknownOperation.body.error, /Unknown action/);

  const unknownTask = await rawRequest(port, {
    body: JSON.stringify({action: 'status', args: {id: 'task-ffffffffffff'}}),
    headers: auth,
  });
  assert.equal(unknownTask.status, 404);
  assert.equal(unknownTask.body.code, 'NOT_FOUND');
  assert.equal(unknownTask.body.error, 'Unknown task');

  const conflict = await rawRequest(port, {
    body: JSON.stringify({action: 'accept', args: {id: ID, evidence: 'checked'}}),
    headers: auth,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'CONFLICT');
  assert.equal(conflict.body.error, 'Cannot accept task in running');

  const ok = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', ...auth},
    body: JSON.stringify({action: 'list', args: {}}),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), []);
});

function cliArgs(command, data) {
  return parseCliOperation(command, [JSON.stringify(data)]);
}

test('CLI, MCP, and manager validation agree on valid and invalid requests', () => {
  const valid = [
    ['create', {workspace: './w', prompt: 'work'}],
    ['create', {workspace: './w', prompt: 'work', maxTokens: 4096, effort: 'max'}],
    ['rework', {id: ID, prompt: 'next'}],
    ['status', {id: ID, view: 'result', offset: 10, limit: 500}],
    ['wait', {id: ID, timeoutSeconds: 60}],
    ['research_start', {question: 'q', shards: [{subject: 'A'}, {subject: 'B', url: 'https://example.invalid'}]}],
  ];
  for (const [name, args] of valid) {
    assert.doesNotThrow(() => validateOperation(name, args), name);
    assert.doesNotThrow(() => validateOperation(name, args, {mcp: true}), name);
    if (operationByName(name).entries.cli?.style === 'json') {
      assert.deepEqual(cliArgs(name, args).data, args, name);
    }
  }

  const invalid = [
    ['create', {workspace: './w'}, /Missing argument prompt/],
    ['create', {workspace: './w', prompt: 'work', bogus: 1}, /Invalid argument bogus/],
    ['create', {workspace: './w', prompt: 'work', maxTokens: 0}, /maxTokens/],
    ['create', {workspace: './w', prompt: 'work', effort: 'low'}, /effort/],
    ['create', {workspace: './w', prompt: 'work', usageLimits: {enabled: 'yes'}}, /usageLimits\.enabled/],
    ['rework', {id: ID, prompt: 'next', overrideLimits: true}, /overrideLimits requires a nonempty overrideReason/],
    ['rework', {id: ID, prompt: 'next', overrideReason: 'x'.repeat(1001), overrideLimits: true}, /at most 1000/],
    ['status', {id: ID, view: 'full'}, /view must be one of/],
    ['status', {id: ID, offset: -1}, /offset/],
    ['status', {id: ID, limit: 4001}, /limit/],
    ['wait', {id: ID, timeoutSeconds: 0}, /timeoutSeconds/],
    ['research_start', {question: 'q', shards: []}, /at least 1 item/],
    ['accept', {id: ID, evidence: '   '}, /evidence required/],
  ];
  for (const [name, args, pattern] of invalid) {
    assert.throws(() => validateOperation(name, args), pattern, name);
    assert.throws(() => validateOperation(name, args, {mcp: true}), pattern, name);
    if (operationByName(name).entries.cli?.style === 'json') {
      assert.throws(() => cliArgs(name, args), pattern, name);
    }
  }
});

test('declared entry differences stay at the entry, not in the manager', () => {
  // MCP caps wait at 300s; the manager and CLI accept up to 86400s.
  assert.doesNotThrow(() => validateOperation('wait', {id: ID, timeoutSeconds: 86400}));
  assert.doesNotThrow(() => parseCliOperation('wait', [ID, '--timeout', '86400']));
  assert.throws(() => validateOperation('wait', {id: ID, timeoutSeconds: 301}, {mcp: true}), /300/);
  assert.throws(() => parseCliOperation('wait', [ID, '--timeout', '86401']), /86400/);

  // The CLI rejects pagination without a paged view; the manager ignores it and
  // the MCP schema does not add a cross-field rule.
  assert.throws(() => parseCliOperation('status', [ID, '--offset', '1']), /--view/);
  assert.doesNotThrow(() => validateOperation('status', {id: ID, offset: 1}));
  assert.doesNotThrow(() => validateOperation('status', {id: ID, offset: 1}, {mcp: true}));

  // A human-only operation is absent from the MCP catalogue but present in the
  // operation table for the CLI and gateway.
  assert.ok(operationByName('grant_delete'));
  assert.equal(operationByName('grant_delete').entries.humanOnly, true);
  const names = catalogue.map(tool => tool.name);
  assert.equal(names.includes('waxwing_grant_delete'), false);
  assert.equal(names.includes('ds_grant_delete'), false);
  assert.equal(names.includes('waxwing_delete'), true);
  assert.equal(new Set(names).size, names.length);
  const waitTool = catalogue.find(tool => tool.name === 'waxwing_wait');
  assert.equal(waitTool.inputSchema.properties.timeoutSeconds.maximum, 300);
});

test('the gateway rejects oversized bodies before parsing and keeps operation errors typed', async t => {
  const gateway = createGateway({
    manager: {
      restore() {}, async shutdown() {},
      async action() { throw new OperationError('boom', {code: 'TEAPOT', status: 418}); },
    },
    port: 0,
    token: 't',
  });
  await gateway.listen();
  t.after(() => gateway.close());
  const response = await rawRequest(gateway.port, {
    body: JSON.stringify({action: 'list', args: {}}),
    headers: {authorization: 'Bearer t'},
  });
  assert.equal(response.status, 418);
  assert.deepEqual(response.body, {error: 'boom', code: 'TEAPOT'});
});
