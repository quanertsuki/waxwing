// Real usage and cost observability for one task's local DSH event log.
//
// The index stores only IDs, times, rounds, models, token counts, and latency.
// Message text, tool arguments, prompts, and results are never read into it.
// Amounts are deliberately not stored: every query prices the indexed tokens
// with the current pricing.json. All filesystem work stays under the managed
// managed task directory; failures are returned to the caller, never thrown
// through list/status.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {HERE,config} from './common.mjs';
import {
    boundedReason,
    effectiveLimits,
    evaluateLimits,
    unavailableUsageSnapshot,
} from '../src/usage/policy.mjs';

const INDEX_VERSION=1;
const INDEX_NAME='usage-index.json';
// A bounded fingerprint catches rewrites near the beginning or the indexed end
// without re-reading a whole multi-megabyte event log on every query.
const FINGERPRINT_BYTES=4096;
const PRICING_FILE=path.join(HERE,'pricing.json');
// Provider-specific pricing files take precedence when a task has a provider
const PROVIDERS_DIR = config.providersDir || path.join(HERE, '..', 'data', 'providers');
const PRICING_CAVEATS=[
    'Estimates cover only events recorded locally by this prototype; direct DSH sessions, other processes, unknown keys, and requests without recorded usage are not included.',
    'Search and Fetch fees are not included.',
    'Statutory holidays are not modeled; weekday peak windows apply even on public holidays.',
    'Amounts are recomputed from the current pricing.json on every query and are not a bill.',
    'Requests with cache-write tokens are not priced because DeepSeek does not publish a separate cache-write rate.',
];

function shortError(error) {
    const text=error?.message??String(error);
    return text.length>240?`${text.slice(0,239)}…`:text;
}
function isoFromMs(value) {
    if (!Number.isFinite(value)) return null;
    const date=new Date(value);
    return Number.isFinite(date.getTime())?date.toISOString():null;
}
function timeFromAt(value) {
    if (typeof value!=='string') return null;
    const parsed=Date.parse(value);
    return Number.isFinite(parsed)?parsed:null;
}
function hashBytes(value) {
    return createHash('sha256').update(value).digest('hex');
}
function tokenCount(value) {
    return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
}
function round(value,digits) {
    const factor=10**digits;
    return Math.round((value+Number.EPSILON)*factor)/factor;
}
function readRange(file,start,end) {
    const length=Math.max(0,end-start);
    if (length===0) return Buffer.alloc(0);
    const fd=fs.openSync(file,'r');
    try {
        const buffer=Buffer.alloc(length);
        let offset=0;
        while (offset<length) {
            const read=fs.readSync(fd,buffer,offset,length-offset,start+offset);
            if (read<=0) break;
            offset+=read;
        }
        return buffer.subarray(0,offset);
    } finally {
        fs.closeSync(fd);
    }
}
function statOrNull(file) {
    try { return fs.statSync(file); }
    catch (error) { if (error?.code==='ENOENT') return null; throw error; }
}

