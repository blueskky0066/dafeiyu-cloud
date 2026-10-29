import http from 'node:http';import {spawn} from 'node:child_process';import {readFileSync} from 'node:fs';import {randomUUID,timingSafeEqual} from 'node:crypto';import {fileURLToPath} from 'node:url';import {MODEL,prepare,translate} from './protocol.mjs';
export function runCli(prepared,{signal,model=process.env.GEMINI_UPSTREAM_MODEL||''}={}){
 return new Promise((resolve,reject)=>{
  const args=['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--print-timeout','80s'];if(model)args.push('--model',model);if(prepared.schema)args.push('--json-schema',JSON.stringify(prepared.schema));
  const child=spawn(process.env.AGY_BIN||'/srv/gemini-gateway/bin/agy',args,{cwd:process.env.GEMINI_WORK_DIR||'/srv/gemini-gateway/work',env:{HOME:'/srv/gemini-gateway',PATH:'/usr/local/node22bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TERM:'dumb'},stdio:['pipe','pipe','pipe'],detached:true});
  let stdout='',over=false;const kill=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}};const timer=setTimeout(()=>{over=true;kill();setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},1500).unref();},90000);signal?.addEventListener('abort',kill,{once:true});
  child.stdout.on('data',b=>{stdout+=b.toString();if(stdout.length>3000000){over=true;kill();}});child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});child.on('error',reject);
  child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',kill);if(over)return reject(Object.assign(Error('Google订阅调用超时或响应过大'),{status:504}));let result;for(const line of stdout.split('\n')){try{const r=JSON.parse(line);if(r.event==='result')result=r.result;}catch{}}if(!result)return reject(Object.assign(Error(code?'Google调用失败，请检查官方客户端登录与额度':'Google没有返回结果'),{status:503}));try{resolve(translate(result,prepared));}catch(e){reject(e);}});
  child.stdin.end(JSON.stringify({event:'user',message:{content:prepared.text}})+'\n');
 });
}
export function createGateway({token,runner=runCli}={}){
 if(!token)throw Error('Private gateway token required');let busy=false,lastSuccess=null;
 const server=http.createServer(async(req,res)=>{
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(req.url==='/health'&&req.method==='GET')return json(200,{ok:true,backend:'official-antigravity-cli',ready:!!lastSuccess,lastSuccess,busy});
  const supplied=req.headers.authorization||'',expected='Bearer '+token;if(Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return json(401,{error:{message:'需要模型网关凭据'}});
  if(req.url==='/v1/models'&&req.method==='GET')return json(200,{object:'list',data:[{id:MODEL,object:'model',owned_by:'local-subscription-adapter'}]});
  if(req.url!=='/v1/chat/completions'||req.method!=='POST')return json(404,{error:{message:'接口不存在'}});
  if(busy)return json(429,{error:{message:'Gemini正在回复其他消息，请稍后重试'}});
  const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{let raw='';for await(const b of req){raw+=b.toString();if(Buffer.byteLength(raw)>1000000)throw Object.assign(Error('请求过大'),{status:413});}const body=JSON.parse(raw),prepared=prepare(body);if(busy)return json(429,{error:{message:'Gemini正在回复其他消息，请稍后重试'}});busy=true;
   try{const out=await runner(prepared,{signal:controller.signal});lastSuccess=new Date().toISOString();if(res.destroyed)return;const id='chatcmpl-'+randomUUID(),created=Math.floor(Date.now()/1000);
    if(!body.stream)return json(200,{id,object:'chat.completion',created,model:MODEL,choices:[{index:0,message:out.message,finish_reason:out.finish_reason}],usage:out.usage});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});const chunk=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id,object:'chat.completion.chunk',created,model:MODEL,choices:[{index:0,delta,finish_reason}]})+'\n\n');chunk({role:'assistant',...(out.message.content?{content:out.message.content}:{}),...(out.message.tool_calls?{tool_calls:out.message.tool_calls.map((t,index)=>({...t,index}))}:{})});chunk({},out.finish_reason);res.end('data: [DONE]\n\n');
   }finally{busy=false;}
  }catch(e){if(!res.destroyed&&!res.headersSent)json(e.status||502,{error:{message:e.status?e.message:'模型适配失败，请检查请求或模型响应'}});}
 });server.requestTimeout=100000;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const token=readFileSync(process.env.GATEWAY_TOKEN_FILE||'/srv/gemini-gateway/gateway.token','utf8').trim();const server=createGateway({token});server.listen(8328,'127.0.0.1',()=>console.log('Gemini subscription adapter listening on localhost:8328'));}
