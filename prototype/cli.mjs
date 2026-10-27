import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureServer,request} from './client.mjs';
import {config,HERE,cleanEnvironment} from './common.mjs';

const out=value=>console.log(JSON.stringify(value,null,2));
export const WAIT_INITIAL_MS=1000, WAIT_MAX_MS=10000, WAIT_GRACE_MS=30000;
export const waitTimeoutMs=()=>config.roundTimeoutSeconds*1000+WAIT_GRACE_MS;
export const nextWaitDelay=previous=>Math.min(previous*2,WAIT_MAX_MS);
export const HELP_TEXT=(
  'waxwing [tui | demo | health | list | status ID [--view summary|result|history|usage|report|workspace|diff|log] [--offset N --limit N] | wait ID [--timeout N] | ' +
  'research-start JSON | research-status BATCH_ID | research-wait BATCH_ID [--timeout N] | research-collect BATCH_ID [--offset N --limit N] | research-cancel BATCH_ID | ' +
  'create JSON | rework JSON | accept JSON | cancel ID | close ID | cleanup-worktree ID | export ID | preview-delete ID | grant-delete ID | delete ID | shutdown]\n' +
  'JSON 参数也可用 @绝对文件路径。create/rework 可选数值 maxTokens（正安全整数，单次请求输出上限；rework 省略则继承上一轮预算，下一轮生效）。' +
  'create/rework 可选 effort high|max（推理强度，默认 high；rework 省略则继承任务当前值，下一轮生效；反复失败时可升到 max）。' +
  'create 可选 usageLimits 对象（enabled、warnCostCny、blockCostCny、warnRequests、blockRequests；默认关闭，只统计；省略字段继承全局配置）；' +
  'rework 亦可传 usageLimits 调整后续轮次上限。主动启用并达到上限时，rework 需要 overrideLimits:true 和非空 overrideReason（最多 1000 字符）。' +
  '默认 list/status/变更操作返回有界摘要；完整结果用 status --view result，完整历史用 --view history，用量与费用明细用 --view usage，均可用 offset/limit 分页读取。' +
  'create 可选 workspaceMode auto|worktree|shared；auto 对干净 Git 仓库创建隔离 worktree，对非 Git 目录使用共享锁，脏仓库必须显式选择 shared。' +
  'wait/research-wait 在管理器内阻塞等待，默认截止时间为 roundTimeoutSeconds + 30 秒，可用 --timeout 调整。MCP：waxwing-mcp 或 node prototype/mcp.mjs'
);

/**
 * Parse create/rework/accept JSON (inline or @file) and route ID arguments.
 * The CLI deliberately does not filter the object: the manager validates every
 * new field again, including when the HTTP surface is called directly.
 */
export function parseCommandArgs(command,args) {
  if(['create','rework','accept','research_start'].includes(command)) {
    const value=args.join(' ');
    return {command,data:JSON.parse(value.startsWith('@')?fs.readFileSync(value.slice(1),'utf8'):value)};
  }
  return {command,data:args[0]?{id:args[0]}:{}};
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
  const [id,...rest]=args;
  if(!id)throw new Error(`${label} requires an ID`);
  const data={id};
  for(let i=0;i<rest.length;i++) {
    const token=rest[i],eq=token.indexOf('='),name=token.slice(2,eq<0?undefined:eq);
    if(!token.startsWith('--'))throw new Error(`Unexpected ${label} argument ${token}`);
    if(name!=='timeout')throw new Error(`Unknown ${label} option --${name}`);
    if(data.timeoutSeconds!==undefined)throw new Error(`Duplicate ${label} option --timeout`);
    let value;
    if(eq>=0)value=token.slice(eq+1);
    else {
      if(i+1>=rest.length)throw new Error('Missing value for --timeout');
      value=rest[++i];
    }
    if(!/^\d+$/.test(value))throw new Error('timeout must be a positive integer');
    const seconds=Number(value);
    if(!Number.isSafeInteger(seconds)||seconds<1||seconds>86400) {
      throw new Error('timeout must be an integer between 1 and 86400 seconds');
    }
    data.timeoutSeconds=seconds;
  }
  return data;
}

