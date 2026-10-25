// The DSH plugin mounted into each task runtime must override every model
// request's maxTokens from the task budget file, and must fail loudly rather
// than silently inheriting or clamping when that file is invalid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {apply,name} from '../budget-plugin.mjs';
import {writeRoundBudget,budgetFileFor} from '../budget.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const dir=path.join(HERE,'.tmp','plugin');
fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});

/** Mount the plugin against a fake Cordis context and return its request handler. */
function mount(budgetFile) {
  const handlers={};
  apply({on:(event,handler)=>{handlers[event]=handler;}},{budgetFile});
  return handlers['agent/request'];
}
const seed=()=>({provider:'deepseek-official',model:'deepseek-flash',maxTokens:32768,temperature:0.2});

test('plugin exports the expected Cordis identity',()=>{
  assert.equal(name,'task-budget');
});
test('plugin replaces the resolved request budget with the file value',async()=>{
  const file=budgetFileFor(dir);
  writeRoundBudget(file,1234);
  const handler=mount(file);
  let nextCalled=0;
  const resolved=await handler({turn:1,step:0},async()=>{nextCalled++;return seed();});
  assert.equal(nextCalled,1);
  assert.equal(resolved.maxTokens,1234);
  assert.equal(resolved.provider,'deepseek-official');
  assert.equal(resolved.model,'deepseek-flash');
  assert.equal(resolved.temperature,0.2);
});
test('plugin re-reads the file on every request so the next round wins',async()=>{
  const file=budgetFileFor(dir);
  const handler=mount(file);
  writeRoundBudget(file,8192);
  assert.equal((await handler({},async()=>seed())).maxTokens,8192);
  writeRoundBudget(file,256);
  assert.equal((await handler({},async()=>seed())).maxTokens,256);
  // It overrides even an SDK handshake value that differs from the file.
  assert.equal((await handler({},async()=>({...seed(),maxTokens:99999}))).maxTokens,256);
});
test('plugin rejects an invalid or missing budget file instead of falling back',async()=>{
  const file=budgetFileFor(dir);
  const handler=mount(file);
  for(const bad of ['','oops','[]','null','{}','{"maxTokens":0}','{"maxTokens":"4096"}','{"maxTokens":1.5}']) {
    fs.writeFileSync(file,bad);
    await assert.rejects(()=>handler({},async()=>seed()),/budget/i,bad);
  }
  fs.rmSync(file);
  await assert.rejects(()=>handler({},async()=>seed()),/unreadable/);
});
test('plugin refuses a missing or blank budgetFile config at load',()=>{
  assert.throws(()=>apply({on(){}},undefined),/budgetFile/);
  assert.throws(()=>apply({on(){}},{}),/budgetFile/);
  assert.throws(()=>apply({on(){}},{budgetFile:'   '}),/budgetFile/);
  assert.throws(()=>apply({on(){}},{budgetFile:7}),/budgetFile/);
});
