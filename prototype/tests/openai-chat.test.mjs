// OpenAI-compatible tool-loop termination and finish-reason handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {OpenAIChatAdapter} from '../providers/openai-chat.mjs';
import {validateProviderConfig} from '../providers/registry.mjs';

const tools=[{
  name:'read_file',
  description:'Read a file',
  input_schema:{type:'object',properties:{path:{type:'string'}},required:['path']},
}];

async function withServer(handler,run) {
  const server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
}

function reply(res,body) {
  res.writeHead(200,{'content-type':'application/json','connection':'close'});
  res.end(JSON.stringify(body));
}

function sse(res,event) {
  res.write(`data: ${typeof event==='string'?event:JSON.stringify(event)}\n\n`);
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function adapter(baseUrl,extra={}) {
  return new OpenAIChatAdapter({name:'test',type:'openai-chat',baseUrl,
    apiKey:'test-key',model:'test-model',...extra});
}

test('openai-chat defaults to no tool-request limit; zero also means unlimited',async()=>{
  for (const maxToolRequests of [undefined,0]) {
    let requests=0;
    await withServer((req,res)=>{
      req.resume();
      requests+=1;
      const tool=requests<=12;
      reply(res,{id:`msg-${requests}`,model:'test-model',choices:[{
        message:tool?{content:null,tool_calls:[{
          id:`call-${requests}`,
          type:'function',
          function:{name:'read_file',arguments:'{"path":"x"}'},
        }]}:{content:'finished after twelve tool calls'},
        finish_reason:tool?'tool_calls':'stop',
      }],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
    },async baseUrl=>{
      const result=await adapter(baseUrl,{maxToolRequests}).run({
        prompt:'do work',history:[],tools,maxTokens:16,
        onToolCall:()=>({content:'tool result'}),
      });
      assert.equal(result.text,'finished after twelve tool calls');
      assert.equal(result.events.length,13);
    });
    assert.equal(requests,13,`maxToolRequests=${maxToolRequests}`);
  }
});

test('openai-chat enforces an explicitly configured tool-request limit',async()=>{
  let requests=0;
  await withServer((req,res)=>{
    req.resume();
    requests+=1;
    reply(res,{id:`msg-${requests}`,model:'test-model',choices:[{
      message:{content:null,tool_calls:[{
        id:`call-${requests}`,
        type:'function',
        function:{name:'read_file',arguments:'{"path":"x"}'},
      }]},
      finish_reason:'tool_calls',
    }],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
  },async baseUrl=>{
    await assert.rejects(
      adapter(baseUrl,{maxToolRequests:3}).run({prompt:'do work',history:[],tools,maxTokens:16,
        onToolCall:()=>({content:'tool result'})}),
      error=>{
        assert.match(error.message,/tool call limit reached after 3 requests/i);
        assert.equal(error.finishReason,'tool_call_limit');
        assert.equal(error.events.length,3);
        return true;
      },
    );
  });
  assert.equal(requests,3);
});

test('provider config validates maxToolRequests while allowing unlimited values',()=>{
  const base={name:'test',type:'openai-chat',model:'test-model'};
  for (const maxToolRequests of [undefined,null,0,1,100]) {
    assert.doesNotThrow(()=>validateProviderConfig({...base,maxToolRequests}));
  }
  for (const maxToolRequests of [-1,1.5,'3',NaN,Infinity]) {
    assert.throws(()=>validateProviderConfig({...base,maxToolRequests}),/maxToolRequests/i);
  }
});

test('provider config validates the optional stream flag',()=>{
  const base={name:'test',type:'openai-chat',model:'test-model'};
  assert.doesNotThrow(()=>validateProviderConfig({...base,stream:true}));
  assert.doesNotThrow(()=>validateProviderConfig({...base,stream:false}));
  for (const stream of [null,0,1,'false',{},[]]) {
    assert.throws(()=>validateProviderConfig({...base,stream}),/stream must be a boolean/i);
  }
});

test('openai-chat rejects an empty final assistant message',async()=>{
  await withServer((req,res)=>{
    req.resume();
    reply(res,{id:'msg-empty',model:'test-model',choices:[{
      message:{content:''},
      finish_reason:'stop',
    }],usage:{prompt_tokens:10,completion_tokens:0,total_tokens:10}});
  },async baseUrl=>{
    await assert.rejects(
      adapter(baseUrl).run({prompt:'do work',history:[],tools:[]}),
      error=>{
        assert.match(error.message,/empty final assistant message/i);
        assert.equal(error.finishReason,'empty_response');
        assert.equal(error.events.length,1);
        return true;
      },
    );
  });
});

test('openai-chat preserves a length stop as max_tokens',async()=>{
  await withServer((req,res)=>{
    req.resume();
    reply(res,{id:'msg-length',model:'test-model',choices:[{
      message:{content:'partial answer'},
      finish_reason:'length',
    }],usage:{prompt_tokens:10,completion_tokens:16,total_tokens:26}});
  },async baseUrl=>{
    const result=await adapter(baseUrl).run({prompt:'do work',history:[],tools:[],maxTokens:16});
    assert.equal(result.text,'partial answer');
    assert.equal(result.finishReason,'max_tokens');
    assert.equal(result.events.length,1);
  });
});

test('openai-chat streams bounded progress before the final response',async()=>{
  let requestBody=null;
  const seen=[];
  let finished=false;
  await withServer((req,res)=>{
    const chunks=[];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',async()=>{
      requestBody=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive'});
      sse(res,{id:'stream-1',model:'test-model',choices:[{delta:{reasoning_content:'checking'}}]});
      await delay(30);
      sse(res,{id:'stream-1',model:'test-model',choices:[{delta:{content:'final answer'}}]});
      sse(res,{id:'stream-1',model:'test-model',choices:[{delta:{},finish_reason:'stop'}]});
      sse(res,{id:'stream-1',model:'test-model',choices:[],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
      sse(res,'[DONE]');
      res.end();
    });
  },async baseUrl=>{
    const result=await adapter(baseUrl).run({prompt:'do work',history:[],tools:[],maxTokens:16,
      onEvent:event=>seen.push({type:event.type,finished,data:event.data})});
    finished=true;
    assert.equal(result.text,'final answer');
    assert.equal(result.finishReason,'completed');
    assert.equal(result.events.length,1);
  });
  assert.equal(requestBody.stream,true);
  assert.ok(seen.some(event=>event.type==='provider/request-start'&&!event.finished));
  assert.ok(seen.some(event=>event.type==='provider/progress'&&!event.finished));
  assert.ok(seen.some(event=>event.type==='assistant/message'&&!event.finished));
  const progress=seen.find(event=>event.type==='provider/progress');
  assert.ok(progress.data.reasoningChars>0);
  assert.equal('reasoning' in progress.data,false,'progress must not expose hidden reasoning text');
});

test('openai-chat keeps a non-streaming compatibility fallback',async()=>{
  let requestBody=null;
  const seen=[];
  await withServer((req,res)=>{
    const chunks=[];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{
      requestBody=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      reply(res,{id:'json-1',model:'test-model',choices:[{
        message:{content:'JSON fallback answer'},
        finish_reason:'stop',
      }],usage:{prompt_tokens:10,completion_tokens:3,total_tokens:13}});
    });
  },async baseUrl=>{
    const result=await adapter(baseUrl,{stream:false}).run({
      prompt:'do work',history:[],tools:[],maxTokens:16,
      onEvent:event=>seen.push(event.type),
    });
    assert.equal(result.text,'JSON fallback answer');
    assert.equal(result.finishReason,'completed');
  });
  assert.equal(requestBody.stream,false);
  assert.ok(seen.includes('provider/request-start'));
  assert.ok(seen.includes('provider/request-complete'));
  assert.equal(seen.includes('provider/progress'),false);
});

test('openai-chat abort stops a quiet stream without waiting for the request timeout',async()=>{
  const seen=[];
  const controller=new AbortController();
  const started=Date.now();
  await withServer((req,res)=>{
    req.resume();
    req.on('end',()=>{
      res.writeHead(200,{'content-type':'text/event-stream','connection':'keep-alive'});
      sse(res,{id:'quiet-1',model:'test-model',choices:[{delta:{reasoning_content:'thinking'}}]});
      const timer=setInterval(()=>sse(res,{id:'quiet-1',choices:[{delta:{reasoning_content:'.'}}]}),20);
      res.on('close',()=>clearInterval(timer));
    });
  },async baseUrl=>{
    const watchdog=setTimeout(()=>controller.abort(),1500);
    try {
      await assert.rejects(
        adapter(baseUrl).run({prompt:'do work',history:[],tools:[],maxTokens:16,
          signal:controller.signal,onEvent:event=>{
            seen.push(event.type);
            if(event.type==='provider/progress') controller.abort();
          }}),
        /abort/i,
      );
    } finally {
      clearTimeout(watchdog);
    }
  });
  assert.ok(seen.includes('provider/progress'),'first streamed activity must be observable');
  assert.ok(seen.includes('provider/request-failed'),'cancellation must close the request phase');
  assert.ok(Date.now()-started<1500,'cancellation must not wait for the request timeout');
});