/** Parse `status ID [--view summary|result|history|usage] [--offset N --limit N]`. */
export function parseStatusArgs(args) {
  const [id,...rest]=args;
  if(!id)throw new Error('status requires a task ID');
  const data={id}, seen=new Set();
  const allowedViews=['summary','result','history','usage','report','workspace','diff','log'];
  for(let i=0;i<rest.length;i++) {
    const token=rest[i];
    if(!token.startsWith('--'))throw new Error(`Unexpected status argument ${token}`);
    const eq=token.indexOf('='), name=token.slice(2,eq<0?undefined:eq);
    if(!['view','offset','limit'].includes(name))throw new Error(`Unknown status option --${name}`);
    if(seen.has(name))throw new Error(`Duplicate status option --${name}`);
    seen.add(name);
    let value;
    if(eq>=0)value=token.slice(eq+1);
    else {
      if(i+1>=rest.length)throw new Error(`Missing value for --${name}`);
      value=rest[++i];
    }
    if(name==='view') {
      if(!allowedViews.includes(value))throw new Error(`view must be one of ${allowedViews.join(', ')}`);
      data.view=value;
    } else if(name==='offset') {
      if(!/^\d+$/.test(value))throw new Error('offset must be a non-negative integer');
      const n=Number(value);
      if(!Number.isSafeInteger(n))throw new Error('offset must be a non-negative safe integer');
      data.offset=n;
    } else {
      if(!/^\d+$/.test(value))throw new Error('limit must be an integer between 1 and 4000');
      const n=Number(value);
      if(!Number.isSafeInteger(n)||n<1||n>4000)throw new Error('limit must be an integer between 1 and 4000');
      data.limit=n;
    }
  }
  if((data.offset!==undefined||data.limit!==undefined)&&!['result','history','usage','report','workspace','diff','log'].includes(data.view)) {
    throw new Error('--offset/--limit require --view result, history, usage, report, workspace, diff, or log');
  }
  return data;
}
/** Parse `research-collect BATCH_ID [--offset N --limit N]`. */
export function parseResearchCollectArgs(args) {
  const [id,...rest]=args;
  if(!id)throw new Error('research-collect requires a batch ID');
  const parsed=parseStatusArgs([id,'--view','result',...rest]);
  const {view,...data}=parsed;
  return data;
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
  await ensureServer();
  if(!command || command==='tui'){await tui();return;}
  if(command==='demo'){await demo();return;}
  if(command==='wait') {
    const data=parseWaitArgs(args);
    out(await wait(data.id,{timeoutSeconds:data.timeoutSeconds}));
    return;
  }
  if(command==='status'){out(await request('status',parseStatusArgs(args)));return;}
  if(command==='research-wait') {
    const data=parseWaitArgs(args,'research-wait');
    out(await request('research_wait',{
      ...data,
      timeoutSeconds:data.timeoutSeconds ?? Math.max(1,Math.ceil(waitTimeoutMs()/1000)),
    }));
    return;
  }
  if(command==='research-collect'){out(await request('research_collect',parseResearchCollectArgs(args)));return;}
  if(command==='cleanup-worktree'){if(!args[0])throw new Error('cleanup-worktree requires a task ID');out(await request('cleanup_worktree',{id:args[0]}));return;}
  if(command==='grant-delete') {
    const rl=readline.createInterface({input:stdin,output:stdout});
    try{out(await authorize(args[0],rl));}finally{rl.close();}return;
  }
  const parsed=parseCommandArgs(command.replaceAll('-','_'),args);
  out(await request(parsed.command,parsed.data));
}
// Importing this module for tests must not start the CLI. Match mcp.mjs.
const selfPath=path.resolve(fileURLToPath(import.meta.url));
const entryPath=process.argv[1]===undefined?undefined:path.resolve(process.argv[1]);
const isMain=entryPath!==undefined && (process.platform==='win32'?selfPath.toLowerCase()===entryPath.toLowerCase():selfPath===entryPath);
if(isMain) main().catch(e=>{console.error(e.message);process.exitCode=1;});
