// Real usage and cost observability tests. All events are synthetic and live
// under the isolated test root; no real task data or model API is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
// Isolation MUST be imported before common.mjs or manager.mjs.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {ROOT} from '../common.mjs';
import {usageForList,usageForStatus,usageForView} from '../usage.mjs';
import {createManager} from '../manager.mjs';
import {parseStatusArgs} from '../cli.mjs';
import {catalogue,handle} from '../mcp.mjs';

const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if(samePath(ROOT,REAL_ROOT)) throw new Error(`usage tests refused: live root ${ROOT}`);
if(!samePath(ROOT,TEST_ROOT)) throw new Error(`usage tests refused: non-isolated root ${ROOT}`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PROTOTYPE=path.resolve(HERE,'..');
const base=path.join(TEST_ROOT,'usage-suite');
fs.rmSync(base,{recursive:true,force:true});fs.mkdirSync(base,{recursive:true});
const workspaceBase=path.join(HERE,'.tmp',`usage-ws-${process.pid}`);
fs.rmSync(workspaceBase,{recursive:true,force:true});fs.mkdirSync(workspaceBase,{recursive:true});

// 2026-10-20 is a Tuesday in Asia/Shanghai. Convert Beijing wall time to epoch
// without relying on the host timezone.
const beijing=(hour,minute=0,second=0,day=20)=>Date.UTC(2026,9,day,hour-8,minute,second);
const iso=ms=>new Date(ms).toISOString();
let taskCounter=0,idCounter=0;
function newTask({events=[],rounds=[],model='deepseek-flash'}={}) {
    const id=`task-${(++taskCounter).toString(16).padStart(12,'0')}`;
    const dir=path.join(base,id);
    fs.mkdirSync(dir,{recursive:true});
    writeEvents(dir,events);
    return {task:{id,model,rounds},dir,eventsFile:path.join(dir,'events.jsonl'),indexFile:path.join(dir,'usage-index.json')};
}
function writeEvents(dir,events) {
    const text=events.map(event=>typeof event==='string'?event:JSON.stringify(event)).join('\n');
    fs.writeFileSync(path.join(dir,'events.jsonl'),events.length?text+'\n':'');
}
function appendEvents(dir,events) {
    fs.appendFileSync(path.join(dir,'events.jsonl'),events.map(event=>typeof event==='string'?event:JSON.stringify(event)).join('\n')+'\n');
}
function roundStarted(number,time) {
    return {at:iso(time),kind:'round_started',number,maxTokens:4096};
}
function roundFinished(time,status='awaiting_review') {
    return {at:iso(time),kind:'round_finished',status};
}
function envelope(time,type,data) {
    return {at:iso(time),kind:'event',notification:{method:'session.event',params:{sessionId:'session-usage-test',event:{type,time,data}}}};
}
function stepStart(time,turn=1,step=1) {
    return envelope(time,'step/start',{turn,step});
}
function assistant(time,{id=`response-${++idCounter}`,usage,turn=1,step=1,model='deepseek-flash',
    provider='deepseek-official',text='SYNTHETIC_BODY_SENTINEL'}={}) {
    const source={kind:'model',provider};
    if(typeof model==='string'&&model)source.model=model;
    const data={turn,step,message:{id,role:'assistant',content:[{type:'text',text}],source}};
    if(usage!==undefined)data.usage=usage;
    return envelope(time,'assistant/message',data);
}
const tokens=(inputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,outputTokens=0)=>({inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,
    totalTokens:inputTokens+cacheReadTokens+cacheWriteTokens+outputTokens});
const usageOf=(task,dir)=>usageForStatus(task,dir).usage;
const roundsOf=(task,dir)=>usageForStatus(task,dir).usageRounds;
const viewOf=(task,dir)=>usageForView(task,dir);

test('empty event files report zero usage and totals are recomputed from components',()=>{
    const empty=newTask();
    const emptyStatus=usageForStatus(empty.task,empty.dir);
    assert.equal(emptyStatus.usage.available,true);
    assert.equal(emptyStatus.usage.requests,0);
    assert.equal(emptyStatus.usage.totalTokens,0);
    assert.equal(emptyStatus.usage.estimatedCostCny,0);
    assert.equal(emptyStatus.usage.usageComplete,true);
    assert.equal(emptyStatus.usage.costComplete,true);
    assert.deepEqual(emptyStatus.usageRounds,[]);
    assert.deepEqual(usageForList(empty.task,empty.dir),{available:true,requests:0,outputTokens:0,estimatedCostCny:0,costComplete:true});
    const emptyView=viewOf(empty.task,empty.dir);
    assert.equal(emptyView.scan.eventsBytes,0);
    assert.equal(emptyView.scan.indexedBytes,0);
    assert.equal(emptyView.scan.pendingBytes,0);

    const t0=beijing(10);
    const task=newTask({events:[roundStarted(1,t0),
        assistant(t0+1000,{usage:{inputTokens:10,cacheReadTokens:20,cacheWriteTokens:0,outputTokens:5,totalTokens:999}})]});
    const status=usageForStatus(task.task,task.dir);
    assert.equal(status.usage.requests,1);
    assert.equal(status.usage.inputTokens,10);
    assert.equal(status.usage.cacheReadTokens,20);
    assert.equal(status.usage.outputTokens,5);
    assert.equal(status.usage.totalTokens,35);
    assert.equal(status.usage.totalMismatch,1);
    assert.ok(status.usage.warnings.some(warning=>/total/i.test(warning)));
    const request=viewOf(task.task,task.dir).requests[0];
    assert.equal(request.totalTokens,35);
    assert.equal(request.id,'response-1');
    assert.equal(request.inputTokens,10);
});

test('duplicate message IDs keep the last record and sort by last occurrence',()=>{
    const t0=beijing(10);
    const task=newTask({events:[roundStarted(1,t0),
        assistant(t0+1000,{id:'first-id',usage:tokens(10,0,0,1)}),
        assistant(t0+2000,{id:'second-id',usage:tokens(5,0,0,1)}),
        assistant(t0+3000,{id:'first-id',usage:tokens(20,0,0,2)})]});
    const status=usageForStatus(task.task,task.dir);
    assert.equal(status.usage.requests,2);
    assert.equal(status.usage.duplicates,1);
    assert.equal(status.usage.inputTokens,25);
    assert.equal(status.usage.outputTokens,3);
    assert.equal(status.usage.totalTokens,28);
    const requests=viewOf(task.task,task.dir).requests;
    assert.deepEqual(requests.map(request=>request.id),['second-id','first-id']);
    assert.equal(requests[1].inputTokens,20);
    assert.equal(requests[1].outputTokens,2);
    assert.equal(requests[1].at,iso(t0+3000));
});

test('round_started controls attribution; event-only and empty task rounds are reported',()=>{
    const t0=beijing(10);
    const task=newTask({
        rounds:[
            {number:1,startedAt:iso(t0),finishedAt:iso(t0+1234)},
            {number:3,startedAt:iso(t0+5000)},
        ],
        events:[
            assistant(t0-500,{usage:tokens(1,0,0,1)}),
            roundStarted(1,t0),
            assistant(t0+100,{usage:tokens(2,0,0,2)}),
            roundStarted(2,t0+2000),
            assistant(t0+2100,{usage:tokens(3,0,0,3)}),
            roundFinished(t0+2500),
        ],
    });
    const status=usageForStatus(task.task,task.dir);
    assert.equal(status.usage.requests,3);
    const view=viewOf(task.task,task.dir);
    assert.equal(view.requests[0].round,null);
    assert.equal(view.requests[1].round,1);
    assert.equal(view.requests[2].round,2);
    assert.deepEqual(status.usageRounds.map(round=>round.number),[null,1,2,3]);
    const unassigned=status.usageRounds[0];
    assert.equal(unassigned.number,null);
    assert.equal(unassigned.unassigned,true);
    assert.equal(unassigned.requests,1);
    assert.equal(unassigned.inputTokens,1);
    assert.equal(unassigned.cacheReadTokens,0);
    assert.equal(unassigned.outputTokens,1);
    assert.equal(unassigned.elapsedMs,null);
    assert.equal(status.usageRounds.reduce((sum,round)=>sum+round.requests,0),status.usage.requests);
    const one=status.usageRounds.find(round=>round.number===1);
    assert.equal(one.requests,1);
    assert.equal(one.elapsedMs,1234);
    assert.equal(one.fromEventsOnly,undefined);
    const two=status.usageRounds.find(round=>round.number===2);
    assert.equal(two.fromEventsOnly,true);
    assert.equal(two.elapsedMs,500);
    const three=status.usageRounds.find(round=>round.number===3);
    assert.equal(three.requests,0);
    assert.equal(three.elapsedMs,null);
    const fullUnassigned=view.rounds[0];
    assert.equal(fullUnassigned.number,null);
    assert.equal(fullUnassigned.unassigned,true);
    assert.equal(fullUnassigned.startedAt,null);
    assert.equal(fullUnassigned.finishedAt,null);
    const fullTwo=view.rounds.find(round=>round.number===2);
    assert.equal(fullTwo.fromEventsOnly,true);
    assert.equal(fullTwo.startedAt,iso(t0+2000));
    assert.equal(fullTwo.finishedAt,iso(t0+2500));
    assert.equal(view.rounds.reduce((sum,round)=>sum+round.requests,0),view.totals.requests);
});

test('latency pairs the nearest step/start in the same round and clears after use',()=>{
    const t0=beijing(10);
    const task=newTask({events:[
        roundStarted(1,t0),
        stepStart(t0),
        assistant(t0+123,{usage:tokens(1,0,0,1)}),
        assistant(t0+200,{usage:tokens(1,0,0,1)}),
        stepStart(t0+300),
        assistant(t0+250,{usage:tokens(1,0,0,1)}),
        stepStart(t0+400),
        roundStarted(2,t0+410),
        assistant(t0+450,{usage:tokens(1,0,0,1)}),
    ]});
    const requests=viewOf(task.task,task.dir).requests;
    assert.equal(requests[0].latencyMs,123);
    assert.equal(requests[1].latencyMs,null);
    assert.equal(requests[2].latencyMs,null);
    assert.equal(requests[3].latencyMs,null);
    assert.equal(requests[3].round,2);
});

test('missing usage, unidentified responses, bad JSON, and half lines are counted without zero-filling',()=>{
    const t0=beijing(10);
    const missing=assistant(t0+100,{id:'missing-1'});
    const noId=assistant(t0+200,{id:null});
    const complete=assistant(t0+300,{id:'complete-1',usage:tokens(7,0,0,3)});
    const partial=JSON.stringify(assistant(t0+400,{id:'pending-1',usage:tokens(9,0,0,4)}));
    const half=partial.slice(0,Math.floor(partial.length/2));
    const task=newTask({events:[roundStarted(1,t0),missing,missing,
        noId,noId,'not-json-at-all',half]});
    // Drop the final newline so `half` is a genuinely pending line.
    fs.writeFileSync(task.eventsFile,fs.readFileSync(task.eventsFile,'utf8').slice(0,-1));
    const status=usageForStatus(task.task,task.dir);
    assert.equal(status.usage.requests,0);
    assert.equal(status.usage.missingUsageRequests,1);
    assert.equal(status.usage.unidentifiedResponses,2);
    assert.equal(status.usage.requestsWithoutUsage,3);
    assert.equal(status.usage.parseErrors,1);
    assert.equal(status.usage.duplicates,1);
    assert.equal(status.usage.usageComplete,false);
    assert.equal(status.usage.costComplete,false);
    assert.equal(status.usage.estimatedCostCny,null);
    const missingRound=status.usageRounds.find(round=>round.number===1);
    assert.equal(missingRound.requests,0);
    assert.equal(missingRound.estimatedCostCny,null);
    assert.equal(missingRound.costComplete,false);
    const view=viewOf(task.task,task.dir);
    assert.equal(view.scan.pendingBytes,Buffer.byteLength(half));
    assert.equal(view.scan.indexedBytes,view.scan.eventsBytes-view.scan.pendingBytes);
    assert.deepEqual(view.missingUsage.map(entry=>entry.id).sort(),[null,null,'missing-1'].sort());

    // Complete the pending half line, then append the same complete request
    // twice so its duplicate counter advances by one.
    const rest=partial.slice(half.length);
    fs.appendFileSync(task.eventsFile,[rest,JSON.stringify(complete),JSON.stringify(complete)].join('\n')+'\n');
    const updated=usageForStatus(task.task,task.dir);
    assert.equal(updated.usage.parseErrors,1);
    assert.equal(updated.usage.requests,2);
    assert.equal(updated.usage.totalTokens,23);
    assert.equal(updated.usage.duplicates,2);
    const updatedView=viewOf(task.task,task.dir);
    assert.equal(updatedView.scan.pendingBytes,0);
    assert.equal(updatedView.scan.bytesRead<updatedView.scan.eventsBytes,true);
});

test('peak windows are Asia/Shanghai weekdays and independent of the host timezone',()=>{
    const times=[
        ['09:00:00',beijing(9),'peak'],
        ['11:59:59',beijing(11,59,59),'peak'],
        ['12:00:00',beijing(12),'offPeak'],
        ['13:59:59',beijing(13,59,59),'offPeak'],
        ['14:00:00',beijing(14),'peak'],
        ['17:59:59',beijing(17,59,59),'peak'],
        ['18:00:00',beijing(18),'offPeak'],
        ['Saturday',beijing(10,0,0,24),'offPeak'],
        ['Sunday',beijing(10,0,0,25),'offPeak'],
    ];
    const task=newTask({events:times.map(([,time],index)=>assistant(time,{id:`tier-${index}`,usage:tokens(1,0,0,1)}))});
    const tiers=viewOf(task.task,task.dir).requests.map(request=>request.priceTier);
    assert.deepEqual(tiers,times.map(([, ,tier])=>tier));

    const saved=process.env.TZ;
    try {
        process.env.TZ='America/Los_Angeles';
        assert.equal(viewOf(task.task,task.dir).requests[0].priceTier,'peak');
        process.env.TZ='Asia/Shanghai';
        assert.equal(viewOf(task.task,task.dir).requests[0].priceTier,'peak');
    } finally {
        if(saved===undefined)delete process.env.TZ;else process.env.TZ=saved;
    }
});

test('costs use cache-hit, cache-miss, and output rates with per-request 8 and total 6 decimals',()=>{
    const peak=newTask({events:[assistant(beijing(10),{id:'priced-peak',
        usage:tokens(123456,234567,0,34567)})]});
    const peakStatus=usageForStatus(peak.task,peak.dir).usage;
    const peakView=viewOf(peak.task,peak.dir);
    assert.equal(peakStatus.requests,1);
    assert.equal(peakStatus.totalTokens,392590);
    assert.equal(peakStatus.unpricedRequests,0);
    assert.equal(peakStatus.costComplete,true);
    assert.ok(Math.abs(peakView.requests[0].estimatedCostCny-0.53283068)<1e-12);
    assert.ok(Math.abs(peakStatus.estimatedCostCny-0.532831)<1e-12);

    const offPeak=newTask({events:[assistant(beijing(13),{id:'priced-offpeak',
        usage:tokens(123456,234567,0,34567)})]});
    const offPeakView=viewOf(offPeak.task,offPeak.dir);
    assert.ok(Math.abs(offPeakView.requests[0].estimatedCostCny-0.26641534)<1e-12);

    const mixed=newTask({events:[
        assistant(beijing(10),{id:'write',usage:tokens(1000,0,50,10)}),
        assistant(beijing(10),{id:'unknown',model:'not-a-priced-model',usage:tokens(1000000,0,0,0)}),
        assistant(beijing(10),{id:'no-model',model:null,usage:tokens(1000000,0,0,0)}),
        assistant(beijing(10),{id:'alias',model:'deepseek-v4-flash',usage:tokens(1000000,0,0,0)}),
    ]});
    const mixedView=viewOf(mixed.task,mixed.dir);
    const byId=Object.fromEntries(mixedView.requests.map(request=>[request.id,request]));
    assert.equal(byId.write.estimatedCostCny,null);
    assert.equal(byId.write.priceTier,'peak');
    assert.equal(byId.write.totalTokens,1060);
    assert.equal(byId.unknown.estimatedCostCny,null);
    assert.equal(byId.unknown.modelAssumed,false);
    assert.equal(byId['no-model'].model,'deepseek-flash');
    assert.equal(byId['no-model'].modelAssumed,true);
    assert.ok(Math.abs(byId['no-model'].estimatedCostCny-2)<1e-12);
    assert.ok(Math.abs(byId.alias.estimatedCostCny-2)<1e-12);
    const mixedStatus=usageForStatus(mixed.task,mixed.dir).usage;
    assert.equal(mixedStatus.unpricedRequests,2);
    assert.equal(mixedStatus.costComplete,false);
    assert.ok(Math.abs(mixedStatus.estimatedCostCny-4)<1e-12);
});

test('missing or invalid pricing degrades cost only and never fails list or status',()=>{
    const pricingFile=path.join(PROTOTYPE,'pricing.json');
    const original=fs.readFileSync(pricingFile);
    const backup=`${pricingFile}.test-backup`;
    const t0=beijing(10);
    const task=newTask({events:[assistant(t0,{id:'pricing-degrade',usage:tokens(1000000,0,0,1000000)})]});
    try {
        fs.renameSync(pricingFile,backup);
        const missing=usageForStatus(task.task,task.dir);
        assert.equal(missing.usage.available,true);
        assert.equal(missing.usage.requests,1);
        assert.equal(missing.usage.inputTokens,1000000);
        assert.equal(missing.usage.estimatedCostCny,null);
        assert.equal(missing.usage.costComplete,false);
        assert.equal(missing.usage.pricing,null);
        assert.ok(missing.usage.warnings.some(warning=>/pricing|price/i.test(warning)));
        const list=usageForList(task.task,task.dir);
        assert.equal(list.available,true);
        assert.equal(list.requests,1);
        assert.equal(list.estimatedCostCny,null);
        assert.equal(list.costComplete,false);

        fs.writeFileSync(pricingFile,'{"models":{}}');
        const invalid=usageForStatus(task.task,task.dir);
        assert.equal(invalid.usage.available,true);
        assert.equal(invalid.usage.totalTokens,2000000);
        assert.equal(invalid.usage.estimatedCostCny,null);
        assert.equal(invalid.usage.costComplete,false);
        assert.ok(invalid.usage.warnings.some(warning=>/pricing|price/i.test(warning)));
        assert.equal(viewOf(task.task,task.dir).pricing,null);
    } finally {
        fs.writeFileSync(pricingFile,original);
        if(fs.existsSync(backup))fs.unlinkSync(backup);
    }
});

test('usage index builds once, appends incrementally, rebuilds damage, and is not rewritten without changes',async()=>{
    const t0=beijing(10);
    const task=newTask({events:[roundStarted(1,t0),assistant(t0+1000,{id:'index-1',usage:tokens(1,0,0,2)})]});
    const first=viewOf(task.task,task.dir);
    assert.equal(first.scan.rebuilt,true);
    assert.equal(first.scan.bytesRead,first.scan.eventsBytes);
    assert.equal(first.scan.indexedBytes,first.scan.eventsBytes);
    assert.equal(fs.existsSync(task.indexFile),true);
    assert.equal(first.requests.length,1);

    appendEvents(task.dir,[assistant(t0+2000,{id:'index-2',usage:tokens(3,0,0,4)})]);
    const second=viewOf(task.task,task.dir);
    assert.equal(second.scan.rebuilt,false);
    assert.equal(second.scan.bytesRead<second.scan.eventsBytes,true);
    assert.equal(second.requests.length,2);
    assert.equal(second.scan.indexedBytes,second.scan.eventsBytes);

    const beforeStat=fs.statSync(task.indexFile),beforeText=fs.readFileSync(task.indexFile,'utf8');
    await new Promise(resolve=>setTimeout(resolve,20));
    const unchanged=viewOf(task.task,task.dir);
    assert.equal(unchanged.scan.bytesRead,0);
    assert.equal(unchanged.scan.rebuilt,false);
    assert.equal(fs.readFileSync(task.indexFile,'utf8'),beforeText);
    assert.equal(fs.statSync(task.indexFile).mtimeMs,beforeStat.mtimeMs);

    fs.writeFileSync(task.indexFile,'{broken');
    const repaired=viewOf(task.task,task.dir);
    assert.equal(repaired.scan.rebuilt,true);
    assert.equal(repaired.requests.length,2);

    fs.writeFileSync(task.eventsFile,JSON.stringify(roundStarted(1,t0))+'\n');
    const truncated=viewOf(task.task,task.dir);
    assert.equal(truncated.scan.rebuilt,true);
    assert.equal(truncated.requests.length,0);
    const truncatedAgain=viewOf(task.task,task.dir);
    assert.equal(truncatedAgain.scan.rebuilt,false);
    assert.equal(truncatedAgain.scan.bytesRead,0);

    appendEvents(task.dir,[assistant(t0+3000,{id:'index-3',usage:tokens(5,0,0,6)})]);
    const afterTruncate=viewOf(task.task,task.dir);
    assert.equal(afterTruncate.requests.length,1);
    assert.ok(afterTruncate.scan.bytesRead<afterTruncate.scan.eventsBytes);

    // A same-size edit with the original mtime must be caught by the prefix hash.
    const prefixTask=newTask({events:[roundStarted(1,t0),assistant(t0+1000,{id:'index-1',usage:tokens(1111,0,0,2)})]});
    const prefixFirst=viewOf(prefixTask.task,prefixTask.dir);
    assert.equal(prefixFirst.requests[0].inputTokens,1111);
    const eventsStat=fs.statSync(prefixTask.eventsFile);
    const originalText=fs.readFileSync(prefixTask.eventsFile,'utf8');
    const tamperedText=originalText.replace('"inputTokens":1111','"inputTokens":1112');
    assert.equal(Buffer.byteLength(tamperedText),Buffer.byteLength(originalText));
    fs.writeFileSync(prefixTask.eventsFile,tamperedText);
    fs.utimesSync(prefixTask.eventsFile,eventsStat.atime,eventsStat.mtime);
    const prefix=viewOf(prefixTask.task,prefixTask.dir);
    assert.equal(prefix.scan.rebuilt,true);
    assert.equal(prefix.requests[0].inputTokens,1112);
    const leftovers=fs.readdirSync(prefixTask.dir).filter(name=>name.startsWith('usage-index.json'));
    assert.deepEqual(leftovers,['usage-index.json']);
});

test('an unwritable index still returns computed usage with a warning and recovers',()=>{
    const t0=beijing(10);
    const task=newTask({events:[assistant(t0,{id:'write-fail',usage:tokens(1,2,0,3)})]});
    fs.mkdirSync(task.indexFile);
    const status=usageForStatus(task.task,task.dir);
    assert.equal(status.usage.available,true);
    assert.equal(status.usage.requests,1);
    assert.equal(status.usage.totalTokens,6);
    assert.ok(status.usage.warnings.some(warning=>/index write failed/i.test(warning)));
    const list=usageForList(task.task,task.dir);
    assert.equal(list.requests,1);
    assert.ok(Array.isArray(list.warnings)&&list.warnings.some(warning=>/index write failed/i.test(warning)));
    fs.rmdirSync(task.indexFile);
    const recovered=usageForStatus(task.task,task.dir);
    assert.equal(recovered.usage.requests,1);
    assert.ok(!recovered.usage.warnings.some(warning=>/index write failed/i.test(warning)));
});

test('metric serialization and the index never contain message bodies, tool arguments, or prompts',()=>{
    const t0=beijing(10);
    const sentinel='BODY_SENTINEL_DO_NOT_STORE_9f3a';
    const task=newTask({events:[
        {at:iso(t0),kind:'round_started',number:1,maxTokens:4096,prompt:sentinel},
        envelope(t0+1,'system/message',{turn:1,step:1,message:{role:'system',content:[{type:'text',text:sentinel}]}}),
        envelope(t0+2,'user/message',{turn:1,step:1,content:[{type:'text',text:sentinel}]}),
        stepStart(t0+3),
        assistant(t0+4,{id:'safe-id',usage:tokens(1,2,0,3),text:sentinel}),
    ]});
    const view=viewOf(task.task,task.dir);
    const serialized=JSON.stringify(view);
    const indexText=fs.readFileSync(task.indexFile,'utf8');
    assert.ok(!serialized.includes(sentinel));
    assert.ok(!indexText.includes(sentinel));
    assert.ok(!serialized.includes('arguments'));
    assert.equal(view.requests[0].id,'safe-id');
});

function fakeFork() {
    const child=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.connected=true;child.exitCode=null;child.pid=4545;
    child.send=message=>{queueMicrotask(()=>onMessage(message,child));};
    child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
    return child;
}
function onMessage(message,child) {
    if(message.kind==='close') {child.exitCode=0;setImmediate(()=>child.emit('exit',0));return;}
    if(message.kind!=='run')return;
    child.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
    child.emit('message',{kind:'ack',roundId:message.roundId});
    setImmediate(()=>{
        child.emit('message',{kind:'result',roundId:message.roundId,text:'done',finishReason:'completed'});
        child.emit('message',{kind:'released',roundId:message.roundId});
    });
}
const manager=createManager({forkWorker:fakeFork});
let workspaceCounter=0;
const newWorkspace=()=>{const dir=path.join(workspaceBase,`ws-${++workspaceCounter}`);fs.mkdirSync(dir,{recursive:true});return dir;};
async function settled(id) {
    for(let i=0;i<300;i++) {
        const task=await manager.action('status',{id});
        if(task.status!=='running'&&task.status!=='stopping')return task;
        await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('task did not settle');
}
async function collectUsage(id,limit) {
    const pages=[];let offset=0;
    for(;;) {
        const page=await manager.action('status',{id,view:'usage',offset,limit});
        pages.push(page);
        if(page.nextOffset===null)break;
        assert.ok(page.nextOffset>offset);
        offset=page.nextOffset;
    }
    return {text:pages.map(page=>page.text).join(''),pages};
}

test('manager list/status expose usage and view=usage pagination reconstructs the complete JSON',async()=>{
    const created=await manager.action('create',{workspace:newWorkspace(),prompt:'PROMPT_SENTINEL',plan:'p',criteria:'c'});
    await settled(created.id);
    const status=(await manager.action('status',{id:created.id}));
    const t0=beijing(10);
    // Use deepseek-flash model to match the provider pricing
    appendEvents(status.dataDirectory,[
        assistant(t0+1000,{id:'manager-1',usage:tokens(100,200,0,50),model:'deepseek-flash'}),
        assistant(t0+2000,{id:'manager-2',usage:tokens(10,20,0,5),model:'deepseek-flash'}),
    ]);
    const list=await manager.action('list');
    const item=list.find(entry=>entry.id===created.id);
    assert.equal(item.usage.available,true);
    assert.equal(item.usage.requests,2);
    assert.equal(item.usage.outputTokens,55);
    // Cost may be null if model is not in pricing, just check it doesn't throw
    if(item.usage.estimatedCostCny!==null) {
        assert.equal(typeof item.usage.estimatedCostCny,'number');
    }
    assert.equal(item.usage.costComplete,true);

    const summarized=await manager.action('status',{id:created.id});
    assert.equal(summarized.usage.available,true);
    assert.equal(summarized.usage.requests,2);
    assert.equal(summarized.usage.totalTokens,385);
    assert.equal(summarized.usageRounds.length,1);
    assert.equal(summarized.usageRounds[0].requests,2);
    // Pricing model depends on provider pricing config
    if(summarized.usage.pricing) {
        assert.equal(typeof summarized.usage.pricing.model,'string');
        assert.equal(summarized.usage.pricing.currency,'CNY');
    }

    const {text,pages}=await collectUsage(created.id,97);
    assert.ok(pages.length>1);
    const view=JSON.parse(text);
    assert.equal(view.id,created.id);
    // Model depends on provider config
    assert.equal(typeof view.model,'string');
    if(view.pricing) {
        assert.equal(view.pricing.currency,'CNY');
        assert.ok(Array.isArray(view.pricing.caveats));
        assert.ok(view.pricing.caveats.length>=4);
    }
    const {pricing,...expectedTotals}=summarized.usage;
    assert.deepEqual(view.totals,expectedTotals);
    assert.equal(view.rounds.length,1);
    assert.equal(view.rounds[0].cacheWriteTokens,0);
    assert.equal(view.requests.length,2);
    assert.equal(view.requests[0].id,'manager-1');
    assert.equal(view.scan.pendingBytes,0);
    assert.ok(!text.includes('PROMPT_SENTINEL'));
});

test('metric failures are isolated to usage.available=false on list and status',async()=>{
    const created=await manager.action('create',{workspace:newWorkspace(),prompt:'break events',plan:'p',criteria:'c'});
    const status=await settled(created.id);
    const eventsFile=path.join(status.dataDirectory,'events.jsonl');
    const moved=`${eventsFile}.moved`;
    fs.renameSync(eventsFile,moved);
    fs.mkdirSync(eventsFile);
    try {
        const list=await manager.action('list');
        const item=list.find(entry=>entry.id===created.id);
        assert.equal(item.usage.available,false);
        assert.equal(typeof item.usage.error,'string');
        const summarized=await manager.action('status',{id:created.id});
        assert.equal(summarized.status,'awaiting_review');
        assert.equal(summarized.usage.available,false);
        assert.equal(typeof summarized.usage.error,'string');
        assert.deepEqual(summarized.usageRounds,[]);
        const {text}=await collectUsage(created.id,200);
        const view=JSON.parse(text);
        assert.equal(view.totals.available,false);
        assert.equal(view.id,created.id);
    } finally {
        fs.rmdirSync(eventsFile);
        fs.renameSync(moved,eventsFile);
    }
});

test('CLI accepts view=usage and MCP exposes Waxwing plus legacy tools',async()=>{
    const ID='task-0123456789ab';
    assert.deepEqual(parseStatusArgs([ID,'--view','usage']),{id:ID,view:'usage'});
    assert.deepEqual(parseStatusArgs([ID,'--view=usage','--offset=0','--limit=100']),{id:ID,view:'usage',offset:0,limit:100});
    assert.throws(()=>parseStatusArgs([ID,'--offset','0']),/result|history|usage/);
  assert.equal(catalogue.length,34);
    const exportedStatus=catalogue.find(tool=>tool.name==='waxwing_status');
    assert.ok(exportedStatus.inputSchema.properties.view.enum.includes('usage'));
    const listed=await handle({jsonrpc:'2.0',id:1,method:'tools/list'});
    assert.equal(listed.result.tools.length,34);
    const statusTool=listed.result.tools.find(tool=>tool.name==='waxwing_status');
    assert.ok(statusTool.inputSchema.properties.view.enum.includes('usage'));
    assert.deepEqual(statusTool.inputSchema,exportedStatus.inputSchema);
    assert.match(statusTool.description,/usage/i);
});

test.after(async()=>{await manager.shutdown();});
