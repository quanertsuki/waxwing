// The desktop type contract is generated from the same fixture the Rust and
// JavaScript tests read. Regenerating is the only way it should change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildTaskViewContract,
  CONTRACT_TYPES_PATH,
  renderContractTypes,
} from '../../scripts/generate-task-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PATH = path.join(HERE, '..', '..', 'desktop', 'src', 'api.ts');

test('the committed desktop types match the generated contract', () => {
  const committed = fs.readFileSync(CONTRACT_TYPES_PATH, 'utf8');
  assert.equal(committed, renderContractTypes(buildTaskViewContract()),
    'run node scripts/generate-task-contract.mjs after changing the task view');
});

test('every fixture field appears in the generated desktop interface', () => {
  const fixture = buildTaskViewContract();
  const generated = renderContractTypes(fixture);
  const taskBlock = generated.slice(generated.indexOf('export interface Task {'),
    generated.indexOf('export interface TaskDetail {'));
  const detailBlock = generated.slice(generated.indexOf('export interface TaskDetail {'));
  for (const field of Object.keys(fixture.list)) {
    assert.match(taskBlock, new RegExp(`\\b${field}\\??:`), `Task.${field}`);
  }
  for (const field of Object.keys(fixture.detail)) {
    assert.match(detailBlock, new RegExp(`\\b${field}\\??:`), `TaskDetail.${field}`);
  }
});

test('the desktop call layer defines task types only once', () => {
  const source = fs.readFileSync(API_PATH, 'utf8');
  assert.match(source, /from '\.\/contract\.generated'/, 'api.ts imports the generated types');
  for (const name of ['Task', 'TaskDetail', 'TaskUsage', 'TaskRound']) {
    assert.doesNotMatch(source, new RegExp(`interface ${name}\\b`),
      `api.ts must not redeclare ${name}`);
  }
  assert.match(source, /export const api = \{/, 'api.ts is the single call layer');
});
