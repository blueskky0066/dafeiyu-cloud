// Only used by browser tests with an isolated temporary database.
import {createApp} from '../server.mjs';
import QRCode from 'qrcode';
const qr=await QRCode.toDataURL('https://example.test/fixture-only');
let persona={id:'dafeiyu',name:'大肥鱼',tags:['测试'],body:'测试用人格：自然回应对话。'};
let group={interjectChance:.15,cooldownSec:90,maxPerHour:6,minRelevance:.25,overrides:{'1055067483':{cooldownSec:90,burstMax:50}}};
let card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'Claude',description:'测试世界背景',personality:'温柔认真',scenario:'书院',mes_example:'示例',character_book:{name:'测试世界书',entries:[{id:1,keys:['书院'],content:'测试书院设定',enabled:true,constant:false}]}}};
let worldState={chatId:'group:1055067483',scene:'书桌',activity:'看书',mood:'平静',source:'测试',updatedAt:new Date().toISOString()};
let settings={enabled:true,mode:'active',groupIds:['1055067483']};
let learning={ok:true,revision:1,notes:[],recent:[{id:'message-1',chatId:'group:1055067483',speaker:'测试群友',speakerId:'11111',text:'谢谢你啊',images:[],at:new Date().toISOString()}],candidates:[{chatId:'group:1055067483',phrase:'好耶',count:3,speakers:2}],chats:['group:1055067483'],lastRecall:[]};
const dsh={
 invalidate(){},
 state:async()=>({status:'online',source:'live',qqState:'connected',account:'2708089138',configGroup:structuredClone(group),modules:[{id:'social-learning',name:'语境注释与表达学习',enabled:true,running:'user'},{id:'claude-world',name:'角色世界与对话连续性',enabled:true,running:'user'},{id:'dafeiyu-social-understanding',name:'群聊理解',enabled:true,running:'user'}]}),
 persona:async()=>({...persona,raw:JSON.stringify(persona)}),
 understanding:async()=>({version:'test',settings:structuredClone(settings),analyzed:0,fallback:0,lastMs:null}),
 memories:async()=>[{id:'fixture-memory',text:'仅在测试环境中使用的记忆'}],
 conversations:async()=>[{at:Date.now(),speaker:'测试群友',role:'user',text:'这是测试对话',chatId:'group:1055067483'}],
 call:async(path,body)=>{
  if(path==='/ext/social-learning/bundle')return structuredClone(learning);
  if(path==='/ext/social-learning/note'){if(body.delete)learning.notes=learning.notes.filter(n=>n.id!==body.id);else{const n={...body.note,id:body.note.id||'note-'+learning.revision};learning.notes=learning.notes.filter(v=>v.id!==n.id);learning.notes.push(n);}learning.revision++;return {ok:true};}
  if(path==='/ext/social-learning/preview'){const notes=learning.notes.filter(n=>n.enabled&&n.chatId===body.chatId&&(!n.trigger||body.text.includes(n.trigger)));return {ok:true,ids:notes.map(n=>n.id),text:notes.map(n=>n.explanation).join('\n')};}
  if(path==='/stickers')return {ok:true,items:[{md5:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',name:'测试表情',tags:['测试']}]};
  if(path==='/ext/claude-world/editor/card'){if(body)card=structuredClone(body.value);return {ok:true,value:structuredClone(card)};}
  if(path==='/ext/claude-world/editor/states')return {ok:true,items:worldState?[structuredClone(worldState)]:[]};
  if(path.startsWith('/ext/claude-world/editor/state?')){if(body)worldState=structuredClone(body.value);return {ok:true,value:structuredClone(worldState)};}
  if(path==='/persona/save'){persona=structuredClone(body);return {ok:true,persona};}
  if(path==='/save'){if(body.group)group=structuredClone(body.group);if(body.ext)settings=structuredClone(body.ext['dafeiyu-social-understanding']);return {ok:true};}
  throw Error('Unexpected fixture call: '+path);
 }
};
const originalDiagnostics={items:[{id:'fixture-trace',kind:'turn',chatId:'group:1055067483',createdAt:new Date().toISOString(),input:'测试群友：今天又加班',decision:{reply:true,reason:'被 @',mode:'must'},analysisState:'injected',analysisMs:200,analysis:{topic:'加班',intent:'吐槽',target:'测试群友',confidence:.8,approach:'轻松共鸣',uncertainty:'不确定是否需要建议',evidence:['今天又加班'],avoid:['说教']},outcome:'reply_generated',reply:'辛苦啦'}]};
dsh.diagnostics=async()=>originalDiagnostics;
dsh.reconnect=async()=>({ok:true});
const napcat={configured:false,status:async expectedAccount=>({available:true,phase:'waiting_qrcode',isLogin:false,coreReady:false,expectedAccount,account:'',wrongAccount:false,checkedAt:new Date().toISOString()}),qr:async()=>({state:{phase:'waiting_qrcode'},image:qr,refreshAfterMs:35000})};
const app=createApp({dataDir:process.env.QA_DATA,password:'browser-test-only-12345',dsh,napcat,startMonitor:false});
app.server.listen(6382,'127.0.0.1');
process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
