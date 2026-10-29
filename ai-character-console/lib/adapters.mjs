import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
export class ApiError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export function validateBaseUrl(raw, allowLocal=false) {
  let u;try{u=new URL(raw);}catch{throw new ApiError('请输入有效的服务地址');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if(u.username||u.password||u.search||u.hash||!['http:','https:'].includes(u.protocol)|| (u.protocol!=='https:' && !(allowLocal&&loopback)))throw new ApiError('服务地址需要 HTTPS，本机网关可以使用 HTTP');
  if(u.hostname==='169.254.169.254'||u.hostname.endsWith('.internal'))throw new ApiError('不支持此服务地址');
  return u.toString().replace(/\/$/,'');
}
export async function jsonFetch(url,options={}) {
  let r;try{r=await fetch(url,{...options,redirect:'error',signal:options.signal||AbortSignal.timeout(8000)});}catch{throw new ApiError('连接失败或超时，请检查服务地址与网络',502);}
  if(!r.ok)throw new ApiError('上游服务返回 HTTP '+r.status,502);
  const text=await r.text(); if(text.length>8_000_000)throw new ApiError('上游响应过大',502);
  let data;try{data=JSON.parse(text);}catch{throw new ApiError('上游返回了无效的数据',502);}
  if(data?.ok===false)throw new ApiError('上游未完成此操作，请检查对应模块状态',502);
  return data;
}
export class DshAdapter {
  constructor({baseUrl='http://127.0.0.1:63482',botDir='/srv/dsh/plugins-data/aurabot'}={}){this.base=baseUrl.replace(/\/$/,'')+'/aurabot/api';this.botDir=botDir;this.cached=null;this.checked=0;this.generation=0;}
  call(path,body){return jsonFetch(this.base+path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
  invalidate(){this.cached=null;this.checked=0;this.generation++;}
  async state(force=false){
    if(!force&&this.cached&&Date.now()-this.checked<15000)return this.cached;
    const generation=this.generation;
    try{
      const s=await this.call('/state');
      const value={status:s.onebot?.state==='connected'&&s.config?.enabled!==false&&!s.config?.dryRun?'online':'attention',source:'live',checkedAt:new Date().toISOString(),account:s.onebot?.login?.uin||'',nickname:s.onebot?.login?.nickname||'',qqState:s.onebot?.state||'unknown',connectionProblem:String(s.onebot?.problem||'').slice(0,500),model:s.config?.model?.model||'',stats:s.stats,stickers:s.stickers?.count||0,mood:s.mood,modules:(s.modules||[]).map(m=>({id:m.id,name:m.name,enabled:m.enabled,running:m.running,error:!!m.error,featureEnabled:({voice:s.config?.voice?.enabled,stickers:s.config?.stickers?.enabled,mood:s.config?.mood?.enabled,memory:s.config?.memory?.enabled,imagegen:s.config?.imageGen?.enabled,song:s.config?.song?.enabled,diary:s.config?.diary?.enabled,'qzone-social':s.config?.qzoneSocial?.enabled,speakup:s.config?.speakUp?.enabled,bili:s.config?.bili?.enabled,'dafeiyu-social-understanding':s.config?.ext?.['dafeiyu-social-understanding']?.enabled})[m.id]})),sessions:s.sessions||[],enabled:s.config?.enabled,dryRun:s.config?.dryRun,group:s.config?.group||{},personaId:s.config?.persona?.current,configGroup:s.config?.group||{}};
      if(generation===this.generation){this.cached=value;this.checked=Date.now();}return value;
    }catch(e){const value={status:'offline',source:'unavailable',checkedAt:new Date().toISOString(),error:e.message};if(generation===this.generation){this.cached=value;this.checked=Date.now();}return value;}
  }
  async persona(){const s=await this.state();if(!s.personaId)throw new ApiError('暂时无法读取 DSH 人格',502);return (await this.call('/persona/get?id='+encodeURIComponent(s.personaId))).persona;}
  async memories(){return (await this.call('/memories')).items||[];}
  async conversations(){
    let files;try{files=(await readdir(join(this.botDir,'chatlog'))).filter(f=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);}catch{throw new ApiError('聊天日志目录不可用',502);}
    const rows=[];
    for(const f of files){const h=await open(join(this.botDir,'chatlog',f),'r');try{const st=await h.stat(),size=Math.min(st.size,512000),buffer=Buffer.alloc(size);const {bytesRead}=await h.read(buffer,0,size,st.size-size);let lines=buffer.subarray(0,bytesRead).toString('utf8').split('\n');if(st.size>size)lines.shift();for(const line of lines){try{rows.push(JSON.parse(line));}catch{}}}finally{await h.close();}}
    return rows.slice(-500).map(r=>({at:r.t,chatId:r.chatId,speaker:r.who,text:r.text,role:r.who==='bot'?'assistant':'user'}));
  }
  async learning(path,body){if(!['bundle','note','preview'].includes(path))throw new ApiError('未知理解接口');const r=await fetch(this.base+'/ext/social-learning/'+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(8000)});const data=await r.json();if(!r.ok||data.ok===false){const message=String(data.message||'理解库操作未完成').slice(0,300);throw new ApiError(message,/已更新|变化|版本/.test(message)?409:r.ok?400:502);}return data;}
  async reconnect(){const result=await jsonFetch(this.base+'/onebot/reconnect',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});this.invalidate();return result;}
  async diagnostics(){return this.call('/ext/dafeiyu-social-understanding/traces');}
  async understanding(){return this.call('/ext/dafeiyu-social-understanding/status');}
}
export function keyOptional(character){try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(character.config.baseUrl).hostname);}catch{return false;}}
export async function generate(character,key,system,messages,fetcher=jsonFetch){
  const {model,baseUrl,protocol}=character.config;
  if(!model||(!key&&!keyOptional(character)))throw new ApiError('请先配置该角色的模型与 API 密钥',409);
  const base=validateBaseUrl(baseUrl,true), headers={'content-type':'application/json'};if(key)headers.authorization='Bearer '+key;
  let endpoint,body;
  if(protocol==='anthropic-messages'){
    delete headers.authorization;if(key)headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';endpoint=base.replace(/\/v1$/,'')+'/v1/messages';body={model,system,messages:messages.map(m=>({role:m.role,content:m.text})),max_tokens:1500};
  }else if(protocol==='gemini'){
    delete headers.authorization;headers['x-goog-api-key']=key;
    endpoint=base+'/models/'+encodeURIComponent(model.replace(/^models\//,''))+':generateContent';
    body={systemInstruction:{parts:[{text:system}]},contents:messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.text}]})),generationConfig:{maxOutputTokens:1500}};
  }else if(protocol==='responses'){
    endpoint=base+'/responses';body={model,instructions:system,input:messages.map(m=>({role:m.role,content:m.text})),max_output_tokens:1500,store:false};
  }else{endpoint=base+'/chat/completions';body={model,messages:[{role:'system',content:system},...messages.map(m=>({role:m.role,content:m.text}))],max_tokens:1500};}
  const j=await fetcher(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const text= protocol==='anthropic-messages'?(j.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join(''):protocol==='gemini'?(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join(''):protocol==='responses'?(j.output||[]).filter(i=>i.type==='message').flatMap(i=>i.content||[]).filter(i=>i.type==='output_text').map(i=>i.text).join(''):j.choices?.[0]?.message?.content;
  if(typeof text!=='string'||!text.trim())throw new ApiError('模型没有返回可显示的文字，请检查模型设置',502);
  return {text:text.slice(0,20000),usage:j.usage||j.usageMetadata||null};
}
