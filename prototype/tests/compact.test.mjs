// Bounded default responses, explicit result/history pagination, and the
// no-echo contract for mutation responses. Uses the same isolated test root
// and fake worker protocol as the other manager tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
// Isolation MUST be imported before manager.mjs/common.mjs.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {config,ROOT} from '../common.mjs';

const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if(samePath(ROOT,REAL_ROOT)) throw new Error(`compact tests refused: common ROOT points at the live root (${ROOT})`);
if(!samePath(ROOT,TEST_ROOT)) throw new Error(`compact tests refused: common ROOT (${ROOT}) is not the isolated test root (${TEST_ROOT})`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(HERE,'.tmp',`compact-${process.pid}`);
fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(base,{recursive:true});

const LONG_PROMPT='A'.repeat(1200)+'TAIL_MARKER_勿回显';
const LONG_REWORK='B'.repeat(1200)+'REWORK_TAIL_勿回显';
const LONG_EVIDENCE='E'.repeat(1000)+'EVIDENCE_TAIL_勿回显';
const LONG_RESULT='😀'.repeat(40)+'汉字'.repeat(600)+'😀结尾';

function fakeFork() {
  const child=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.connected=true;child.exitCode=null;child.pid=4343;
  child.send=message=>{queueMicrotask(()=>onMessage(message,child));};
  child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  return child;
}
function onMessage(message,child) {
  if(message.kind==='close') {child.exitCode=0;setImmediate(()=>child.emit('exit',0));return;}
  if(message.kind!=='run')return;
  child.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
  child.emit('message',{kind:'ack',roundId:message.roundId});
  const finish=()=>{
    child.emit('message',{kind:'result',roundId:message.roundId,
      text:message.prompt.includes('[long]')?LONG_RESULT:`done:${message.prompt.slice(0,16)}`,
      finishReason:'completed'});
    child.emit('message',{kind:'released',roundId:message.roundId});
  };
  if(message.prompt.includes('[empty]')) {
    setImmediate(()=>{
      child.emit('message',{kind:'error',roundId:message.roundId,error:'fake failure'});
      child.emit('message',{kind:'released',roundId:message.roundId});
    });
    return;
  }
  if(message.prompt.includes('[long-error]')) {
    setImmediate(()=>{
      child.emit('message',{kind:'error',roundId:message.roundId,error:'E'.repeat(500)+'ERROR_TAIL'});
      child.emit('message',{kind:'released',roundId:message.roundId});
    });
    return;
  }
  if(message.prompt.includes('[slow]')) setTimeout(finish,400); else setImmediate(finish);
}
const manager=createManager({forkWorker:fakeFork});
let counter=0;
const newWorkspace=()=>{const dir=path.join(base,`ws-${++counter}`);fs.mkdirSync(dir,{recursive:true});return dir;};
// These tests assert response shape and size, not provider behavior. Use the
// legacy DSH SDK provider so the fake worker matches its budget protocol and
// failure fallback does not turn a simulated error into a retry.
const create=extra=>manager.action('create',{workspace:newWorkspace(),prompt:'short',plan:'p',criteria:'c',provider:'deepseek-flash',...extra});
const withoutVariablePaths=value=>JSON.stringify({...value,workspace:'<workspace>',
  ...(value.dataDirectory?{dataDirectory:'<data-directory>'}:{}),...(value.report?{report:'<report>'}:{})});
async function settled(id) {
  for(let i=0;i<300;i++) {
    const task=await manager.action('status',{id});
    if(task.status!=='running'&&task.status!=='stopping')return task;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('task did not settle');
}
async function collect(id,view,limit) {
  const pages=[];let offset=0;
  for(;;) {
    const page=await manager.action('status',{id,view,offset,limit});
    pages.push(page);
    if(page.nextOffset===null)break;
    assert.ok(page.nextOffset>offset,'nextOffset must advance');
    offset=page.nextOffset;
    if(pages.length>10000)throw new Error('pagination did not finish');
  }
  return {text:pages.map(page=>page.text).join(''),pages,totalChars:pages[0]?.totalChars??0};
}

test('list returns 19 bounded summaries and never raw instructions or results',async()=>{
  for(let i=0;i<19;i++) {
    const created=await create({prompt:`${LONG_PROMPT} ${i} [long]`});
    await settled(created.id);
  }
  const list=await manager.action('list');
  assert.ok(Array.isArray(list));
  assert.equal(list.length,19);
  const text=JSON.stringify(list.map(item=>({...item,workspace:'<workspace>'})));
  assert.ok(text.length<15000,`list payload ${text.length} chars must stay under 15000`);
  for(const item of list) {
    for(const key of ['rounds','prompt','plan','criteria','output','acceptance','resultPreview','dataDirectory','report']) {
      assert.ok(!(key in item),`list item must not expose ${key}`);
    }
    assert.equal(item.roundCount,1);
    assert.equal(typeof item.live,'boolean');
    assert.equal(typeof item.workspace,'string');
    assert.equal(item.maxTokens,config.maxTokens);
    assert.equal(item.accepted,false);
    assert.equal(item.cleanupAuthorized,false);
    assert.equal(typeof item.summary,'string');
    assert.ok(item.summary.length<=120);
    assert.equal(item.error,null);
  }
  assert.ok(!text.includes('TAIL_MARKER'),'list must not echo the long instruction tail');
  assert.ok(!text.includes('汉字'.repeat(20)),'list must not contain the result body');
});

test('default status is a bounded preview with progress and paths',async()=>{
  const created=await create({prompt:`${LONG_PROMPT} [long]`});
  await settled(created.id);
  const status=await manager.action('status',{id:created.id});
  for(const key of ['rounds','prompt','plan','criteria','output','acceptance']) {
    assert.ok(!(key in status),`status must not expose ${key}`);
  }
  assert.equal(status.roundCount,1);
  assert.equal(status.maxTokens,config.maxTokens);
  assert.equal(status.resultTotalChars,LONG_RESULT.length);
  assert.ok(status.resultPreview.length<=400);
  assert.ok(status.resultPreview.endsWith('…'));
  assert.ok(LONG_RESULT.startsWith(status.resultPreview.slice(0,-1)));
  assert.equal(status.resultPreviewChars,status.resultPreview.length);
  assert.equal(status.resultPreviewComplete,false);
  assert.equal(status.resultPreviewTruncated,true);
  assert.ok(status.dataDirectory.endsWith(created.id));
  assert.ok(status.report.endsWith(`${created.id}.md`));
  assert.equal(status.lastRound.number,1);
  const text=withoutVariablePaths(status);
  assert.ok(text.length<2500,`status payload ${text.length} chars must stay under 2500 excluding checkout paths`);
  assert.ok(!text.includes('汉字'.repeat(300)),'status preview must stay bounded');
});

test('create/rework/accept/cancel/close return summaries and do not echo long input',async()=>{
  const created=await create({prompt:`${LONG_PROMPT} [long]`});
  const createText=withoutVariablePaths(created);
  assert.ok(!('rounds' in created));
  assert.ok(!createText.includes('TAIL_MARKER'));
  assert.ok(createText.length<2500);
  await settled(created.id);

  const reworked=await manager.action('rework',{id:created.id,prompt:LONG_REWORK+' [long]'});
  const reworkText=withoutVariablePaths(reworked);
  assert.ok(!('rounds' in reworked));
  assert.ok(!reworkText.includes('REWORK_TAIL'));
  assert.ok(reworkText.length<2500);
  await settled(created.id);

  const accepted=await manager.action('accept',{id:created.id,evidence:LONG_EVIDENCE});
  const acceptText=withoutVariablePaths(accepted);
  assert.ok(!('acceptance' in accepted));
  assert.ok(!('rounds' in accepted));
  assert.equal(accepted.accepted,true);
  assert.ok(!acceptText.includes('EVIDENCE_TAIL'));
  assert.ok(acceptText.length<2500,`accept payload ${acceptText.length} chars must stay under 2500 excluding checkout paths`);

  const closed=await manager.action('close',{id:created.id});
  const closeText=withoutVariablePaths(closed);
  assert.equal(closed.status,'closed');
  assert.ok(!('rounds' in closed));
  assert.ok(!closeText.includes('EVIDENCE_TAIL'));
  assert.ok(closeText.length<2500);

  const slow=await create({prompt:`${LONG_PROMPT} [slow]`});
  const cancelled=await manager.action('cancel',{id:slow.id});
  assert.equal(cancelled.status,'cancelled');
  assert.ok(!('rounds' in cancelled));
  assert.ok(!JSON.stringify(cancelled).includes('TAIL_MARKER'));
});

test('result pages reconstruct Chinese and emoji exactly; empty results are explicit',async()=>{
  const created=await create({prompt:'[long] task'});
  await settled(created.id);
  const {text,pages,totalChars}=await collect(created.id,'result',7);
  assert.equal(text,LONG_RESULT);
  assert.equal(totalChars,LONG_RESULT.length);
  assert.ok(pages.length>1);
  let expectedOffset=0;
  for(const page of pages) {
    assert.equal(page.offset,expectedOffset);
    assert.ok(page.text.length<=7);
    assert.doesNotMatch(page.text,/[\uD800-\uDBFF]$/);
    assert.doesNotMatch(page.text,/^[\uDC00-\uDFFF]/);
    if(page.nextOffset!==null)expectedOffset=page.nextOffset;
    assert.equal(page.complete,page.nextOffset===null);
  }
  assert.equal(pages.at(-1).complete,true);

  const empty=await create({prompt:'[empty] task'});
  const failed=await settled(empty.id);
  assert.equal(failed.status,'failed');
  const page=await manager.action('status',{id:empty.id,view:'result'});
  assert.equal(page.text,'');
  assert.equal(page.totalChars,0);
  assert.equal(page.nextOffset,null);
  assert.equal(page.complete,true);
});

test('offset inside a surrogate pair is rejected; narrow pages stay within limit',async()=>{
  const created=await create({prompt:'[long] task'});
  await settled(created.id);
  // LONG_RESULT starts with 😀: offset 1 is its low surrogate.
  await assert.rejects(()=>manager.action('status',{id:created.id,view:'result',offset:1,limit:10}),/splits a surrogate pair/);
  // limit=1 cannot advance over a pair without splitting or exceeding the page size.
  await assert.rejects(()=>manager.action('status',{id:created.id,view:'result',offset:0,limit:1}),/limit is too small/);
  const first=await manager.action('status',{id:created.id,view:'result',offset:0,limit:2});
  assert.equal(first.text,'😀');
  assert.equal(first.nextOffset,2);
  const {text,pages}=await collect(created.id,'result',2);
  assert.equal(text,LONG_RESULT);
  for(const page of pages) assert.ok(page.text.length<=2,`page length ${page.text.length}`);
});

test('history pages reconstruct the complete record including prompts and evidence',async()=>{
  const created=await create({prompt:`${LONG_PROMPT} [long]`});
  await settled(created.id);
  const rework=await manager.action('rework',{id:created.id,prompt:LONG_REWORK+' [long]'});
  assert.equal(rework.roundCount,2);
  await settled(created.id);
  await manager.action('accept',{id:created.id,evidence:LONG_EVIDENCE});
  await manager.action('close',{id:created.id});

  const {text,pages,totalChars}=await collect(created.id,'history',500);
  assert.equal(totalChars,text.length);
  assert.ok(pages.length>1);
  const record=JSON.parse(text);
  assert.equal(record.id,created.id);
  assert.equal(record.status,'closed');
  assert.equal(record.rounds.length,2);
  assert.equal(record.rounds[0].prompt,LONG_PROMPT+' [long]');
  assert.equal(record.rounds[1].prompt,LONG_REWORK+' [long]');
  assert.equal(record.rounds[0].result.text,LONG_RESULT);
  assert.equal(record.rounds[1].result.text,LONG_RESULT);
  assert.equal(record.acceptance.evidence,LONG_EVIDENCE);
});

test('result view is empty while the latest round is still running',async()=>{
  const created=await create({prompt:'[long] first round'});
  await settled(created.id);
  await manager.action('rework',{id:created.id,prompt:'[slow] second round'});
  const status=await manager.action('status',{id:created.id});
  assert.equal(status.resultPreview,'');
  assert.equal(status.resultTotalChars,0);
  assert.equal(status.resultPreviewComplete,true);
  const page=await manager.action('status',{id:created.id,view:'result'});
  assert.equal(page.text,'');
  assert.equal(page.totalChars,0);
  assert.equal(page.nextOffset,null);
  assert.equal(page.complete,true);
  await settled(created.id);
});

test('long errors stay within 240 characters in list and status summaries',async()=>{
  const created=await create({prompt:'[long-error] task'});
  const failed=await settled(created.id);
  assert.equal(failed.status,'failed');
  assert.ok(failed.error.length<=240);
  assert.equal(failed.errorTruncated,true);
  const item=(await manager.action('list')).find(entry=>entry.id===created.id);
  assert.ok(item.error.length<=240);
  assert.equal(item.errorTruncated,true);
  assert.ok(item.summary.length<=120);
});

test('invalid views and pagination are rejected; summary cannot be paged into history',async()=>{
  const created=await create({prompt:'[long] task'});
  await settled(created.id);
  const invalid=[
    ['view','full'],['view','SUMMARY'],['view',null],['view',1],
    ['offset',-1],['offset',1.5],['offset','0'],['offset',null],['offset',2**53],
    ['limit',0],['limit',-1],['limit',4001],['limit',1.5],['limit','2000'],['limit',null],['limit',2**53],
  ];
  for(const [key,value] of invalid) {
    await assert.rejects(()=>manager.action('status',{id:created.id,[key]:value}),/view|offset|limit/,`${key}=${String(value)}`);
    await assert.rejects(()=>manager.action('status',{id:created.id,view:'result',[key]:value}),/view|offset|limit/,`result ${key}=${String(value)}`);
  }
  // Valid pagination args with the default view are validated but still summary.
  const summary=await manager.action('status',{id:created.id,offset:0,limit:4000});
  assert.ok(!('rounds' in summary));
  assert.ok(withoutVariablePaths(summary).length<2500);
  // Maximum page size is accepted, and an offset past the end is an explicit empty tail.
  const maxPage=await manager.action('status',{id:created.id,view:'result',limit:4000});
  assert.ok(maxPage.text.length<=4000);
  assert.equal(maxPage.nextOffset,null);
  const beyond=await manager.action('status',{id:created.id,view:'result',offset:999999});
  assert.equal(beyond.text,'');
  assert.equal(beyond.complete,true);
  assert.equal(beyond.nextOffset,null);
});
