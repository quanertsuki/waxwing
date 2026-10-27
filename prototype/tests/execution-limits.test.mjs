// Execution-policy and cumulative-usage-limit regression tests.
// All tasks, events, and workers are synthetic and isolated under the test
// test root. No real model request is made and the live data root is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
// Isolation MUST be imported before common.mjs or manager.mjs.
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {ROOT,config} from '../common.mjs';
import {usageForStatus} from '../usage.mjs';
import {createManager} from '../manager.mjs';
import * as cli from '../cli.mjs';
import {catalogue,handle} from '../mcp.mjs';

const samePath=(a,b)=>{const left=path.resolve(a),right=path.resolve(b);
    return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;};
if (samePath(ROOT,REAL_ROOT)) throw new Error(`execution-limit tests refused: live root ${ROOT}`);
if (!samePath(ROOT,TEST_ROOT)) throw new Error(`execution-limit tests refused: non-isolated root ${ROOT}`);

const PROTOTYPE=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TEST_DIR=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(TEST_ROOT,'execution-limits-suite');
fs.rmSync(base,{recursive:true,force:true});
fs.mkdirSync(base,{recursive:true});
const workspaceBase=path.join(TEST_DIR,'.tmp',`execution-limits-ws-${process.pid}`);
const policyBase=path.join(base,'policy');
fs.rmSync(workspaceBase,{recursive:true,force:true});
fs.mkdirSync(workspaceBase,{recursive:true});
fs.mkdirSync(policyBase,{recursive:true});

const POLICY_TEXT=`## 执行纪律（本原型附加，不改变任务目标与验收标准；若与上文冲突，以上文任务指令为准）
1. 新建文件优先一次 write 完整内容；同一文件的多处修改合并为少量 edit，避免逐行反复修改。
2. 开发阶段优先运行针对性测试；全量测试最多 3 次。同一测试连续失败 3 次时停止修改，报告失败原因、已尝试的修复和当前状态。
3. 不要重复读取刚编辑过的文件，不要重复执行完全相同的命令。
4. 若判断任务无法在当前上下文或预算内完成，停止并报告阻塞点，不要继续无进展循环。
5. 完成时只报告修改文件、测试结果和剩余风险，不要用大段输出复述已完成的代码。`;
const sha256=text=>createHash('sha256').update(text).digest('hex');

const beijing=(hour,minute=0,second=0,day=20)=>Date.UTC(2026,9,day,hour-8,minute,second);
const iso=ms=>new Date(ms).toISOString();
const tokens=(inputTokens=0,cacheReadTokens=0,cacheWriteTokens=0,outputTokens=0)=>({inputTokens,cacheReadTokens,
    cacheWriteTokens,outputTokens,totalTokens:inputTokens+cacheReadTokens+cacheWriteTokens+outputTokens});
