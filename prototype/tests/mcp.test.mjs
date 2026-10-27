// MCP catalogue and argument validation for numeric output budgets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {handle,catalogue} from '../mcp.mjs';

const call=(name,args)=>handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
const tool=name=>catalogue.find(entry=>entry.name===name);

test('waxwing_create and waxwing_rework declare maxTokens as an integer with minimum 1',()=>{
  for(const name of ['waxwing_create','waxwing_rework']) {
    assert.deepEqual(tool(name).inputSchema.properties.maxTokens,{type:'integer',minimum:1},name);
    assert.ok(tool(name).inputSchema.required.includes('prompt'));
    assert.equal(tool(name).inputSchema.additionalProperties,false);
  }
  assert.equal(tool('waxwing_status').inputSchema.properties.maxTokens,undefined);
  assert.ok(tool('ds_create'),'legacy ds_* alias remains available in 0.1.x');
});
test('ds_create and ds_rework declare effort as high|max',()=>{
  for(const name of ['ds_create','ds_rework']) {
    assert.deepEqual(tool(name).inputSchema.properties.effort,{type:'string',enum:['high','max']},name);
  }
  assert.match(tool('ds_create').description,/effort/i);
  assert.match(tool('ds_rework').description,/max/i);
});
test('MCP rejects unsupported effort before contacting the manager and forwards max',async()=>{
  const calls=[];
  const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {id:'task-0123456789ab'};}};
  for(const value of ['low','medium','xhigh','HIGH','maxx',null,1,true,[]]) {
    const response=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ds_create',arguments:{workspace:'./example',prompt:'p',effort:value}}},io);
    assert.equal(response.result.isError,true,JSON.stringify(value));
    assert.match(response.result.content[0].text,/effort/);
  }
  assert.equal(calls.length,0);
  const response=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'ds_rework',arguments:{id:'task-0123456789ab',prompt:'p',effort:'max'}}},io);
  assert.equal(response.result.isError,undefined);
  assert.deepEqual(calls,[{name:'rework',args:{id:'task-0123456789ab',prompt:'p',effort:'max'}}]);
});
test('waxwing_status exposes all bounded pagination views',()=>{
  const schema=tool('waxwing_status').inputSchema;
  assert.deepEqual(schema.properties.view,{type:'string',enum:['summary','result','history','usage','report','workspace','diff','log'],default:'summary'});
  assert.deepEqual(schema.properties.offset,{type:'integer',minimum:0,default:0});
  assert.deepEqual(schema.properties.limit,{type:'integer',minimum:1,maximum:4000,default:2000});
  assert.deepEqual(schema.required,['id']);
  assert.equal(schema.additionalProperties,false);
  assert.match(tool('waxwing_status').description,/summary/i);
  assert.match(tool('waxwing_status').description,/result/i);
  assert.match(tool('waxwing_status').description,/diff/i);
  assert.deepEqual(tool('waxwing_wait').inputSchema.properties.timeoutSeconds,{
    type:'integer',minimum:1,maximum:300,default:30,
  });
  assert.equal(catalogue.length,34,'17 public tools plus 17 legacy aliases');
});
test('research tools expose batch fan-out, status, collection, and cancellation',()=>{
  const start=tool('waxwing_research_start');
  assert.deepEqual(start.inputSchema.required,['question','shards']);
  assert.equal(start.inputSchema.properties.shards.type,'array');
  assert.equal(start.inputSchema.properties.shards.minItems,1);
  assert.deepEqual(start.inputSchema.properties.shards.items.required,['subject']);
  assert.equal(tool('waxwing_research_status').annotations.readOnlyHint,true);
  assert.equal(tool('waxwing_research_wait').annotations.readOnlyHint,true);
  assert.equal(tool('waxwing_research_cancel').annotations.destructiveHint,true);
  assert.ok(tool('ds_research_collect'),'legacy research alias remains available in 0.1.x');
});
test('MCP leaves an omitted view to the manager summary default and forwards pagination',async()=>{
  const calls=[];
  const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {id:'task-0123456789ab',status:'running'};}};
  const callStatus=args=>handle({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'ds_status',arguments:args}},io);
  const omitted=await callStatus({id:'task-0123456789ab'});
  assert.equal(omitted.result.isError,undefined);
  assert.deepEqual(calls[0],{name:'status',args:{id:'task-0123456789ab'}});
  const paged=await callStatus({id:'task-0123456789ab',view:'result',offset:10,limit:500});
  assert.equal(paged.result.isError,undefined);
  assert.deepEqual(calls[1],{name:'status',args:{id:'task-0123456789ab',view:'result',offset:10,limit:500}});
});

