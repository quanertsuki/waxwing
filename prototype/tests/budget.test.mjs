// Budget validation, inheritance, and per-task budget-file behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertMaxTokens,parseOptionalMaxTokens,resolveRoundBudget,writeRoundBudget,readRoundBudget,budgetFileFor} from '../budget.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const dir=path.join(HERE,'.tmp','budget');
fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});

// Explicitly invalid inputs from the requirement: zero, negative, fractional,
// string, null, and unsafe integer, plus other non-numbers.
const invalid=[0,-1,-32768,1.5,0.5,32768.25,'2048','','0',null,NaN,Infinity,-Infinity,2**53,Number.MAX_SAFE_INTEGER+1,true,false,{},[],['1']];

test('assertMaxTokens rejects every non-positive-safe-integer budget',()=>{
  for(const value of invalid) assert.throws(()=>assertMaxTokens(value),/positive safe integer/,String(value));
});
test('assertMaxTokens accepts positive safe integers unchanged',()=>{
  for(const value of [1,2,2048,32768,Number.MAX_SAFE_INTEGER]) assert.equal(assertMaxTokens(value),value);
});
test('parseOptionalMaxTokens lets only undefined inherit',()=>{
  assert.equal(parseOptionalMaxTokens(undefined),undefined);
  for(const value of invalid) assert.throws(()=>parseOptionalMaxTokens(value),/positive safe integer/);
});
test('resolveRoundBudget applies explicit > inherited > manager default',()=>{
  assert.equal(resolveRoundBudget({requested:undefined,inherited:undefined,fallback:32768}),32768);
  assert.equal(resolveRoundBudget({requested:undefined,inherited:8192,fallback:32768}),8192);
  assert.equal(resolveRoundBudget({requested:512,inherited:8192,fallback:32768}),512);
  assert.equal(resolveRoundBudget({requested:undefined,inherited:1,fallback:32768}),1);
  assert.throws(()=>resolveRoundBudget({requested:0,inherited:8192,fallback:32768}),/positive safe integer/);
  assert.throws(()=>resolveRoundBudget({requested:undefined,inherited:'8192',fallback:32768}),/positive safe integer/);
  assert.throws(()=>resolveRoundBudget({requested:undefined,inherited:undefined,fallback:0}),/config\.maxTokens/);
});
test('budget file round-trips, overwrites atomically, and rejects invalid contents',()=>{
  const file=budgetFileFor(dir);
  assert.equal(writeRoundBudget(file,1024),1024);
  assert.equal(readRoundBudget(file),1024);
  assert.equal(writeRoundBudget(file,4096),4096);
  assert.equal(readRoundBudget(file),4096);
  // An invalid write is refused before touching the existing file.
  assert.throws(()=>writeRoundBudget(file,0),/positive safe integer/);
  assert.throws(()=>writeRoundBudget(file,'2048'),/positive safe integer/);
  assert.equal(readRoundBudget(file),4096);
  for(const bad of ['','not json','[]','null','{}','{"maxTokens":0}','{"maxTokens":-5}','{"maxTokens":1.5}','{"maxTokens":"12"}','{"maxTokens":9007199254740993}']) {
    fs.writeFileSync(file,bad);
    assert.throws(()=>readRoundBudget(file),/budget/i,bad);
  }
  fs.rmSync(file);
  assert.throws(()=>readRoundBudget(file),/unreadable/);
});
