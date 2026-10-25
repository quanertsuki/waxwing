// Deployment smoke for the reliability fixes (workspace lock, reworkability).
//
// Run only AFTER the manager has been reloaded with this code:
//   node checks/reliability-smoke.mjs [baseline.json] [--workspace DIR] [--timeout-seconds N]
//
// The script first performs a read-only health check through the normal HTTP
// token. It never calls ensureServer(), so a stopped daemon is an error rather
// than being started silently. It then creates at most two short real tasks in
// isolated workspaces, verifies live-session rework with a changed
// budget, workspace occupancy rejection, and close/cancel rework rejection with
// unchanged records. Created tasks are closed (never deleted) and their IDs are
// printed for audit. Without --workspace it uses tests/.tmp; it refuses to use
// the managed data root or a filesystem root. Output is one short JSON line;
// errors exit non-zero.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {handle} from '../mcp.mjs';
import {request} from '../client.mjs';
import {ROOT,canonicalPath,canonicalExistingPath,isDriveRoot,pathsOverlap} from '../common.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE=path.join(HERE,'..','tests','.tmp',`reliability-smoke-${Date.now()}-${process.pid}`);
const MARKER='RELIABILITY-SMOKE-OK';
const PROMPT=`Reply with exactly ${MARKER}. Do not call any tools, run commands, or create, modify, or delete any files.`;
const REWORK_PROMPT=`Reply again with exactly ${MARKER}. Do not call any tools, run commands, or create, modify, or delete any files.`;
const CREATE_MAX_TOKENS=4096;
const REWORK_MAX_TOKENS=8192;
const MAX_STATUS_CHARS=2500;

function parseArgs(argv) {
  const options={baseline:undefined,workspace:undefined,timeoutSeconds:600};
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--workspace') { if(++i>=argv.length)throw new Error('--workspace needs a directory'); options.workspace=argv[i]; }
    else if(arg.startsWith('--workspace=')) options.workspace=arg.slice('--workspace='.length);
    else if(arg==='--timeout-seconds') { if(++i>=argv.length)throw new Error('--timeout-seconds needs a number'); options.timeoutSeconds=Number(argv[i]); }
    else if(arg.startsWith('--timeout-seconds=')) options.timeoutSeconds=Number(arg.slice('--timeout-seconds='.length));
    else if(arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else if(options.baseline===undefined) options.baseline=arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if(!Number.isSafeInteger(options.timeoutSeconds)||options.timeoutSeconds<30||options.timeoutSeconds>3600) {
    throw new Error('--timeout-seconds must be a safe integer between 30 and 3600');
  }
  return options;
}
function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}
function loadBaseline(file) {
  if(!file)return null;
  const parsed=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
  const records=Array.isArray(parsed)?parsed:parsed?.records;
  if(!Array.isArray(records)||records.length===0)throw new Error('baseline must contain a nonempty records array');
  const entries=records.map(record=>{
    if(typeof record?.Path!=='string'||typeof record?.Hash!=='string')throw new Error('baseline records must have Path and Hash strings');
    return {path:record.Path,hash:record.Hash.toUpperCase()};
  });
  return entries;
}
function baselineUnchanged(entries) {
  for(const entry of entries) {
    if(!fs.existsSync(entry.path))throw new Error(`baseline task file disappeared: ${path.basename(path.dirname(entry.path))}`);
    if(sha256(entry.path)!==entry.hash)throw new Error(`baseline task file changed: ${path.basename(path.dirname(entry.path))}`);
  }
}
function prepareWorkspace(requested) {
  const candidate=path.resolve(requested??DEFAULT_WORKSPACE);
  fs.mkdirSync(candidate,{recursive:true});
  const real=fs.realpathSync(candidate);
  if(isDriveRoot(real))throw new Error('Smoke workspace must not be a drive root');
  const root=canonicalExistingPath(ROOT);
  if(pathsOverlap(canonicalPath(candidate),root)||pathsOverlap(canonicalExistingPath(real),root)) {
    throw new Error('Smoke workspace must not overlap the managed data root');
  }
  return real;
}

