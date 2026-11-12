// The create command keeps its validation order; rework no longer lives here.
// These cases run through the manager so the production wiring is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
// Isolation must load before manager/common so the data root is fixed.
import './isolate.mjs';
import {createManager} from '../manager.mjs';

async function rejected(manager, request, pattern) {
  await assert.rejects(manager.action('create', request), pattern);
  assert.deepEqual(await manager.action('list'), [], 'a rejected create writes no task');
}

test('create rejects prompt, budget, effort, and limits before any task is written', async () => {
  const manager = createManager();
  try {
    await rejected(manager, {prompt: '   '}, /Nonempty prompt/);
    await rejected(manager, {prompt: 'work', maxTokens: 0}, /maxTokens must be a positive safe integer/);
    await rejected(manager, {prompt: 'work', effort: 'low'}, /effort must be one of high, max/);
    await rejected(
      manager,
      {prompt: 'work', usageLimits: {enabled: 'yes'}},
      /usageLimits\.enabled must be a boolean/,
    );
  } finally {
    await manager.shutdown();
  }
});
