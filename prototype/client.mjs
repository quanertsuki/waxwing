import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {config,HERE,RUNTIME,ROOT,ensureDirs,cleanEnvironment,request} from './common.mjs';
export async function ensureServer() {
  ensureDirs();
  try { const h=await request('health'); if(h.root!==ROOT)throw new Error('Wrong manager on selected port');return h; }
  catch(e) { if(e.message==='Wrong manager on selected port')throw e; }
  const log=fs.openSync(path.join(RUNTIME,'server.log'),'a');
  const spawnedServer=spawn(config.node,[path.join(HERE,'server.mjs')],{
    cwd:HERE,env:cleanEnvironment(path.join(RUNTIME,'tmp')),detached:true,windowsHide:true,
    stdio:['ignore',log,log],
  });
  let spawnError;spawnedServer.on('error',e=>{spawnError=e;});spawnedServer.unref();fs.closeSync(log);
  for(let i=0;i<80;i++) {
    if(spawnError)throw spawnError;
    await new Promise(r=>setTimeout(r,150));
    try { const h=await request('health');if(h.root!==ROOT)throw new Error('Wrong manager on selected port');return h; }
    catch(e) {if(e.message==='Wrong manager on selected port')throw e;}
  }
  throw new Error(`Manager did not start; inspect ${path.join(RUNTIME,'server.log')}`);
}
export {request};
