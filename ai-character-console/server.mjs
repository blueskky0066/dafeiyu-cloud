import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { Store } from './lib/store.mjs';
import {NapcatAdapter} from './lib/napcat.mjs';
import {createQqMonitor} from './lib/qq-monitor.mjs';
import {createRuntimeRegistry} from './lib/runtime-registry.mjs';
import { DshAdapter, ApiError, validateBaseUrl, generate, keyOptional, jsonFetch } from './lib/adapters.mjs';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
const hash=v=>createHash('sha256').update(v).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const fingerprint=v=>hash(JSON.stringify(canonical(v)));
const personaPayload=p=>({id:p.id,name:p.name,tags:p.tags||[],body:p.body});
const passwordHash=p=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex');};
function passwordValid(p,h){const [salt,value]=(h||'').split(':');return !!salt&&equal(scryptSync(p,salt,64).toString('hex'),value);}
const requireText=(v,label,max=20000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw new ApiError(label+'不能为空且长度必须小于 '+max);return v.trim();};
const versionOf=b=>{if(!Number.isInteger(b.version)||b.version<1)throw new ApiError('缺少有效的配置版本');return b.version;};
export function createApp(options={}) {
 const store=options.store||new Store(options.dataDir||process.env.CONSOLE_DATA_DIR||join(ROOT,'.data'));
 const dsh=options.dsh||new DshAdapter({baseUrl:process.env.DSH_BASE_URL,botDir:process.env.BOT_DATA_DIR});
 const napcat=options.napcat||new NapcatAdapter();
 const runtimes=createRuntimeRegistry({store,dsh,napcat,extra:options.runtimes});
 const monitors=[...runtimes.entries()].map(([characterId,binding])=>createQqMonitor({...binding,store,characterId}));
 const monitor=monitors[0];
 const monitorTimer=options.startMonitor===false?null:setInterval(()=>{for(const m of monitors)m.check().catch(()=>{});},15000);monitorTimer?.unref();
 const sessions=new Map(),attempts=new Map(),busy=new Set(),imageLibraries=new Map();
 if(options.password&&!store.setting('password'))store.setting('password',passwordHash(options.password));
 const setupPath=join(store.dir,'setup-token');
 if(!store.setting('password')&&!existsSync(setupPath))writeFileSync(setupPath,randomBytes(24).toString('base64url'),{mode:0o600});
 const cleanup=setInterval(()=>{const now=Date.now();for(const [k,v]of sessions)if(v.until<now)sessions.delete(k);for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);},60000);cleanup.unref();
 function send(res,status,data,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(data));}
 async function body(req){const parts=[];let size=0;for await(const b of req){size+=b.length;if(size>150000)throw new ApiError('请求内容过大',413);parts.push(b);}try{return JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{throw new ApiError('无效的 JSON');}}
 function session(req){const m=(req.headers.cookie||'').match(/(?:^|; )console_session=([a-zA-Z0-9_-]+)/);const s=m&&sessions.get(hash(m[1]));return s&&s.until>Date.now()?s:null;}
 function login(res){const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url');sessions.set(hash(token),{csrf,until:Date.now()+12*3600000});const secure=process.env.COOKIE_SECURE==='1'?'; Secure':'';send(res,200,{ok:true,csrf},{'set-cookie':`console_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`});}
 const ensureCharacter=id=>{const c=store.get(id);if(!c)throw new ApiError('角色不存在',404);return c;};
 const isDsh=c=>runtimes.has(c.id);
 const decorate=c=>({...c,runtimeType:isDsh(c)?'dsh':null});
 async function runtimeValue(kind,adapter=dsh){
  if(kind==='world-card')return (await adapter.call('/ext/claude-world/editor/card')).value;
  if(kind.startsWith('world-state:'))return (await adapter.call('/ext/claude-world/editor/state?chatId='+encodeURIComponent(kind.slice(12)))).value;
  if(kind==='persona')return personaPayload(await adapter.persona());
  if(kind==='group'){const live=await adapter.state(true);if(!live.configGroup)throw new ApiError('无法读取群设置',502);return live.configGroup;}
  if(kind==='understanding')return (await adapter.understanding()).settings;
  throw new ApiError('不支持的运行配置类型');
 }
 async function runtimeWrite(kind,value,adapter=dsh,before){
  if(kind==='world-card')return adapter.call('/ext/claude-world/editor/card',{value,expected:before});
  if(kind.startsWith('world-state:'))return adapter.call('/ext/claude-world/editor/state?chatId='+encodeURIComponent(kind.slice(12)),{value,expected:before});
  if(kind==='persona')return adapter.call('/persona/save',value);
  if(kind==='group')return adapter.call('/save',{group:value});
  if(kind==='understanding')return adapter.call('/save',{ext:{'dafeiyu-social-understanding':value}});
  throw new ApiError('不支持的运行配置类型');
 }
 async function applyRuntime(id,kind,title,before,after){
  const adapter=runtimes.get(id)?.dsh;
  if(!adapter)throw new ApiError('角色没有运行系统',409);
  const rid=store.beginRuntimeChange(id,kind,title,before,after);
  try{
   const result=await runtimeWrite(kind,after,adapter,before);
   adapter.invalidate();
   const actual=await runtimeValue(kind,adapter);
   if(fingerprint(actual)!==fingerprint(after))throw new ApiError('实际配置与提交内容不一致，请刷新检查；修改前的配置已保留',502);
   store.finishRuntimeChange(rid,'applied');store.audit(id,title,'已保存旧配置并核对运行结果');return result;
  }catch(error){store.finishRuntimeChange(rid,'unknown');store.audit(id,title+'：结果待核实','请求失败，修改前的配置已保留');throw error;}
 }
 async function stateFor(c){
  if(isDsh(c)){
   const binding=runtimes.get(c.id);
   const runtime=await binding.dsh.state();
   if(binding.napcat.configured){const qq=await binding.napcat.status(c.qqAccount);if(qq.available&&(!qq.isLogin||!qq.coreReady||qq.wrongAccount))return {...runtime,status:'attention',connectionProblem:qq.wrongAccount?'QQ 登录账号与角色不匹配':qq.error||'QQ 登录尚未就绪，请进入 QQ 连接页检查'};}
   return runtime;
  }
  return{status:c.config.model&&(c.hasKey||keyOptional(c))?'configured':'unconfigured',source:'local',checkedAt:null,qqConnected:false};
 }
 function validatePatch(b,c){
  const p={};for(const [k,max]of [['name',40],['summary',240],['persona',30000]])if(b[k]!==undefined){if(typeof b[k]!=='string'||b[k].length>max||(k==='name'&&!b[k].trim()))throw new ApiError('无效的'+k);p[k]=b[k];}
  if(b.qqAccount!==undefined){if(typeof b.qqAccount!=='string'||!/^\d{5,20}$|^$/.test(b.qqAccount))throw new ApiError('QQ账号格式不正确');p.qqAccount=b.qqAccount;}
  if(b.config){p.config={};for(const k of ['model','baseUrl','protocol'])if(b.config[k]!==undefined){if(typeof b.config[k]!=='string'||b.config[k].length>500)throw new ApiError('无效的模型设置');p.config[k]=b.config[k];}if(p.config.baseUrl)p.config.baseUrl=validateBaseUrl(p.config.baseUrl,true);if(p.config.protocol&&!['responses','chat-completions','gemini','anthropic-messages'].includes(p.config.protocol))throw new ApiError('未知的接口协议');}
  if(b.apiKey!==undefined){if(typeof b.apiKey!=='string'||b.apiKey.length>8000)throw new ApiError('无效的密钥');p.apiKey=b.apiKey;}
  if(b.clearKey===true)p.clearKey=true;
  if(isDsh(c)&&p.qqAccount!==undefined&&p.qqAccount!==c.qqAccount)throw new ApiError('已绑定角色的 QQ 账号由独立网关管理，不能直接修改');
  return p;
 }
 async function handler(req,res){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  let mutationLock=null;
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   const write=!['GET','HEAD','OPTIONS'].includes(req.method);
   if(write&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)throw new ApiError('来源校验失败',403);
   if(!path.startsWith('/api/')){
    if(req.method!=='GET'&&req.method!=='HEAD')throw new ApiError('不支持的请求方法',405);
    const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/world-editor.js':'world-editor.js','/learning-editor.js':'learning-editor.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};
    const file=files[path];if(!file)throw new ApiError('页面不存在',404);
    const content=readFileSync(join(ROOT,'public',file));res.writeHead(200,{'content-type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[extname(file)],'cache-control':'no-cache'});return res.end(req.method==='HEAD'?undefined:content);
   }
   if(path==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,version:'0.4.1'});
   if(path==='/api/auth'&&req.method==='GET'){const s=session(req);return send(res,200,{authenticated:!!s,needsSetup:!store.setting('password'),csrf:s?.csrf});}
   if((path==='/api/login'||path==='/api/setup')&&req.method==='POST'){
    const ip=req.socket.remoteAddress||'unknown',rate=attempts.get(ip)||{count:0,until:Date.now()+600000};if(rate.count>=8&&rate.until>Date.now())throw new ApiError('尝试次数过多，请稍后重试',429);if(rate.until<Date.now()){rate.count=0;rate.until=Date.now()+600000;}rate.count++;attempts.set(ip,rate);
    const b=await body(req);const pass=requireText(b.password,'密码',256);
    if(path==='/api/setup'){
     if(store.setting('password'))throw new ApiError('后台已完成初始化',409);
     const token=existsSync(setupPath)?readFileSync(setupPath,'utf8').trim():'';
     if(!token||!equal(b.token,token))throw new ApiError('初始化口令不正确',403);
     if(pass.length<12)throw new ApiError('请使用至少 12 位的密码');
     store.setting('password',passwordHash(pass));store.audit(null,'后台初始化完成');
    }else if(!passwordValid(pass,store.setting('password')))throw new ApiError('密码不正确',401);
    attempts.delete(ip);return login(res);
   }
   const s=session(req);if(!s)throw new ApiError('请先登录',401);
   if(write&&!equal(req.headers['x-csrf-token'],s.csrf))throw new ApiError('会话校验失败，请重新登录',403);
   if(path==='/api/logout'&&req.method==='POST'){const token=(req.headers.cookie||'').match(/console_session=([^;]+)/)?.[1];sessions.delete(hash(token||''));return send(res,200,{ok:true},{'set-cookie':'console_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
   if(path==='/api/password'&&req.method==='POST'){const b=await body(req);if(typeof b.oldPassword!=='string'||!passwordValid(b.oldPassword,store.setting('password')))throw new ApiError('原密码不正确',403);const p=requireText(b.password,'新密码',256);if(p.length<12)throw new ApiError('请使用至少 12 位的密码');store.setting('password',passwordHash(p));sessions.clear();store.audit(null,'管理密码已修改');return login(res);}
   if(path==='/api/characters'&&req.method==='GET')return send(res,200,{characters:await Promise.all(store.list().map(async c=>({...decorate(c),runtime:await stateFor(c)})))});
   if(path==='/api/characters'&&req.method==='POST'){
    const b=await body(req),name=requireText(b.name,'角色名称',40);if(!['gemini','grok','openai','compatible','claude'].includes(b.provider))throw new ApiError('请选择支持的服务类型');
    const defaultConfig={gemini:{baseUrl:'https://generativelanguage.googleapis.com/v1beta',protocol:'gemini'},grok:{baseUrl:'https://api.x.ai/v1',protocol:'responses'},openai:{baseUrl:'https://api.openai.com/v1',protocol:'responses'},compatible:{baseUrl:'',protocol:'chat-completions'},claude:{baseUrl:'http://127.0.0.1:8317/v1',protocol:'chat-completions',model:'claude-sonnet-5-5'}}[b.provider];
    return send(res,201,{character:store.create({name,provider:b.provider,color:{gemini:'violet',grok:'orange',openai:'green',compatible:'blue',claude:'terracotta'}[b.provider],summary:typeof b.summary==='string'?b.summary.slice(0,240):'',config:{model:'',...defaultConfig}})});
   }
   if(path==='/api/audit'&&req.method==='GET')return send(res,200,{items:store.audits()});
   const match=path.match(/^\/api\/characters\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);if(!match)throw new ApiError('接口不存在',404);
   const [,id,action='']=match,c=ensureCharacter(id);
   const {dsh:runtimeDsh,napcat:runtimeNapcat}=runtimes.get(id)||{};
   const learningCall=(suffix,b)=>runtimeDsh.learning?runtimeDsh.learning(suffix,b):runtimeDsh.call('/ext/social-learning/'+suffix,b);
   if(write){mutationLock='mutation:'+id;if(busy.has(mutationLock)){mutationLock=null;throw new ApiError('此角色的修改正在保存，请稍等',409);}busy.add(mutationLock);}
   if(!action&&req.method==='GET')return send(res,200,{character:decorate(c),runtime:await stateFor(c)});
   if(!action&&req.method==='PATCH'){const b=await body(req);return send(res,200,{character:decorate(store.update(id,validatePatch(b,c),versionOf(b)))});}
   if(action==='qq'&&req.method==='GET'){
    if(!isDsh(c))throw new ApiError('此角色尚未接入 QQ 网关',409);
    const [qq,runtime]=await Promise.all([runtimeNapcat.status(c.qqAccount),runtimeDsh.state(true)]);return send(res,200,{qq,runtime});
   }
   if(action==='qq/qr'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('此角色尚未接入 QQ 网关',409);
    const b=await body(req);return send(res,200,await runtimeNapcat.qr(c.qqAccount,{refresh:b.refresh===true}));
   }
   if(action==='qq/reconnect'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('此角色尚未接入 QQ 网关',409);
    const qq=await runtimeNapcat.status(c.qqAccount);
    if(!qq.available)throw new ApiError(qq.error||'QQ 网关不可达',502);
    if(qq.wrongAccount)throw new ApiError('当前登录的不是这个角色的 QQ 账号，请切换正确账号',409);
    if(!qq.isLogin||!qq.coreReady)throw new ApiError('请先完成手机扫码登录',409);
    await runtimeDsh.reconnect();const runtime=await runtimeDsh.state(true);
    if(runtime.qqState!=='connected'||runtime.account!==c.qqAccount)throw new ApiError('尚未连上正确的 QQ 账号，请稍后重试',502);
    store.audit(id,'QQ 网关已手动重连');return send(res,200,{ok:true,runtime});
   }
   if(action==='diagnostics'&&req.method==='GET'){
    if(!isDsh(c))return send(res,200,{items:[],feedback:[],supported:false});
    const result=await runtimeDsh.diagnostics();return send(res,200,{...result,feedback:store.traceFeedback(id),supported:true});
   }
   if(action==='diagnostics/feedback'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('此角色暂未接入聊天诊断',409);
    const b=await body(req),traceId=requireText(b.traceId,'诊断编号',80);
    if(!['合理','误解对象','抢话','表达刻意','其他'].includes(b.label))throw new ApiError('请选择有效的标注');
    if(b.note!==undefined&&(typeof b.note!=='string'||b.note.length>1000))throw new ApiError('备注过长');
    const records=await runtimeDsh.diagnostics();if(!(records.items||[]).some(r=>r.id===traceId))throw new ApiError('诊断记录不存在或已过保留期限',404);
    store.saveTraceFeedback(id,traceId,b.label,b.note||'');return send(res,200,{ok:true});
   }
   if(action==='learning'&&req.method==='GET'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);
    const bundle=await learningCall('bundle');let stickers=[],history=[];
    try{stickers=(await runtimeDsh.call('/stickers')).items||[];imageLibraries.set(id,{at:Date.now(),items:stickers});}catch{}
    try{history=(await runtimeDsh.conversations()).slice(-100).reverse().map(r=>({...r,id:'log:'+fingerprint(r),historical:true}));}catch{}
    return send(res,200,{...bundle,stickers:stickers.slice(0,1000).map(s=>({md5:s.md5,name:s.name,tags:s.tags||[]})),history});
   }
   if(action==='learning/note'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);
    const b=await body(req);if(!Number.isInteger(b.revision)||b.revision<1)throw new ApiError('缺少理解库版本');
    const r=await learningCall('note',b);store.audit(id,b.delete?'语境注释已删除':'语境注释已保存',b.note?.kind||'');return send(res,200,r);
   }
   if(action==='learning/preview'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);return send(res,200,await learningCall('preview',await body(req)));
   }
   if(action.startsWith('learning/image/')&&req.method==='GET'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);const md5=action.slice('learning/image/'.length);if(!/^[a-f0-9]{32}$/.test(md5))throw new ApiError('表情标识无效');
    const cached=imageLibraries.get(id);const library=cached&&Date.now()-cached.at<15000?cached:await runtimeDsh.call('/stickers');if(!(library.items||[]).some(s=>s.md5===md5))throw new ApiError('当前角色表情库没有这张图',404);
    const upstream=await fetch(runtimeDsh.base+'/sticker/image?md5='+md5,{redirect:'error',signal:AbortSignal.timeout(8000)});if(!upstream.ok)throw new ApiError('表情图片暂时不可用',502);const type=upstream.headers.get('content-type')?.split(';')[0];if(!['image/png','image/jpeg','image/gif','image/webp'].includes(type))throw new ApiError('不支持的图片格式');if(Number(upstream.headers.get('content-length'))>6000000)throw new ApiError('表情图片过大');const buffer=Buffer.from(await upstream.arrayBuffer());if(buffer.length>6000000)throw new ApiError('表情图片过大');res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});return res.end(buffer);
   }
   if(action==='world'&&req.method==='GET'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);
    const card=await runtimeValue('world-card',runtimeDsh),states=await runtimeDsh.call('/ext/claude-world/editor/states');
    return send(res,200,{card,hash:fingerprint(card),states:(states.items||[]).map(value=>({value,hash:fingerprint(value)}))});
   }
   if(action==='world/card'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);
    const b=await body(req),before=await runtimeValue('world-card',runtimeDsh);
    if(b.baseHash!==fingerprint(before))throw new ApiError('角色卡已更新，请刷新后保存',409);
    if(!b.card||b.card.spec!=='chara_card_v2'||!b.card.data||JSON.stringify(b.card).length>70000)throw new ApiError('角色卡格式或长度无效');
    await applyRuntime(id,'world-card','角色卡与世界书已保存',before,b.card);return send(res,200,{ok:true});
   }
   if(action==='world/state'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('角色尚未接入运行系统',409);
    const b=await body(req);if(!/^(group|private):\d{5,20}$/.test(b.chatId||''))throw new ApiError('会话编号格式错误');
    const kind='world-state:'+b.chatId,before=await runtimeValue(kind,runtimeDsh);
    if(b.baseHash!==fingerprint(before))throw new ApiError('会话状态已更新，请刷新后保存',409);
    let after=null;
    if(!b.reset){const v=b.state||{};for(const k of ['scene','activity','mood'])requireText(v[k],'状态内容',160);after={chatId:b.chatId,scene:v.scene,activity:v.activity,mood:v.mood,source:'工作台编辑',updatedAt:new Date().toISOString()};}
    await applyRuntime(id,kind,'角色会话状态已'+(b.reset?'重置':'保存'),before,after);return send(res,200,{ok:true});
   }
   if(action==='revisions'&&req.method==='GET')return send(res,200,{items:store.revisions(id)});
   if(action==='runtime-history'&&req.method==='GET')return send(res,200,{items:store.runtimeChanges(id)});
   if(action.startsWith('runtime-history/')&&req.method==='GET'){
    const item=store.runtimeChange(id,action.slice('runtime-history/'.length));if(!item)throw new ApiError('运行配置记录不存在',404);return send(res,200,{item});
   }
   if(action==='runtime-restore'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('此角色未绑定 DSH');
    const b=await body(req),item=store.runtimeChange(id,b.changeId);if(!item)throw new ApiError('运行配置记录不存在',404);
    if(item.status!=='applied')throw new ApiError('这次修改的结果尚未确认，请先检查运行配置',409);
    const current=await runtimeValue(item.kind,runtimeDsh);
    if(fingerprint(current)!==fingerprint(item.after))throw new ApiError('实际配置已被再次修改。请先检查最新状态，避免覆盖后续改动。',409);
    await applyRuntime(id,item.kind,'已撤销：'+item.title,current,item.before);
    if(item.kind==='persona')store.update(id,{persona:item.before.body},c.version);
    return send(res,200,{ok:true});
   }
   if(action==='restore'&&req.method==='POST'){const b=await body(req),r=store.revision(id,b.revisionId);if(!r)throw new ApiError('历史版本不存在',404);const next=store.update(id,{name:r.name,summary:r.summary,persona:r.persona,qqAccount:isDsh(c)?c.qqAccount:r.qqAccount,config:r.config},versionOf(b));store.audit(id,'已恢复历史配置','来源版本 '+r.version+'；密钥不回滚');return send(res,200,{character:decorate(next)});}
   if(action==='persona'&&req.method==='GET'){if(isDsh(c)){const persona=await runtimeDsh.persona();return send(res,200,{persona,hash:hash(persona.raw),source:'live'});}return send(res,200,{persona:{body:c.persona,name:c.name},source:'local'});}
   if(action==='persona/apply'&&req.method==='POST'){
    if(!isDsh(c))throw new ApiError('此角色直接保存人格即可');const b=await body(req);if(versionOf(b)!==c.version)throw new ApiError('配置已更新，请刷新',409);
    const p=await runtimeDsh.persona();if(b.baseHash!==hash(p.raw))throw new ApiError('DSH 人格已变化，请重新读取后再保存',409);
    const text=requireText(b.persona,'人格内容',30000);
    const before=personaPayload(p),after={...before,body:text};
    const result=await applyRuntime(id,'persona','DSH 人格已应用',before,after);
    store.update(id,{persona:text},c.version);store.audit(id,'DSH 人格已应用','下一轮对话生效');return send(res,200,{ok:true,persona:result.persona});
   }
   if(action==='persona/hash'&&req.method==='GET'){const p=await runtimeDsh.persona();return send(res,200,{hash:hash(p.raw)});}
   if(action==='conversations'&&req.method==='GET')return send(res,200,{items:isDsh(c)?await runtimeDsh.conversations():[],source:isDsh(c)?'live':'local'});
   if(action==='memories'&&req.method==='GET')return send(res,200,{items:isDsh(c)?await runtimeDsh.memories():store.memories(id),source:isDsh(c)?'live':'local'});
   if(action==='memories'&&req.method==='POST'){const b=await body(req),text=requireText(b.text,'记忆',4000);if(isDsh(c)){const result=await runtimeDsh.call('/memory/add',{text,importance:0.6});store.audit(id,'DSH 记忆已添加');return send(res,201,{ok:true,result});}return send(res,201,{memory:store.addMemory(id,text)});}
   if(action.startsWith('memories/')&&req.method==='DELETE'){const mid=decodeURIComponent(action.slice(9));if(isDsh(c)){const result=await runtimeDsh.call('/memory/delete',{id:mid});store.audit(id,'DSH 记忆已删除');return send(res,200,{ok:true,result});}store.deleteMemory(id,mid);return send(res,200,{ok:true});}
   if(action==='understanding'&&req.method==='GET'){if(!isDsh(c))return send(res,200,{supported:false});const u=await runtimeDsh.understanding();return send(res,200,{supported:true,...u,hash:fingerprint(u.settings)});}
   if(action==='understanding'&&req.method==='PATCH'){
    if(!isDsh(c))throw new ApiError('此角色未接入群聊理解模块');const b=await body(req);if(typeof b.enabled!=='boolean'||!['observe','active'].includes(b.mode))throw new ApiError('无效的模块设置');
    const live=await runtimeDsh.understanding();if(b.baseHash!==fingerprint(live.settings))throw new ApiError('理解模块设置已变化，请刷新后重试',409);
    const settings={...live.settings,enabled:b.enabled,mode:b.mode};await applyRuntime(id,'understanding','群聊理解设置已修改',live.settings,settings);return send(res,200,{ok:true});
   }
   if(action==='group'&&req.method==='GET'){if(!isDsh(c))throw new ApiError('此角色尚未绑定 QQ 运行系统',409);const s=await runtimeDsh.state(true);if(!s.configGroup)throw new ApiError('无法读取群设置',502);return send(res,200,{group:s.configGroup,hash:fingerprint(s.configGroup)});}
   if(action==='group'&&req.method==='PATCH'){
    if(!isDsh(c))throw new ApiError('此角色尚未绑定 QQ 运行系统',409);const b=await body(req),live=await runtimeDsh.state(true);if(!live.configGroup||b.baseHash!==fingerprint(live.configGroup))throw new ApiError('群设置已变化，请重新读取',409);
    if(!/^\d{5,20}$/.test(b.groupId))throw new ApiError('无效的群号');const p=b.policy||{};
    for(const[k,min,max]of[['interjectChance',0,1],['cooldownSec',0,3600],['maxPerHour',0,1000],['minRelevance',0,1]])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<min||p[k]>max)throw new ApiError('群设置数值超出范围');
    const overrides={...live.configGroup.overrides,[b.groupId]:{...(live.configGroup.overrides?.[b.groupId]||{}),interjectChance:p.interjectChance,cooldownSec:p.cooldownSec,maxPerHour:p.maxPerHour,minRelevance:p.minRelevance}};
    await applyRuntime(id,'group','群聊策略已修改 · '+b.groupId,live.configGroup,{...live.configGroup,overrides});return send(res,200,{ok:true});
   }
   if(action==='test-connection'&&req.method==='POST'){
    const started=Date.now();
    if((!c.hasKey&&!keyOptional(c))||!c.config.model)throw new ApiError('请先保存 API 密钥和模型名称',409);
    const base=validateBaseUrl(c.config.baseUrl,true),key=store.credential(id);
    if(c.config.protocol==='anthropic-messages')await (options.generate||generate)(c,key,'仅简短确认连接可用。',[{role:'user',text:'回复OK'}]);
    else if(c.config.protocol==='gemini')await jsonFetch(base+'/models/'+encodeURIComponent(c.config.model.replace(/^models\//,'')),{headers:key?{'x-goog-api-key':key}:{}});
    else{const result=await jsonFetch(base+'/models',{headers:key?{authorization:'Bearer '+key}:{}});if(!(result.data||[]).some(m=>m.id===c.config.model))throw new ApiError('连接成功，但账号的模型列表中没有这个模型',409);}
    store.audit(id,'模型连接测试成功');return send(res,200,{ok:true,ms:Date.now()-started,message:'凭据与模型访问检查通过'});
   }
   if(action==='sandbox'&&req.method==='GET'){const sid=url.searchParams.get('session')||'default';return send(res,200,{messages:store.messages(id,sid)});}
   if(action==='sandbox'&&req.method==='POST'){
    const b=await body(req),text=requireText(b.text,'消息',4000),sid=requireText(b.sessionId||'default','会话',80);const lock=id+':'+sid;if(busy.has(lock))throw new ApiError('这个会话正在回复，请稍等',409);busy.add(lock);
    try{
     let persona=c.persona;if(isDsh(c))persona=(await runtimeDsh.persona()).body;
     const memories=isDsh(c)?await runtimeDsh.memories():store.memories(id);
     const relevant=memories.filter(m=>typeof m.text==='string'&&[...new Set(text.match(/[\p{L}\p{N}]{2,}/gu)||[])].some(t=>m.text.includes(t))).slice(0,5);
     const system=(persona||`你是${c.name}。自然地交流，信息不足时直接说明。`)+(relevant.length?'\n以下为可能相关的角色记忆，仅供参考：\n'+JSON.stringify(relevant.map(m=>m.text)):'');
     const history=store.messages(id,sid).map(m=>({role:m.role,text:m.text}));
     const result=await (options.generate||generate)(c,store.credential(id),system,[...history,{role:'user',text}]);
     store.message(id,sid,'user',text);store.message(id,sid,'assistant',result.text);store.audit(id,'后台试聊完成');return send(res,200,{message:result.text,usage:result.usage});
    }finally{busy.delete(lock);}
   }
   throw new ApiError('接口不存在或请求方法不支持',404);
  }catch(e){if(res.headersSent)return res.end();let status=e.status||500,message=e.status?e.message:'操作失败，请查看后台服务日志';if(String(e.message).includes('UNIQUE constraint')){status=409;message='此 QQ 账号已分配给另一个角色';}if(status===500)console.error('console error:',e.message);send(res,status,{error:message});}
  finally{if(mutationLock)busy.delete(mutationLock);}
 }
 const server=http.createServer(handler);server.requestTimeout=60000;server.headersTimeout=10000;
 return {server,store,dsh,napcat,monitor,runtimes,close:async()=>{for(const m of monitors)m.stop();clearInterval(monitorTimer);clearInterval(cleanup);await new Promise(r=>server.close(r));store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=createApp(),port=Number(process.env.PORT||6380),host=process.env.HOST||'127.0.0.1';
 app.server.listen(port,host,()=>{console.log(`AI 角色管理台: http://${host}:${port}`);if(!app.store.setting('password'))console.log('首次访问请使用数据目录中的 setup-token 初始化管理密码。');});
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit(0);});
}
