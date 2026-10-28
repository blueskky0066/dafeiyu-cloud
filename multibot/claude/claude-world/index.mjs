import {join} from 'node:path';
import {writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {loadCard,createStateStore,stateFor,changeState,render} from './world.mjs';
export default {
 id:'claude-world',name:'角色世界与对话连续性',version:'0.1.0',api:1,
 description:'ST V2 JSON角色卡、关键词世界书、按会话隔离的持续生活状态；QQ适配首版',
 setup(api){
 let card=loadCard(join(api.dir,'character.json')),store=createStateStore(api.dataDir('state'));
 const permitted=chat=>chat?.kind==='group'?api.config().allow?.groups?.map(String).includes(String(chat.groupId)):chat?.kind==='private'&&[api.config().ownerQQ,...(api.config().allow?.private||[])].map(String).includes(String(chat.userId));
 const diagnostics=new Map(),contexts=new Map();
 api.context(({chat})=>permitted(chat)?contexts.get(chat.chatId)||'':'');
 api.on('prompt',(content,{chat,queryText=''})=>{
  if(!permitted(chat))return;
  const s=stateFor(store,chat.chatId);store.put(chat.chatId,s);
  const query=queryText||content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const r=render(card,s,query);diagnostics.delete(chat.chatId);diagnostics.set(chat.chatId,{at:new Date().toISOString(),entryIds:r.ids,characters:r.text.length});while(diagnostics.size>100)diagnostics.delete(diagnostics.keys().next().value);
  // Current system context is assembled by Aurabot; keep user messages unchanged.
  contexts.delete(chat.chatId);contexts.set(chat.chatId,r.text);while(contexts.size>100)contexts.delete(contexts.keys().next().value);
  return content;
 });
 api.tool(({chat})=>!permitted(chat)?[]:[api.defineTool({name:'qq_world_state',description:'保存或查看自己在本会话虚构世界里的场景、活动、心情。改变后再自然表达，保持后续连续。不能保存其他人的隐私或把虚构设定当现实事实。省略字段则只查看。',properties:{scene:{type:'string',maxLength:160},activity:{type:'string',maxLength:160},mood:{type:'string',maxLength:160}},execute:async patch=>{if(!permitted(chat))return {ok:false,message:'当前会话不再允许此操作'};const s=Object.keys(patch).length?changeState(store,chat.chatId,patch):stateFor(store,chat.chatId);return {ok:true,message:JSON.stringify({scene:s.scene,activity:s.activity,mood:s.mood,updatedAt:s.updatedAt})};}})]);
 const same=(a,b)=>{const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return JSON.stringify(sort(a))===JSON.stringify(sort(b));};
 const allowedId=id=>{const m=/^(group|private):(\d{5,20})$/.exec(String(id||''));return !!m&&permitted({kind:m[1],groupId:m[1]==='group'?m[2]:'',userId:m[1]==='private'?m[2]:''});};
 api.route('/editor/card',async req=>{
  if(req.method==='GET')return {ok:true,value:card};
  if(req.method!=='POST')return {ok:false,message:'不支持的请求'};
  const b=await api.core.http.body(req);if(!same(b.expected,card))return {ok:false,message:'角色卡已变化，请刷新后保存'};
  const file=join(api.dir,'character.json'),tmp=file+'.edit.tmp';
  try{writeFileSync(tmp,JSON.stringify(b.value,null,2)+'\n',{mode:0o600});const next=loadCard(tmp);renameSync(tmp,file);card=next;contexts.clear();return {ok:true,value:card};}finally{try{unlinkSync(tmp);}catch{}}
 });
 api.route('/editor/states',async()=>({ok:true,items:store.list().filter(s=>allowedId(s.chatId))}));
 api.route('/editor/state',async req=>{
  const q=api.core.http.query(req);if(!allowedId(q.chatId))return {ok:false,message:'会话不在角色白名单'};
  const current=store.get(q.chatId);if(req.method==='GET')return {ok:true,value:current};
  if(req.method!=='POST')return {ok:false,message:'不支持的请求'};
  const b=await api.core.http.body(req);if(!same(b.expected,current))return {ok:false,message:'会话状态已变化，请刷新后保存'};
  if(b.value===null){store.remove(q.chatId);contexts.delete(q.chatId);return {ok:true,value:null};}
  const v=b.value;if(v.chatId!==q.chatId||!Number.isFinite(Date.parse(v.updatedAt))||typeof v.source!=='string'||v.source.length>80)return {ok:false,message:'状态格式错误'};
  for(const k of ['scene','activity','mood'])if(typeof v[k]!=='string'||!v[k].trim()||v[k].length>160)return {ok:false,message:'状态内容需为1～160字'};
  const next={chatId:q.chatId,scene:v.scene,activity:v.activity,mood:v.mood,source:v.source,updatedAt:v.updatedAt};store.put(q.chatId,next);contexts.delete(q.chatId);return {ok:true,value:next};
 });
 api.route('/status',async()=>({ok:true,version:'0.1.0',adapter:'qq-st-v2-text',nativeTavernInstalled:false,character:card.data.name,world:card.data.character_book.name,entries:card.data.character_book.entries.length,diagnostics:[...diagnostics.values()]}));
 api.route('/preview',async(req)=>{const q=api.core.http.query(req),chatId=String(q.chatId||''),match=/^(group|private):(\d{5,20})$/.exec(chatId);if(!match)return {ok:false,message:'需要当前角色允许的chatId'};const chat={kind:match[1],groupId:match[1]==='group'?match[2]:'',userId:match[1]==='private'?match[2]:'',chatId};if(!permitted(chat))return {ok:false,message:'会话不在当前角色白名单'};const r=render(card,stateFor(store,chatId),String(q.text||'').slice(0,3000));return {ok:true,...r};});
 return {};
 }
};