test('Waxwing tool names forward to the same actions as legacy aliases',async()=>{
  const calls=[];
  const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {ok:true};}};
  const invokeTool=(name,args)=>handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},io);
  assert.equal((await invokeTool('waxwing_list',{})).result.isError,undefined);
  assert.equal((await invokeTool('ds_list',{})).result.isError,undefined);
  assert.equal((await invokeTool('waxwing_cleanup_worktree',{id:'task-0123456789ab'})).result.isError,undefined);
  assert.deepEqual(calls,[
    {name:'list',args:{}},
    {name:'list',args:{}},
    {name:'cleanup_worktree',args:{id:'task-0123456789ab'}},
  ]);
});
test('wait tools forward bounded server-side waits',async()=>{
  const calls=[];
  const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {wait:{timedOut:false}};}};
  const invokeTool=(name,args)=>handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},io);
  assert.equal((await invokeTool('waxwing_wait',{id:'task-0123456789ab',timeoutSeconds:20})).result.isError,undefined);
  assert.equal((await invokeTool('ds_research_wait',{id:'research-0123456789ab'})).result.isError,undefined);
  assert.deepEqual(calls,[
    {name:'wait',args:{id:'task-0123456789ab',timeoutSeconds:20}},
    {name:'research_wait',args:{id:'research-0123456789ab'}},
  ]);
});
test('research_start forwards a valid batch without adding limits',async()=>{
  const calls=[];
  const io={ensureServer:async()=>{},request:async(name,args)=>{calls.push({name,args});return {id:'research-0123456789ab'};}};
  const args={question:'Compare projects',shards:[{subject:'Alpha'},{subject:'Beta',url:'https://example.invalid/beta'}],provider:'magpie'};
  const response=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'waxwing_research_start',arguments:args}},io);
  assert.equal(response.result.isError,undefined);
  assert.deepEqual(calls,[{name:'research_start',args}]);
  assert.equal(calls[0].args.usageLimits,undefined);
});
test('MCP rejects invalid status views and pagination before contacting the manager',async()=>{
  let called=0;
  const io={ensureServer:async()=>{called++;},request:async()=>{called++;return {};}};
  for(const args of [{view:'full'},{view:'SUMMARY'},{offset:-1},{offset:1.5},{offset:'0'},{limit:0},{limit:4001},{limit:'2000'}]) {
    const response=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ds_status',arguments:{id:'task-0123456789ab',...args}}},io);
    assert.equal(response.result.isError,true,JSON.stringify(args));
  }
  assert.equal(called,0);
});
test('tools/list returns the full catalogue',async()=>{
  const response=await handle({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal(response.result.tools.length,catalogue.length);
});
test('initialize tells the delegating Agent to use summaries and read results on demand',async()=>{
  const response=await handle({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}});
  assert.match(response.result.instructions,/summary/i);
  assert.match(response.result.instructions,/wait/i);
  assert.match(response.result.instructions,/view=result/i);
  assert.match(response.result.instructions,/offset\/limit/i);
  assert.ok(response.result.instructions.length<=450,`instructions length ${response.result.instructions.length}`);
});
test('MCP rejects every non-integer budget before contacting the manager',async()=>{
  for(const value of [0,-1,1.5,'2048',null,true,[],{},2**53,NaN]) {
    const response=await call('ds_create',{workspace:'./example',prompt:'p',maxTokens:value});
    assert.equal(response.result.isError,true,JSON.stringify(value));
    assert.match(response.result.content[0].text,/integer/);
  }
  for(const value of ['4096',0,2.5,null,2**53]) {
    const response=await call('ds_rework',{id:'task-0123456789ab',prompt:'p',maxTokens:value});
    assert.equal(response.result.isError,true,JSON.stringify(value));
  }
});
test('MCP still enforces required and unknown arguments',async()=>{
  const missing=await call('ds_create',{maxTokens:1024});
  assert.equal(missing.result.isError,true);
  assert.match(missing.result.content[0].text,/Missing argument workspace/);
  const unknown=await call('ds_create',{workspace:'./example',prompt:'p',bogus:1});
  assert.equal(unknown.result.isError,true);
  assert.match(unknown.result.content[0].text,/Invalid argument bogus/);
  const extra=await call('ds_rework',{id:'task-0123456789ab',prompt:'p',maxTokens:1024,extra:'x'});
  assert.equal(extra.result.isError,true);
  assert.match(extra.result.content[0].text,/Invalid argument extra/);
});