function listSummary(usage) {
    const result={
        available:true,
        requests:usage.requests,
        outputTokens:usage.outputTokens,
        estimatedCostCny:usage.estimatedCostCny,
        costComplete:usage.costComplete,
    };
    if (Array.isArray(usage.warnings)&&usage.warnings.length>0) result.warnings=usage.warnings;
    return result;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function parseClock(value) {
    if (typeof value!=='string'||!/^\d{2}:\d{2}$/.test(value)) return null;
    const [hour,minute]=value.split(':').map(Number);
    if (hour<0||hour>24||minute<0||minute>59) return null;
    if (hour===24&&minute!==0) return null;
    return hour*3600+minute*60;
}
function validWindow(value) {
    return Array.isArray(value)&&value.length===2&&parseClock(value[0])!==null&&parseClock(value[1])!==null&&
        parseClock(value[0])<parseClock(value[1]);
}
function validTier(value) {
    return value&&typeof value==='object'&&!Array.isArray(value)&&
        ['cacheHit','cacheMiss','output'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0);
}
function validatePricing(value) {
    if (!value||typeof value!=='object'||Array.isArray(value)) throw new Error('pricing root must be an object');
    for (const key of ['currency','unit','effectiveAt','source']) {
        if (typeof value[key]!=='string'||!value[key].trim()) throw new Error(`pricing ${key} must be a nonempty string`);
    }
    const rule=value.peakRule;
    if (!rule||typeof rule!=='object'||Array.isArray(rule)) throw new Error('pricing peakRule must be an object');
    if (rule.timezone!=='Asia/Shanghai') throw new Error('pricing peakRule.timezone must be Asia/Shanghai');
    if (!Array.isArray(rule.weekdays)||rule.weekdays.length===0||
        rule.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6)) throw new Error('pricing peakRule.weekdays is invalid');
    if (!Array.isArray(rule.windows)||rule.windows.length===0||!rule.windows.every(validWindow)) {
        throw new Error('pricing peakRule.windows is invalid');
    }
    if (typeof rule.holidayCalendarModeled!=='boolean') throw new Error('pricing peakRule.holidayCalendarModeled must be a boolean');
    if (!value.models||typeof value.models!=='object'||Array.isArray(value.models)) throw new Error('pricing models must be an object');
    const entries=Object.entries(value.models);
    if (entries.length===0) throw new Error('pricing models must not be empty');
    for (const [name,model] of entries) {
        if (!name||!model||typeof model!=='object'||Array.isArray(model)) throw new Error(`pricing model ${name} is invalid`);
        if (model.aliases!==undefined&&(!Array.isArray(model.aliases)||model.aliases.some(alias=>typeof alias!=='string'))) {
            throw new Error(`pricing model ${name} aliases are invalid`);
        }
        if (!validTier(model.peak)||!validTier(model.offPeak)) throw new Error(`pricing model ${name} rates are invalid`);
    }
    return value;
}
function loadPricing(providerName) {
    // Collect all pricing sources: provider-specific first, then global fallback.
    // A model may be priced by any source; the first source that knows the model wins.
    const sources = [];
    if (providerName) {
        const providerPricingFile = path.join(PROVIDERS_DIR, providerName, 'pricing.json');
        try {
            const text = fs.readFileSync(providerPricingFile, 'utf8');
            let value;
            try { value = JSON.parse(text); } catch { throw new Error('provider pricing file is not valid JSON'); }
            sources.push({pricing: validatePricing(value), source: 'provider'});
        } catch (error) {
            // Provider pricing unavailable, continue with global
        }
    }
    // Always add global pricing as a fallback for models not in provider pricing
    try {
        const text=fs.readFileSync(PRICING_FILE,'utf8');
        let value;
        try { value=JSON.parse(text); }
        catch { throw new Error('pricing file is not valid JSON'); }
        sources.push({pricing: validatePricing(value), source: 'global'});
    } catch (error) {
        // Global pricing unavailable
    }
    if (sources.length === 0) {
        return {ok:false, error:'no pricing source available'};
    }
    return {ok:true, sources};
}
// Find the first pricing source that knows this model; returns {pricing, source} or null.
function findPricingForModel(pricingState, model) {
    if (!pricingState.ok) return null;
    for (const {pricing, source} of pricingState.sources) {
        if (canonicalModel(pricing, model)) return {pricing, source};
    }
    return null;
}
function canonicalModel(pricing,model) {
    if (typeof model!=='string'||!model) return null;
    for (const [name,entry] of Object.entries(pricing.models)) {
        if (name===model||(Array.isArray(entry.aliases)&&entry.aliases.includes(model))) return name;
    }
    return null;
}
function classifyTier(ms,rule) {
    if (!Number.isFinite(ms)) return 'unknown';
    // China has no daylight saving time. Shift to UTC+8 and read UTC fields so
    // the result cannot depend on the host timezone.
    const date=new Date(ms+8*60*60*1000);
    if (!Number.isFinite(date.getTime())) return 'unknown';
    if (!rule.weekdays.includes(date.getUTCDay())) return 'offPeak';
    const seconds=date.getUTCHours()*3600+date.getUTCMinutes()*60+date.getUTCSeconds();
    for (const window of rule.windows) {
        const start=parseClock(window[0]),end=parseClock(window[1]);
        if (seconds>=start&&seconds<end) return 'peak';
    }
    return 'offPeak';
}
function weekdayLabel(days) {
    const sorted=[...days].sort((a,b)=>a-b);
    if (sorted.join(',')==='1,2,3,4,5') return 'Mon-Fri';
    const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return sorted.map(day=>names[day]).join(', ');
}
function peakRuleText(rule) {
    const windows=rule.windows.map(([start,end])=>`[${start},${end})`).join(' ');
    return `${rule.timezone} ${weekdayLabel(rule.weekdays)} ${windows}; statutory holidays not modeled`;
}
function statusPricing(pricingState,taskModel) {
    // Use the pricing source that knows the task model, falling back to first source
    const match = findPricingForModel(pricingState, taskModel) ?? pricingState.sources?.[0];
    if (!match) return null;
    const pricing = match.pricing;
    return {
        model:typeof taskModel==='string'&&taskModel?taskModel:null,
        currency:pricing.currency,
        effectiveAt:pricing.effectiveAt,
        source:pricing.source,
        peakRule:peakRuleText(pricing.peakRule),
        holidayCalendarModeled:pricing.peakRule.holidayCalendarModeled,
    };
}
function fullPricing(pricingState) {
    // Use the pricing source that knows the task model, falling back to first source
    const match = pricingState.sources?.[0];
    if (!match) return null;
    const pricing = match.pricing;
    return {
        currency:pricing.currency,
        unit:pricing.unit,
        effectiveAt:pricing.effectiveAt,
        source:pricing.source,
        peakRule:{...pricing.peakRule,weekdays:[...pricing.peakRule.weekdays],windows:pricing.peakRule.windows.map(window=>[...window])},
        holidayCalendarModeled:pricing.peakRule.holidayCalendarModeled,
        models:JSON.parse(JSON.stringify(pricing.models)),
        caveats:[...PRICING_CAVEATS],
    };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

function emptyIndex(taskId) {
    const emptyHash=hashBytes(Buffer.alloc(0));
    return {
        version:INDEX_VERSION,
        taskId,
        eventsBytes:0,
        fileMtimeMs:null,
        prefixHash:emptyHash,
        prefixHashBytes:0,
        tailHash:emptyHash,
        tailHashStart:0,
        currentRound:null,
        eventRounds:[],
        pendingStep:null,
        responses:[],
        duplicates:0,
        totalMismatch:0,
        parseErrors:0,
    };
}
function validResponse(value) {
    return value&&typeof value==='object'&&!Array.isArray(value)&&
        (value.id===null||typeof value.id==='string')&&
        (value.at===null||typeof value.at==='string')&&
        (value.time===null||Number.isFinite(value.time))&&
        (value.round===null||Number.isSafeInteger(value.round))&&
        (value.turn===null||Number.isSafeInteger(value.turn))&&
        (value.step===null||Number.isSafeInteger(value.step))&&
        (value.provider===null||typeof value.provider==='string')&&
        (value.model===null||typeof value.model==='string')&&
        typeof value.modelAssumed==='boolean'&&
        typeof value.usage==='boolean'&&
        ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(key=>typeof value[key]==='number'&&Number.isFinite(value[key])&&value[key]>=0)&&
        (value.latencyMs===null||(Number.isFinite(value.latencyMs)&&value.latencyMs>=0));
}
function validIndex(value,taskId) {
    if (!value||typeof value!=='object'||Array.isArray(value)) return false;
    if (value.version!==INDEX_VERSION||value.taskId!==taskId) return false;
    if (!Number.isSafeInteger(value.eventsBytes)||value.eventsBytes<0) return false;
    if (value.fileMtimeMs!==null&&!Number.isFinite(value.fileMtimeMs)) return false;
    if (typeof value.prefixHash!=='string'||typeof value.tailHash!=='string') return false;
    if (!Number.isSafeInteger(value.prefixHashBytes)||value.prefixHashBytes<0) return false;
    if (!Number.isSafeInteger(value.tailHashStart)||value.tailHashStart<0) return false;
    if (value.currentRound!==null&&!Number.isSafeInteger(value.currentRound)) return false;
    if (!Array.isArray(value.responses)||!value.responses.every(validResponse)) return false;
    if (!Array.isArray(value.eventRounds)||!value.eventRounds.every(roundValue=>
        roundValue&&Number.isSafeInteger(roundValue.number)&&
        (roundValue.startedAt===null||typeof roundValue.startedAt==='string')&&
        (roundValue.finishedAt===null||typeof roundValue.finishedAt==='string'))) return false;
    if (value.pendingStep!==null&&(!value.pendingStep||typeof value.pendingStep!=='object')) return false;
    for (const key of ['duplicates','totalMismatch','parseErrors']) {
        if (!Number.isSafeInteger(value[key])||value[key]<0) return false;
    }
    return true;
}
function loadIndex(file,taskId) {
    try {
        const value=JSON.parse(fs.readFileSync(file,'utf8'));
        return validIndex(value,taskId)?value:null;
    } catch {
        return null;
    }
}
function indexFresh(index,stat,eventsFile) {
    if (!index) return false;
    if (stat&&stat.size<index.eventsBytes) return false;
    const size=stat?stat.size:0;
    if (index.prefixHashBytes>index.eventsBytes||index.prefixHashBytes>FINGERPRINT_BYTES) return false;
    if (index.prefixHashBytes!==Math.min(index.eventsBytes,FINGERPRINT_BYTES)) return false;
    if (index.tailHashStart!==Math.max(0,index.eventsBytes-FINGERPRINT_BYTES)) return false;
    try {
        const prefix=readRange(eventsFile,0,Math.min(index.prefixHashBytes,size));
        if (prefix.length!==index.prefixHashBytes||hashBytes(prefix)!==index.prefixHash) return false;
        const tail=readRange(eventsFile,index.tailHashStart,Math.min(index.eventsBytes,size));
        if (tail.length!==index.eventsBytes-index.tailHashStart||hashBytes(tail)!==index.tailHash) return false;
    } catch {
        return false;
    }
    if (stat&&stat.size===index.eventsBytes&&index.fileMtimeMs!==null&&stat.mtimeMs!==index.fileMtimeMs) return false;
    return true;
}
function roundEntry(index,number) {
    return index.eventRounds.find(entry=>entry.number===number);
}
function processRoundStarted(index,record) {
    const number=record.number;
    if (!Number.isSafeInteger(number)||number<1) return;
    index.currentRound=number;
    index.pendingStep=null;
    let entry=roundEntry(index,number);
    if (!entry) {
        entry={number,startedAt:null,finishedAt:null};
        index.eventRounds.push(entry);
    }
    if (!entry.startedAt) entry.startedAt=isoFromMs(timeFromAt(record.at));
}
function processRoundFinished(index,record) {
    if (index.currentRound===null) return;
    const entry=roundEntry(index,index.currentRound);
    if (!entry) return;
    if (!entry.finishedAt) entry.finishedAt=isoFromMs(timeFromAt(record.at));
}
function addAssistant(index,event,outer,task) {
    const data=event.data&&typeof event.data==='object'?event.data:{};
    const message=data.message&&typeof data.message==='object'?data.message:{};
    const source=message.source&&typeof message.source==='object'?message.source:{};
    const id=typeof message.id==='string'&&message.id?message.id:null;
    const eventTime=Number.isFinite(event.time)?event.time:timeFromAt(outer?.at);
    const at=isoFromMs(eventTime)??(typeof outer?.at==='string'?outer.at:null);
    const rawModel=typeof source.model==='string'&&source.model?source.model:null;
    const taskModel=typeof task.model==='string'&&task.model?task.model:null;
    const modelAssumed=rawModel===null&&taskModel!==null;
    const usagePresent=Boolean(data.usage&&typeof data.usage==='object'&&!Array.isArray(data.usage));
    const inputTokens=usagePresent?tokenCount(data.usage.inputTokens):0;
    const cacheReadTokens=usagePresent?tokenCount(data.usage.cacheReadTokens):0;
    const cacheWriteTokens=usagePresent?tokenCount(data.usage.cacheWriteTokens):0;
    const outputTokens=usagePresent?tokenCount(data.usage.outputTokens):0;
    if (usagePresent) {
        const total=inputTokens+cacheReadTokens+cacheWriteTokens+outputTokens;
        if (typeof data.usage.totalTokens==='number'&&data.usage.totalTokens!==total) index.totalMismatch++;
    }
    let latencyMs=null;
    const pending=index.pendingStep;
    index.pendingStep=null;
    if (pending&&pending.round===index.currentRound&&Number.isFinite(pending.time)&&Number.isFinite(eventTime)) {
        const elapsed=eventTime-pending.time;
        if (elapsed>=0) latencyMs=elapsed;
    }
    const response={
        id,
        at,
        time:Number.isFinite(eventTime)?eventTime:null,
        round:index.currentRound,
        turn:Number.isSafeInteger(data.turn)?data.turn:null,
        step:Number.isSafeInteger(data.step)?data.step:null,
        provider:typeof source.provider==='string'&&source.provider?source.provider:null,
        model:rawModel??taskModel,
        modelAssumed,
        usage:usagePresent,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        latencyMs,
    };
    if (id) {
        const existing=index.responses.findIndex(entry=>entry.id===id);
        if (existing>=0) {
            index.duplicates++;
            // Keep the latest record and its latest event position so the usage
            // view is ordered by the occurrence that survived deduplication.
            index.responses.splice(existing,1);
            index.responses.push(response);
            return;
        }
    }
    index.responses.push(response);
}
function processEvent(record,index,task) {
    if (!record||typeof record!=='object'||Array.isArray(record)) return;
    if (record.kind==='round_started') { processRoundStarted(index,record); return; }
    if (record.kind==='round_finished') { processRoundFinished(index,record); return; }
    if (record.kind!=='event') return;
    const event=record.notification?.params?.event;
    if (!event||typeof event!=='object'||Array.isArray(event)) return;
    if (event.type==='step/start') {
        index.pendingStep={time:Number.isFinite(event.time)?event.time:null,round:index.currentRound};
        return;
    }
    if (event.type==='assistant/message') addAssistant(index,event,record,task);
}
function processBuffer(index,buffer,baseOffset,task) {
    let lineStart=0;
    for (let i=0;i<buffer.length;i++) {
        if (buffer[i]!==0x0a) continue;
        let line=buffer.subarray(lineStart,i).toString('utf8');
        if (line.endsWith('\r')) line=line.slice(0,-1);
        try {
            if (line.length===0) throw new Error('empty event line');
            processEvent(JSON.parse(line),index,task);
        } catch {
            index.parseErrors++;
        }
        lineStart=i+1;
    }
    return baseOffset+lineStart;
}
function writeIndex(file,index,eventsFile) {
    const temp=`${file}.${process.pid}.${randomUUID()}.new`;
    try {
        fs.writeFileSync(temp,JSON.stringify(index),{mode:0o600});
        // Do not regress an index that another concurrent query already advanced.
        // A larger index is only authoritative while the event file still has at
        // least that many bytes; after a truncation our smaller rebuild wins.
        const current=loadIndex(file,index.taskId);
        const currentSize=statOrNull(eventsFile)?.size??0;
        if (current&&current.eventsBytes>index.eventsBytes&&current.eventsBytes<=currentSize) {
            fs.unlinkSync(temp);
            return null;
        }
        fs.renameSync(temp,file);
        return null;
    } catch (error) {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
        return `usage index write failed: ${shortError(error)}`;
    }
}
function scanTask(task,taskDir,options={}) {
    const persist=options.persist!==false;
    const eventsFile=path.join(taskDir,'events.jsonl');
    const indexFile=path.join(taskDir,INDEX_NAME);
    const stat=statOrNull(eventsFile);
    if (stat&&!stat.isFile()) throw new Error('events.jsonl is not a regular file');
    const size=stat?stat.size:0;
    let index=loadIndex(indexFile,task.id);
    let rebuilt=!indexFresh(index,stat,eventsFile);
    if (rebuilt) index=emptyIndex(task.id);
    const previousBytes=index.eventsBytes;
    const start=rebuilt?0:previousBytes;
    let bytesRead=0;
    if (size>start) {
        const buffer=readRange(eventsFile,start,size);
        bytesRead=buffer.length;
        index.eventsBytes=processBuffer(index,buffer,start,task);
    } else {
        index.eventsBytes=Math.min(previousBytes,size);
    }
    index.fileMtimeMs=stat?stat.mtimeMs:null;
    const prefixBytes=Math.min(index.eventsBytes,FINGERPRINT_BYTES);
    const prefix=readRange(eventsFile,0,prefixBytes);
    index.prefixHash=hashBytes(prefix);
    index.prefixHashBytes=prefix.length;
    index.tailHashStart=Math.max(0,index.eventsBytes-FINGERPRINT_BYTES);
    const tail=readRange(eventsFile,index.tailHashStart,index.eventsBytes);
    index.tailHash=hashBytes(tail);
    let writeWarning=null;
    if (persist&&(rebuilt||index.eventsBytes!==previousBytes)) writeWarning=writeIndex(indexFile,index,eventsFile);
    return {
        index,
        scan:{
            eventsBytes:size,
            indexedBytes:index.eventsBytes,
            bytesRead,
            pendingBytes:Math.max(0,size-index.eventsBytes),
            rebuilt,
            parseErrors:index.parseErrors,
        },
        writeWarning,
    };
}

// ---------------------------------------------------------------------------
// Query projection
// ---------------------------------------------------------------------------

function priceRequest(response,pricingState) {
    // Find the first pricing source that knows this model
    const match = findPricingForModel(pricingState, response.model);
    const pricing = match?.pricing ?? null;
    const canonical = pricing ? canonicalModel(pricing, response.model) : null;
    const tier = pricing ? classifyTier(response.time, pricing.peakRule) : 'unknown';
    let rawCost = null;
    if (pricing && canonical && tier !== 'unknown' && response.cacheWriteTokens === 0) {
        const rates = pricing.models[canonical][tier];
        rawCost = response.cacheReadTokens/1e6*rates.cacheHit +
            response.inputTokens/1e6*rates.cacheMiss +
            response.outputTokens/1e6*rates.output;
    }
    const totalTokens = response.inputTokens + response.cacheReadTokens + response.cacheWriteTokens + response.outputTokens;
    return {
        id:response.id,
        at:response.at,
        round:response.round,
        turn:response.turn,
        step:response.step,
        provider:response.provider,
        model:response.model,
        modelAssumed:response.modelAssumed,
        inputTokens:response.inputTokens,
        cacheReadTokens:response.cacheReadTokens,
        cacheWriteTokens:response.cacheWriteTokens,
        outputTokens:response.outputTokens,
        totalTokens,
        latencyMs:response.latencyMs,
        priceTier:tier,
        estimatedCostCny:rawCost===null?null:round(rawCost,8),
        rawCost,
        priced:rawCost!==null,
    };
}
function publicRequest(request) {
    return {
        id:request.id,
        at:request.at,
        round:request.round,
        turn:request.turn,
        step:request.step,
        provider:request.provider,
        model:request.model,
        inputTokens:request.inputTokens,
        cacheReadTokens:request.cacheReadTokens,
        cacheWriteTokens:request.cacheWriteTokens,
        outputTokens:request.outputTokens,
        totalTokens:request.totalTokens,
        latencyMs:request.latencyMs,
        priceTier:request.priceTier,
        estimatedCostCny:request.estimatedCostCny,
        modelAssumed:request.modelAssumed,
    };
}
function sumRequests(requests) {
    const total={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0,totalTokens:0};
    let pricedCost=0,pricedCount=0,unpricedRequests=0;
    for (const request of requests) {
        total.inputTokens+=request.inputTokens;
        total.cacheReadTokens+=request.cacheReadTokens;
        total.cacheWriteTokens+=request.cacheWriteTokens;
        total.outputTokens+=request.outputTokens;
        total.totalTokens+=request.totalTokens;
        if (request.priced) { pricedCost+=request.rawCost; pricedCount++; }
        else unpricedRequests++;
    }
    return {total,pricedCost,pricedCount,unpricedRequests};
}
function roundCost(requests,pricingOk,hasMissing) {
    if (requests.length===0) return {value:hasMissing?null:0,complete:!hasMissing};
    if (!pricingOk) return {value:null,complete:false};
    let sum=0,priced=0;
    for (const request of requests) {
        if (request.priced) { sum+=request.rawCost; priced++; }
    }
    return {value:priced===0?null:round(sum,6),complete:priced===requests.length};
}
function elapsedOf(startedAt,finishedAt) {
    const start=timeFromAt(startedAt),finish=timeFromAt(finishedAt);
    if (start===null||finish===null||finish<start) return null;
    return finish-start;
}
function buildRoundRow(number,roundRequests,roundMissing,pricingOk,parseErrors,startedAt,finishedAt,extra={}) {
    const summed=sumRequests(roundRequests);
    const cost=roundCost(roundRequests,pricingOk,roundMissing.length>0);
    const complete=roundMissing.length===0&&(roundRequests.length===0||(cost.complete&&parseErrors===0));
    return {
        number,
        ...extra,
        requests:roundRequests.length,
        inputTokens:summed.total.inputTokens,
        cacheReadTokens:summed.total.cacheReadTokens,
        cacheWriteTokens:summed.total.cacheWriteTokens,
        outputTokens:summed.total.outputTokens,
        totalTokens:summed.total.totalTokens,
        estimatedCostCny:cost.value,
        unpricedRequests:summed.unpricedRequests,
        costComplete:complete,
        elapsedMs:elapsedOf(startedAt,finishedAt),
        startedAt,
        finishedAt,
    };
}
function buildRounds(task,index,requests,missingUsage,pricingOk) {
    const taskRounds=Array.isArray(task.rounds)?task.rounds:[];
    const byNumber=new Map();
    for (const item of taskRounds) {
        if (!item||!Number.isSafeInteger(item.number)) continue;
        byNumber.set(item.number,{number:item.number,taskRound:item,eventRound:null});
    }
    for (const item of index.eventRounds) {
        if (!byNumber.has(item.number)) byNumber.set(item.number,{number:item.number,taskRound:null,eventRound:item});
    }
    const rows=[];
    const nullRequests=requests.filter(request=>request.round===null);
    const nullMissing=missingUsage.filter(entry=>entry.round===null);
    if (nullRequests.length>0||nullMissing.length>0) {
        rows.push(buildRoundRow(null,nullRequests,nullMissing,pricingOk,index.parseErrors,null,null,{unassigned:true}));
    }
    const numbers=[...byNumber.keys()].sort((a,b)=>a-b);
    for (const number of numbers) {
        const info=byNumber.get(number),taskRound=info.taskRound,eventRound=info.eventRound;
        const roundRequests=requests.filter(request=>request.round===number);
        const roundMissing=missingUsage.filter(entry=>entry.round===number);
        const startedAt=taskRound?.startedAt??eventRound?.startedAt??null;
        const finishedAt=taskRound?.finishedAt??eventRound?.finishedAt??null;
        rows.push(buildRoundRow(number,roundRequests,roundMissing,pricingOk,index.parseErrors,startedAt,finishedAt,
            taskRound?{}:{fromEventsOnly:true}));
    }
    return rows;
}
function statusRound(roundValue) {
    const value={
        number:roundValue.number,
        requests:roundValue.requests,
        inputTokens:roundValue.inputTokens,
        cacheReadTokens:roundValue.cacheReadTokens,
        outputTokens:roundValue.outputTokens,
        estimatedCostCny:roundValue.estimatedCostCny,
        costComplete:roundValue.costComplete,
        elapsedMs:roundValue.elapsedMs,
    };
    if (roundValue.unassigned) value.unassigned=true;
    if (roundValue.fromEventsOnly) value.fromEventsOnly=true;
    return value;
}
function warningList(index,summed,requests,missingUsage,pricingState,writeWarning) {
    const warnings=[];
    if (index.parseErrors>0) warnings.push(`${index.parseErrors} event line(s) could not be parsed; usage may be incomplete`);
    if (missingUsage.length>0) warnings.push(`${missingUsage.length} assistant response(s) have no usage record and no token data`);
    if (index.totalMismatch>0) warnings.push(`${index.totalMismatch} usage record(s) had a mismatched totalTokens; recomputed totals are used`);
    if (!pricingState.ok) warnings.push(`Usage tokens are available, but estimated cost is unavailable: ${pricingState.error}`);
    if (pricingState.ok&&requests.some(request=>request.cacheWriteTokens>0)) {
        warnings.push('Requests with cache-write tokens are not priced; DeepSeek publishes no separate cache-write rate');
    }
    if (pricingState.ok&&requests.some(request=>!request.priced&&request.cacheWriteTokens===0)) {
        warnings.push('Some requests could not be priced (unknown model or missing event time); their tokens are counted but their cost is null');
    }
    if (writeWarning) warnings.push(writeWarning);
    return [...new Set(warnings)];
}
function computeUsage(task,taskDir,options={}) {
    const scanned=scanTask(task,taskDir,options);
    const index=scanned.index;
    // Use provider-specific pricing when task has a provider
    const providerName = task?.provider?.name;
    const pricingState=loadPricing(providerName);
    const requests=[],missingUsage=[];
    for (const response of index.responses) {
        if (!response.usage) {
            missingUsage.push({id:response.id,at:response.at,round:response.round,turn:response.turn,step:response.step});
            continue;
        }
        requests.push(priceRequest(response,pricingState));
    }
    const summed=sumRequests(requests);
    const missingWithId=missingUsage.filter(entry=>entry.id!==null).length;
    const unidentified=missingUsage.filter(entry=>entry.id===null).length;
    const requestsWithoutUsage=missingWithId+unidentified;
    const usageComplete=index.parseErrors===0&&requestsWithoutUsage===0;
    const pricingAvailable=pricingState.ok;
    let estimatedCostCny;
    if (requests.length===0) estimatedCostCny=(requestsWithoutUsage===0&&index.parseErrors===0)?0:null;
    else if (!pricingAvailable||summed.pricedCount===0) estimatedCostCny=null;
    else estimatedCostCny=round(summed.pricedCost,6);
    const unpricedRequests=pricingAvailable?summed.unpricedRequests:requests.length;
    const costComplete=usageComplete&&(requests.length===0||(pricingAvailable&&unpricedRequests===0));
    const warnings=warningList(index,summed,requests,missingUsage,pricingState,scanned.writeWarning);
    const statusUsage={
        available:true,
        requests:requests.length,
        requestsWithoutUsage,
        missingUsageRequests:missingWithId,
        unidentifiedResponses:unidentified,
        parseErrors:index.parseErrors,
        duplicates:index.duplicates,
        totalMismatch:index.totalMismatch,
        inputTokens:summed.total.inputTokens,
        cacheReadTokens:summed.total.cacheReadTokens,
        cacheWriteTokens:summed.total.cacheWriteTokens,
        outputTokens:summed.total.outputTokens,
        totalTokens:summed.total.totalTokens,
        estimatedCostCny,
        unpricedRequests,
        usageComplete,
        costComplete,
        warnings,
        pricing:pricingAvailable?statusPricing(pricingState,task.model):null,
    };
    const rounds=buildRounds(task,index,requests,missingUsage,pricingAvailable);
    return {
        statusUsage,
        statusRounds:rounds.map(statusRound),
        fullRounds:rounds,
        requests,
        missingUsage,
        index,
        pricingState,
        scan:scanned.scan,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Public results
// ---------------------------------------------------------------------------

/**
 * Compute usage once and project both the compact list summary and the status
 * usage object. The manager reuses both projections for a single status reply.
 * Never throws: an unreadable event source becomes limitState "unavailable".
 */
export function usageForTask(task,taskDir,options={}) {
    const limits=effectiveLimits(task?.usageLimits,config.usageLimits);
    try {
        const computed=computeUsage(task,taskDir,options);
        const evaluation=evaluateLimits(computed.statusUsage,limits);
        const {message,...limitFields}=evaluation;
        const warnings=message?[...new Set([...computed.warnings,message])]:computed.warnings;
        const statusUsage={...computed.statusUsage,...limitFields,warnings};
        if (task&&typeof task.lastLimitOverride==='object'&&task.lastLimitOverride&&
            typeof task.lastLimitOverride.at==='string') {
            statusUsage.limitOverride={at:task.lastLimitOverride.at,
                reason:boundedReason(task.lastLimitOverride.reason)};
        }
        const result={
            available:true,
            statusUsage,
            usageRounds:computed.statusRounds,
            listUsage:listSummary({...computed.statusUsage,warnings:computed.warnings}),
            computed,
            limits,
        };
        return result;
    } catch (error) {
        const reason=shortError(error);
        return unavailableUsageSnapshot({task,reason,limits});
    }
}

/** Bounded list-level usage summary. Never throws. */
export function usageForList(task,taskDir) {
    return usageForTask(task,taskDir).listUsage;
}

/** Default status summary: full totals, cumulative limits, and per-round rows. Never throws. */
export function usageForStatus(task,taskDir) {
    const result=usageForTask(task,taskDir);
    return {usage:result.statusUsage,usageRounds:result.usageRounds};
}

/** Full usage view payload (pagination is applied by the manager). Never throws. */
export function usageForView(task,taskDir) {
    const result=usageForTask(task,taskDir);
    if (!result.computed) {
        const reason=result.statusUsage.error??'usage is unavailable';
        return {
            id:task?.id??null,
            model:typeof task?.model==='string'&&task.model?task.model:null,
            pricing:null,
            totals:result.statusUsage,
            rounds:[],
            requests:[],
            missingUsage:[],
            warnings:result.statusUsage.warnings,
            scan:{eventsBytes:0,indexedBytes:0,bytesRead:0,pendingBytes:0,rebuilt:false,parseErrors:0},
        };
    }
    const computed=result.computed;
    const {pricing,...totals}=result.statusUsage;
    return {
        id:task.id,
        model:typeof task.model==='string'&&task.model?task.model:null,
        pricing:computed.pricingState.ok?fullPricing(computed.pricingState):null,
        totals,
        rounds:computed.fullRounds,
        requests:computed.requests.map(publicRequest),
        missingUsage:computed.missingUsage,
        warnings:result.statusUsage.warnings,
        scan:computed.scan,
    };
}

