// Manual experiment: real DSH starts a timed command, the delegating Agent cancels it.
import fs from 'node:fs';
import path from 'node:path';
import {ensureServer,request} from './client.mjs';
import {HERE} from './common.mjs';
await ensureServer();
const workspace=path.resolve(HERE,`../demo-workspace/cancel-${Date.now()}`);fs.mkdirSync(workspace,{recursive:true});
const task=await request('create',{workspace,plan:'验证运行中的命令可以取消',criteria:'取消后 finished.txt 不应出现',
  prompt:'本任务专门验证取消。只使用 PowerShell 工具执行以下一段脚本：Set-Content -LiteralPath ./started.txt -Value started; Start-Sleep -Seconds 15; Set-Content -LiteralPath ./finished.txt -Value finished。不要提前创建 finished.txt，不要执行其他命令。执行完后简短报告。'});
console.log(`Cancellation experiment: ${task.id}`);
try {
  let started=false;
  for(let i=0;i<90;i++) {
    if(fs.existsSync(path.join(workspace,'started.txt'))){started=true;break;}
    const t=await request('status',{id:task.id});if(t.status!=='running')throw new Error(t.error??'Task ended before command started');
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!started)throw new Error('Command did not start within experiment budget');
  const t=await request('cancel',{id:task.id});
  if(t.status!=='cancelled'||t.live)throw new Error('Cancellation did not reap runtime');
  await new Promise(r=>setTimeout(r,17000));
  if(fs.existsSync(path.join(workspace,'finished.txt')))throw new Error('Cancelled command continued running');
  console.log(JSON.stringify({id:task.id,status:t.status,live:t.live,commandStarted:true,finishedFileAppeared:false}));
  fs.writeFileSync(path.join(workspace,'DELEGATING-CANCEL-RESULT.md'),`取消验收通过：${task.id}\nDelegating Agent 观察到 started.txt，取消后运行时退出。等待超过命令原定睡眠时间后，finished.txt 仍不存在。\n`);
  await request('close',{id:task.id});
} catch(e) {await request('close',{id:task.id}).catch(()=>{});throw e;}
