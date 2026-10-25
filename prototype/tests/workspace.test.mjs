// Git worktree lease behavior: clean repositories isolate automatically, dirty
// repositories require an explicit shared choice, and cleanup never deletes
// branches or uncommitted work automatically.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {REAL_ROOT,TEST_ROOT} from './isolate.mjs';
import {createManager} from '../manager.mjs';
import {ROOT,RUNS} from '../common.mjs';

const samePath=(a,b)=>{
  const left=path.resolve(a),right=path.resolve(b);
  return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
};
if(samePath(ROOT,REAL_ROOT))throw new Error(`workspace tests refused live root ${ROOT}`);
if(!samePath(ROOT,TEST_ROOT))throw new Error(`workspace tests refused non-isolated root ${ROOT}`);

const HERE=path.dirname(fileURLToPath(import.meta.url));
const base=path.join(HERE,'.tmp',`workspace-${process.pid}`);
fs.rmSync(base,{recursive:true,force:true});
fs.mkdirSync(base,{recursive:true});

function git(cwd,args) {
  return execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
}
function makeRepo(name) {
  const repo=path.join(base,name);
  fs.mkdirSync(repo,{recursive:true});
  git(repo,['init','-b','main']);
  git(repo,['config','user.name','Waxwing Tests']);
  git(repo,['config','user.email','tests@waxwing.invalid']);
  fs.writeFileSync(path.join(repo,'README.md'),'# fixture\n');
  git(repo,['add','README.md']);
  git(repo,['commit','-m','fixture']);
  return repo;
}
function fakeFork() {
  const child=new EventEmitter();
  child.stdout=new EventEmitter();
  child.stderr=new EventEmitter();
  child.connected=true;
  child.exitCode=null;
  child.signalCode=null;
  child.pid=5100;
  child.send=message=>queueMicrotask(()=>onMessage(message,child));
  child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
  return child;
}
function onMessage(message,worker) {
  if(message.kind==='close') {
    worker.exitCode=0;
    setImmediate(()=>worker.emit('exit',0));
    return;
  }
  if(message.kind!=='run')return;
  worker.emit('message',{kind:'ready',roundId:message.roundId,ownerMarker:message.ownerMarker});
  worker.emit('message',{kind:'ack',roundId:message.roundId});
  setImmediate(()=>{
    worker.emit('message',{kind:'result',roundId:message.roundId,text:'done',finishReason:'completed'});
    worker.emit('message',{kind:'released',roundId:message.roundId});
  });
}