let sequence=0;
let serverHealth;
const createdTaskIds=[];
const taskWorkspaces=new Map();
let smokeWorkspace;
let cleanupFailures=[];
const io={
  // Read-only: reuse the health response; never auto-start a daemon.
  ensureServer: async()=>serverHealth,
  request,
};
async function rpc(method,params) {
  const response=await handle({jsonrpc:'2.0',id:++sequence,method,params},io);
  if(!response)throw new Error(`no JSON-RPC response for ${method}`);
  if(response.error)throw new Error(`${method}: ${response.error.message}`);
  return response.result;
}
async function callToolRaw(name,args) {
  const result=await rpc('tools/call',{name,arguments:args});
  return {isError:Boolean(result.isError),text:result.content?.[0]?.text??''};
}
async function callTool(name,args) {
  const result=await callToolRaw(name,args);
  if(result.isError)throw new Error(`${name}: ${result.text}`);
  try{return JSON.parse(result.text);}
  catch{throw new Error(`${name}: response was not JSON`);}
}
/** Create, registering a persisted startup failure so cleanup closes it too. */
async function createTool(args) {
  const result=await callToolRaw('ds_create',args);
  if(result.isError) {
    const id=result.text.match(/Task (task-[a-f0-9]{12}) failed to start/)?.[1];
    if(id) {
      if(!createdTaskIds.includes(id))createdTaskIds.push(id);
      taskWorkspaces.set(id,args.workspace);
    }
    throw new Error(`ds_create: ${result.text}`);
  }
  let value;
  try{value=JSON.parse(result.text);}
  catch{throw new Error('ds_create: response was not JSON');}
  if(typeof value.id!=='string'||!/^task-[a-f0-9]{12}$/.test(value.id))throw new Error('ds_create: response has no valid task ID');
  taskWorkspaces.set(value.id,args.workspace);
  return value;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitTerminal(id,timeoutSeconds) {
  const deadline=Date.now()+timeoutSeconds*1000;
  let delay=1000; // 1 -> 2 -> 4 -> 8 -> 10 seconds
  for(;;) {
    const status=await callTool('ds_status',{id});
    if(!['running','stopping'].includes(status.status))return status;
    const remaining=deadline-Date.now();
    if(remaining<=0)throw new Error(`task ${id} did not settle within ${timeoutSeconds}s (status ${status.status})`);
    await sleep(Math.min(delay,remaining));
    delay=Math.min(delay*2,10000);
  }
}
/** Reconstruct the complete latest result through paginated view=result. */
async function readResultText(id) {
  let offset=0,text='',pages=0,totalChars;
  for(;;) {
    if(++pages>1000)throw new Error(`result pagination for ${id} exceeded 1000 pages`);
    const page=await callTool('ds_status',{id,view:'result',offset,limit:4000});
    if(page.view!=='result')throw new Error(`result page for ${id} has view=${page.view}`);
    if(page.offset!==offset)throw new Error(`result page for ${id} has offset=${page.offset}, expected ${offset}`);
    if(page.limit!==4000)throw new Error(`result page for ${id} has limit=${page.limit}`);
    if(!Number.isSafeInteger(page.totalChars)||page.totalChars<0)throw new Error(`result page for ${id} has invalid totalChars`);
    if(totalChars===undefined)totalChars=page.totalChars;
    else if(page.totalChars!==totalChars)throw new Error(`result totalChars for ${id} changed between pages`);
    if(typeof page.text!=='string'||page.text.length>4000)throw new Error(`result page for ${id} has invalid text`);
    text+=page.text;
    if(page.nextOffset===null) {
      if(page.complete!==true)throw new Error(`final result page for ${id} is not complete`);
      break;
    }
    if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset)throw new Error(`result nextOffset for ${id} did not advance`);
    offset=page.nextOffset;
  }
  if(text.length!==totalChars)throw new Error(`result pages for ${id} did not reconstruct totalChars`);
  return text;
}
function assertMarker(text,label) {
  assert(typeof text==='string',`${label}: result is not a string`);
  assert(text.trim()===MARKER,`${label}: result ${JSON.stringify(text.slice(0,120))} (${text.length} chars) is not exactly ${MARKER}`);
}
function assert(condition,message) { if(!condition)throw new Error(message); }
async function closeAndVerify(id) {
  const status=await callTool('ds_status',{id});
  if(status.status!=='closed')await callTool('ds_close',{id});
  const finalStatus=await callTool('ds_status',{id});
  assert(finalStatus.status==='closed',`cleanup: ${id} is ${finalStatus.status}, not closed`);
  assert(finalStatus.live===false,`cleanup: ${id} still has a live runtime`);
  return finalStatus;
}
function snapshot(status) {
  return {status:status.status,roundCount:status.roundCount,maxTokens:status.maxTokens,updatedAt:status.updatedAt};
}
function sameSnapshot(a,b,label) {
  for(const key of Object.keys(a))assert(a[key]===b[key],`${label}: ${key} changed from ${a[key]} to ${b[key]}`);
}