let responseCounter=0;
function envelope(time,type,data) {
    return {at:iso(time),kind:'event',notification:{method:'session.event',params:{sessionId:'session-limits-test',
        event:{type,time,data}}}};
}
function assistant(time,{id=`limits-${++responseCounter}`,usage,turn=1,step=1,model='llm-default'}={}) {
    const data={turn,step,message:{id,role:'assistant',content:[{type:'text',text:'synthetic'}],
        source:{kind:'model',provider:'rl2-kimi',model}}};
    if (usage!==undefined) data.usage=usage;
    return envelope(time,'assistant/message',data);
}
function appendUsage(dir,count,{usage=tokens(1,0,0,1),missing=0,time=beijing(10),model='llm-default'}={}) {
    const events=[];
    for (let i=0;i<count;i++) events.push(assistant(time+i,{usage,model}));
    for (let i=0;i<missing;i++) events.push(assistant(time+count+i,{},{model}));
    fs.appendFileSync(path.join(dir,'events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
}

function makeWorker({delay=250}={}) {
    const stats={runs:[],closes:0,closeMessages:0,kills:0};
    let pid=4700;
    function onMessage(message,child) {
        if (message.kind==='close') {
            stats.closeMessages++;
            child.exitCode=0;
            setImmediate(()=>child.emit('exit',0));
            return;
        }
        if (message.kind!=='run') return;
        stats.runs.push({taskId:message.task.id,prompt:message.prompt,maxTokens:message.maxTokens});
        // Only write budget file for DSH SDK providers (OpenAI providers don't use it)
        if (message.budgetFile) {
            fs.writeFileSync(message.budgetFile,JSON.stringify({maxTokens:message.maxTokens}));
        }
        child.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
        child.emit('message',{kind:'ack',roundId:message.roundId});
        const finish=()=>{
            if (child.exitCode!==null) return;
            child.emit('message',{kind:'result',roundId:message.roundId,text:'done',finishReason:'completed'});
            child.emit('message',{kind:'released',roundId:message.roundId});
        };
        if (message.prompt.includes('[slow]')) setTimeout(finish,delay); else setImmediate(finish);
    }
    function fork() {
        const child=new EventEmitter();
        child.stdout=new EventEmitter();
        child.stderr=new EventEmitter();
        child.connected=true;
        child.exitCode=null;
        child.pid=pid++;
        child.send=message=>{queueMicrotask(()=>onMessage(message,child));};
        child.kill=()=>{
            stats.kills++;
            child.exitCode=0;
            child.emit('exit',0);
        };
        return child;
    }
    return {fork,stats};
}

const worker=makeWorker();
const manager=createManager({forkWorker:worker.fork});
let workspaceCounter=0;
const newWorkspace=()=>{
    const dir=path.join(workspaceBase,`ws-${++workspaceCounter}`);
    fs.mkdirSync(dir,{recursive:true});
    return dir;
};
async function settledOn(mgr,id) {
    for (let i=0;i<400;i++) {
        const task=await mgr.action('status',{id});
        if (task.status!=='running'&&task.status!=='stopping') return task;
        await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error('task did not settle');
}
const settled=id=>settledOn(manager,id);
const create=extra=>manager.action('create',{workspace:newWorkspace(),prompt:'do work',plan:'p',criteria:'c',...extra});
async function historyOf(mgr,id) {
    const chunks=[];
    let offset=0;
    for (;;) {
        const page=await mgr.action('status',{id,view:'history',offset,limit:4000});
        chunks.push(page.text);
        if (page.nextOffset===null) break;
        offset=page.nextOffset;
    }
    return JSON.parse(chunks.join(''));
}
const history=id=>historyOf(manager,id);
function readEvents(dir) {
    return fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
}
const taskFile=dir=>path.join(dir,'task.json');
const budgetFile=dir=>path.join(dir,'budget.json');

async function withPolicyFile(file,fn) {
    const original=config.executionPolicy;
    config.executionPolicy={...(original??{}),enabled:true,file,version:original?.version??1};
    try { return await fn(); }
    finally {
        if (original===undefined) delete config.executionPolicy;
        else config.executionPolicy=original;
    }
}

test('execution-policy.md exists with the required text',()=>{
    const file=path.join(PROTOTYPE,'execution-policy.md');
    assert.equal(fs.existsSync(file),true,'execution-policy.md must exist');
    assert.equal(fs.readFileSync(file,'utf8').trimEnd(),POLICY_TEXT);
});

test('policy is appended once after the user prompt; raw prompt and per-round hash are retained',async()=>{
    const policyText=fs.readFileSync(path.join(PROTOTYPE,'execution-policy.md'),'utf8');
    const policyHash=sha256(policyText);
    const userPrompt='USER_PROMPT_SENTINEL_第一次';
    const created=await create({prompt:userPrompt});
    await settled(created.id);
    const record=await history(created.id);
    assert.equal(record.rounds[0].prompt,userPrompt,'rounds[].prompt must stay the raw user prompt');
    assert.equal(record.rounds[0].policy.enabled,true);
    assert.equal(record.rounds[0].policy.version,1);
    assert.equal(record.rounds[0].policy.sha256,policyHash);
    assert.equal(record.rounds[0].policy.applied,true);
    assert.equal(record.rounds[0].policy.warning,undefined);
    const run=worker.stats.runs.find(entry=>entry.taskId===created.id);
    assert.equal(run.prompt,`${userPrompt}\n---\n${policyText}`);
    assert.equal(run.prompt.split(policyText).length-1,1);

    const second='SECOND_PROMPT_SENTINEL';
    await manager.action('rework',{id:created.id,prompt:second});
    await settled(created.id);
    const reworked=await history(created.id);
    assert.equal(reworked.rounds[1].prompt,second);
    assert.equal(reworked.rounds[0].prompt,userPrompt);
    assert.equal(reworked.rounds[0].policy.sha256,policyHash);
    assert.equal(reworked.rounds[1].policy.sha256,policyHash);
    const secondRun=worker.stats.runs.filter(entry=>entry.taskId===created.id).at(-1);
    assert.equal(secondRun.prompt,`${second}\n---\n${policyText}`);
    assert.equal(secondRun.prompt.split(policyText).length-1,1);

    const report=await manager.action('export',{id:created.id});
    const reportText=fs.readFileSync(report.file,'utf8');
    assert.ok(reportText.includes(policyText),'report must append the policy text once');
    assert.equal(reportText.split(policyText).length-1,1);
    assert.ok(reportText.includes(policyHash),'report must include the policy hash');
});

test('policy changes take effect on the next round and finished rounds keep their hash',async()=>{
    const file=path.join(policyBase,'changing.md');
    const firstText='POLICY_VERSION_A';
    const secondText='POLICY_VERSION_B';
    fs.writeFileSync(file,firstText);
    await withPolicyFile(file,async()=>{
        const created=await create({prompt:'round one'});
        await settled(created.id);
        fs.writeFileSync(file,secondText);
        await manager.action('rework',{id:created.id,prompt:'round two'});
        await settled(created.id);
        const record=await history(created.id);
        assert.equal(record.rounds[0].policy.sha256,sha256(firstText));
        assert.equal(record.rounds[1].policy.sha256,sha256(secondText));
        const runs=worker.stats.runs.filter(entry=>entry.taskId===created.id);
        assert.ok(runs[0].prompt.endsWith(`\n---\n${firstText}`));
        assert.ok(runs[1].prompt.endsWith(`\n---\n${secondText}`));
        // The report keeps the last applied body even if the file changes again.
        fs.writeFileSync(file,'POLICY_VERSION_C');
        const report=await manager.action('export',{id:created.id});
        const reportText=fs.readFileSync(report.file,'utf8');
        assert.ok(reportText.includes(secondText));
        assert.ok(reportText.includes(sha256(secondText)));
        assert.ok(!reportText.includes('POLICY_VERSION_C'));
    });
});

test('disabled policy is not appended and does not warn',async()=>{
    const original=config.executionPolicy;
    config.executionPolicy={...(original??{}),enabled:false,file:'missing-on-purpose.md',version:1};
    try {
        const created=await create({prompt:'NO_POLICY_PROMPT'});
        await settled(created.id);
        const record=await history(created.id);
        assert.equal(record.rounds[0].policy.enabled,false);
        assert.equal(record.rounds[0].policy.applied,false);
        assert.equal(record.rounds[0].policy.warning,undefined);
        const run=worker.stats.runs.find(entry=>entry.taskId===created.id);
        assert.equal(run.prompt,'NO_POLICY_PROMPT');
    } finally {
        if (original===undefined) delete config.executionPolicy;
        else config.executionPolicy=original;
    }
});

test('missing or empty policy files never block the task and are visible as warnings',async()=>{
    const missing=path.join(policyBase,'does-not-exist.md');
    await withPolicyFile(missing,async()=>{
        const created=await create({prompt:'missing policy'});
        const status=await settled(created.id);
        assert.equal(status.status,'awaiting_review');
        const record=await history(created.id);
        assert.equal(record.rounds[0].policy.enabled,true);
        assert.equal(record.rounds[0].policy.applied,false);
        assert.equal(record.rounds[0].policy.sha256,null);
        assert.match(record.rounds[0].policy.warning,/policy/i);
        assert.ok(status.usage.warnings.some(warning=>/policy/i.test(warning)));
        const run=worker.stats.runs.find(entry=>entry.taskId===created.id);
        assert.equal(run.prompt,'missing policy');
    });

    const empty=path.join(policyBase,'empty.md');
    fs.writeFileSync(empty,'   \n');
    await withPolicyFile(empty,async()=>{
        const created=await create({prompt:'empty policy'});
        const status=await settled(created.id);
        assert.equal(status.status,'awaiting_review');
        const record=await history(created.id);
        assert.equal(record.rounds[0].policy.applied,false);
        assert.match(record.rounds[0].policy.warning,/empty|nonempty/i);
        assert.ok(status.usage.warnings.some(warning=>/policy/i.test(warning)));
        const run=worker.stats.runs.find(entry=>entry.taskId===created.id);
        assert.equal(run.prompt,'empty policy');
    });
});

test('limits are opt-in and per-task fields inherit omitted values',async()=>{
    const created=await create({usageLimits:{enabled:true,warnRequests:5,blockRequests:9}});
    assert.equal(created.usage.limits.enabled,true);
    assert.equal(created.usage.limits.warnCostCny,3);
    assert.equal(created.usage.limits.blockCostCny,5);
    assert.equal(created.usage.limits.warnRequests,5);
    assert.equal(created.usage.limits.blockRequests,9);
    const record=await history(created.id);
    assert.deepEqual(record.usageLimits,{enabled:true,warnCostCny:3,blockCostCny:5,warnRequests:5,blockRequests:9});

    const defaults=await create();
    assert.deepEqual(defaults.usage.limits,{enabled:false,warnCostCny:3,blockCostCny:5,warnRequests:100,blockRequests:160});
    assert.equal(defaults.usage.limitState,'disabled');
    assert.equal(defaults.usage.limitWarning,false);
    assert.equal(defaults.usage.limitBlocked,false);

    await settled(created.id);
    const adjusted=await manager.action('rework',{id:created.id,prompt:'wider',usageLimits:{blockRequests:20}});
    assert.equal(adjusted.usage.limits.warnRequests,5);
    assert.equal(adjusted.usage.limits.blockRequests,20);
    assert.equal(adjusted.usage.limits.warnCostCny,3);
    await settled(created.id);
    const adjustedRecord=await history(created.id);
    assert.equal(adjustedRecord.usageLimits.blockRequests,20);
});

test('old tasks without usageLimits use current global limits without rewriting task.json',async()=>{
    const created=await create();
    await settled(created.id);
    const file=taskFile(created.dataDirectory);
    const raw=JSON.parse(fs.readFileSync(file,'utf8'));
    delete raw.usageLimits;
    fs.writeFileSync(file,JSON.stringify(raw,null,2));
    const restored=createManager({forkWorker:worker.fork});
    restored.restore();
    try {
        const before=fs.readFileSync(file,'utf8');
        const status=await restored.action('status',{id:created.id});
        assert.deepEqual(status.usage.limits,{enabled:false,warnCostCny:3,blockCostCny:5,warnRequests:100,blockRequests:160});
        assert.equal(status.usage.limitState,'disabled');
        assert.equal(fs.readFileSync(file,'utf8'),before,'status must not rewrite an old task.json');
        await restored.action('list');
        assert.equal(fs.readFileSync(file,'utf8'),before,'list must not rewrite an old task.json');
    } finally {
        await restored.shutdown();
    }
});

test('invalid usageLimits are rejected before any task, round, budget, authorization, or file change',async()=>{
    const invalid=[
        null,[], 'x', 3,
        {unknown:1},
        {warnRequests:0},
        {warnRequests:-1},
        {warnRequests:1.5},
        {warnRequests:'2'},
        {warnRequests:NaN},
        {warnRequests:Infinity},
        {warnRequests:2**53},
        {warnCostCny:0},
        {warnCostCny:-0.5},
        {warnCostCny:'3'},
        {warnCostCny:Infinity},
        {warnCostCny:NaN},
        {warnRequests:10,blockRequests:10},
        {warnRequests:20,blockRequests:10},
        {warnCostCny:5,blockCostCny:5},
        {warnCostCny:6,blockCostCny:5},
        {enabled:'yes'},
        {enabled:1},
    ];
    const before=await manager.action('list');
    const dirsBefore=fs.readdirSync(path.join(TEST_ROOT,'runs')).length;
    for (const usageLimits of invalid) {
        await assert.rejects(()=>create({usageLimits}),/usageLimits|limit/i,String(usageLimits));
    }
    assert.equal((await manager.action('list')).length,before.length);
    assert.equal(fs.readdirSync(path.join(TEST_ROOT,'runs')).length,dirsBefore);

    const task=await create({usageLimits:{warnRequests:10,blockRequests:20}});
    const done=await settled(task.id);
    const eventsBefore=fs.readFileSync(path.join(done.dataDirectory,'events.jsonl'),'utf8');
    const taskBefore=fs.readFileSync(taskFile(done.dataDirectory),'utf8');
    // budget.json only exists for DSH SDK providers
    const budgetPath=budgetFile(done.dataDirectory);
    const hasBudget=fs.existsSync(budgetPath);
    const budgetBefore=hasBudget?fs.readFileSync(budgetPath,'utf8'):null;
    const statusBefore=await manager.action('status',{id:task.id});
    const listingBefore=fs.readdirSync(done.dataDirectory).sort();
    for (const usageLimits of invalid) {
        await assert.rejects(()=>manager.action('rework',{id:task.id,prompt:'bad limits',usageLimits}),
            /usageLimits|limit/i,String(usageLimits));
    }
    for (const bad of [
        {overrideLimits:'true',overrideReason:'x'},
        {overrideLimits:true,overrideReason:''},
        {overrideLimits:true,overrideReason:'   '},
        {overrideLimits:true,overrideReason:5},
        {overrideLimits:true,overrideReason:'x'.repeat(1001)},
    ]) {
        await assert.rejects(()=>manager.action('rework',{id:task.id,prompt:'bad override',...bad}),/override/i);
    }
    const statusAfter=await manager.action('status',{id:task.id});
    assert.equal(statusAfter.roundCount,statusBefore.roundCount);
    assert.equal(statusAfter.status,statusBefore.status);
    assert.equal(statusAfter.updatedAt,statusBefore.updatedAt);
    assert.equal(statusAfter.cleanupAuthorized,statusBefore.cleanupAuthorized);
    assert.equal(fs.readFileSync(path.join(done.dataDirectory,'events.jsonl'),'utf8'),eventsBefore);
    assert.equal(fs.readFileSync(taskFile(done.dataDirectory),'utf8'),taskBefore);
    if (hasBudget) assert.equal(fs.readFileSync(budgetPath,'utf8'),budgetBefore);
    assert.deepEqual(fs.readdirSync(done.dataDirectory).sort(),listingBefore);
});

test('internalRequests counts responses without usage and drives request warn/block thresholds',()=>{
    const t0=beijing(10);
    for (const [count,missing,expected] of [[98,1,'ok'],[100,1,'warning'],[158,1,'warning'],[159,1,'blocked']]) {
        const dir=path.join(base,`req-${count}-${missing}`);
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,'events.jsonl'),'');
        appendUsage(dir,count,{missing,time:t0});
        const task={id:'task-'+String(count).padStart(12,'0'),model:'deepseek-flash',rounds:[],
            usageLimits:{enabled:true}};
        const usage=usageForStatus(task,dir).usage;
        assert.equal(usage.requests,count);
        assert.equal(usage.requestsWithoutUsage,missing);
        assert.equal(usage.internalRequests,count+missing,`${count}+${missing}`);
        assert.equal(usage.limitState,expected,`${count}+${missing}`);
        assert.equal(usage.limitBlocked,expected==='blocked');
        assert.equal(usage.limitWarning,expected==='warning');
        assert.equal(usage.limitsEvaluated,true);
    }
});

test('cost thresholds use reliable complete cost; incomplete cost never blocks',()=>{
    const t0=beijing(10);
    const warnDir=path.join(base,'cost-warn');
    fs.mkdirSync(warnDir,{recursive:true});
    fs.writeFileSync(path.join(warnDir,'events.jsonl'),'');
    appendUsage(warnDir,1,{usage:tokens(1500000,0,0,0),time:t0,model:'deepseek-flash'});
    // Use deepseek-flash provider to get non-zero pricing
    const warn=usageForStatus({id:'task-cost-warn',model:'deepseek-flash',provider:{name:'deepseek-flash'},rounds:[],
        usageLimits:{enabled:true}},warnDir).usage;
    assert.equal(warn.internalRequests,1);
    assert.ok(Math.abs(warn.estimatedCostCny-3)<1e-9);
    assert.equal(warn.costLimitReliable,true);
    assert.equal(warn.limitState,'warning');
    assert.equal(warn.limitWarning,true);

    const blockDir=path.join(base,'cost-block');
    fs.mkdirSync(blockDir,{recursive:true});
    fs.writeFileSync(path.join(blockDir,'events.jsonl'),'');
    appendUsage(blockDir,1,{usage:tokens(2500000,0,0,0),time:t0,model:'deepseek-flash'});
    const blocked=usageForStatus({id:'task-cost-block',model:'deepseek-flash',provider:{name:'deepseek-flash'},rounds:[],
        usageLimits:{enabled:true}},blockDir).usage;
    assert.ok(Math.abs(blocked.estimatedCostCny-5)<1e-9);
    assert.equal(blocked.costLimitReliable,true);
    assert.equal(blocked.limitState,'blocked');
    assert.equal(blocked.limitBlocked,true);

    const partialDir=path.join(base,'cost-partial');
    fs.mkdirSync(partialDir,{recursive:true});
    fs.writeFileSync(path.join(partialDir,'events.jsonl'),'');
    appendUsage(partialDir,1,{usage:tokens(2500000,0,0,0),time:t0,model:'deepseek-flash'});
    appendUsage(partialDir,1,{usage:tokens(0,0,10,0),time:t0+10,model:'deepseek-flash'});
    const partial=usageForStatus({id:'task-cost-partial',model:'deepseek-flash',provider:{name:'deepseek-flash'},rounds:[],
        usageLimits:{enabled:true}},partialDir).usage;
    assert.equal(partial.costComplete,false);
    assert.equal(partial.costLimitReliable,false);
    assert.equal(partial.internalRequests,2);
    assert.equal(partial.limitState,'ok','the cost dimension must not block while unreliable');
    assert.equal(partial.limitBlocked,false);
    assert.ok(typeof partial.estimatedCostCny==='number');
});

test('disabled limits still report usage but never warn or block',async()=>{
    const created=await create({prompt:'disabled limits',usageLimits:{enabled:false}});
    const done=await settled(created.id);
    appendUsage(done.dataDirectory,200);
    const status=await manager.action('status',{id:created.id});
    assert.equal(status.usage.internalRequests,200);
    assert.equal(status.usage.limitState,'disabled');
    assert.equal(status.usage.limitWarning,false);
    assert.equal(status.usage.limitBlocked,false);
    assert.equal(status.usage.limitsEvaluated,false);
    assert.equal(status.canRework,true);
    assert.equal(status.usage.limits.enabled,false);
    const item=(await manager.action('list')).find(entry=>entry.id===created.id);
    assert.equal('limitWarning' in item,false);
    assert.equal('limitBlocked' in item,false);
    const continued=await manager.action('rework',{id:created.id,prompt:'disabled still continues'});
    assert.equal(continued.roundCount,2);
});

test('a warning does not block rework; blocked rework is refused without changing state, rounds, budget, or files',async()=>{
    const warned=await create({prompt:'warning task',usageLimits:{enabled:true,warnRequests:1,blockRequests:3,
        warnCostCny:100,blockCostCny:200}});
    const warnedStatus=await settled(warned.id);
    appendUsage(warnedStatus.dataDirectory,1);
    const warning=await manager.action('status',{id:warned.id});
    assert.equal(warning.usage.limitState,'warning');
    assert.equal(warning.canRework,true);
    assert.equal(warning.reworkBlockedReason,null);
    const continued=await manager.action('rework',{id:warned.id,prompt:'continue after warning'});
    assert.equal(continued.roundCount,2);
    await settled(warned.id);

    const blocked=await create({prompt:'blocked task',usageLimits:{enabled:true,warnRequests:1,blockRequests:2,
        warnCostCny:100,blockCostCny:200}});
    const blockedStatus=await settled(blocked.id);
    appendUsage(blockedStatus.dataDirectory,2);
    const before=await manager.action('status',{id:blocked.id});
    assert.equal(before.usage.limitState,'blocked');
    assert.equal(before.usage.limitBlocked,true);
    assert.equal(before.canRework,false);
    assert.match(before.reworkBlockedReason,/usage|limit/i);
    assert.equal(before.status,'awaiting_review');
    assert.equal(before.resultPreview,'done','the completed result must stay readable');

    const eventsBefore=fs.readFileSync(path.join(blockedStatus.dataDirectory,'events.jsonl'),'utf8');
    const taskBefore=fs.readFileSync(taskFile(blockedStatus.dataDirectory),'utf8');
    // budget.json only exists for DSH SDK providers
    const budgetPath=budgetFile(blockedStatus.dataDirectory);
    const hasBudget=fs.existsSync(budgetPath);
    const budgetBefore=hasBudget?fs.readFileSync(budgetPath,'utf8'):null;
    // Remove the derived index so the refused preflight must stay read-only.
    const indexFile=path.join(blockedStatus.dataDirectory,'usage-index.json');
    if (fs.existsSync(indexFile)) fs.unlinkSync(indexFile);
    const listingBefore=fs.readdirSync(blockedStatus.dataDirectory).sort();
    await assert.rejects(()=>manager.action('rework',{id:blocked.id,prompt:'must not run'}),/usage|limit/i);
    assert.equal(fs.existsSync(indexFile),false,'a refused rework must not write the usage index');
    const after=await manager.action('status',{id:blocked.id});
    assert.equal(after.status,before.status);
    assert.equal(after.roundCount,before.roundCount);
    assert.equal(after.updatedAt,before.updatedAt);
    assert.equal(after.canRework,false);
    assert.equal(fs.readFileSync(path.join(blockedStatus.dataDirectory,'events.jsonl'),'utf8'),eventsBefore);
    assert.equal(fs.readFileSync(taskFile(blockedStatus.dataDirectory),'utf8'),taskBefore);
    if (hasBudget) assert.equal(fs.readFileSync(budgetPath,'utf8'),budgetBefore);
    // status itself may rebuild the index; the refused rework must not have created it.
    assert.equal(fs.existsSync(indexFile),true);
    assert.deepEqual(fs.readdirSync(blockedStatus.dataDirectory).sort(),listingBefore.concat('usage-index.json').sort());
});

test('overrideLimits plus a reason allows one round, records the event, and does not lift the next block',async()=>{
    const created=await create({prompt:'override base',usageLimits:{enabled:true,warnRequests:1,blockRequests:2,
        warnCostCny:100,blockCostCny:200}});
    const done=await settled(created.id);
    appendUsage(done.dataDirectory,2);
    const blocked=await manager.action('status',{id:created.id});
    assert.equal(blocked.usage.limitState,'blocked');
    const reason='Delegating Agent approved one recovery round after reviewing the task';
    const continued=await manager.action('rework',{id:created.id,prompt:'override round',
        overrideLimits:true,overrideReason:reason});
    assert.equal(continued.roundCount,2);
    assert.equal(continued.sessionId,created.sessionId);
    await settled(created.id);

    const events=readEvents(done.dataDirectory).filter(event=>event.kind==='limit_override');
    assert.equal(events.length,1);
    assert.equal(events[0].reason,reason);
    assert.equal(events[0].usage.internalRequests,2);
    assert.deepEqual(events[0].limitsBefore,{enabled:true,warnCostCny:100,blockCostCny:200,
        warnRequests:1,blockRequests:2});
    assert.deepEqual(events[0].limitsAfter,events[0].limitsBefore);

    const stillBlocked=await manager.action('status',{id:created.id});
    assert.equal(stillBlocked.usage.limitState,'blocked');
    assert.equal(stillBlocked.canRework,false);
    assert.equal(stillBlocked.usage.limitOverride.reason,reason);
    await assert.rejects(()=>manager.action('rework',{id:created.id,prompt:'no second override'}),/usage|limit/i);

    const raised=await manager.action('rework',{id:created.id,prompt:'raised limits',overrideLimits:true,
        overrideReason:'Raise this task limits',usageLimits:{warnRequests:100,blockRequests:999,
            warnCostCny:100,blockCostCny:200}});
    assert.equal(raised.roundCount,3);
    await settled(created.id);
    const after=await manager.action('status',{id:created.id});
    assert.equal(after.usage.limitState,'ok');
    assert.equal(after.canRework,true);
    assert.equal(after.usage.limits.blockRequests,999);
    const overrides=readEvents(done.dataDirectory).filter(event=>event.kind==='limit_override');
    assert.deepEqual(overrides.at(-1).limitsAfter,{enabled:true,warnCostCny:100,blockCostCny:200,
        warnRequests:100,blockRequests:999});
});

test('override cannot bypass running, closed, accepted, maxRounds, or missing-runtime refusals',async()=>{
    const override={overrideLimits:true,overrideReason:'delegating override attempt'};
    const running=await create({prompt:'[slow] override running',usageLimits:{enabled:true,warnRequests:1,blockRequests:2,
        warnCostCny:100,blockCostCny:200}});
    assert.equal((await manager.action('status',{id:running.id})).status,'running');
    await assert.rejects(()=>manager.action('rework',{id:running.id,prompt:'too soon',...override}),/running/);
    await settled(running.id);

    const closed=await create();
    await settled(closed.id);
    await manager.action('close',{id:closed.id});
    await assert.rejects(()=>manager.action('rework',{id:closed.id,prompt:'closed',...override}),/closed/);

    const accepted=await create();
    await settled(accepted.id);
    await manager.action('accept',{id:accepted.id,evidence:'delegating evidence'});
    await assert.rejects(()=>manager.action('rework',{id:accepted.id,prompt:'accepted',...override}),/accepted/);

    const savedMax=config.maxRounds;
    config.maxRounds=1;
    try {
        const capped=await create();
        await settled(capped.id);
        await assert.rejects(()=>manager.action('rework',{id:capped.id,prompt:'capped',...override}),/Maximum 1 rounds/);
    } finally {
        config.maxRounds=savedMax;
    }

    const live=await create();
    await settled(live.id);
    const restored=createManager({forkWorker:worker.fork});
    restored.restore();
    try {
        await assert.rejects(()=>restored.action('rework',{id:live.id,prompt:'resume',...override}),
            /runtime is gone|cannot resume|new runtime/i);
    } finally {
        await restored.shutdown();
    }
});

test('blocked status never stops a running round: it completes, stays live, and keeps its result',async()=>{
    const blocked=await create({prompt:'[slow] finishing round',usageLimits:{enabled:true,warnRequests:1,blockRequests:2,
        warnCostCny:100,blockCostCny:200}});
    const closeBaseline=worker.stats.closeMessages;
    const killBaseline=worker.stats.kills;
    const status=await manager.action('status',{id:blocked.id});
    assert.equal(status.status,'running');
    appendUsage(status.dataDirectory,2);
    const limitBlocked=await manager.action('status',{id:blocked.id});
    assert.equal(limitBlocked.usage.limitState,'blocked');
    assert.equal(limitBlocked.canRework,false);
    assert.equal(limitBlocked.status,'running','a blocked limit must not stop the running round');
    const finished=await settled(blocked.id);
    assert.equal(finished.status,'awaiting_review');
    assert.equal(finished.live,true,'the live session must be retained');
    assert.equal(finished.resultPreview,'done');
    assert.equal(finished.usage.limitState,'blocked');
    assert.equal(worker.stats.closeMessages,closeBaseline,'no stop/close may be sent because of a limit');
    assert.equal(worker.stats.kills,killBaseline,'no kill may be sent because of a limit');
    await manager.action('close',{id:blocked.id});
});

test('unavailable usage reports unavailable, warns, and does not block rework',async()=>{
    const created=await create();
    const status=await settled(created.id);
    const eventsFile=path.join(status.dataDirectory,'events.jsonl');
    const moved=`${eventsFile}.moved`;
    fs.renameSync(eventsFile,moved);
    fs.mkdirSync(eventsFile);
    try {
        const unavailable=await manager.action('status',{id:created.id});
        assert.equal(unavailable.usage.available,false);
        assert.equal(unavailable.usage.limitState,'disabled');
        assert.equal(unavailable.usage.limitWarning,false);
        assert.equal(unavailable.usage.limitBlocked,false);
        assert.equal(unavailable.usage.limitsEvaluated,false);
        assert.equal(unavailable.usage.costLimitReliable,false);
        assert.ok(unavailable.usage.warnings.some(warning=>/usage|unavailable/i.test(warning)));
        assert.deepEqual(unavailable.usage.limits,{enabled:false,warnCostCny:3,blockCostCny:5,
            warnRequests:100,blockRequests:160});
        assert.equal(unavailable.canRework,true,'unavailable usage must not block rework');
        assert.equal(unavailable.usage.internalRequests,0);
        assert.equal(unavailable.usage.estimatedCostCny,null);
    } finally {
        fs.rmdirSync(eventsFile);
        fs.renameSync(moved,eventsFile);
    }
});

test('list flags only non-ok tasks and list/status stay within the size targets',async()=>{
    const listWorker=makeWorker();
    const listManager=createManager({forkWorker:listWorker.fork});
    try {
        const workspaces=path.join(workspaceBase,'list');
        fs.mkdirSync(workspaces,{recursive:true});
        for (let i=0;i<33;i++) {
            const dir=path.join(workspaces,`ws-${i+1}`);
            fs.mkdirSync(dir,{recursive:true});
            const limits=i===0?{enabled:true,warnRequests:1,blockRequests:2,warnCostCny:100,blockCostCny:200}
                :i===1?{enabled:true,warnRequests:1,blockRequests:3,warnCostCny:100,blockCostCny:200}:undefined;
            // Pin the provider so the test does not depend on config.defaultProvider;
            // rl2-kimi ships a pricing file for llm-default, which cost limits need.
            const task=await listManager.action('create',{workspace:dir,prompt:'list task',plan:'p',criteria:'c',
                provider:'rl2-kimi',...(limits?{usageLimits:limits}:{})});
            await settledOn(listManager,task.id);
            if (i===0) appendUsage(path.join(TEST_ROOT,'runs',task.id),2);
            if (i===1) appendUsage(path.join(TEST_ROOT,'runs',task.id),1);
        }
        const list=await listManager.action('list');
        assert.equal(list.length,33);
        const listText=JSON.stringify(list.map(item=>({...item,workspace:'<workspace>'})));
        assert.ok(listText.length<20000,`list payload ${listText.length} chars must stay under 20000 excluding checkout paths`);
        const blockedItem=list[0];
        const warnedItem=list[1];
        const okItem=list[2];
        assert.equal(blockedItem.limitBlocked,true);
        assert.equal(blockedItem.limitWarning,undefined);
        assert.equal(warnedItem.limitWarning,true);
        assert.equal(warnedItem.limitBlocked,undefined);
        assert.equal('limitBlocked' in okItem,false);
        assert.equal('limitWarning' in okItem,false);

        const blockedStatus=await listManager.action('status',{id:list[0].id});
        assert.equal(blockedStatus.usage.limits.blockRequests,2);
        assert.equal(blockedStatus.usage.limitState,'blocked');
        assert.equal(blockedStatus.usage.limitsEvaluated,true);
        assert.equal(blockedStatus.usage.costLimitReliable,true);
        assert.equal(blockedStatus.usage.internalRequests,2);
        const statusText=JSON.stringify({...blockedStatus,workspace:'<workspace>',
            dataDirectory:'<data-directory>',report:'<report>'});
        assert.ok(statusText.length<4000,`status payload ${statusText.length} chars must stay under 4000 excluding checkout paths`);

        const pages=[];
        let offset=0;
        for (;;) {
            const page=await listManager.action('status',{id:list[0].id,view:'usage',offset,limit:4000});
            pages.push(page);
            if (page.nextOffset===null) break;
            offset=page.nextOffset;
        }
        const view=JSON.parse(pages.map(page=>page.text).join(''));
        assert.equal(view.totals.internalRequests,2);
        assert.deepEqual(view.totals.limits,{enabled:true,warnCostCny:100,blockCostCny:200,
            warnRequests:1,blockRequests:2});
        assert.equal(view.totals.limitState,'blocked');
        assert.equal(view.totals.limitBlocked,true);
        assert.equal(view.totals.limitWarning,false);
        assert.equal(view.totals.limitsEvaluated,true);
        assert.equal(view.totals.costLimitReliable,true);
    } finally {
        await listManager.shutdown();
    }
});

test('CLI JSON passes the new fields through and help documents them',()=>{
    assert.equal(typeof cli.parseCommandArgs,'function','CLI must expose JSON argument parsing for tests');
    assert.equal(typeof cli.HELP_TEXT,'string','CLI must expose its help text for tests');
    assert.match(cli.HELP_TEXT,/usageLimits/);
    assert.match(cli.HELP_TEXT,/overrideLimits/);
    assert.match(cli.HELP_TEXT,/overrideReason/);
    const args={id:'task-0123456789ab',prompt:'p',overrideLimits:true,overrideReason:'reason',
        usageLimits:{warnRequests:10,blockRequests:20}};
    const parsed=cli.parseCommandArgs('rework',[JSON.stringify(args)]);
    assert.deepEqual(parsed,{command:'rework',data:args});
    const created=cli.parseCommandArgs('create',[JSON.stringify({workspace:'./w',prompt:'p',
        usageLimits:{enabled:false}})]);
    assert.deepEqual(created,{command:'create',data:{workspace:'./w',prompt:'p',
        usageLimits:{enabled:false}}});
});

test('MCP exposes Waxwing tools plus legacy aliases and forwards usage fields',async()=>{
  assert.equal(catalogue.length,34);
    const createTool=catalogue.find(tool=>tool.name==='ds_create');
    const reworkTool=catalogue.find(tool=>tool.name==='ds_rework');
    assert.equal(createTool.inputSchema.properties.usageLimits.type,'object');
    assert.equal(createTool.inputSchema.properties.usageLimits.additionalProperties,false);
    assert.deepEqual(createTool.inputSchema.properties.usageLimits.properties.enabled,{type:'boolean'});
    assert.equal(createTool.inputSchema.properties.usageLimits.properties.warnRequests.type,'integer');
    assert.equal(reworkTool.inputSchema.properties.overrideLimits.type,'boolean');
    assert.equal(reworkTool.inputSchema.properties.overrideReason.type,'string');
    assert.equal(reworkTool.inputSchema.properties.overrideReason.maxLength,1000);
    assert.equal(reworkTool.inputSchema.properties.usageLimits.type,'object');

    const calls=[];
    const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {ok:true};}};
    const call=(name,args)=>handle({jsonrpc:'2.0',id:1,method:'tools/call',
        params:{name,arguments:args}},io);
    const validCreate=await call('ds_create',{workspace:'./w',prompt:'p',
        usageLimits:{warnRequests:10,blockRequests:20,enabled:true}});
    assert.equal(validCreate.result.isError,undefined);
    const validRework=await call('ds_rework',{id:'task-0123456789ab',prompt:'p',overrideLimits:true,
overrideReason:'delegating approved',usageLimits:{warnCostCny:1,blockCostCny:2}});
    assert.equal(validRework.result.isError,undefined);
    assert.deepEqual(calls[0],{name:'create',args:{workspace:'./w',prompt:'p',
        usageLimits:{warnRequests:10,blockRequests:20,enabled:true}}});
    assert.deepEqual(calls[1],{name:'rework',args:{id:'task-0123456789ab',prompt:'p',overrideLimits:true,
overrideReason:'delegating approved',usageLimits:{warnCostCny:1,blockCostCny:2}}});

    calls.length=0;
    const invalid=[
        {usageLimits:[]},
        {usageLimits:'x'},
        {usageLimits:null},
        {usageLimits:{unknown:1}},
        {usageLimits:{warnRequests:0}},
        {usageLimits:{warnRequests:1.5}},
        {usageLimits:{warnCostCny:'3'}},
        {overrideLimits:'true'},
        {overrideLimits:true,overrideReason:5},
        {overrideLimits:true,overrideReason:'x'.repeat(1001)},
    ];
    for (const extra of invalid) {
        const response=await call('ds_rework',{id:'task-0123456789ab',prompt:'p',...extra});
        assert.equal(response.result.isError,true,JSON.stringify(extra));
    }
    assert.equal(calls.length,0,'invalid arguments must never reach the manager');
});

test.after(async()=>{await manager.shutdown();});
