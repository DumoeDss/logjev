import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../dist/index.js';
import { createNodeServer } from '../dist/server.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { once } from 'node:events';

const q = {type:'choice',instructions:'Choose.',criteria:{yes:'Yes',no:'No'}};
const config = () => ({active:'chat',providers:{chat:{name:'chat',kind:'chat',baseUrl:'http://upstream.test/v1',model:'test-model',apiKey:'fixture-upstream-key',extraBody:{thinking:{type:'disabled'}}},official:{name:'official',kind:'jev',baseUrl:'http://upstream.test/decisions',model:'jev-test',apiKey:'fixture-official-key'}},retryDelaysMs:[1,2],concurrency:2});
const upstream = (top=[{token:' A',logprob:-.2},{token:'B',logprob:-2}]) => Response.json({choices:[{logprobs:{content:[{top_logprobs:top}]}}],usage:{prompt_tokens:20,completion_tokens:1}});
const request = (body,headers={}) => new Request('http://bridge.test/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
test('chat mapping, per-request provider/model, multimodal history, usage and CORS',async()=>{
  const calls=[];
  const bridge=createBridge(config(),{fetch:async(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return upstream();}});
  const history=[{role:'user',content:[{type:'text',text:'inspect'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}];
  const r=await bridge(request({model:'override',messages:history,questions:{a:q,b:q}},{Origin:'http://demo.test'}));
  assert.equal(r.status,200);const data=await r.json();
  assert.equal(data.model,'override');assert.equal(data.answers.a.choice,'yes');assert.deepEqual(data.usage,{input_tokens:40,output_tokens:2,reads:2});
  assert.equal(calls.length,2);assert.deepEqual(calls[0].body.messages[0],history[0]);
  assert.equal(calls[0].body.temperature,1);assert.equal(calls[0].body.max_tokens,1);assert.equal(calls[0].body.top_logprobs,20);assert.deepEqual(calls[0].body.thinking,{type:'disabled'});
  assert.equal(calls[0].init.headers.Authorization,'Bearer fixture-upstream-key');assert.equal(r.headers.get('Access-Control-Allow-Origin'),'*');
});
test('official passthrough preserves response fields and forwards only the official payload',async()=>{
  let captured;
  const bridge=createBridge(config(),{fetch:async(url,init)=>{captured={url,body:JSON.parse(init.body),headers:init.headers};return Response.json({answers:{q:{type:'noul',noul:.9}},usage:{cost:.004},custom:'kept'});}});
  const r=await bridge(request({provider:'official',model:'jev-latest',state:'context',prompt_mode:'ignored',questions:{q:{type:'custom-official'}}}));
  const data=await r.json();assert.equal(r.status,200);assert.equal(data.custom,'kept');assert.deepEqual(data.usage,{cost:.004});assert.equal(data.model,'jev-test');
  assert.deepEqual(captured.body,{model:'jev-test',state:'context',questions:{q:{type:'custom-official'}}});assert.equal(captured.headers.Authorization,'Bearer fixture-official-key');
});
test('missing logprobs retry, firm retry and usage accounting',async()=>{
  const bodies=[];let calls=0;
  const bridge=createBridge(config(),{fetch:async(_url,init)=>{bodies.push(JSON.parse(init.body));calls++;return calls===1?Response.json({choices:[{message:{content:'ignored'}}],usage:{prompt_tokens:10,completion_tokens:1}}):calls===2?upstream([{token:'unrelated',logprob:-1}]):upstream();}});
  const r=await bridge(request({state:'s',questions:{q}}));const data=await r.json();
  assert.equal(r.status,200);assert.equal(calls,3);assert.deepEqual(data.usage,{input_tokens:50,output_tokens:3,reads:1});
  assert.match(bodies[2].messages.at(-1).content,/Answer immediately/);
});
test('retry transient 529 and 429, but never retry an upstream 401',async()=>{
  let calls=0;const delays=[];
  const bridge=createBridge(config(),{sleep:async(ms)=>delays.push(ms),fetch:async()=>++calls<3?new Response('busy',{status:calls===1?529:429}):upstream()});
  assert.equal((await bridge(request({questions:{q}}))).status,200);assert.deepEqual(delays,[1,2]);
  calls=0;const blocked=createBridge(config(),{fetch:async()=>{calls++;return new Response('bad key',{status:401});}});
  assert.equal((await blocked(request({questions:{q}}))).status,502);assert.equal(calls,1);
});
test('validation and bridge authentication do not call upstream',async()=>{
  let calls=0;const cfg=config();cfg.bridgeApiKey='fixture-bridge-key';
  const bridge=createBridge(cfg,{fetch:async()=>{calls++;return upstream();}});
  assert.equal((await bridge(request({questions:{q}}))).status,401);
  for(const body of [[],{provider:'missing',questions:{q}},{state:'s',messages:[],questions:{q}},{messages:[{role:'tool',content:'x'}],questions:{q}},{messages:[{role:'user',content:[]}],questions:{q}},{questions:{}},{questions:{q:{...q,criteria:{}}}},{questions:{q},prompt_mode:'bad'}]) {
    assert.equal((await bridge(request(body,{Authorization:'Bearer fixture-bridge-key'}))).status,422);
  }
  assert.equal(calls,0);
});
test('global concurrency cap spans simultaneous requests',async()=>{
  let running=0,maximum=0;
  const bridge=createBridge(config(),{fetch:async()=>{running++;maximum=Math.max(maximum,running);await new Promise(r=>setTimeout(r,5));running--;return upstream();}});
  const responses=await Promise.all([bridge(request({questions:{a:q,b:q,c:q}})),bridge(request({questions:{a:q,b:q,c:q}}))]);
  assert(responses.every(r=>r.status===200));assert.equal(maximum,2);
});
test('missing selected-provider credentials fail clearly without calling upstream',async()=>{
  for(const name of ['chat','official']) {
    for(const missing of ['', '  ']) {
      let calls=0;const cfg=config();cfg.active=name;
      cfg.providers[name].apiKeyEnv='FIXTURE_MISSING_KEY';cfg.providers[name].apiKey=missing;
      const bridge=createBridge(cfg,{fetch:async()=>{calls++;return upstream();}});
      const r=await bridge(request({questions:{q}}));assert.equal(r.status,503);
      const data=await r.json();assert.match(data.detail,/FIXTURE_MISSING_KEY/);assert.match(data.detail,/\.env beside the selected config.yaml/);assert.match(data.detail,/restart/);
      if(name==='chat') assert.equal((await bridge(new Request('http://bridge.test/v1/models'))).status,503);
      for(const path of ['/health','/v1/providers']) assert.equal((await bridge(new Request('http://bridge.test'+path))).status,200);
      assert.equal(calls,0);
    }
  }
});
test('keyless local servers and configured providers work despite unused missing credentials',async()=>{
  const cfg=config();cfg.providers.chat.apiKey='';
  cfg.providers.official.apiKeyEnv='UNUSED_KEY';cfg.providers.official.apiKey='';
  const calls=[];
  const bridge=createBridge(cfg,{fetch:async(_url,init)=>{calls.push(init.headers);return upstream();}});
  assert.equal((await bridge(request({questions:{q}}))).status,200);assert.equal(calls[0].Authorization,undefined);
  cfg.providers.chat.apiKeyEnv='PRESENT_KEY';cfg.providers.chat.apiKey='fixture-present';
  assert.equal((await bridge(request({questions:{q}}))).status,200);assert.equal(calls[1].Authorization,'Bearer fixture-present');
});
test('provider metadata excludes keys; models default first; CORS allowlist',async()=>{
  const cfg=config();cfg.corsOrigins=['http://allowed.test'];
  const bridge=createBridge(cfg,{fetch:async()=>Response.json({data:[{id:'z'},{id:'test-model'},{id:'a'}]})});
  for(const path of ['/health','/v1/providers']) {
    const r=await bridge(new Request('http://bridge.test'+path));assert.equal(r.status,200);assert(!JSON.stringify(await r.json()).includes('fixture-upstream-key'));
  }
  const r=await bridge(new Request('http://bridge.test/v1/models'));assert.deepEqual((await r.json()).data.map(x=>x.id),['test-model','a','z']);
  const preflight=await bridge(new Request('http://bridge.test/v1/systemone',{method:'OPTIONS',headers:{Origin:'http://allowed.test'}}));assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'http://allowed.test');
  const denied=await bridge(new Request('http://bridge.test/health',{headers:{Origin:'http://other.test'}}));assert.equal(denied.headers.get('Access-Control-Allow-Origin'),null);
});
test('malformed and logprob-free responses fail clearly with secrets redacted',async()=>{
  for(const response of [()=>new Response('not json'),()=>Response.json({choices:[{message:{content:'A'}}]}),()=>new Response('fixture-upstream-key',{status:401})]) {
    const bridge=createBridge(config(),{fetch:async()=>response()});const r=await bridge(request({questions:{q}}));assert.equal(r.status,502);assert(!(await r.text()).includes('fixture-upstream-key'));
  }
});
test('real Node HTTP adapter serves API and endpoint-aware shared demos',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'logjev-demos-'));await writeFile(join(dir,'index.html'),'<html><head></head><body>fixture</body></html>');
  const server=createNodeServer(config(),{demosDirectory:dir,fetch:async()=>upstream()});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));const scope=relative(tmpdir(),dir);assert(!isAbsolute(scope)&&!scope.startsWith('..')&&scope.startsWith('logjev-demos-'));await rm(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+server.address().port;
  const api=await fetch(base+'/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:{q}})});assert.equal(api.status,200);
  const html=await (await fetch(base+'/demos/')).text();assert(html.includes(`name="jev-endpoint" content="${base}"`));
  assert.equal((await fetch(base+'/demos/%2e%2e%2f.env')).status,404);
  assert.equal((await fetch(base+'/demos/missing.html')).status,404);
});