async function main(argv) {
  const options=parseArgs(argv);
  // 1. Read-only health gate, before any baseline read or task creation.
  serverHealth=await request('health');
  assert(serverHealth?.prototype===true,'manager health response is not the prototype');
  assert(canonicalExistingPath(serverHealth.root)===canonicalExistingPath(ROOT),'health root does not match config root');
  const createdIds=createdTaskIds;
  let workspace;
  let primaryError;
  let result;
  try {
    const baseline=loadBaseline(options.baseline);
    if(baseline)baselineUnchanged(baseline);
    workspace=prepareWorkspace(options.workspace);
    smokeWorkspace=workspace;

    const init=await rpc('initialize',{protocolVersion:'2025-03-26'});
    assert(typeof init?.instructions==='string','initialize did not return instructions');
    const catalogue=await rpc('tools/list');
    assert(Array.isArray(catalogue?.tools)&&catalogue.tools.length===10,`expected 10 MCP tools, found ${catalogue?.tools?.length}`);

    // 2. One live session: real round, then same-session rework with a new budget.
    const first=await createTool({workspace,prompt:PROMPT,plan:'smoke',criteria:'must reply with the fixed marker',maxTokens:CREATE_MAX_TOKENS});
    createdIds.push(first.id);
    assert(first.status==='running'&&first.live===true,`created task ${first.id} is not running with a live runtime`);
    const firstDone=await waitTerminal(first.id,options.timeoutSeconds);
    assert(firstDone.status==='awaiting_review',`first round ended as ${firstDone.status}: ${firstDone.error??''}`);
    assert(firstDone.live===true,'first round has no live runtime for rework');
    assert(firstDone.canRework===true,'live awaiting_review task is not reworkable');
    assert(firstDone.reworkBlockedReason===null,'live reworkable task has a blocked reason');
    assert(JSON.stringify(firstDone).length<MAX_STATUS_CHARS,'default status response grew beyond the compact limit');
    assertMarker(await readResultText(first.id),'round 1');

    const reworked=await callTool('ds_rework',{id:first.id,prompt:REWORK_PROMPT,maxTokens:REWORK_MAX_TOKENS});
    assert(reworked.roundCount===2,`rework did not add a second round (${reworked.roundCount})`);
    assert(reworked.maxTokens===REWORK_MAX_TOKENS,`rework budget is ${reworked.maxTokens}, expected ${REWORK_MAX_TOKENS}`);
    assert(reworked.sessionId===first.sessionId,'rework changed the session ID');
    const secondDone=await waitTerminal(first.id,options.timeoutSeconds);
    assert(secondDone.status==='awaiting_review',`rework round ended as ${secondDone.status}: ${secondDone.error??''}`);
    assert(secondDone.roundCount===2,'second round count changed unexpectedly');
    assert(secondDone.maxTokens===REWORK_MAX_TOKENS,`effective budget is ${secondDone.maxTokens}, expected ${REWORK_MAX_TOKENS}`);
    assert(secondDone.lastRound?.maxTokens===REWORK_MAX_TOKENS,'latest round did not record the adjusted budget');
    assert(secondDone.sessionId===first.sessionId,'live session ID was not preserved');
    assert(secondDone.live===true&&secondDone.canRework===true,'live session is not reworkable after the budget adjustment');
    assertMarker(await readResultText(first.id),'round 2');

    // 3. The live awaiting_review session owns the workspace: create in the same
    // or nested workspace is refused without creating another task.
    const listBefore=await callTool('ds_list',{});
    const same=await callToolRaw('ds_create',{workspace,prompt:'should be refused'});
    assert(same.isError,'create accepted an occupied workspace');
    assert(/occup|workspace|live runtime/i.test(same.text),`occupied-workspace error is unclear: ${same.text}`);
    const nestedWorkspace=path.join(workspace,'nested');
    fs.mkdirSync(nestedWorkspace,{recursive:true});
    const nested=await callToolRaw('ds_create',{workspace:nestedWorkspace,prompt:'should be refused'});
    assert(nested.isError,'create accepted a nested workspace inside an occupied workspace');
    assert(/occup|workspace|live runtime/i.test(nested.text),`containment/overlap error is unclear: ${nested.text}`);
    const listAfter=await callTool('ds_list',{});
    assert(listAfter.length===listBefore.length,'a rejected create left a task behind');

    // 4. Close releases the workspace, but the old task cannot be reworked.
    const closed=await callTool('ds_close',{id:first.id});
    assert(closed.status==='closed'&&closed.live===false,`close left task ${first.id} not closed or still live`);
    assert(closed.canRework===false&&/closed/i.test(closed.reworkBlockedReason??''),'closed task does not report a clear non-reworkable reason');
    const closedBefore=await callTool('ds_status',{id:first.id});
    const closedHashes={task:sha256(path.join(closedBefore.dataDirectory,'task.json')),events:sha256(path.join(closedBefore.dataDirectory,'events.jsonl'))};
    const closedRework=await callToolRaw('ds_rework',{id:first.id,prompt:'must be refused',maxTokens:REWORK_MAX_TOKENS});
    assert(closedRework.isError,'rework succeeded on a closed task');
    assert(/closed|cannot resume|runtime is gone|new task|new runtime/i.test(closedRework.text),`closed-task rework error is unclear: ${closedRework.text}`);
    const closedAfter=await callTool('ds_status',{id:first.id});
    sameSnapshot(snapshot(closedBefore),snapshot(closedAfter),'closed task');
    assert(sha256(path.join(closedAfter.dataDirectory,'task.json'))===closedHashes.task,'closed task.json changed after rejected rework');
    assert(sha256(path.join(closedAfter.dataDirectory,'events.jsonl'))===closedHashes.events,'closed events.jsonl changed after rejected rework');

    // 5. Cancelled runtime: rework must be refused with no record change.
    const second=await createTool({workspace:prepareWorkspace(path.join(workspace,'cancel')),prompt:PROMPT,maxTokens:CREATE_MAX_TOKENS});
    createdIds.push(second.id);
    const secondBeforeCancel=await waitTerminal(second.id,options.timeoutSeconds);
    assert(secondBeforeCancel.status==='awaiting_review',`cancel fixture ended as ${secondBeforeCancel.status}: ${secondBeforeCancel.error??''}`);
    assertMarker(await readResultText(second.id),'cancel fixture round 1');
    const cancelled=await callTool('ds_cancel',{id:second.id});
    assert(cancelled.status==='cancelled'&&cancelled.live===false,`cancel left task ${second.id} in ${cancelled.status}`);
    assert(cancelled.canRework===false&&/runtime is gone|cannot resume|new task/i.test(cancelled.reworkBlockedReason??''),'cancelled task does not report that its old runtime is gone');
    const cancelledBefore=await callTool('ds_status',{id:second.id});
    const cancelledHashes={task:sha256(path.join(cancelledBefore.dataDirectory,'task.json')),events:sha256(path.join(cancelledBefore.dataDirectory,'events.jsonl'))};
    const cancelledRework=await callToolRaw('ds_rework',{id:second.id,prompt:'must be refused',maxTokens:REWORK_MAX_TOKENS});
    assert(cancelledRework.isError,'rework succeeded on a cancelled task');
    assert(/cannot resume|runtime is gone|new task|new runtime/i.test(cancelledRework.text),`cancelled-task rework error is unclear: ${cancelledRework.text}`);
    const cancelledAfter=await callTool('ds_status',{id:second.id});
    sameSnapshot(snapshot(cancelledBefore),snapshot(cancelledAfter),'cancelled task');
    assert(sha256(path.join(cancelledAfter.dataDirectory,'task.json'))===cancelledHashes.task,'cancelled task.json changed after rejected rework');
    assert(sha256(path.join(cancelledAfter.dataDirectory,'events.jsonl'))===cancelledHashes.events,'cancelled events.jsonl changed after rejected rework');
    await callTool('ds_close',{id:second.id});

    if(baseline)baselineUnchanged(baseline);
    result={ok:true,healthRoot:serverHealth.root,workspace,
      taskIds:createdIds,taskWorkspaces:Object.fromEntries(taskWorkspaces),
      rounds:[2,1],maxTokens:REWORK_MAX_TOKENS,
      closed:createdIds.length,cleanup:'verified',
      baseline:baseline?'matched':'not-provided',records:'retained'};
  } catch(error) {
    primaryError=error;
    throw error;
  } finally {
    // Keep every created record, but never leave a runtime running. Always
    // verify the closed state before any success output is printed.
    cleanupFailures=[];
    for(const id of createdIds) {
      try { await closeAndVerify(id); }
      catch(error) { cleanupFailures.push(`${id}: ${error.message}`); }
    }
    if(primaryError===undefined&&cleanupFailures.length>0)throw new Error(`cleanup failed: ${cleanupFailures.join('; ')}`);
  }
  console.log(JSON.stringify(result));
}

// Only an explicit CLI execution runs the smoke; importing it is inert.
const selfPath=path.resolve(fileURLToPath(import.meta.url));
const entryPath=process.argv[1]===undefined?undefined:path.resolve(process.argv[1]);
const isMain=entryPath!==undefined && (process.platform==='win32'?selfPath.toLowerCase()===entryPath.toLowerCase():selfPath===entryPath);
if(isMain) main(process.argv.slice(2)).catch(error=>{
  console.error(JSON.stringify({ok:false,error:error.message,
    taskIds:createdTaskIds,taskWorkspaces:Object.fromEntries(taskWorkspaces),
    workspace:smokeWorkspace??null,cleanupFailures}));
  process.exitCode=1;
});