const manager=createManager({forkWorker:fakeFork});
after(()=>manager.shutdown());
async function settled(id) {
  for(let i=0;i<300;i++) {
    const status=await manager.action('status',{id});
    if(status.status!=='running'&&status.status!=='stopping')return status;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('task did not settle');
}
async function collect(id,view,limit=1000) {
  let offset=0,text='';
  for(;;) {
    const page=await manager.action('status',{id,view,offset,limit});
    text+=page.text;
    if(page.nextOffset===null)return text;
    offset=page.nextOffset;
  }
}
function create(repo,extra={}) {
  return manager.action('create',{
    workspace:repo,
    workspaceMode:'auto',
    prompt:'work',
    provider:'deepseek-flash',
    ...extra,
  });
}

let gitAvailable=true;
try { execFileSync('git',['--version'],{stdio:'ignore',windowsHide:true}); } catch { gitAvailable=false; }

test('a clean Git repository gets an isolated worktree on waxwing/task-*',{skip:!gitAvailable},async()=>{
  const repo=makeRepo('clean');
  const baseCommit=git(repo,['rev-parse','HEAD']);
  const created=await create(repo);
  assert.notEqual(path.resolve(created.workspace).toLowerCase(),path.resolve(repo).toLowerCase());
  assert.equal(created.workspaceMode,'worktree');
  assert.equal(created.branch,`waxwing/${created.id}`);
  assert.equal(created.baseCommit,baseCommit);
  const workspace=JSON.parse(await collect(created.id,'workspace'));
  assert.equal(workspace.workspaceLease.mode,'worktree');
  assert.equal(workspace.workspaceLease.status,'active');
  assert.equal(workspace.details.mode,'worktree');
  await settled(created.id);
  const report=await collect(created.id,'report');
  assert.match(report,/^# Waxwing task /);
  const log=await manager.action('status',{id:created.id,view:'log',offset:0,limit:1000});
  assert.equal(log.view,'log');
  assert.equal(typeof log.path,'string');
  assert.equal(typeof log.text,'string');
  const original=fs.readFileSync(path.join(created.workspace,'README.md'),'utf8');
  fs.appendFileSync(path.join(created.workspace,'README.md'),'diff view\n');
  const diff=await collect(created.id,'diff');
  assert.match(diff,/\+diff view/);
  fs.writeFileSync(path.join(created.workspace,'README.md'),original);
  await manager.action('close',{id:created.id});
  const cleaned=await manager.action('cleanup_worktree',{id:created.id});
  assert.equal(cleaned.removed,true);
  assert.equal(cleaned.branchRetained,true);
  assert.equal(fs.existsSync(workspace.workspaceLease.worktreePath),false);
  assert.equal(git(repo,['branch','--list',created.branch]).trim(),created.branch);
});

test('a dirty Git repository refuses auto isolation without creating task data',{skip:!gitAvailable},async()=>{
  const repo=makeRepo('dirty');
  fs.appendFileSync(path.join(repo,'README.md'),'dirty\n');
  const before=fs.readdirSync(RUNS).sort();
  await assert.rejects(()=>create(repo),/DIRTY_WORKSPACE|tracked or untracked/i);
  assert.deepEqual(fs.readdirSync(RUNS).sort(),before);
});

test('shared mode is explicit for a dirty Git repository and uses the source path',{skip:!gitAvailable},async()=>{
  const repo=makeRepo('shared');
  fs.appendFileSync(path.join(repo,'README.md'),'allowed shared change\n');
  const created=await create(repo,{workspaceMode:'shared'});
  assert.equal(created.workspaceMode,'shared');
  assert.equal(path.resolve(created.workspace).toLowerCase(),path.resolve(repo).toLowerCase());
  await settled(created.id);
  await manager.action('close',{id:created.id});
  await assert.rejects(()=>manager.action('cleanup_worktree',{id:created.id}),/workspaceLease.mode=worktree/i);
});

test('a non-Git directory automatically uses shared mode',async()=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'waxwing-plain-'));
  try {
    const created=await create(workspace);
    assert.equal(created.workspaceMode,'shared');
    assert.equal(path.resolve(created.workspace).toLowerCase(),path.resolve(workspace).toLowerCase());
    await settled(created.id);
    await manager.action('close',{id:created.id});
  } finally {
    fs.rmSync(workspace,{recursive:true,force:true});
  }
});

test('cleanup refuses a dirty worktree and retains the branch',{skip:!gitAvailable},async()=>{
  const repo=makeRepo('cleanup-dirty');
  const created=await create(repo);
  await settled(created.id);
  await manager.action('close',{id:created.id});
  fs.writeFileSync(path.join(created.workspace,'untracked.txt'),'keep me\n');
  await assert.rejects(()=>manager.action('cleanup_worktree',{id:created.id}),/WORKTREE_DIRTY|uncommitted/i);
  assert.equal(fs.existsSync(created.workspace),true);
  assert.match(git(repo,['branch','--list',created.branch]),new RegExp(created.branch.replaceAll('/','\\/')));
  fs.unlinkSync(path.join(created.workspace,'untracked.txt'));
  const cleaned=await manager.action('cleanup_worktree',{id:created.id});
  assert.equal(cleaned.removed,true);
  assert.equal(git(repo,['branch','--list',created.branch]).trim(),created.branch);
});
