// CLI status parsing, the bounded wait polling contract, and the fact that
// importing cli.mjs for tests does not start the interactive CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {config,ROOT} from '../common.mjs';
import {parseStatusArgs,nextWaitDelay,wait,waitTimeoutMs,WAIT_INITIAL_MS,WAIT_MAX_MS,WAIT_GRACE_MS} from '../cli.mjs';

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
test('wait backoff is 1->2->4->8->10 seconds and respects roundTimeoutSeconds',()=>{
  assert.equal(WAIT_INITIAL_MS,1000);
  assert.equal(WAIT_MAX_MS,10000);
  let delay=WAIT_INITIAL_MS;
  const seen=[];
  for(let i=0;i<6;i++){seen.push(delay);delay=nextWaitDelay(delay);}
  assert.deepEqual(seen,[1000,2000,4000,8000,10000,10000]);
  assert.equal(waitTimeoutMs(),config.roundTimeoutSeconds*1000+WAIT_GRACE_MS);
  assert.ok(waitTimeoutMs()>=config.roundTimeoutSeconds*1000);
});
test('wait polls summaries, backs off, and returns the terminal summary',async()=>{
  let now=0;const sleeps=[];
  const statuses=[{status:'running'},{status:'stopping'},{status:'awaiting_review',id:ID,roundCount:2,resultPreview:'ok'}];
  const result=await wait(ID,{timeoutMs:60000,now:()=>now,
    sleep:async ms=>{sleeps.push(ms);now+=ms;},requestStatus:async()=>statuses.shift()});
  assert.deepEqual(sleeps,[1000,2000]);
  assert.equal(result.status,'awaiting_review');
  assert.equal(result.roundCount,2);
});
test('wait fails once the configured deadline is exhausted',async()=>{
  let now=0;const sleeps=[];
  await assert.rejects(()=>wait(ID,{timeoutMs:3000,now:()=>now,
    sleep:async ms=>{sleeps.push(ms);now+=ms;},requestStatus:async()=>({status:'running'})}),/timed out/);
  assert.deepEqual(sleeps,[1000,2000]);
});
