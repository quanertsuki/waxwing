import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskCommandModule} from '../../src/tasks/command.mjs';

function command(overrides = {}) {
  return new TaskCommandModule({
    maxPromptLength: 20,
    maxRounds: 3,
    limitsForRequest: (_task, value) => value ?? {enabled: false},
    preflight: ({prompt, usageLimits}) => ({
      prompt,
      usageLimits,
      workspace: 'C:/work/example',
      workspacePlan: {mode: 'shared'},
      maxTokens: 2048,
      effort: 'high',
      provider: {name: 'test', type: 'dsh-sdk', model: 'model'},
    }),
    providerSupportsEffort: provider => provider?.type === 'dsh-sdk',
    resolveBudget: ({requested, inherited, fallback}) => requested ?? inherited ?? fallback,
    resolveEffort: ({requested, inherited, fallback}) => requested ?? inherited ?? fallback,
    defaultEffort: 'high',
    workspaceConflict: () => null,
    canStart: () => null,
    ...overrides,
  });
}

test('TaskCommandModule validates create before invoking preflight', () => {
  const calls = [];
  const module = command({
    preflight: input => {
      calls.push(input);
      return {workspace: 'C:/work/example'};
    },
  });
  assert.throws(() => module.create({prompt: '   '}, {taskId: 'task-0123456789ab'}), /Nonempty prompt/);
  assert.equal(calls.length, 0);
  const created = module.create({prompt: 'work'}, {taskId: 'task-0123456789ab'});
  assert.equal(created.prompt, 'work');
  assert.deepEqual(created.usageLimits, {enabled: false});
  assert.equal(calls.length, 1);
});

test('TaskCommandModule refuses create while the manager is shutting down', () => {
  const module = command({canStart: () => 'Manager is shutting down'});
  assert.throws(() => module.create({prompt: 'work'}, {taskId: 'task-0123456789ab'}), /shutting down/);
});

test('TaskCommandModule validates rework in compatibility order', () => {
  const module = command();
  const task = {
    id: 'task-0123456789ab',
    status: 'awaiting_review',
    rounds: [{number: 1}],
    provider: {name: 'test', type: 'dsh-sdk'},
    maxTokens: 1024,
    effort: 'high',
  };
  assert.throws(() => module.rework(task, {prompt: '', maxTokens: 0}), /maxTokens/);
  assert.throws(() => module.rework({...task, provider: {type: 'openai-chat'}}, {
    prompt: 'next',
    effort: 'max',
  }), /effort is not supported/);
  const result = module.rework(task, {prompt: 'next', maxTokens: 4096, effort: 'max'});
  assert.equal(result.prompt, 'next');
  assert.equal(result.maxTokens, 4096);
  assert.equal(result.effort, 'max');
});

test('TaskCommandModule refuses max-round and workspace conflicts before writes', () => {
  const maxed = command();
  assert.throws(() => maxed.rework({
    id: 'task-0123456789ab',
    rounds: [{}, {}, {}],
    provider: {type: 'dsh-sdk'},
  }, {prompt: 'next'}), /Maximum 3 rounds/);

  const conflicted = command({workspaceConflict: () => ({id: 'task-other'})});
  assert.throws(() => conflicted.rework({
    id: 'task-0123456789ab',
    rounds: [],
    provider: {type: 'dsh-sdk'},
  }, {prompt: 'next'}), /Workspace overlaps/);
});

test('TaskCommandModule reads maxRounds and default effort dynamically', () => {
  let maxRounds = 2;
  let effort = 'high';
  const module = command({
    maxRounds: () => maxRounds,
    defaultEffort: () => effort,
  });
  const task = {
    id: 'task-0123456789ab',
    rounds: [{}, {}],
    provider: {type: 'dsh-sdk'},
  };
  assert.throws(() => module.rework(task, {prompt: 'next'}), /Maximum 2 rounds/);
  maxRounds = 3;
  effort = 'max';
  const result = module.rework({...task, rounds: [{}]}, {prompt: 'next'});
  assert.equal(result.effort, 'max');
});
