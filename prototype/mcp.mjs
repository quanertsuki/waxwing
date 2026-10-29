// Stdio proxy: every caller connects to the SAME local manager, not its own jobs map.
// The tool catalogue and argument rules come from the shared operation table.
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {ensureServer,request} from './client.mjs';
import {OPERATIONS,mcpSchema,validateOperation} from '../src/operations/catalogue.mjs';
// The reported server version must follow the published manifest, not a copy.
const VERSION=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;

function catalogueFor(prefix) {
  return OPERATIONS
    .filter(spec=>spec.entries.mcp !== false && !spec.entries.humanOnly)
    .map(spec=>({
      name:prefix+spec.name,
      description:spec.description,
      inputSchema:mcpSchema(spec),
      annotations:{...spec.annotations},
    }));
}
// Public names are Waxwing-prefixed. The complete ds_* catalogue remains as a
// 0.1.x compatibility alias and is scheduled for removal no earlier than 0.2.
export const catalogue=[
  ...catalogueFor('waxwing_'),
  ...catalogueFor('ds_'),
];
const output=data=>process.stdout.write(JSON.stringify(data)+'\n');
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
      const action=spec.name.replace(/^(?:waxwing_|ds_)/,'');
      const args=m.params.arguments??{};
      validateOperation(action,args,{mcp:true});
      await deps.ensureServer();const value=await deps.request(action,args);
      return result({content:[{type:'text',text:JSON.stringify(value)}]});
    } catch(e){return result({isError:true,code:e.code??null,content:[{type:'text',text:e.message}]});}
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
