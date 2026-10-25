// Round-lease regressions: a result is not a release, and no next run may be
// dispatched until the worker has explicitly relinquished its active round.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {config,ROOT} from '../common.mjs';

const samePath=(a,b)=>{
  const left=path.resolve(a),right=path.resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
};
if(samePath(ROOT,REAL_ROOT))throw new Error(`runtime tests refused live root ${ROOT}`);
if(!samePath(ROOT,TEST_ROOT))throw new Error(`runtime tests refused non-isolated root ${ROOT}`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(HERE,'.tmp',`runtime-protocol-${process.pid}`);
fs.rmSync(base,{recursive:true,force:true});
fs.mkdirSync(base,{recursive:true});

const runs=[];
const releases=[];
let child;
let workspaceCounter=0;

function forkWorker() {
  const value=new EventEmitter();
  value.stdout=new EventEmitter();
  value.stderr=new EventEmitter();
  value.connected=true;
  value.exitCode=null;
  value.signalCode=null;
  value.pid=4900+runs.length;
  value.send=message=>queueMicrotask(()=>onMessage(message,value));
  value.kill=()=>{
    value.exitCode=0;
    value.emit('exit',0);
  };
  child=value;
  return value;
}

function release(message,worker,text='done') {
  worker.emit('message',{kind:'released',roundId:message.roundId});
  releases.push(message.roundId);
  return text;
}

function onMessage(message,worker) {
  if(message.kind==='close') {
    if(worker.pendingRelease) {
      const pending=worker.pendingRelease;
      worker.pendingRelease=null;
      pending();
    }
    worker.exitCode=0;
    setImmediate(()=>worker.emit('exit',0));
    return;
  }
  if(message.kind!=='run')return;
  const entry={
    roundId:message.roundId,
    taskId:message.task.id,
    prompt:message.prompt,
    provider:message.task.provider?.type,
    release:null,
  };
  runs.push(entry);
  worker.emit('message',{
    kind:'ready',
    roundId:message.roundId,
    ownerMarker:message.ownerMarker,
    pid:worker.pid,
    startedAt:new Date().toISOString(),
  });
  if(message.prompt.includes('[no-ack]'))return;
  worker.emit('message',{kind:'ack',roundId:message.roundId});

  if(message.prompt.includes('[hold-result]')) {
    worker.emit('message',{
      kind:'result',
      roundId:message.roundId,
      text:'first result',
      finishReason:'completed',
    });
    entry.release=()=>release(message,worker);
    return;
  }
  if(message.prompt.includes('[hold-error]')) {
    worker.emit('message',{
      kind:'error',
      roundId:message.roundId,
      error:'first provider failed',
      finishReason:'error',
    });
    entry.release=()=>release(message,worker);
    return;
  }
  if(message.prompt.includes('[release-on-close]')) {
    worker.emit('message',{
      kind:'result',
      roundId:message.roundId,
      text:'waiting for close',
      finishReason:'completed',
    });
    worker.pendingRelease=()=>release(message,worker);
    return;
  }
  if(message.prompt.includes('[stale-heartbeat]')) {
    worker.emit('message',{kind:'heartbeat',roundId:message.roundId,at:new Date().toISOString()});
    entry.release=()=>release(message,worker);
    return;
  }
  if(message.prompt.includes('[stale-event]')) {
    worker.emit('message',{
      kind:'event',
      roundId:'round-00000000-0000-4000-8000-000000000000',
      notification:{params:{event:{type:'late/old-round'}}},
    });
  }
  if(message.prompt.includes('[duplicate-result]')) {
    worker.emit('message',{
      kind:'result',
      roundId:message.roundId,
      text:'only result',
      finishReason:'completed',
    });
    worker.emit('message',{
      kind:'result',
      roundId:message.roundId,
      text:'duplicate must be ignored',
      finishReason:'completed',
    });
    entry.release=()=>release(message,worker);
    setImmediate(()=>entry.release?.());
    return;
  }
  if(message.prompt.includes('[worker-busy]')) {
    worker.emit('message',{kind:'worker_busy',roundId:message.roundId});
    return;
  }
  if(message.prompt.includes('[release-only]')) {
    entry.release=()=>release(message,worker);
    setImmediate(()=>entry.release?.());
    return;
  }
  worker.emit('message',{kind:'heartbeat',roundId:message.roundId,at:new Date().toISOString()});
  worker.emit('message',{
    kind:'result',
    roundId:message.roundId,
    text:'done',
    finishReason:'completed',
  });
  entry.release=()=>release(message,worker);
  setImmediate(()=>entry.release?.());
}

const manager=createManager({forkWorker});
after(()=>manager.shutdown());
const newWorkspace=()=>{
  const dir=path.join(base,`ws-${++workspaceCounter}`);
  fs.mkdirSync(dir,{recursive:true});
  return dir;
};
const create=extra=>manager.action('create',{
  workspace:newWorkspace(),
  prompt:'work',
  plan:'p',
  criteria:'c',
  provider:'deepseek-flash',
  ...extra,
});
const runsFor=id=>runs.filter(run=>run.taskId===id);
async function waitFor(predicate,label,attempts=300) {
  for(let i=0;i<attempts;i++) {
    if(await predicate())return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function settled(id) {
  await waitFor(async()=>{
    const status=await manager.action('status',{id});
    return status.status!=='running'&&status.status!=='stopping';
  },`${id} to settle`);
  return manager.action('status',{id});
}
async function history(id) {
  let offset=0,text='';
  for(;;) {
    const page=await manager.action('status',{id,view:'history',offset,limit:4000});
    text+=page.text;
    if(page.nextOffset===null)return JSON.parse(text);
    offset=page.nextOffset;
  }
}

test('rework issued after result waits for released and then dispatches exactly one round',async()=>{
  const created=await create({prompt:'[hold-result] first'});
  await waitFor(()=>runsFor(created.id).length===1&&Boolean(runsFor(created.id)[0].release),'first result');
  const first=await manager.action('status',{id:created.id});
  assert.equal(first.status,'awaiting_review');
  const pending=manager.action('rework',{id:created.id,prompt:'second round'});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(runsFor(created.id).length,1,'rework must not race the worker busy flag');
  runsFor(created.id)[0].release();
  await pending;
  await settled(created.id);
  await waitFor(()=>releases.length>=2,'second release');
  const record=await history(created.id);
  assert.equal(record.rounds.length,2);
  assert.notEqual(record.rounds[0].roundId,record.rounds[1].roundId);
  const events=fs.readFileSync(path.join(first.dataDirectory,'events.jsonl'),'utf8')
    .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const sequences=events.map(event=>event.sequence);
  assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b));
  assert.equal(new Set(sequences).size,sequences.length);
  assert.ok(events.filter(event=>event.kind==='round_started').every(event=>event.roundId));
  await manager.action('close',{id:created.id});
});

test('provider fallback starts only after the failed round is released',async()=>{
  const originalFallback=config.fallbackProvider;
  config.fallbackProvider='magpie';
  try {
    const created=await create({prompt:'[hold-error] first'});
    await waitFor(()=>runsFor(created.id).length===1&&Boolean(runsFor(created.id)[0].release),'failed result');
    await waitFor(async()=>{
      const status=await manager.action('status',{id:created.id});
      return status.status==='failed';
    },'failed round state');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(runsFor(created.id).length,1,'fallback must wait for released');
    runsFor(created.id)[0].release();
    await waitFor(()=>runsFor(created.id).length===2,'fallback dispatch');
    assert.equal(runsFor(created.id)[1].provider,'openai-chat');
    await settled(created.id);
    await manager.action('close',{id:created.id});
  } finally {
    config.fallbackProvider=originalFallback;
  }
});

test('ACK timeout fails the task without terminating the process',async()=>{
  const original=config.ackTimeoutSeconds;
  config.ackTimeoutSeconds=0.05;
  try {
    const created=await create({prompt:'[no-ack] work'});
    await waitFor(async()=>{
      const status=await manager.action('status',{id:created.id});
      return status.status==='failed';
    },'ACK timeout');
    const failed=await manager.action('status',{id:created.id});
    assert.equal(failed.live,true);
    assert.match(failed.error,/acknowledge|ack/i);
    await manager.action('close',{id:created.id});
  } finally {
    config.ackTimeoutSeconds=original;
  }
});

test('a stale heartbeat marks health unhealthy but does not kill the process',async()=>{
  const originalStale=config.heartbeatStaleMs;
  const originalCheck=config.heartbeatCheckMs;
  config.heartbeatStaleMs=40;
  config.heartbeatCheckMs=10;
  try {
    const created=await create({prompt:'[stale-heartbeat] work'});
    await waitFor(async()=>{
      const status=await manager.action('status',{id:created.id});
      return status.runtimeHealth==='unhealthy';
    },'stale heartbeat health');
    const status=await manager.action('status',{id:created.id});
    assert.equal(status.status,'running');
    assert.equal(status.live,true);
    await manager.action('close',{id:created.id});
  } finally {
    config.heartbeatStaleMs=originalStale;
    config.heartbeatCheckMs=originalCheck;
  }
});

test('stale and duplicate round messages are recorded but never replace the active result',async()=>{
  const created=await create({prompt:'[stale-event] [duplicate-result] work'});
  await settled(created.id);
  const status=await manager.action('status',{id:created.id});
  assert.equal(status.status,'awaiting_review');
  assert.equal(status.usage.requests,0);
  const record=await history(created.id);
  assert.equal(record.rounds.length,1);
  const events=fs.readFileSync(path.join(status.dataDirectory,'events.jsonl'),'utf8')
    .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const ignored=events.filter(event=>event.kind==='runtime_message_ignored');
  assert.ok(ignored.some(event=>event.messageRoundId==='round-00000000-0000-4000-8000-000000000000'));
  assert.ok(ignored.some(event=>event.reason==='duplicate terminal message'));
  assert.equal(record.rounds[0].result.text,'only result');
  await manager.action('close',{id:created.id});
});

test('worker_busy fails explicitly and release without a terminal message is a protocol error',async()=>{
  const busy=await create({prompt:'[worker-busy] work'});
  await waitFor(async()=>{
    const status=await manager.action('status',{id:busy.id});
    return status.status==='failed';
  },'worker_busy failure');
  const busyStatus=await manager.action('status',{id:busy.id});
  assert.match(busyStatus.error,/worker_busy/i);
  assert.equal(busyStatus.live,true);
  await manager.action('close',{id:busy.id});

  const released=await create({prompt:'[release-only] work'});
  await waitFor(async()=>{
    const status=await manager.action('status',{id:released.id});
    return status.status==='failed';
  },'missing terminal protocol failure');
  const releasedStatus=await manager.action('status',{id:released.id});
  assert.match(releasedStatus.error,/without a result or error/i);
  await manager.action('close',{id:released.id});
});

test('closing while a finished round is still releasing keeps status and event order',async()=>{
  const created=await create({prompt:'[release-on-close] work'});
  await waitFor(async()=>{
    const status=await manager.action('status',{id:created.id});
    return status.status==='awaiting_review';
  },'held result');
  const closed=await manager.action('close',{id:created.id});
  assert.equal(closed.status,'closed');
  assert.equal(closed.live,false);
  const status=await manager.action('status',{id:created.id});
  const events=fs.readFileSync(path.join(status.dataDirectory,'events.jsonl'),'utf8')
    .trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const sequences=events.map(event=>event.sequence);
  assert.deepEqual(sequences,[...sequences].sort((a,b)=>a-b));
  assert.equal(new Set(sequences).size,sequences.length);
  assert.equal(events.at(-1).kind,'closed');
});
