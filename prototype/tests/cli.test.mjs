// CLI status parsing, the server-side wait contract, and the fact that
// importing cli.mjs for tests does not start the interactive CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {config,ROOT} from '../common.mjs';
import {parseResearchCollectArgs,parseStatusArgs,parseWaitArgs,wait,waitTimeoutMs,WAIT_GRACE_MS} from '../cli.mjs';

const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if(samePath(ROOT,REAL_ROOT)) throw new Error(`cli tests refused: live data root ${ROOT}`);
if(!samePath(ROOT,TEST_ROOT)) throw new Error(`cli tests refused: non-isolated root ${ROOT}`);

const ID='task-0123456789ab';
test('status accepts the existing ID form plus view/offset/limit',()=>{
  assert.deepEqual(parseStatusArgs([ID]),{id:ID});
  assert.deepEqual(parseStatusArgs([ID,'--view','summary']),{id:ID,view:'summary'});
  assert.deepEqual(parseStatusArgs([ID,'--view','result']),{id:ID,view:'result'});
  assert.deepEqual(parseStatusArgs([ID,'--view','result','--offset','0','--limit','4000']),{id:ID,view:'result',offset:0,limit:4000});
  assert.deepEqual(parseStatusArgs([ID,'--view=history','--offset=2000','--limit=500']),{id:ID,view:'history',offset:2000,limit:500});
});
test('status rejects invalid views, pagination and stray arguments',()=>{
  const invalid=[
    [], [ID,'extra'], [ID,'--view'], [ID,'--view','full'], [ID,'--view','SUMMARY'],
    [ID,'--view','result','--offset','-1'], [ID,'--view','result','--offset','1.5'],
    [ID,'--view','result','--offset','abc'], [ID,'--view','result','--limit','0'],
    [ID,'--view','result','--limit','4001'], [ID,'--view','result','--limit','1.5'],
    [ID,'--offset','0'], [ID,'--limit','100'], [ID,'--view','summary','--limit','100'],
    [ID,'--view','result','--view','history'], [ID,'--bogus','x'],
  ];
  for(const args of invalid) assert.throws(()=>parseStatusArgs(args),undefined,JSON.stringify(args));
});
test('research-collect reuses bounded offset/limit parsing without a view argument',()=>{
  const id='research-0123456789ab';
  assert.deepEqual(parseResearchCollectArgs([id]),{id});
  assert.deepEqual(parseResearchCollectArgs([id,'--offset','2000','--limit','500']),{id,offset:2000,limit:500});
  assert.throws(()=>parseResearchCollectArgs([]),/batch ID/);
  assert.throws(()=>parseResearchCollectArgs([id,'--offset','-1']),/offset/);
  assert.throws(()=>parseResearchCollectArgs([id,'--limit','4001']),/limit/);
});
test('wait parsing accepts a bounded server timeout',()=>{
  assert.deepEqual(parseWaitArgs([ID]),{id:ID});
  assert.deepEqual(parseWaitArgs([ID,'--timeout','60']),{id:ID,timeoutSeconds:60});
  assert.deepEqual(parseWaitArgs([ID,'--timeout=90'],'research-wait'),{id:ID,timeoutSeconds:90});
  assert.throws(()=>parseWaitArgs([]),/ID/);
  assert.throws(()=>parseWaitArgs([ID,'extra']),/Unexpected/);
  assert.throws(()=>parseWaitArgs([ID,'--timeout','0']),/between 1 and 86400/);
  assert.throws(()=>parseWaitArgs([ID,'--timeout','1.5']),/positive integer/);
  assert.equal(waitTimeoutMs(),config.roundTimeoutSeconds*1000+WAIT_GRACE_MS);
  assert.ok(waitTimeoutMs()>=config.roundTimeoutSeconds*1000);
});
test('wait makes one server-side call and returns its terminal summary',async()=>{
  const calls=[];
  const result=await wait(ID,{timeoutMs:60000,requestWait:async args=>{
    calls.push(args);
    return {status:'awaiting_review',id:ID,roundCount:2,wait:{timedOut:false}};
  }});
  assert.deepEqual(calls,[{id:ID,timeoutSeconds:60}]);
  assert.equal(result.status,'awaiting_review');
  assert.equal(result.roundCount,2);
  assert.equal(result.wait.timedOut,false);
});
test('wait preserves a timeout result for the caller to inspect',async()=>{
  const result=await wait(ID,{timeoutSeconds:3,requestWait:async()=>({
    status:'running',id:ID,wait:{timedOut:true,timeoutSeconds:3},
  })});
  assert.equal(result.status,'running');
  assert.equal(result.wait.timedOut,true);
});
