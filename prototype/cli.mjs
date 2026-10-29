import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureServer,request} from './client.mjs';
import {config,HERE,cleanEnvironment} from './common.mjs';
import {cliHelp,parseCliOperation} from '../src/operations/catalogue.mjs';
import {managerPaths} from '../src/config/paths.mjs';

const out=value=>console.log(JSON.stringify(value,null,2));
export const WAIT_INITIAL_MS=1000, WAIT_MAX_MS=10000, WAIT_GRACE_MS=30000;
export const waitTimeoutMs=()=>config.roundTimeoutSeconds*1000+WAIT_GRACE_MS;
export const nextWaitDelay=previous=>Math.min(previous*2,WAIT_MAX_MS);
// Help and argument rules are generated from the shared operation catalogue.
export const HELP_TEXT=`${cliHelp()}\npaths: print resolved manager paths (data root, token file, URL) as JSON for launchers.`;

/** Parse create/rework/accept JSON (inline or @file) from the catalogue. */
export function parseCommandArgs(command,args) {
  return parseCliOperation(command,args);
}

/**
 * Use one server-side wait instead of a manual status loop. The default
 * deadline follows roundTimeoutSeconds plus a small grace for the manager's
 * exit-confirmation path.
 */
export async function wait(id,options={}) {
  const timeoutSeconds=options.timeoutSeconds ??
    Math.max(1,Math.ceil((options.timeoutMs ?? waitTimeoutMs())/1000));
  const requestWait=options.requestWait ?? (args=>request('wait',args));
  return requestWait({id,timeoutSeconds});
}

/** Parse `wait ID [--timeout SECONDS]` for task and research waits. */
export function parseWaitArgs(args,label='wait') {
  return parseCliOperation(label,args).data;
}

/** Parse `status ID [--view ...] [--offset N --limit N]`. */
export function parseStatusArgs(args) {
  return parseCliOperation('status',args).data;
}

