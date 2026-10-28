// Stdio proxy: every caller connects to the SAME local manager, not its own jobs map.
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {ensureServer,request} from './client.mjs';
// The reported server version must follow the published manifest, not a copy.
const VERSION=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const string={type:'string'};
// Output budgets are real JSON numbers, not strings. The schema states the
// wire contract (positive integer) and the validator enforces it.
const integer={type:'integer',minimum:1};
const boolean={type:'boolean'};
const effort={type:'string',enum:['high','max']};
// Cumulative limits are a restricted object: only declared fields, no extras.
const usageLimits={type:'object',properties:{
  enabled:{type:'boolean'},
  warnCostCny:{type:'number',exclusiveMinimum:0},
  blockCostCny:{type:'number',exclusiveMinimum:0},
  warnRequests:{type:'integer',minimum:1},
  blockRequests:{type:'integer',minimum:1},
},additionalProperties:false};
const overrideReason={type:'string',maxLength:1000};
const workspaceMode={type:'string',enum:['auto','worktree','shared'],default:'auto'};
const researchShard={type:'object',properties:{
  id:string,
  subject:string,
  url:string,
  focus:string,
  prompt:string,
},required:['subject'],additionalProperties:false};
const researchShards={type:'array',minItems:1,items:researchShard};
const id={id:string};
const view={type:'string',enum:['summary','result','history','usage','report','workspace','diff','log'],default:'summary'};
const offset={type:'integer',minimum:0,default:0};
const limit={type:'integer',minimum:1,maximum:4000,default:2000};
const waitTimeout={type:'integer',minimum:1,maximum:300,default:30};
const specs=[
  ['create','Create a real task after planning. workspaceMode=auto uses an isolated Git worktree for a clean repository, shared locks for a non-Git directory, and refuses a dirty Git repository. Returns a bounded summary. Optional maxTokens sets this task\'s output budget. Optional effort high|max sets reasoning effort. Request and cost limits are disabled by default.',{workspace:string,prompt:string,plan:string,criteria:string,maxTokens:integer,effort,usageLimits,workspaceMode},['workspace','prompt']],
  ['research_start','Fan out one read-only research batch. Every shard gets its own scratch workspace and runs concurrently. Use research_wait, then research_collect once no shard is running. Request and cost limits are disabled by default.',{title:string,question:string,shards:researchShards,commonPrompt:string,criteria:string,provider:string,maxTokens:integer,effort},['question','shards']],
  ['research_status','Read one research batch with shard task status and counts.',id,['id']],
  ['research_wait','Wait server-side until the research batch settles or timeoutSeconds expires. Returns the batch plus wait.timedOut.',{...id,timeoutSeconds:waitTimeout},['id']],
  ['research_collect','Write the final research report and return a bounded page. offset/limit default to 0/2000 and max 4000 characters. Refuses while shards are active.',{...id,offset,limit},['id']],
  ['research_cancel','Stop the unfinished shard tasks in one research batch and retain completed shard results.',id,['id']],
  ['list','List compact task summaries (no instructions, rounds or outputs).',{},[]],
  ['status','Read a bounded summary by default. Paginated views: result, history, usage, report, workspace, diff, and log. offset/limit default to 0/2000 and max 4000 characters.',{...id,view,offset,limit},['id']],
  ['wait','Wait server-side until the task stops running or timeoutSeconds expires. Returns the bounded summary plus wait.timedOut.',{...id,timeoutSeconds:waitTimeout},['id']],
  ['rework','Continue the SAME conversation after delegating review; send precise corrections. Returns a bounded summary. Optional maxTokens changes the budget from the next round on; omitted inherits the task\'s previous budget. Optional effort high|max changes reasoning effort from the next round on (use max when repeated attempts fail); omitted inherits the task\'s effort. usageLimits adjusts later rounds; limits are disabled by default. If explicitly enabled cumulative limits block rework, overrideLimits:true with a nonempty overrideReason approves exactly this next round.',{...id,prompt:string,maxTokens:integer,effort,usageLimits,overrideLimits:boolean,overrideReason},['id','prompt']],
  ['accept','Record delegating acceptance evidence and save a durable external report. Returns a bounded summary.',{...id,evidence:string},['id','evidence']],
  ['cancel','Stop owned DSH work and reap its runtime; retain records. Returns a bounded summary.',id,['id']],
  ['close','Close the task and owned runtime; retain records. Returns a bounded summary.',id,['id']],
  ['cleanup_worktree','After a task is closed, remove its clean Git worktree. The branch is retained; dirty worktrees are refused.',id,['id']],
  ['export','Export task instructions and results to an external report.',id,['id']],
  ['preview_delete','Preview cleanup of a closed archived task; never grants permission.',id,['id']],
  ['delete','Delete scratch task records ONLY after explicit human authorization via local grant-delete CLI; preserve project and report.',id,['id']],
];
function catalogueFor(prefix) {
  return specs.map(([n,description,properties,required])=>({name:prefix+n,description,
    inputSchema:{type:'object',properties,required,additionalProperties:false},
    annotations:{readOnlyHint:['list','status','wait','preview_delete','research_status','research_wait'].includes(n),destructiveHint:['cancel','close','delete','cleanup_worktree','research_cancel'].includes(n),openWorldHint:['create','rework','research_start'].includes(n)}}));
}
// Public names are Waxwing-prefixed. The complete ds_* catalogue remains as a
// 0.1.x compatibility alias and is scheduled for removal no earlier than 0.2.
export const catalogue=[
  ...catalogueFor('waxwing_'),
  ...catalogueFor('ds_'),
];
const output=data=>process.stdout.write(JSON.stringify(data)+'\n');
/** Validate one value against its declared schema (strings, numbers, booleans, objects). */
function validateValue(property,key,value) {
  if(property.type==='string') {
    if(typeof value!=='string')throw new Error(`Argument ${key} must be a string`);
    if(Array.isArray(property.enum)&&!property.enum.includes(value)) {
      throw new Error(`Argument ${key} must be one of ${property.enum.join(', ')}`);
    }
    if(property.maxLength!==undefined&&value.length>property.maxLength) {
      throw new Error(`Argument ${key} must be at most ${property.maxLength} characters`);
    }
    return;
  }
  if(property.type==='integer') {
    const minimum=property.minimum ?? 1, maximum=property.maximum;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum||(maximum!==undefined&&value>maximum)) {
      throw new Error(`Argument ${key} must be an integer ${maximum===undefined?`>= ${minimum}`:`between ${minimum} and ${maximum}`}`);
    }
    return;
  }
  if(property.type==='number') {
    const minimum=property.minimum, maximum=property.maximum, exclusiveMinimum=property.exclusiveMinimum;
    if(typeof value!=='number'||!Number.isFinite(value)||
      (minimum!==undefined&&value<minimum)||(maximum!==undefined&&value>maximum)||
      (exclusiveMinimum!==undefined&&value<=exclusiveMinimum)) {
      throw new Error(`Argument ${key} must be a positive finite number`);
    }
    return;
  }
  if(property.type==='boolean') {
    if(typeof value!=='boolean')throw new Error(`Argument ${key} must be a boolean`);
    return;
  }
  if(property.type==='array') {
    if(!Array.isArray(value))throw new Error(`Argument ${key} must be an array`);
    if(property.minItems!==undefined&&value.length<property.minItems)throw new Error(`Argument ${key} must contain at least ${property.minItems} item`);
    if(property.maxItems!==undefined&&value.length>property.maxItems)throw new Error(`Argument ${key} must contain at most ${property.maxItems} items`);
    value.forEach((entry,index)=>validateValue(property.items,`${key}[${index}]`,entry));
    return;
  }
  if(property.type==='object') {
    if(typeof value!=='object'||value===null||Array.isArray(value))throw new Error(`Argument ${key} must be an object`);
    for(const nestedKey of Object.keys(value)) {
      const nestedSpec=property.properties?.[nestedKey];
      if(!nestedSpec)throw new Error(`Invalid argument ${key}.${nestedKey}`);
      validateValue(nestedSpec,`${key}.${nestedKey}`,value[nestedKey]);
    }
    for(const requiredKey of property.required ?? []) {
      if(value[requiredKey]===undefined)throw new Error(`Missing argument ${key}.${requiredKey}`);
    }
    return;
  }
  throw new Error(`Unsupported argument schema for ${key}`);
}
function validateArgument(spec,key,value) {
  const property=spec.inputSchema.properties[key];
  if(!property)throw new Error(`Invalid argument ${key}`);
  validateValue(property,key,value);
}
export async function handle(m, io={}) {
  const deps={ensureServer,request,...io};
  if(!m || m.jsonrpc!=='2.0' || typeof m.method!=='string') return {jsonrpc:'2.0',id:m?.id??null,error:{code:-32600,message:'Invalid request'}};
  if(m.id===undefined)return;
  const result=value=>({jsonrpc:'2.0',id:m.id,result:value});
  if(m.method==='initialize')return result({protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(m.params?.protocolVersion)?m.params.protocolVersion:'2025-03-26',
    capabilities:{tools:{}},serverInfo:{name:'waxwing',version:VERSION},
    instructions:'Delegate a complete, independently acceptable task; handle simple tasks directly. Plan, create, then use wait for the bounded summary instead of a manual status polling loop. Read view=result, report, usage, workspace, diff, or log only as needed, paging with offset/limit. Independently verify work and accept with evidence. Request and cost limits are disabled by default. Deletion needs separate human authorization; completion is not acceptance.'});
  if(m.method==='ping')return result({});
  if(m.method==='tools/list')return result({tools:catalogue});
  if(m.method==='tools/call') {
    try {
      const spec=catalogue.find(t=>t.name===m.params?.name);if(!spec)throw new Error('Unknown tool');
      const args=m.params.arguments??{};
      if(typeof args!=='object'||args===null||Array.isArray(args))throw new Error('Arguments must be an object');
      for(const key of Object.keys(args))validateArgument(spec,key,args[key]);
      for(const key of spec.inputSchema.required)if(args[key]===undefined)throw new Error(`Missing argument ${key}`);
      const action=spec.name.replace(/^(?:waxwing_|ds_)/,'');
      await deps.ensureServer();const value=await deps.request(action,args);
      return result({content:[{type:'text',text:JSON.stringify(value)}]});
    } catch(e){return result({isError:true,content:[{type:'text',text:e.message}]});}
  }
  return {jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}};
}
// Start the stdio loop only when this module is the process entry point; tests
// import `handle`/`catalogue` directly. Windows paths compare case-insensitively.
const selfPath=path.resolve(fileURLToPath(import.meta.url));
const entryPath=process.argv[1]===undefined?undefined:path.resolve(process.argv[1]);
const isMain=entryPath!==undefined && (process.platform==='win32'?selfPath.toLowerCase()===entryPath.toLowerCase():selfPath===entryPath);
export function runStdio() {
  const rl=readline.createInterface({input:process.stdin});
  // Requests stay concurrent so status/cancel can proceed while another call closes a runtime.
  rl.on('line',line=>{void(async()=>{
    try{const m=JSON.parse(line),r=await handle(m);if(r)output(r);}
    catch(e){output({jsonrpc:'2.0',id:null,error:{code:-32700,message:e.message}});}
  })();});
}
if(isMain) runStdio();
