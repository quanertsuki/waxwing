// Reasoning-effort validation and the openai-chat request field.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DEFAULT_EFFORT, assertEffort, parseOptionalEffort, resolveRoundEffort} from '../effort.mjs';
import {OpenAIChatAdapter} from '../providers/openai-chat.mjs';

test('effort accepts only high and max, and defaults to high',()=>{
  assert.equal(DEFAULT_EFFORT,'high');
  assert.equal(assertEffort('high'),'high');
  assert.equal(assertEffort('max'),'max');
  for(const value of ['low','medium','xhigh','HIGH','maxx','',null,1,true,[]]) {
    assert.throws(()=>assertEffort(value),/effort must be one of high, max/,String(value));
    assert.throws(()=>parseOptionalEffort(value),/effort must be one of high, max/,String(value));
  }
  assert.equal(parseOptionalEffort(undefined),undefined);
});

test('round effort resolves request > task value > default',()=>{
  assert.equal(resolveRoundEffort({fallback:'high'}),'high');
  assert.equal(resolveRoundEffort({inherited:'max',fallback:'high'}),'max');
  assert.equal(resolveRoundEffort({requested:'high',inherited:'max',fallback:'high'}),'high');
  assert.throws(()=>resolveRoundEffort({requested:'low',fallback:'high'}),/effort/);
  assert.throws(()=>resolveRoundEffort({inherited:'low',fallback:'high'}),/task effort/);
  assert.throws(()=>resolveRoundEffort({fallback:'low'}),/default effort/);
});

test('openai-chat sends reasoning_effort when the provider supports reasoning',async()=>{
  const bodies=[];
  const server=http.createServer((req,res)=>{
    let raw='';
    req.on('data',chunk=>raw+=chunk);
    req.on('end',()=>{
      bodies.push(JSON.parse(raw));
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:`msg-${bodies.length}`,model:'group/waxwing',
        choices:[{message:{content:'ok'},finish_reason:'stop'}],
        usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const adapter=new OpenAIChatAdapter({name:'reasoning',type:'openai-chat',baseUrl:base,
      apiKey:'test-key',model:'group/waxwing',supportsReasoning:true});
    const result=await adapter.run({prompt:'hi',history:[],tools:[],maxTokens:16,effort:'max'});
    assert.equal(result.text,'ok');
    assert.equal(bodies[0].reasoning_effort,'max');
    assert.equal(bodies[0].model,'group/waxwing');
    assert.equal(bodies[0].max_tokens,16);

    const plain=new OpenAIChatAdapter({name:'plain',type:'openai-chat',baseUrl:base,
      apiKey:'test-key',model:'group/waxwing'});
    await plain.run({prompt:'hi',history:[],tools:[],maxTokens:16,effort:'high'});
    assert.equal('reasoning_effort' in bodies[1],false);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
