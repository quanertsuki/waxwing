// The Worker process outlives one round (the fallback reuses it), so the
// adapter must follow the Provider that dispatched the current round.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapterCache} from '../../src/providers/adapter-cache.mjs';

function recordingFactory() {
  const built = [];
  return {
    built,
    createAdapter(config) {
      const adapter = {
        config,
        validateCalls: 0,
        validate() { this.validateCalls += 1; },
      };
      built.push(adapter);
      return adapter;
    },
  };
}

test('the same provider reuses one adapter instance across rounds', () => {
  const factory = recordingFactory();
  const cache = createAdapterCache({createAdapter: factory.createAdapter});
  const provider = {name: 'deepseek-flash', type: 'openai-chat', baseUrl: 'https://a', model: 'm'};

  const first = cache.adapterFor(provider);
  const second = cache.adapterFor({...provider});
  assert.equal(first, second);
  assert.equal(factory.built.length, 1);
  assert.equal(first.validateCalls, 1);
});

test('a different provider in the next round builds a new adapter', () => {
  const factory = recordingFactory();
  const cache = createAdapterCache({createAdapter: factory.createAdapter});
  const first = cache.adapterFor({name: 'deepseek-flash', type: 'openai-chat', baseUrl: 'https://a', model: 'm'});
  const second = cache.adapterFor({name: 'kimi', type: 'openai-chat', baseUrl: 'https://b', model: 'k'});

  assert.notEqual(first, second);
  assert.equal(second.config.baseUrl, 'https://b');
  assert.equal(cache.current, second);
  assert.equal(factory.built.length, 2);
});

test('the caller provider object is never modified', () => {
  const factory = recordingFactory();
  const env = {TEST_PROVIDER_KEY: 'secret-key'};
  const cache = createAdapterCache({createAdapter: factory.createAdapter, env});
  const provider = {
    name: 'deepseek-flash',
    type: 'openai-chat',
    baseUrl: 'https://a',
    model: 'm',
    apiKeyEnv: 'TEST_PROVIDER_KEY',
  };

  const adapter = cache.adapterFor(provider);
  assert.equal(provider.apiKey, undefined, 'the task record keeps no resolved secret');
  assert.equal(adapter.config.apiKey, 'secret-key');
  assert.equal(adapter.config, adapter.config, 'the adapter owns its own copy');

  // A changed key is a different identity, so the adapter is rebuilt.
  env.TEST_PROVIDER_KEY = 'rotated-key';
  const rotated = cache.adapterFor(provider);
  assert.notEqual(rotated, adapter);
  assert.equal(rotated.config.apiKey, 'rotated-key');
});

test('closeAll closes every adapter the process built, newest first', async () => {
  const closed = [];
  const createAdapter = config => ({
    config,
    async close() { closed.push(config.name); },
  });
  const cache = createAdapterCache({createAdapter, adapterOptions: {marker: true}});
  cache.adapterFor({name: 'first', type: 'openai-chat'});
  cache.adapterFor({name: 'second', type: 'openai-chat'});
  await cache.closeAll();
  assert.deepEqual(closed, ['second', 'first']);
  assert.equal(cache.current, null);
});