/** Parse `research-collect BATCH_ID [--offset N --limit N]`. */
export function parseResearchCollectArgs(args) {
  return parseCliOperation('research-collect',args).data;
}
async function authorize(id,rl) {
  const preview=await request('preview_delete',{id});out(preview);
  if(!stdin.isTTY) throw new Error('Cleanup authorization requires an interactive human terminal');
  const confirmation=await rl.question(`确认仅删除这个任务的临时记录（保留报告和项目）：输入完整 ID ${id}\n> `);
  if(confirmation!==id)throw new Error('未授权，数据保留');
  return request('grant_delete',{id,confirmation});
}
async function demo() {
  const workspace=path.resolve(HERE,'../demo-workspace');fs.mkdirSync(workspace,{recursive:true});
  // Each run uses its own example directory and does not overwrite earlier user edits.
  const project=path.join(workspace,`example-${Date.now()}`);fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'PLAN.md'),'# 演示计划\n\n第一轮实现英文问候；Delegating Agent 验收后提出中文问候返工；验收通过后保留报告并关闭。\n');
  fs.writeFileSync(path.join(project,'check.cjs'),
    "const assert=require('node:assert/strict');const fs=require('node:fs');\n"+
    "const text=fs.readFileSync('greeting.txt','utf8').trim();\n"+
    "assert.equal(text,process.argv[2]);console.log('PASS: greeting matches delegating requirement');\n");
  const first=await request('create',{workspace:project,
    prompt:'在当前工作目录创建 greeting.txt，内容恰好为 Hello, Codex!（可带末尾换行）。只改这个文件，不要修改 check.cjs 或 PLAN.md。完成后读取文件确认，简短报告结果。',
    plan:'实现问候文件 → 英文验收 → 中文返工 → 中文验收 → 导出报告 → 关闭',
    criteria:'Delegating Agent 执行 node check.cjs "你好，Codex！"，必须退出 0；check.cjs 不可被 Worker Agent 修改。'});
  console.log(`真实 DSH 演示任务：${first.id}\n工作区：${project}`);
  const initialCheck=fs.readFileSync(path.join(project,'check.cjs'));
  let t=await wait(first.id);if(t.status!=='awaiting_review')throw new Error(`第一轮失败: ${t.error}`);
  const check=expected=>{
    if(!fs.readFileSync(path.join(project,'check.cjs')).equals(initialCheck))throw new Error('Delegating acceptance checker was modified');
    const r=spawnSync(config.node,['check.cjs',expected],{cwd:project,encoding:'utf8',windowsHide:true,
      env:cleanEnvironment(path.join(project,'.tmp'))});
    if(r.status!==0)throw new Error(`Delegating check failed: ${r.stderr}`);return r.stdout.trim();
  };
  console.log('Delegating Agent 第一轮验收：'+check('Hello, Codex!'));
  await request('rework',{id:first.id,prompt:'Delegating Agent 提出返工：把 greeting.txt 内容改成恰好为 你好，Codex！（可带末尾换行）。只改这个文件，不要修改 check.cjs 或 PLAN.md。读取确认后简短报告。'});
  t=await wait(first.id);if(t.status!=='awaiting_review')throw new Error(`返工失败: ${t.error}`);
  const evidence=check('你好，Codex！');console.log('Delegating Agent 返工验收：'+evidence);
  await request('accept',{id:first.id,evidence:`Delegating Agent 使用独立 check.cjs 验证两轮输出；校验器内容未变。第一轮英文验证退出 0；第二轮中文验证退出 0。${evidence}`});
  const closed=await request('close',{id:first.id});
  out(closed);
  try{await request('delete',{id:first.id});throw new Error('Unexpected unauthorized deletion');}
  catch(e){if(!e.message.includes('No matching human'))throw e;console.log('未授权删除被拒绝，演示记录已保留。');}
}
async function tui() {
  const rl=readline.createInterface({input:stdin,output:stdout});
  let lastMessage='';
  try {
    while(true) {
      const list=await request('list');console.clear();
      console.log('Waxwing · 本地任务管理器\n数据根目录：'+config.root+'\n');
      console.table(list.map(t=>({ID:t.id,状态:t.status,轮次:t.roundCount,进程:t.live?'在线':'已关闭',授权:t.cleanupAuthorized?'可清理':'未授权',验收:t.accepted?'已验收':'未验收'})));
      if(lastMessage)console.log(lastMessage+'\n');
      console.log('[n] 新任务  [v] 摘要  [r] 返工  [a] 验收通过  [s] 取消\n[c] 关闭  [d] 预览并授权清理  [e] 真实演示  [x] 停止服务  [Enter] 刷新  [q] 退出面板');
      const cmd=(await rl.question('> ')).trim();if(cmd==='q')break;
      try {
        if(cmd==='n') {
          const workspace=await rl.question('项目绝对路径: ');
          const prompt=await rl.question('任务: '),criteria=await rl.question('验收标准: ');
          lastMessage=JSON.stringify(await request('create',{workspace,prompt,criteria}),null,2);
        } else if(cmd==='e'){await demo();await rl.question('演示完成，按 Enter 返回');}
        else if(cmd==='x'){await request('shutdown');break;}
        else if(['v','r','a','s','c','d'].includes(cmd)) {
          const id=await rl.question('任务 ID: ');
          if(cmd==='v')lastMessage=JSON.stringify(await request('status',{id}),null,2)+
            `\n\n完整最新结果：node prototype/cli.mjs status ${id} --view result\n完整历史：node prototype/cli.mjs status ${id} --view history`;
          if(cmd==='r')lastMessage=JSON.stringify(await request('rework',{id,prompt:await rl.question('具体返工要求: ')}),null,2);
          if(cmd==='a')lastMessage=JSON.stringify(await request('accept',{id,evidence:await rl.question('Delegating Agent 实际验收证据: ')}),null,2);
          if(cmd==='s')lastMessage=JSON.stringify(await request('cancel',{id}),null,2);
          if(cmd==='c')lastMessage=JSON.stringify(await request('close',{id}),null,2);
          if(cmd==='d'){await authorize(id,rl);lastMessage=JSON.stringify(await request('delete',{id}),null,2);}
        }
      } catch(e){lastMessage='操作失败：'+e.message;}
    }
  } finally {rl.close();}
}
export async function main() {
  const [command,...args]=process.argv.slice(2);
  if(command==='help') {
    console.log(HELP_TEXT);return;
  }
  // Launchers need the resolved paths before a manager exists; this is the
  // only command that neither starts nor contacts the server.
  if(command==='paths') {
    if(args.length) throw new Error('paths takes no arguments');
    out(managerPaths({here:HERE}));return;
  }
  await ensureServer();
  if(!command || command==='tui'){await tui();return;}
  if(command==='demo'){await demo();return;}
  if(command==='wait') {
    const {data}=parseCliOperation('wait',args);
    out(await wait(data.id,{timeoutSeconds:data.timeoutSeconds}));
    return;
  }
  if(command==='status'){out(await request('status',parseCliOperation('status',args).data));return;}
  if(command==='research-wait') {
    const {data}=parseCliOperation('research-wait',args);
    out(await request('research_wait',{
      ...data,
      timeoutSeconds:data.timeoutSeconds ?? Math.max(1,Math.ceil(waitTimeoutMs()/1000)),
    }));
    return;
  }
  if(command==='research-collect'){out(await request('research_collect',parseCliOperation('research-collect',args).data));return;}
  if(command==='grant-delete') {
    const {data}=parseCliOperation('grant-delete',args);
    const rl=readline.createInterface({input:stdin,output:stdout});
    try{out(await authorize(data.id,rl));}finally{rl.close();}return;
  }
  const parsed=parseCliOperation(command,args);
  out(await request(parsed.command,parsed.data));
}
// Importing this module for tests must not start the CLI. Match mcp.mjs.
const selfPath=path.resolve(fileURLToPath(import.meta.url));
const entryPath=process.argv[1]===undefined?undefined:path.resolve(process.argv[1]);
const isMain=entryPath!==undefined && (process.platform==='win32'?selfPath.toLowerCase()===entryPath.toLowerCase():selfPath===entryPath);
if(isMain) main().catch(e=>{console.error(e.message);process.exitCode=1;});
