import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createApp} from '../server.mjs';
import {generate} from '../lib/adapters.mjs';
const PASSWORD='test-only-long-password';
async function setup(t,opts={}){
 const dataDir=mkdtempSync(join(tmpdir(),'cohabit-test-'));
 const dsh={state:async()=>({status:'online',source:'live',account:'2708089138'}),invalidate(){},...opts.dsh};
 const app=createApp({dataDir,password:PASSWORD,...opts,dsh});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 t.after(async()=>{await app.close();rmSync(dataDir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+app.server.address().port;let cookie='',csrf='';
 async function req(path,{method='GET',data,auth=true,headers={}}={}){const r=await fetch(base+'/api'+path,{method,headers:{'content-type':'application/json',...(auth?{cookie,'x-csrf-token':csrf}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});const j=await r.json();return{r,j};}
 const l=await req('/login',{method:'POST',data:{password:PASSWORD},auth:false});cookie=l.r.headers.get('set-cookie').split(';')[0];csrf=l.j.csrf;
 return{...app,req,base,dataDir};
}
test('authentication, CSRF, origin checks, and no secrets returned',async t=>{const a=await setup(t);assert.equal((await a.req('/characters',{auth:false})).r.status,401);assert.equal((await a.req('/characters/gemini',{method:'PATCH',data:{version:1,name:'x'},headers:{'x-csrf-token':'bad'}})).r.status,403);assert.equal((await a.req('/characters',{method:'POST',data:{},headers:{origin:'https://evil.example'}})).r.status,403);let r=await a.req('/characters/gemini',{method:'PATCH',data:{version:1,apiKey:'secret-for-gemini',config:{model:'chosen-model'}}});assert.equal(r.r.status,200);assert.equal(r.j.character.hasKey,true);assert.ok(!JSON.stringify((await a.req('/characters')).j).includes('secret-for-gemini'));assert.equal(a.store.credential('grok'),'');assert.equal(a.store.credential('gemini'),'secret-for-gemini');assert.ok(!readFileSync(join(a.dataDir,'console.sqlite')).includes(Buffer.from('secret-for-gemini')));});
test('role memory isolation includes cross-role deletion protection',async t=>{const a=await setup(t);const m=(await a.req('/characters/gemini/memories',{method:'POST',data:{text:'Gemini 的专属记忆'}})).j.memory;assert.equal((await a.req('/characters/grok/memories')).j.items.length,0);assert.equal((await a.req('/characters/grok/memories/'+m.id,{method:'DELETE',data:{}})).r.status,404);assert.equal((await a.req('/characters/gemini/memories')).j.items.length,1);});
test('optimistic version check and rollback preserve current credentials',async t=>{const a=await setup(t);await a.req('/characters/gemini',{method:'PATCH',data:{version:1,name:'独立角色',apiKey:'key-one'}});assert.equal((await a.req('/characters/gemini',{method:'PATCH',data:{version:1,name:'stale'}})).r.status,409);await a.req('/characters/gemini',{method:'PATCH',data:{version:2,apiKey:'key-two'}});const revisions=(await a.req('/characters/gemini/revisions')).j.items;const rev=revisions.find(x=>x.version===1);const r=await a.req('/characters/gemini/restore',{method:'POST',data:{version:3,revisionId:rev.id}});assert.equal(r.j.character.name,'Gemini');assert.equal(a.store.credential('gemini'),'key-two');assert.equal((await a.req('/characters/grok/restore',{method:'POST',data:{version:1,revisionId:rev.id}})).r.status,404);});
test('QQ account uniqueness, provider immutability, and no arbitrary upstream proxy',async t=>{const a=await setup(t);assert.equal((await a.req('/characters/gemini',{method:'PATCH',data:{version:1,qqAccount:'2708089138'}})).r.status,409);const r=await a.req('/characters/gemini',{method:'PATCH',data:{version:1,provider:'dsh',config:{baseUrl:'https://api.example.test/v1'}}});assert.equal(r.j.character.provider,'gemini');assert.equal((await a.req('/characters/gemini/proxy?path=/shell')).r.status,404);});
test('sandbox conversation and persona are scoped to role',async t=>{let request;const a=await setup(t,{generate:async(c,key,system,messages)=>{request={c,key,system,messages};return{text:'独立回复'};}});await a.req('/characters/gemini',{method:'PATCH',data:{version:1,persona:'你是角色甲',apiKey:'role-key',config:{model:'configured'}}});await a.req('/characters/grok/memories',{method:'POST',data:{text:'不应泄漏的记忆'}});assert.equal((await a.req('/characters/gemini/sandbox',{method:'POST',data:{text:'你好',sessionId:'same'}})).r.status,200);assert.equal(request.c.id,'gemini');assert.equal(request.system,'你是角色甲');assert.equal(request.key,'role-key');assert.equal((await a.req('/characters/grok/sandbox?session=same')).j.messages.length,0);assert.equal((await a.req('/characters/gemini/sandbox?session=same')).j.messages.length,2);});
test('DSH group conflict detection and bounded module updates',async t=>{let saved;let group={overrides:{'1055067483':{burstMax:50,cooldownSec:0}}};let moduleSettings={enabled:true,mode:'active',groupIds:['1055067483']};const a=await setup(t,{dsh:{state:async()=>({status:'online',source:'live',configGroup:structuredClone(group)}),understanding:async()=>({settings:structuredClone(moduleSettings)}),call:async(path,body)=>{saved={path,body};if(body.group)group=structuredClone(body.group);if(body.ext)moduleSettings=structuredClone(body.ext['dafeiyu-social-understanding']);return {ok:true};}}});assert.equal((await a.req('/characters/dafeiyu/group',{method:'PATCH',data:{baseHash:'stale'}})).r.status,409);const {j}=await a.req('/characters/dafeiyu/group');const r=await a.req('/characters/dafeiyu/group',{method:'PATCH',data:{baseHash:j.hash,groupId:'1055067483',policy:{interjectChance:.3,cooldownSec:30,maxPerHour:20,minRelevance:.2}}});assert.equal(r.r.status,200);assert.equal(saved.body.group.overrides['1055067483'].burstMax,50);const understanding=(await a.req('/characters/dafeiyu/understanding')).j;assert.equal((await a.req('/characters/dafeiyu/understanding',{method:'PATCH',data:{enabled:true,mode:'observe',baseHash:understanding.hash}})).r.status,200);assert.deepEqual(saved.body.ext['dafeiyu-social-understanding'].groupIds,['1055067483']);});
test('initial setup requires token and becomes unavailable after completion',async t=>{const dir=mkdtempSync(join(tmpdir(),'cohabit-setup-'));const a=createApp({dataDir:dir,dsh:{state:async()=>({status:'offline'})}});a.server.listen(0,'127.0.0.1');await once(a.server,'listening');t.after(async()=>{await a.close();rmSync(dir,{recursive:true,force:true});});const base='http://127.0.0.1:'+a.server.address().port;const setup=async(token)=>fetch(base+'/api/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:PASSWORD})});assert.equal((await setup('bad')).status,403);assert.equal((await setup(readFileSync(join(dir,'setup-token'),'utf8'))).status,200);assert.equal((await setup('anything')).status,409);});
test('provider protocol mappings preserve role-specific key and message history',async()=>{for(const protocol of ['gemini','responses','chat-completions']){let request;const provider=protocol==='gemini'?'gemini':'openai';const response=protocol==='gemini'?{candidates:[{content:{parts:[{text:'answer'}]}}]}:protocol==='responses'?{output:[{type:'message',content:[{type:'output_text',text:'answer'}]}]}:{choices:[{message:{content:'answer'}}]};const out=await generate({provider,config:{model:'model-id',baseUrl:'https://api.example.test/v1',protocol}},'role-key','人格',[{role:'user',text:'hello'}],async(url,o)=>{request={url,o,body:JSON.parse(o.body)};return response;});assert.equal(out.text,'answer');assert.equal(protocol==='gemini'?request.o.headers['x-goog-api-key']:request.o.headers.authorization,protocol==='gemini'?'role-key':'Bearer role-key');assert.ok(request.url.startsWith('https://api.example.test/v1/'));if(protocol==='responses')assert.equal(request.body.store,false);}});
test('only loopback model gateways can be used without a key',async()=>{const c={provider:'compatible',config:{baseUrl:'http://127.0.0.1:8377/v1',model:'local-model',protocol:'chat-completions'}};const answer=await generate(c,'','persona',[{role:'user',text:'hello'}],async()=>({choices:[{message:{content:'ok'}}]}));assert.equal(answer.text,'ok');await assert.rejects(generate({...c,config:{...c.config,baseUrl:'https://remote.example/v1'}},'','persona',[]),/密钥/);});
test('model connection button calls real HTTP adapters and handles inaccessible models',async t=>{
 const requests=[];
 const upstream=createServer((req,res)=>{requests.push({url:req.url,auth:req.headers.authorization,key:req.headers['x-goog-api-key']});res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('/models/')?{name:'models/chosen'}:{data:[{id:'chosen'}]}));});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>new Promise(r=>upstream.close(r)));
 const a=await setup(t),baseUrl='http://127.0.0.1:'+upstream.address().port+'/v1';
 for(const [id,protocol] of [['gemini','gemini'],['grok','responses']]){
  assert.equal((await a.req('/characters/'+id,{method:'PATCH',data:{version:1,apiKey:id+'-key',config:{baseUrl,model:'chosen',protocol}}})).r.status,200);
  const r=await a.req('/characters/'+id+'/test-connection',{method:'POST',data:{}});assert.equal(r.r.status,200);assert.equal(r.j.ok,true);
 }
 assert.equal(requests[0].key,'gemini-key');assert.equal(requests[1].auth,'Bearer grok-key');
 await a.req('/characters/grok',{method:'PATCH',data:{version:2,config:{model:'missing'}}});
 assert.equal((await a.req('/characters/grok/test-connection',{method:'POST',data:{}})).r.status,409);
});
test('runtime group backups can be undone without overwriting later external changes',async t=>{
 let group={interjectChance:.15,overrides:{'1055067483':{burstMax:50,cooldownSec:0}}};const initial=structuredClone(group);
 const a=await setup(t,{dsh:{state:async()=>({source:'live',status:'online',configGroup:structuredClone(group)}),call:async(path,body)=>{group=structuredClone(body.group);return {ok:true};}}});
 const h=(await a.req('/characters/dafeiyu/group')).j.hash;
 const saved=await a.req('/characters/dafeiyu/group',{method:'PATCH',data:{baseHash:h,groupId:'1055067483',policy:{interjectChance:.3,cooldownSec:30,maxPerHour:20,minRelevance:.2}}});assert.equal(saved.r.status,200);
 let changes=(await a.req('/characters/dafeiyu/runtime-history')).j.items;assert.equal(changes[0].status,'applied');
 const changed=structuredClone(group);group.overrides['1055067483'].cooldownSec=99;
 assert.equal((await a.req('/characters/dafeiyu/runtime-restore',{method:'POST',data:{changeId:changes[0].id}})).r.status,409);assert.equal(group.overrides['1055067483'].cooldownSec,99);
 group=changed;assert.equal((await a.req('/characters/dafeiyu/runtime-restore',{method:'POST',data:{changeId:changes[0].id}})).r.status,200);assert.deepEqual(group,initial);
 changes=(await a.req('/characters/dafeiyu/runtime-history')).j.items;assert.equal(changes.length,2);
 assert.equal((await a.req('/characters/grok/runtime-history/'+changes[0].id)).r.status,404);
});
test('first live persona edit backs up imported DSH persona and can restore it',async t=>{
 let persona='已有的人格，不是空白草稿';
 const a=await setup(t,{dsh:{persona:async()=>({id:'dafeiyu',name:'大肥鱼',tags:[],body:persona,raw:'raw:'+persona}),call:async(path,p)=>{persona=p.body;return {ok:true,persona:p};}}});
 const original=await a.req('/characters/dafeiyu/persona');assert.ok(original.j.hash);
 const r=await a.req('/characters/dafeiyu/persona/apply',{method:'POST',data:{version:1,persona:'新的人格',baseHash:original.j.hash}});assert.equal(r.r.status,200);assert.equal(persona,'新的人格');
 const change=(await a.req('/characters/dafeiyu/runtime-history')).j.items[0];
 assert.equal((await a.req('/characters/dafeiyu/runtime-restore',{method:'POST',data:{changeId:change.id}})).r.status,200);
 assert.equal(persona,'已有的人格，不是空白草稿');
});
test('failed upstream write retains backup with uncertain outcome and prevents blind rollback',async t=>{
 const a=await setup(t,{dsh:{understanding:async()=>({settings:{mode:'active',enabled:true,groupIds:['1055067483']}}),call:async()=>{throw Object.assign(Error('upstream timeout'),{status:502});}}});
 const {j}=await a.req('/characters/dafeiyu/understanding');
 assert.equal((await a.req('/characters/dafeiyu/understanding',{method:'PATCH',data:{baseHash:j.hash,mode:'observe',enabled:true}})).r.status,502);
 const history=(await a.req('/characters/dafeiyu/runtime-history')).j.items;assert.equal(history[0].status,'unknown');
 const change=(await a.req('/characters/dafeiyu/runtime-history/'+history[0].id)).j.item;assert.equal(change.before.mode,'active');
 assert.equal((await a.req('/characters/dafeiyu/runtime-restore',{method:'POST',data:{changeId:change.id}})).r.status,409);
});
test('an HTTP success without the expected live settings is not reported as applied',async t=>{
 const a=await setup(t,{dsh:{understanding:async()=>({settings:{mode:'active',enabled:true,groupIds:['1055067483']}}),call:async()=>({ok:true})}});
 const {j}=await a.req('/characters/dafeiyu/understanding');
 const r=await a.req('/characters/dafeiyu/understanding',{method:'PATCH',data:{baseHash:j.hash,mode:'observe',enabled:true}});
 assert.equal(r.r.status,502);assert.match(r.j.error,/实际配置/);
 assert.equal((await a.req('/characters/dafeiyu/runtime-history')).j.items[0].status,'unknown');
});
test('QQ recovery endpoints require login and reject wrong or unconfirmed account',async t=>{
 let wrong=true,ready=true,reconnected=0,qrCalls=0;
 const a=await setup(t,{napcat:{configured:false,status:async(expectedAccount)=>({available:true,wrongAccount:wrong,isLogin:ready,coreReady:ready,expectedAccount}),qr:async()=>{qrCalls++;return {image:'data:image/png;base64,aGVsbG8=',state:{phase:'waiting_qrcode'}};}},dsh:{state:async()=>({qqState:'connected',account:'2708089138'}),reconnect:async()=>{reconnected++;}}});
 assert.equal((await a.req('/characters/dafeiyu/qq/qr',{auth:false,method:'POST',data:{}})).r.status,401);assert.equal(qrCalls,0);
 assert.equal((await a.req('/characters/dafeiyu/qq/reconnect',{method:'POST',data:{}})).r.status,409);assert.equal(reconnected,0);
 wrong=false;ready=false;assert.equal((await a.req('/characters/dafeiyu/qq/reconnect',{method:'POST',data:{}})).r.status,409);
 ready=true;assert.equal((await a.req('/characters/dafeiyu/qq/reconnect',{method:'POST',data:{}})).r.status,200);assert.equal(reconnected,1);
 assert.equal((await a.req('/characters/grok/qq')).r.status,409);
});
test('diagnostic feedback is scoped to existing records and the DSH character',async t=>{
 const a=await setup(t,{dsh:{diagnostics:async()=>({items:[{id:'trace-test',kind:'turn',input:'测试对话'}]})}});
 assert.equal((await a.req('/characters/dafeiyu/diagnostics/feedback',{method:'POST',data:{traceId:'trace-test',label:'误解对象',note:'A 在回应 B'}})).r.status,200);
 const result=(await a.req('/characters/dafeiyu/diagnostics')).j;assert.equal(result.feedback[0].label,'误解对象');assert.equal((await a.req('/characters/grok/diagnostics')).j.feedback.length,0);
 assert.equal((await a.req('/characters/dafeiyu/diagnostics/feedback',{method:'POST',data:{traceId:'expired',label:'合理'}})).r.status,404);
});
test('overview detects expired native login even while an old DSH socket looks connected',async t=>{const a=await setup(t,{napcat:{configured:true,status:async()=>({available:true,isLogin:false,coreReady:false,error:'登录已失效'})},dsh:{state:async()=>({status:'online',source:'live',qqState:'connected',account:'2708089138'})},startMonitor:false});const d=(await a.req('/characters')).j.characters.find(c=>c.id==='dafeiyu');assert.equal(d.runtime.status,'attention');assert.equal(d.runtime.connectionProblem,'登录已失效');});
test('Claude is an independent role with Sonnet gateway defaults and no inherited credentials or memory',async t=>{const a=await setup(t);const r=await a.req('/characters',{method:'POST',data:{name:'Claude QQ Bot',provider:'claude'}});assert.equal(r.r.status,201);const c=r.j.character;assert.equal(c.provider,'claude');assert.equal(c.config.model,'claude-sonnet-5-5');assert.equal(c.config.protocol,'chat-completions');assert.equal(c.hasKey,false);assert.equal(c.qqAccount,'');assert.equal((await a.req('/characters/'+c.id+'/memories')).j.items.length,0);assert.equal((await a.req('/characters/'+c.id+'/sandbox')).j.messages.length,0);assert.equal((await a.req('/characters/dafeiyu')).j.character.qqAccount,'2708089138');});
test('independent runtime routes never read or write the primary bot',async t=>{
 let persona='Claude 原始人格';let primaryWrites=0,claudeWrites=0;
 const claudeDsh={state:async()=>({status:'attention',source:'live',qqState:'connecting',account:''}),persona:async()=>({id:'claude',name:'Claude',tags:[],body:persona,raw:'raw:'+persona}),memories:async()=>[{id:'c-memory',text:'Claude 专属记忆'}],conversations:async()=>[{text:'Claude 专属会话'}],diagnostics:async()=>({items:[]}),invalidate(){},call:async(path,value)=>{claudeWrites++;persona=value.body;return {ok:true,persona:value};}};
 const a=await setup(t,{runtimes:{claude:{dsh:claudeDsh,napcat:{configured:false,status:async()=>({available:true,isLogin:false,expectedAccount:'2083346400'})}}},dsh:{memories:async()=>[{id:'d-memory',text:'大肥鱼记忆'}],call:async()=>{primaryWrites++;}}});
 a.store.create({id:'claude',name:'Claude',provider:'claude',qqAccount:'2083346400',config:{model:'claude-sonnet-5-5'}});
 const current=(await a.req('/characters/claude')).j.character;assert.equal(current.runtimeType,'dsh');
 assert.equal((await a.req('/characters/claude/memories')).j.items[0].id,'c-memory');assert.equal((await a.req('/characters/dafeiyu/memories')).j.items[0].id,'d-memory');
 const p=(await a.req('/characters/claude/persona')).j;
 assert.equal((await a.req('/characters/claude/persona/apply',{method:'POST',data:{version:1,persona:'新的 Claude 人格',baseHash:p.hash}})).r.status,200);
 assert.equal(claudeWrites,1);assert.equal(primaryWrites,0);assert.equal(persona,'新的 Claude 人格');
 const change=(await a.req('/characters/claude/runtime-history')).j.items[0];
 assert.equal((await a.req('/characters/claude/runtime-restore',{method:'POST',data:{changeId:change.id}})).r.status,200);assert.equal(persona,'Claude 原始人格');assert.equal(primaryWrites,0);
 assert.equal((await a.req('/characters/claude',{method:'PATCH',data:{version:3,qqAccount:'2708089138'}})).r.status,400);
});
test('world editing and state rollback remain scoped to the bound role with stale-write protection',async t=>{
 let card={spec:'chara_card_v2',data:{name:'Claude',description:'old'}},value={chatId:'group:1055067483',scene:'desk',activity:'reading',mood:'calm',source:'test',updatedAt:new Date().toISOString()};
 const own={invalidate(){},state:async()=>({status:'online',source:'live'}),call:async(path,body)=>{
  if(path==='/ext/claude-world/editor/card'){if(body){assert.deepEqual(body.expected,card);card=structuredClone(body.value);}return {ok:true,value:structuredClone(card)};}
  if(path==='/ext/claude-world/editor/states')return {ok:true,items:value?[structuredClone(value)]:[]};
  if(path==='/ext/claude-world/editor/state?chatId=group%3A1055067483'){if(body){assert.deepEqual(body.expected,value);value=structuredClone(body.value);}return {ok:true,value:structuredClone(value)};}
  throw Error('wrong world target');
 }};
 const a=await setup(t,{dsh:{call:async()=>{throw Error('primary must not be called');}},runtimes:{claude:{dsh:own,napcat:{configured:false}}}});
 a.store.create({id:'claude',name:'Claude',provider:'claude',qqAccount:'2083346400'});
 const j=(await a.req('/characters/claude/world')).j;
 assert.equal((await a.req('/characters/claude/world/card',{method:'POST',data:{baseHash:'stale',card:j.card}})).r.status,409);
 assert.equal((await a.req('/characters/claude/world/card',{method:'POST',data:{baseHash:j.hash,card:{...j.card,data:{...j.card.data,description:'new'}}}})).r.status,200);
 const change=a.store.runtimeChanges('claude')[0];assert.equal((await a.req('/characters/dafeiyu/runtime-restore',{method:'POST',data:{changeId:change.id}})).r.status,404);
 assert.equal((await a.req('/characters/claude/runtime-restore',{method:'POST',data:{changeId:change.id}})).r.status,200);assert.equal(card.data.description,'old');
 const s=(await a.req('/characters/claude/world')).j.states[0];
 assert.equal((await a.req('/characters/claude/world/state',{method:'POST',data:{chatId:s.value.chatId,baseHash:s.hash,state:{scene:'new desk',activity:'writing',mood:'happy'}}})).r.status,200);
 assert.equal(value.activity,'writing');
 const sc=a.store.runtimeChanges('claude')[0];assert.equal((await a.req('/characters/claude/runtime-restore',{method:'POST',data:{changeId:sc.id}})).r.status,200);assert.equal(value.activity,'reading');
 assert.equal((await a.req('/characters/claude/world/state',{method:'POST',data:{chatId:'../../etc/passwd',baseHash:s.hash,reset:true}})).r.status,400);
 assert.equal((await a.req('/characters/claude/world',{auth:false})).r.status,401);
});
test('Anthropic Messages adapter uses native headers, endpoint and response format',async()=>{let request;const c={provider:'claude',config:{model:'claude-sonnet-5-5',baseUrl:'https://gateway.example/v1',protocol:'anthropic-messages'}};const r=await generate(c,'private-key','live persona',[{role:'user',text:'hello'}],async(url,o)=>{request={url,headers:o.headers,body:JSON.parse(o.body)};return {content:[{type:'thinking',thinking:'not public'},{type:'text',text:'OK'}]};});assert.equal(r.text,'OK');assert.equal(request.url,'https://gateway.example/v1/messages');assert.equal(request.headers['x-api-key'],'private-key');assert.equal(request.headers.authorization,undefined);assert.equal(request.body.system,'live persona');assert.equal(request.body.max_tokens,1500);});
test('understanding annotations and image access remain authenticated and role scoped',async t=>{const calls=[];const a=await setup(t,{dsh:{call:async()=>{throw Error('primary must not receive annotation');}},runtimes:{claude:{dsh:{invalidate(){},state:async()=>({status:'online'}),conversations:async()=>[],call:async(path,b)=>{calls.push([path,b]);if(path==='/ext/social-learning/bundle')return {ok:true,revision:1,notes:[],recent:[],candidates:[],chats:['group:12345']};if(path==='/stickers')return {ok:true,items:[]};if(path==='/ext/social-learning/note')return {ok:true};if(path==='/ext/social-learning/preview')return {ok:true,ids:[],text:''};throw Error(path);}},napcat:{configured:false}}}});a.store.create({id:'claude',name:'Claude',provider:'claude'});assert.equal((await a.req('/characters/claude/learning',{auth:false})).r.status,401);assert.equal((await a.req('/characters/claude/learning')).j.revision,1);assert.equal((await a.req('/characters/claude/learning/note',{method:'POST',data:{revision:1,note:{kind:'meaning',explanation:'反话'}}})).r.status,200);assert.ok(calls.some(([p])=>p==='/ext/social-learning/note'));assert.equal((await a.req('/characters/claude/learning/image/'+'a'.repeat(32))).r.status,404);assert.equal((await a.req('/characters/claude/learning/image/not-an-md5')).r.status,400);assert.equal((await a.req('/characters/claude/learning/note',{method:'POST',data:{revision:1},headers:{'x-csrf-token':'bad'}})).r.status,403);});
