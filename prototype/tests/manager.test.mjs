// Manager-level budget behavior: defaults, inheritance, per-round snapshots,
// round_started events, worker budget-file updates, running-task refusal, and
// rejection without side effects. A fake worker replaces the forked DSH worker
// (spawned processes are unavailable in the restricted sandbox) but speaks the
// same IPC protocol and calls the same writeRoundBudget the real worker uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
// Isolation MUST be imported before manager.mjs/common.mjs so the environment
// is fixed before common.mjs resolves its data root.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {config,ROOT,RUNS} from '../common.mjs';
import {budgetFileFor,readRoundBudget,writeRoundBudget} from '../budget.mjs';

// Defense in depth: refuse to run any createManager call (which calls
// ensureDirs and writes task files) unless common resolved to the isolated
// test root rather than the live prototype-data directory.
const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if(samePath(ROOT,REAL_ROOT)) throw new Error(`manager tests refused: common ROOT points at the live data root (${ROOT}); set DSH_SUBAGENT_ROOT to an isolated directory`);
if(!samePath(ROOT,TEST_ROOT)) throw new Error(`manager tests refused: common ROOT (${ROOT}) is not the isolated test root (${TEST_ROOT})`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(HERE,'.tmp',`manager-${process.pid}`);
fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(base,{recursive:true});

const seen=[];
function fakeFork() {
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.connected=true;child.exitCode=null;child.pid=4242;
  child.send=message=>{queueMicrotask(()=>onMessage(message,child));};
  child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  return child;
}
function onMessage(message,child) {
  if(message.kind==='close') {child.exitCode=0;setImmediate(()=>child.emit('exit',0));return;}
  if(message.kind!=='run')return;
  seen.push({id:message.task.id,sessionId:message.task.sessionId,maxTokens:message.maxTokens,effort:message.effort,budgetFile:message.budgetFile});
  // Exactly what worker.mjs does before harness.run: only the DSH SDK path
  // publishes a round budget file.
  if(message.budgetFile)writeRoundBudget(message.budgetFile,message.maxTokens);
  child.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
  child.emit('message',{kind:'ack',roundId:message.roundId});
  const finish=()=>{
    child.emit('message',{kind:'result',roundId:message.roundId,text:`budget=${message.maxTokens}`,finishReason:'completed'});
    child.emit('message',{kind:'released',roundId:message.roundId});
  };
  if(message.prompt.includes('[hold]'))return;
  if(message.prompt.includes('[slow]'))setTimeout(finish,300);else setImmediate(finish);
}
const manager=createManager({forkWorker:fakeFork});
let counter=0;
const newWorkspace=()=>{const dir=path.join(base,`ws-${++counter}`);fs.mkdirSync(dir,{recursive:true});return dir;};
// The budget-file tests exercise the legacy DSH SDK path explicitly; the LIVE
// default provider is openai-chat and has no budget file.
const create=extra=>manager.action('create',{workspace:newWorkspace(),prompt:'do work',plan:'p',criteria:'c',provider:'deepseek-flash',...extra});
async function settledOn(mgr,id) {
  for(let i=0;i<300;i++) {
    const task=await mgr.action('status',{id});
    if(task.status!=='running'&&task.status!=='stopping')return task;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('task did not settle');
}
const settled=id=>settledOn(manager,id);
const readEvents=task=>fs.readFileSync(path.join(task.dataDirectory,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
/** Default responses are summaries; tests opt into the complete record explicitly. */
async function historyOf(mgr,id) {
  const chunks=[];let offset=0;
  for(;;) {
    const page=await mgr.action('status',{id,view:'history',offset,limit:4000});
    chunks.push(page.text);
    if(page.nextOffset===null)break;
    offset=page.nextOffset;
  }
  return JSON.parse(chunks.join(''));
}
const history=id=>historyOf(manager,id);

test('create without maxTokens inherits config.maxTokens and snapshots it',async()=>{
  const created=await create();
  assert.equal(created.maxTokens,config.maxTokens);
  assert.equal(created.roundCount,1);
  assert.equal(created.status,'running');
  assert.equal(created.rounds,undefined); // default is a bounded summary
  const record=await history(created.id);
  assert.equal(record.rounds[0].maxTokens,config.maxTokens);
  // The task patch must INSERT the budget plugin (a flat {id} row would be an
  // override targeting a nonexistent entry and would never mount).
  const patch=JSON.parse(fs.readFileSync(record.patch,'utf8'));
  const inserted=patch.flatMap(row=>row.insert??[]).find(entry=>entry.id==='task-budget');
  assert.ok(inserted,'task-budget plugin must be inserted by the task patch');
  assert.match(inserted.name,/budget-plugin\.mjs$/);
  assert.equal(inserted.config.budgetFile.replaceAll('\\','/'),budgetFileFor(created.dataDirectory).replaceAll('\\','/'));
  const done=await settled(created.id);
  assert.equal(done.status,'awaiting_review');
  const finished=await history(created.id);
  assert.equal(finished.rounds[0].result.text,`budget=${config.maxTokens}`);
  assert.equal(readRoundBudget(budgetFileFor(done.dataDirectory)),config.maxTokens);
  const started=readEvents(done).find(event=>event.kind==='round_started'&&event.number===1);
  assert.equal(started.maxTokens,config.maxTokens);
  const worker=seen.find(entry=>entry.id===created.id);
  assert.equal(worker.maxTokens,config.maxTokens);
  assert.equal(worker.budgetFile,budgetFileFor(done.dataDirectory));
  const report=await manager.action('export',{id:created.id});
  assert.match(fs.readFileSync(report.file,'utf8'),new RegExp(`Output budget: ${config.maxTokens}`));
});

test('rework inherits the task budget, accepts an explicit one, and keeps the session',async()=>{
  const created=await create({maxTokens:4096});
  assert.equal(created.maxTokens,4096);
  await settled(created.id);
  const inherited=await manager.action('rework',{id:created.id,prompt:'again'});
  assert.equal(inherited.maxTokens,4096);
  assert.equal(inherited.roundCount,2);
  assert.equal(inherited.sessionId,created.sessionId);
  const second=await history(created.id);
  assert.equal(second.rounds[1].maxTokens,4096);
  await settled(created.id);
  const changed=await manager.action('rework',{id:created.id,prompt:'smaller',maxTokens:1024});
  assert.equal(changed.maxTokens,1024);
  assert.equal(changed.roundCount,3);
  assert.equal(changed.sessionId,created.sessionId);
  const third=await history(created.id);
  assert.equal(third.rounds[2].maxTokens,1024);
  assert.equal(third.rounds[1].maxTokens,4096); // earlier snapshot is untouched
  const done=await settled(created.id);
  assert.equal(readRoundBudget(budgetFileFor(done.dataDirectory)),1024);
  const started=readEvents(done).filter(event=>event.kind==='round_started').map(event=>event.maxTokens);
  assert.deepEqual(started,[4096,4096,1024]);
  // The same live session saw all three budgets in order, without a restart.
  const sessionIds=new Set(seen.filter(entry=>entry.id===created.id).map(entry=>entry.sessionId));
  assert.deepEqual([...sessionIds],[created.sessionId]);
  assert.deepEqual(seen.filter(entry=>entry.id===created.id).map(entry=>entry.maxTokens),[4096,4096,1024]);
});

test('a rework supplied while the task is running is refused and adds no round',async()=>{
  const created=await create({prompt:'[slow] work'});
  assert.equal((await manager.action('status',{id:created.id})).status,'running');
  await assert.rejects(()=>manager.action('rework',{id:created.id,prompt:'too soon'}),/running/);
  const done=await settled(created.id);
  assert.equal(done.roundCount,1);
  assert.equal(done.status,'awaiting_review');
});

test('wait returns one terminal summary without caller-side polling',async()=>{
  const created=await create({prompt:'[slow] work'});
  const started=Date.now();
  const done=await manager.action('wait',{id:created.id,timeoutSeconds:2});
  assert.equal(done.status,'awaiting_review');
  assert.equal(done.wait.timedOut,false);
  assert.equal(done.wait.timeoutSeconds,2);
  assert.ok(Date.now()-started>=250);
});

test('wait reports a timeout while retaining the managed task',async()=>{
  const created=await create({prompt:'[hold] work'});
  const started=Date.now();
  const pending=await manager.action('wait',{id:created.id,timeoutSeconds:1});
  assert.equal(pending.status,'running');
  assert.equal(pending.wait.timedOut,true);
  assert.ok(Date.now()-started>=900);
  assert.equal((await manager.action('status',{id:created.id})).status,'running');
  await manager.action('close',{id:created.id});
});

test('invalid budgets are rejected before any task, round, or file change',async()=>{
  const invalid=[0,-1,1.5,'2048',null,true,[],{},2**53,NaN];
  const before=await manager.action('list');
  const dirsBefore=fs.readdirSync(RUNS).length;
  for(const value of invalid) {
    await assert.rejects(()=>create({workspace:newWorkspace(),prompt:'x',maxTokens:value}),/positive safe integer/,String(value));
  }
  assert.equal((await manager.action('list')).length,before.length);
  assert.equal(fs.readdirSync(RUNS).length,dirsBefore);
  // rework: rounds, status, updatedAt, and the on-disk budget stay untouched
  const task=await create({maxTokens:2048});
  await settled(task.id);
  const prior=await manager.action('status',{id:task.id});
  for(const value of invalid) {
    await assert.rejects(()=>manager.action('rework',{id:task.id,prompt:'bad',maxTokens:value}),/positive safe integer/,String(value));
  }
  const after=await manager.action('status',{id:task.id});
  assert.equal(after.roundCount,prior.roundCount);
  assert.equal(after.maxTokens,prior.maxTokens);
  assert.equal(after.status,prior.status);
  assert.equal(after.updatedAt,prior.updatedAt);
  assert.equal(after.cleanupAuthorized,prior.cleanupAuthorized);
  assert.equal(readRoundBudget(budgetFileFor(after.dataDirectory)),2048);
});

test('effort defaults to high, inherits across rework, and escalates to max',async()=>{
  const created=await create({provider:'magpie',prompt:'do work'});
  assert.equal(created.effort,'high');
  await settled(created.id);
  const inherited=await manager.action('rework',{id:created.id,prompt:'again'});
  assert.equal(inherited.effort,'high');
  await settled(created.id);
  const escalated=await manager.action('rework',{id:created.id,prompt:'harder',effort:'max'});
  assert.equal(escalated.effort,'max');
  assert.equal(escalated.lastRound.effort,'max');
  await settled(created.id);
  const record=await history(created.id);
  assert.equal(record.effort,'max');
  assert.deepEqual(record.rounds.map(round=>round.effort),['high','high','max']);
  assert.deepEqual(seen.filter(entry=>entry.id===created.id).map(entry=>entry.effort),['high','high','max']);
  const started=readEvents(await manager.action('status',{id:created.id}))
    .filter(event=>event.kind==='round_started').map(event=>event.effort);
  assert.deepEqual(started,['high','high','max']);
  const report=await manager.action('export',{id:created.id});
  assert.match(fs.readFileSync(report.file,'utf8'),/Reasoning effort: max/);
  await manager.action('close',{id:created.id});
});

test('invalid or unsupported effort is rejected before any task or round is created',async()=>{
  const before=await manager.action('list');
  const dirsBefore=fs.readdirSync(RUNS).length;
  for(const value of ['low','medium','xhigh','HIGH','maxx',null,1,true,[]]) {
    await assert.rejects(()=>create({provider:'magpie',prompt:'x',effort:value}),/effort must be one of high, max/,String(value));
  }
  await assert.rejects(()=>create({provider:'deepseek-flash',prompt:'x',effort:'max'}),/effort is not supported/);
  assert.equal((await manager.action('list')).length,before.length);
  assert.equal(fs.readdirSync(RUNS).length,dirsBefore);
  const task=await create({provider:'magpie',maxTokens:2048});
  await settled(task.id);
  const prior=await manager.action('status',{id:task.id});
  for(const value of ['low','maxx',3]) {
    await assert.rejects(()=>manager.action('rework',{id:task.id,prompt:'bad',effort:value}),/effort must be one of high, max/,String(value));
  }
  const after=await manager.action('status',{id:task.id});
  assert.equal(after.roundCount,prior.roundCount);
  assert.equal(after.effort,prior.effort);
  assert.equal(after.updatedAt,prior.updatedAt);
  await manager.action('close',{id:task.id});
});

test('historical tasks without maxTokens keep the default budget but cannot resume a dead runtime',async()=>{
  const created=await create({maxTokens:512});
  await settled(created.id);
  const taskFile=path.join(created.dataDirectory,'task.json');
  const raw=JSON.parse(fs.readFileSync(taskFile,'utf8'));
  delete raw.maxTokens;
  for(const round of raw.rounds)delete round.maxTokens;
  fs.writeFileSync(taskFile,JSON.stringify(raw,null,2));
  const restored=createManager({forkWorker:fakeFork});
  restored.restore();
  const reloaded=await restored.action('status',{id:created.id});
  assert.equal(reloaded.maxTokens,config.maxTokens); // effective budget falls back to config
  assert.equal(reloaded.canRework,false);
  assert.match(reloaded.reworkBlockedReason,/runtime is gone|cannot resume|new task/i);
  // A fake worker can no longer prove that a new runtime resumes an old
  // sessionId. The restored manager owns no runtime, so rework must be refused
  // before rounds, status, budget, authorization, or files change.
  const taskText=fs.readFileSync(taskFile,'utf8');
  const budgetBefore=readRoundBudget(budgetFileFor(reloaded.dataDirectory));
  await assert.rejects(()=>restored.action('rework',{id:created.id,prompt:'continue'}),/cannot resume|runtime is gone|new runtime|create a new task/i);
  const after=await restored.action('status',{id:created.id});
  assert.equal(after.status,reloaded.status);
  assert.equal(after.roundCount,reloaded.roundCount);
  assert.equal(after.maxTokens,reloaded.maxTokens);
  assert.equal(after.updatedAt,reloaded.updatedAt);
  assert.equal(fs.readFileSync(taskFile,'utf8'),taskText);
  assert.equal(readRoundBudget(budgetFileFor(after.dataDirectory)),budgetBefore);
  await restored.shutdown();
  await manager.action('close',{id:created.id}); // reap the original live fake runtime
});
