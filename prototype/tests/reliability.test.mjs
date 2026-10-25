// Reliability regressions for managed-data path boundaries, workspace
// occupancy, reworkability of old runtimes, and side-effect-free create.
// All data roots and workspaces are isolated under tests/.tmp on I:.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
// Isolation MUST be imported before manager.mjs/common.mjs.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {config,ROOT,RUNS,canonicalPath,isDriveRoot,pathsOverlap,sameOrDescendantPath} from '../common.mjs';
import {budgetFileFor,readRoundBudget,writeRoundBudget} from '../budget.mjs';

const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if(samePath(ROOT,REAL_ROOT)) throw new Error(`reliability tests refused: live root ${ROOT}`);
if(!samePath(ROOT,TEST_ROOT)) throw new Error(`reliability tests refused: non-isolated root ${ROOT}`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(HERE,'.tmp',`reliability-${process.pid}`);
fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(base,{recursive:true});

const managers=[];
function managerWith(forkWorker) {
  const manager=createManager({forkWorker});
  managers.push(manager);
  return manager;
}
const seen=[];
function baseChild() {
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.connected=true;child.exitCode=null;child.signalCode=null;child.pid=4500+seen.length;
  child.closeDelay=0;
  child.send=message=>{queueMicrotask(()=>onMessage(message,child));};
  child.kill=()=>{child.exitCode=0;setImmediate(()=>child.emit('exit',0));};
  return child;
}
function finish(message,child) {
  child.emit('message',{kind:'result',roundId:message.roundId,text:`budget=${message.maxTokens}`,finishReason:'completed'});
  child.emit('message',{kind:'released',roundId:message.roundId});
}
function onMessage(message,child) {
  if(message.kind==='close') {
    const done=()=>{child.exitCode=0;child.emit('exit',0);};
    if(child.closeDelay)setTimeout(done,child.closeDelay);else setImmediate(done);
    return;
  }
  if(message.kind!=='run')return;
  seen.push({id:message.task.id,sessionId:message.task.sessionId,maxTokens:message.maxTokens});
  // Only write budget file for DSH SDK providers (OpenAI providers don't use it)
  if(message.budgetFile) {
    writeRoundBudget(message.budgetFile,message.maxTokens);
  }
  child.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
  child.emit('message',{kind:'ack',roundId:message.roundId});
  const prompt=message.prompt;
  if(prompt.includes('[exit-fail]')) {
    setImmediate(()=>{child.exitCode=1;child.emit('exit',1);});
    return;
  }
  if(prompt.includes('[error]')) {
    setImmediate(()=>{
      child.emit('message',{kind:'error',roundId:message.roundId,error:'fake failure'});
      child.emit('message',{kind:'released',roundId:message.roundId});
    });
    return;
  }
  if(prompt.includes('[exit-after]')) {
    setImmediate(()=>{
      finish(message,child);
      setImmediate(()=>{child.exitCode=0;child.emit('exit',0);});
    });
    return;
  }
  if(prompt.includes('[slow]')) { setTimeout(()=>finish(message,child),350); return; }
  if(prompt.includes('[delay-exit]'))child.closeDelay=200;
  setImmediate(()=>finish(message,child));
}
const manager=managerWith(baseChild);

let counter=0;
const newWorkspace=(prefix='ws')=>{const dir=path.join(base,`${prefix}-${++counter}`);fs.mkdirSync(dir,{recursive:true});return dir;};
const create=extra=>manager.action('create',{workspace:newWorkspace(),prompt:'do work',plan:'p',criteria:'c',...extra});
async function settledOn(mgr,id) {
  for(let i=0;i<400;i++) {
    const task=await mgr.action('status',{id});
    if(task.status!=='running'&&task.status!=='stopping')return task;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('task did not settle');
}
const settled=id=>settledOn(manager,id);
/** Wait for a terminal status AND the exit event that removes the live handle. */
async function settledWithoutRuntime(mgr,id) {
  let task=await settledOn(mgr,id);
  for(let i=0;i<200;i++) {
    task=await mgr.action('status',{id});
    if(task.live===false)return task;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error(`task ${id} runtime did not exit`);
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function taskHashes(status) {
  const dir=status.dataDirectory;
  const budget=budgetFileFor(dir);
  return {task:sha(path.join(dir,'task.json')),events:sha(path.join(dir,'events.jsonl')),
    budget:fs.existsSync(budget)?sha(budget):null};
}
function runsSnapshot() {
  return fs.readdirSync(RUNS).sort().map(name=>{
    const dir=path.join(RUNS,name);
    return {name,files:fs.readdirSync(dir).sort()};
  });
}
async function listSnapshot() {
  const list=await manager.action('list');
  return list.map(item=>({id:item.id,cleanupAuthorized:item.cleanupAuthorized})).sort((a,b)=>a.id.localeCompare(b.id));
}
async function assertUnchanged(status,hashes,label) {
  const now=await manager.action('status',{id:status.id});
  assert.equal(now.status,status.status,`${label}: status changed`);
  assert.equal(now.roundCount,status.roundCount,`${label}: rounds changed`);
  assert.equal(now.maxTokens,status.maxTokens,`${label}: budget changed`);
  assert.equal(now.updatedAt,status.updatedAt,`${label}: updatedAt changed`);
  assert.deepEqual(taskHashes(now),hashes,`${label}: task files changed`);
  // Budget file only exists for DSH SDK providers
  const budgetPath=budgetFileFor(now.dataDirectory);
  if(fs.existsSync(budgetPath)) {
    assert.equal(readRoundBudget(budgetPath),status.maxTokens,`${label}: budget file value changed`);
  }
}
after(async()=>{for(const mgr of managers)await mgr.shutdown();});

test('create rejects the managed root, its ancestors, descendants, and drive roots without side effects',async()=>{
  const inside=path.join(ROOT,'ws-reliability-inside');fs.mkdirSync(inside,{recursive:true});
  const ancestor=path.dirname(ROOT);
  const workspaces=[ROOT,ancestor,inside,path.parse(ROOT).root];
  if(process.platform==='win32')workspaces.push(ROOT.toUpperCase());
  const beforeList=await listSnapshot(),beforeRuns=runsSnapshot();
  for(const workspace of workspaces) {
    await assert.rejects(()=>manager.action('create',{workspace,prompt:'x'}),/workspace|managed|data root|drive/i,String(workspace));
  }
  assert.deepEqual(await listSnapshot(),beforeList);
  assert.deepEqual(runsSnapshot(),beforeRuns);
});

test('create accepts an adjacent-prefix sibling workspace outside the managed root',async()=>{
  const adjacent=`${ROOT}-adjacent-${process.pid}`;
  fs.mkdirSync(adjacent,{recursive:true});
  try {
    const created=await manager.action('create',{workspace:adjacent,prompt:'adjacent prefix is not the root'});
    assert.equal(created.status,'running');
    await settled(created.id);
    await manager.action('close',{id:created.id});
  } finally {
    fs.rmSync(adjacent,{recursive:true,force:true});
  }
});

test('path comparison is separator/case aware and never treats adjacent prefixes as nested',()=>{
  const prefix=path.join(base,'prefix');
  const nestedPath=path.join(prefix,'nested');
  const sibling=path.join(base,'prefix-extra');
  assert.equal(sameOrDescendantPath(prefix,prefix),true);
  assert.equal(sameOrDescendantPath(nestedPath,prefix),true);
  assert.equal(sameOrDescendantPath(sibling,prefix),false);
  assert.equal(pathsOverlap(sibling,prefix),false);
  assert.equal(pathsOverlap(nestedPath,prefix),true);
  assert.equal(canonicalPath(prefix+path.sep),canonicalPath(prefix));
  assert.equal(isDriveRoot(path.parse(base).root),true);
  assert.equal(isDriveRoot(prefix),false);
  if(process.platform==='win32') {
    assert.equal(sameOrDescendantPath(prefix.toUpperCase(),prefix),true);
    assert.equal(sameOrDescendantPath(sibling.toUpperCase(),prefix),false);
  }
});

test('a directory junction resolving to a managed or occupied path is rejected',{skip:process.platform!=='win32'},async t=>{
  const rootLink=path.join(base,`root-link-${++counter}`);
  try{fs.symlinkSync(ROOT,rootLink,'junction');}
  catch(error){t.skip(`directory junction unavailable: ${error.message}`);return;}
  await assert.rejects(()=>manager.action('create',{workspace:rootLink,prompt:'x'}),/managed|data root|workspace/i);
  // A link lexically inside managed data is still managed data, even if its
  // target is outside.
  const outside=newWorkspace('junction-outside');
  const insideLink=path.join(ROOT,`inside-link-${process.pid}`);
  try{fs.symlinkSync(outside,insideLink,'junction');}
  catch(error){t.skip(`directory junction unavailable: ${error.message}`);return;}
  await assert.rejects(()=>manager.action('create',{workspace:insideLink,prompt:'x'}),/managed|data root|inside/i);
  const real=newWorkspace('junction-real');
  const link=path.join(base,`workspace-link-${++counter}`);
  try{fs.symlinkSync(real,link,'junction');}
  catch(error){t.skip(`directory junction unavailable: ${error.message}`);return;}
  const first=await manager.action('create',{workspace:real,prompt:'real workspace'});
  await settled(first.id);
  await assert.rejects(()=>manager.action('create',{workspace:link,prompt:'junction workspace'}),/occup|workspace|live runtime/i);
  await manager.action('close',{id:first.id});
});

test('same, containing, and nested workspaces are occupied while the first runtime is live',async()=>{
  const ws=newWorkspace('overlap');
  const nestedPath=path.join(ws,'nested');fs.mkdirSync(nestedPath);
  const first=await create({workspace:ws});
  await settled(first.id);
  const live=await manager.action('status',{id:first.id});
  assert.equal(live.status,'awaiting_review');
  assert.equal(live.live,true);
  const variants=[ws,nestedPath,base];
  if(process.platform==='win32')variants.push(ws.toUpperCase());
  for(const workspace of variants) {
    await assert.rejects(()=>manager.action('create',{workspace,prompt:'overlapping'}),/occup|workspace|live runtime/i,String(workspace));
  }
  await manager.action('close',{id:first.id});
  const second=await manager.action('create',{workspace:nestedPath,prompt:'after close'});
  await settled(second.id);
  await manager.action('close',{id:second.id});
});

test('a delayed runtime exit keeps the workspace locked until exit is confirmed',async()=>{
  const ws=newWorkspace('delay');
  const first=await manager.action('create',{workspace:ws,prompt:'[delay-exit] work'});
  await settled(first.id);
  let cancelling;
  try {
    cancelling=manager.action('cancel',{id:first.id});
    await tick();
    const stopping=await manager.action('status',{id:first.id});
    assert.equal(stopping.status,'stopping');
    assert.equal(stopping.canRework,false);
    assert.match(stopping.reworkBlockedReason,/stop|clos/i);
    await assert.rejects(()=>manager.action('create',{workspace:ws,prompt:'too early'}),/occup|workspace|live runtime/i);
    await assert.rejects(()=>manager.action('rework',{id:first.id,prompt:'too early'}),/stop|clos/i);
    await cancelling;
    cancelling=undefined;
    const cancelled=await manager.action('status',{id:first.id});
    assert.equal(cancelled.status,'cancelled');
    const second=await manager.action('create',{workspace:ws,prompt:'after exit'});
    await settled(second.id);
    await manager.action('close',{id:second.id});
  } finally {
    if(cancelling)await cancelling.catch(()=>{});
  }
});

test('cancel and close wait for a delayed exit when signalCode is undefined',async()=>{
  const children=[];
  const mgr=managerWith(()=>{const child=baseChild();delete child.signalCode;children.push(child);return child;});
  for(const operation of ['cancel','close']) {
    const created=await mgr.action('create',{workspace:newWorkspace(`no-signal-${operation}`),prompt:'[delay-exit] work'});
    const ready=await settledOn(mgr,created.id);
    assert.equal(ready.status,'awaiting_review');
    assert.equal(ready.live,true);
    assert.equal(ready.canRework,true);
    const stoppingPromise=mgr.action(operation,{id:created.id});
    await tick();
    const during=await mgr.action('status',{id:created.id});
    assert.equal(during.status,'stopping');
    assert.equal(during.live,true);
    await stoppingPromise;
    const after=await mgr.action('status',{id:created.id});
    assert.equal(after.status,operation==='cancel'?'cancelled':'closed');
    assert.equal(after.live,false);
    // The fake close is delayed; stop must not return before its exit event.
    assert.notEqual(children.at(-1).exitCode,null,`${operation} returned before exit`);
    assert.notEqual(children.at(-1).exitCode,undefined,`${operation} returned before exit`);
  }
});

test('live-session rework inherits and adjusts the budget, including after a failed round',async()=>{
  const first=await create({maxTokens:4096});
  await settled(first.id);
  const live=await manager.action('status',{id:first.id});
  assert.equal(live.canRework,true);
  assert.equal(live.reworkBlockedReason,null);
  const inherited=await manager.action('rework',{id:first.id,prompt:'again'});
  assert.equal(inherited.maxTokens,4096);
  assert.equal(inherited.roundCount,2);
  assert.equal(inherited.sessionId,first.sessionId);
  await settled(first.id);
  const adjusted=await manager.action('rework',{id:first.id,prompt:'smaller',maxTokens:1024});
  assert.equal(adjusted.maxTokens,1024);
  await settled(first.id);
  const history=JSON.parse((await (async()=>{
    let offset=0,text='';
    for(;;){const page=await manager.action('status',{id:first.id,view:'history',offset,limit:4000});text+=page.text;if(page.nextOffset===null)break;offset=page.nextOffset;}
    return text;
  })()));
  assert.deepEqual(history.rounds.map(round=>round.maxTokens),[4096,4096,1024]);
  const sameSession=new Set(seen.filter(entry=>entry.id===first.id).map(entry=>entry.sessionId));
  assert.deepEqual([...sameSession],[first.sessionId]);
  await manager.action('close',{id:first.id});

  // Provider fallback may turn the first-round error into an automatic retry;
  // disable it to test the failed-live-rework path deterministically.
  const savedFallback=config.fallbackProvider;
  config.fallbackProvider=null;
  try {
    const failed=await manager.action('create',{workspace:newWorkspace('failed-live'),prompt:'[error] fail'});
    const failedStatus=await settled(failed.id);
    assert.equal(failedStatus.status,'failed');
    assert.equal(failedStatus.live,true);
    assert.equal(failedStatus.canRework,true);
    assert.equal(failedStatus.reworkBlockedReason,null);
    const retried=await manager.action('rework',{id:failed.id,prompt:'retry after live failure',maxTokens:2048});
    assert.equal(retried.maxTokens,2048);
    assert.equal(retried.roundCount,2);
    const retriedDone=await settled(failed.id);
    assert.equal(retriedDone.status,'awaiting_review');
    await manager.action('close',{id:failed.id});
  } finally {
    config.fallbackProvider=savedFallback;
  }
});

test('cancel, worker exit, and restore leave old sessions non-reworkable with no record change',async()=>{
  // Worker exited after a completed round: awaiting_review but no live runtime.
  const exited=await manager.action('create',{workspace:newWorkspace('exit-after'),prompt:'[exit-after] work'});
  const exitedStatus=await settledWithoutRuntime(manager,exited.id);
  assert.equal(exitedStatus.status,'awaiting_review');
  assert.equal(exitedStatus.live,false);
  const exitedHashes=taskHashes(exitedStatus);
  await assert.rejects(()=>manager.action('rework',{id:exited.id,prompt:'continue old session'}),/cannot resume|runtime is gone|new runtime|create a new task/i);
  await assertUnchanged(exitedStatus,exitedHashes,'worker-exit');

  // Worker exited before producing a result: failed with one round and no runtime.
  const crashed=await manager.action('create',{workspace:newWorkspace('exit-fail'),prompt:'[exit-fail] work'});
  const crashedStatus=await settledWithoutRuntime(manager,crashed.id);
  assert.equal(crashedStatus.status,'failed');
  assert.equal(crashedStatus.live,false);
  const crashedHashes=taskHashes(crashedStatus);
  await assert.rejects(()=>manager.action('rework',{id:crashed.id,prompt:'continue old session'}),/cannot resume|runtime is gone|new runtime|create a new task/i);
  await assertUnchanged(crashedStatus,crashedHashes,'worker-exit-fail');

  // Cancelled runtime.
  const cancelled=await create();
  await settled(cancelled.id);
  await manager.action('cancel',{id:cancelled.id});
  const cancelledStatus=await manager.action('status',{id:cancelled.id});
  assert.equal(cancelledStatus.status,'cancelled');
  assert.equal(cancelledStatus.live,false);
  const cancelledHashes=taskHashes(cancelledStatus);
  await assert.rejects(()=>manager.action('rework',{id:cancelled.id,prompt:'continue old session'}),/cannot resume|runtime is gone|new runtime|create a new task/i);
  await assertUnchanged(cancelledStatus,cancelledHashes,'cancelled');

  // Restored manager sees the same record but owns no runtime.
  const restoredTask=await create();
  await settled(restoredTask.id);
  const restored=managerWith(baseChild);
  restored.restore();
  const restoredStatus=await restored.action('status',{id:restoredTask.id});
  assert.equal(restoredStatus.live,false);
  const restoredHashes=taskHashes(restoredStatus);
  await assert.rejects(()=>restored.action('rework',{id:restoredTask.id,prompt:'continue old session'}),/cannot resume|runtime is gone|new runtime|create a new task/i);
  const afterRestore=await restored.action('status',{id:restoredTask.id});
  assert.equal(afterRestore.status,restoredStatus.status);
  assert.equal(afterRestore.roundCount,restoredStatus.roundCount);
  assert.equal(afterRestore.maxTokens,restoredStatus.maxTokens);
  assert.equal(afterRestore.updatedAt,restoredStatus.updatedAt);
  assert.deepEqual(taskHashes(afterRestore),restoredHashes);
  await restored.shutdown();
  await manager.action('close',{id:restoredTask.id});
});

test('status canRework and reworkBlockedReason cover state, rounds, shutdown, and missing runtime',async()=>{
  // running
  const running=await manager.action('create',{workspace:newWorkspace('states-running'),prompt:'[slow] work'});
  const runningStatus=await manager.action('status',{id:running.id});
  assert.equal(runningStatus.canRework,false);
  assert.match(runningStatus.reworkBlockedReason,/running/i);
  await settled(running.id);
  // accepted, then closed
  const accepted=await manager.action('accept',{id:running.id,evidence:'reviewed'});
  const acceptedStatus=await manager.action('status',{id:running.id});
  assert.equal(acceptedStatus.canRework,false);
  assert.match(acceptedStatus.reworkBlockedReason,/accepted/i);
  await manager.action('close',{id:running.id});
  const closedStatus=await manager.action('status',{id:running.id});
  assert.equal(closedStatus.canRework,false);
  assert.match(closedStatus.reworkBlockedReason,/closed/i);

  // maximum rounds
  const maxed=await create();
  await settled(maxed.id);
  for(let round=2;round<=config.maxRounds;round++) {
    await manager.action('rework',{id:maxed.id,prompt:`round ${round}`});
    await settled(maxed.id);
  }
  const maxedStatus=await manager.action('status',{id:maxed.id});
  assert.equal(maxedStatus.roundCount,config.maxRounds);
  assert.equal(maxedStatus.canRework,false);
  assert.match(maxedStatus.reworkBlockedReason,/maximum/i);
  await manager.action('close',{id:maxed.id});

  // shutdown
  const shutting=managerWith(baseChild);
  const parked=await shutting.action('create',{workspace:newWorkspace('states-shutdown'),prompt:'[exit-after] work'});
  const parkedStatus=await settledWithoutRuntime(shutting,parked.id);
  assert.equal(parkedStatus.live,false);
  await shutting.shutdown();
  const shutdownStatus=await shutting.action('status',{id:parked.id});
  assert.equal(shutdownStatus.status,'awaiting_review');
  assert.equal(shutdownStatus.canRework,false);
  assert.match(shutdownStatus.reworkBlockedReason,/shutting down/i);

  // missing runtime
  const orphan=await create();
  await settled(orphan.id);
  await manager.action('cancel',{id:orphan.id});
  const orphanStatus=await manager.action('status',{id:orphan.id});
  assert.equal(orphanStatus.canRework,false);
  assert.match(orphanStatus.reworkBlockedReason,/runtime is gone|cannot resume|new task/i);
});

test('invalid create requests leave tasks, directories, files, and grants unchanged',async()=>{
  const occupiedWorkspace=newWorkspace('occupied');
  const occupied=await manager.action('create',{workspace:occupiedWorkspace,prompt:'occupy'});await settled(occupied.id);
  const inside=path.join(ROOT,'ws-invalid-inside');fs.mkdirSync(inside,{recursive:true});
  const fileWorkspace=path.join(base,'not-a-directory.txt');fs.writeFileSync(fileWorkspace,'x');
  const beforeList=await listSnapshot(),beforeRuns=runsSnapshot();
  const cases=[
    {workspace:newWorkspace('invalid-prompt'),prompt:''},
    {workspace:newWorkspace('invalid-prompt'),prompt:'   '},
    {workspace:newWorkspace('invalid-prompt'),prompt:'x'.repeat(100001)},
    {workspace:newWorkspace('invalid-budget'),prompt:'x',maxTokens:0},
    {workspace:newWorkspace('invalid-budget'),prompt:'x',maxTokens:'2048'},
    {workspace:ROOT,prompt:'x'},
    {workspace:path.dirname(ROOT),prompt:'x'},
    {workspace:inside,prompt:'x'},
    {workspace:path.parse(ROOT).root,prompt:'x'},
    {workspace:fileWorkspace,prompt:'x'},
    {workspace:path.join(base,'does-not-exist',String(Date.now())),prompt:'x'},
    {workspace:occupiedWorkspace,prompt:'x'},
    {workspace:path.join(occupiedWorkspace,'child'),prompt:'x'},
  ];
  fs.mkdirSync(path.join(occupiedWorkspace,'child'));
  for(const args of cases) {
    await assert.rejects(()=>manager.action('create',args),/prompt|budget|maxTokens|workspace|managed|data root|drive|occup|directory|exist|live runtime/i,JSON.stringify({...args,prompt:args.prompt?.slice(0,20)}));
  }
  assert.deepEqual(await listSnapshot(),beforeList);
  assert.deepEqual(runsSnapshot(),beforeRuns);
  await manager.action('close',{id:occupied.id});
});

test('synchronous worker startup failures leave a traceable failed task naming its ID',async()=>{
  const forkFailure=managerWith(()=>{throw new Error('spawn EPERM (simulated)');});
  const ws=newWorkspace('startup-fork');
  let error;
  try{await forkFailure.action('create',{workspace:ws,prompt:'work'});}catch(e){error=e;}
  assert.ok(error,'create must reject when the worker cannot be forked');
  const id=error.message.match(/task-[a-f0-9]{12}/)?.[0];
  assert.ok(id,`startup error must name the task ID: ${error.message}`);
  assert.match(error.message,/failed to start|spawn/i);
  const status=await forkFailure.action('status',{id});
  assert.equal(status.status,'failed');
  assert.equal(status.roundCount,1);
  assert.match(status.error,/spawn EPERM/);
  assert.match(status.error,new RegExp(id));
  assert.equal(status.canRework,false);
  assert.match(status.reworkBlockedReason,/runtime is gone|cannot resume|new task/i);
  const listed=(await forkFailure.action('list')).find(item=>item.id===id);
  assert.ok(listed,'failed startup task must be listed');
  await forkFailure.shutdown();

  // A handle that exists but whose synchronous IPC send fails may still own a
  // live process: record failure and keep the workspace lock until it exits.
  let children=[];
  const sendFailure=managerWith(()=>{
    const child=baseChild();
    if(children.length===0) {
      child.send=()=>{throw new Error('simulated IPC send failure');};
    }
    children.push(child);
    return child;
  });
  const sendWorkspace=newWorkspace('startup-send');
  let sendError;
  try{await sendFailure.action('create',{workspace:sendWorkspace,prompt:'work'});}catch(e){sendError=e;}
  assert.ok(sendError,'create must reject when the run message cannot be sent');
  const sendId=sendError.message.match(/task-[a-f0-9]{12}/)?.[0];
  assert.ok(sendId,`send error must name the task ID: ${sendError.message}`);
  assert.match(sendError.message,/exit not confirmed|runtime/i);
  const sendStatus=await sendFailure.action('status',{id:sendId});
  assert.equal(sendStatus.status,'failed');
  assert.match(sendStatus.error,/exit not confirmed|runtime/i);
  // A handle whose IPC broke is not a healthy old session: rework must be
  // refused with a communication-state reason and no record changes.
  assert.equal(sendStatus.canRework,false);
  assert.match(sendStatus.reworkBlockedReason,/IPC|communicat|untrust/i);
  const sendHashes=taskHashes(sendStatus);
  await assert.rejects(()=>sendFailure.action('rework',{id:sendId,prompt:'retry after IPC failure'}),/IPC|communicat|untrust/i);
  const afterSendReject=await sendFailure.action('status',{id:sendId});
  assert.equal(afterSendReject.status,sendStatus.status);
  assert.equal(afterSendReject.roundCount,sendStatus.roundCount);
  assert.equal(afterSendReject.maxTokens,sendStatus.maxTokens);
  assert.equal(afterSendReject.updatedAt,sendStatus.updatedAt);
  assert.deepEqual(taskHashes(afterSendReject),sendHashes);
  // While the process has not exited, the workspace must stay occupied.
  await assert.rejects(()=>sendFailure.action('create',{workspace:sendWorkspace,prompt:'second'}),/occup|workspace|live runtime/i);
  children[0].exitCode=0;children[0].emit('exit',0);
  await tick();
  const afterExit=await sendFailure.action('create',{workspace:sendWorkspace,prompt:'second'});
  await settledOn(sendFailure,afterExit.id);
  await sendFailure.shutdown();
});

test('asynchronous worker error and pre-result exit fail the task with its ID',async()=>{
  let children=[];
  const errorManager=managerWith(()=>{
    const child=baseChild();
    if(children.length===0) {
      child.send=message=>{queueMicrotask(()=>{
        if(message.kind==='run')setImmediate(()=>child.emit('error',new Error('simulated spawn error')));
        else onMessage(message,child);
      });};
    }
    children.push(child);
    return child;
  });
  const errorWs=newWorkspace('startup-error');
  let asyncError;
  try{await errorManager.action('create',{workspace:errorWs,prompt:'work'});}catch(e){asyncError=e;}
  // The synchronous create may already return before an async process error;
  // wait for the task to leave running.
  const tasks=await errorManager.action('list');
  const failedId=tasks[0]?.id;
  assert.ok(failedId,'the failed task must remain traceable');
  if(asyncError)assert.match(asyncError.message,new RegExp(failedId));
  const failed=await (async()=>{for(let i=0;i<300;i++){const s=await errorManager.action('status',{id:failedId});if(s.status!=='running')return s;await new Promise(r=>setTimeout(r,10));}throw new Error('did not fail');})();
  assert.equal(failed.status,'failed');
  assert.match(failed.error,new RegExp(failedId));
  assert.match(failed.error,/error/i);
  assert.equal(failed.canRework,false);
  assert.match(failed.reworkBlockedReason,/process error|untrust/i);
  const failedHashes=taskHashes(failed);
  await assert.rejects(()=>errorManager.action('rework',{id:failedId,prompt:'retry after process error'}),/process error|untrust/i);
  const afterFailedReject=await errorManager.action('status',{id:failedId});
  assert.equal(afterFailedReject.status,failed.status);
  assert.equal(afterFailedReject.roundCount,failed.roundCount);
  assert.equal(afterFailedReject.maxTokens,failed.maxTokens);
  assert.equal(afterFailedReject.updatedAt,failed.updatedAt);
  assert.deepEqual(taskHashes(afterFailedReject),failedHashes);
  await errorManager.shutdown();

  const exitManager=managerWith(()=>{
    const child=baseChild();
    if(children.length===1) {
      child.send=message=>{queueMicrotask(()=>{if(message.kind==='run')setImmediate(()=>{child.exitCode=2;child.emit('exit',2);});});};
    }
    children.push(child);
    return child;
  });
  const exitWs=newWorkspace('startup-exit');
  await exitManager.action('create',{workspace:exitWs,prompt:'work'});
  const exitId=(await exitManager.action('list'))[0]?.id;
  const exited=await (async()=>{for(let i=0;i<300;i++){const s=await exitManager.action('status',{id:exitId});if(s.status!=='running')return s;await new Promise(r=>setTimeout(r,10));}throw new Error('did not fail');})();
  assert.equal(exited.status,'failed');
  assert.match(exited.error,new RegExp(exitId));
  assert.match(exited.error,/exited/i);
  await exitManager.shutdown();
});
