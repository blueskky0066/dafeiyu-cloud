// Run as root on the project server. Reads the existing encrypted model credential.
import {readFileSync,writeFileSync,mkdirSync,existsSync,symlinkSync,chownSync,chmodSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Store} from '/opt/cohabit-console/current/lib/store.mjs';
const HOME_DIR='/srv/claude-qqbot', QQ='2083346400';
if(process.getuid()!==0)throw Error('Run as root');
if(existsSync(HOME_DIR))throw Error('Claude directory already exists; inspect before changing');
const store=new Store('/var/lib/cohabit-console');
try{
 const role=store.get('claude');if(!role||role.config.model!=='claude-sonnet-5-5')throw Error('Expected existing Claude Sonnet role');
 if(role.qqAccount&&role.qqAccount!==QQ)throw Error('Claude is assigned a different QQ account');
 const primary=JSON.parse(readFileSync('/srv/dsh/plugins-data/aurabot/config.json','utf8'));
 let uid,gid;try{uid=Number(execFileSync('id',['-u','claude-qqbot'],{encoding:'utf8'}).trim());}catch{execFileSync('useradd',['--system','--user-group','--no-create-home','--home-dir',HOME_DIR,'--shell','/usr/sbin/nologin','claude-qqbot']);uid=Number(execFileSync('id',['-u','claude-qqbot'],{encoding:'utf8'}).trim());}
 gid=Number(execFileSync('id',['-g','claude-qqbot'],{encoding:'utf8'}).trim());
 const dirs=['','profiles/web/node_modules','plugins/aurabot','plugins-data/aurabot/personas','plugins-data/aurabot/modules/dafeiyu-social-understanding','plugins-data/aurabot/chatlog','credentials','napcat/qq','napcat/config','napcat/plugins','logs'];
 for(const d of dirs){const p=join(HOME_DIR,d);mkdirSync(p,{recursive:true,mode:0o700});chownSync(p,uid,gid);}
 execFileSync('chown',['-R',uid+':'+gid,HOME_DIR]);
 const consoleGid=Number(execFileSync('getent',['group','cohabit-console'],{encoding:'utf8'}).trim().split(':')[2]);
 chownSync(join(HOME_DIR,'plugins-data/aurabot/chatlog'),uid,consoleGid);chmodSync(join(HOME_DIR,'plugins-data/aurabot/chatlog'),0o2750);
 const save=(name,value,{owner=true,json=false}={})=>{const p=join(HOME_DIR,name);writeFileSync(p,json?JSON.stringify(value,null,2):value,{mode:0o600});chmodSync(p,0o600);if(owner)chownSync(p,uid,gid);};
 const link=(dest,target)=>{if(!existsSync(dest))symlinkSync(target,dest);};
 link(join(HOME_DIR,'plugins/node_modules'),'/opt/dsh-runtime/node_modules');
 link(join(HOME_DIR,'profiles/web/node_modules/@deepseek-ai'),'/opt/dsh-runtime/node_modules/@deepseek-ai');
 link(join(HOME_DIR,'profiles/web/node_modules/dsh-aurabot-qq'),join(HOME_DIR,'plugins/aurabot'));
 save('profiles/web/package.json',{name:'claude-qqbot-web',private:true,dependencies:{'dsh-aurabot-qq':'link:'+join(HOME_DIR,'plugins/aurabot')},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-aurabot-qq']}}},{json:true});
 save('profiles/web/cordis.patch.yml',`- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: claude-gateway\n    model: claude-sonnet-5-5\n- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      claude-gateway:\n        displayName: Claude private gateway\n        apiKeyEnv: CLAUDE_PROXY_KEY\n        api: openai-completions\n        baseURL: http://127.0.0.1:8317/v1\n        defaultContextWindow: 131072\n        defaultMaxTokens: 4096\n        models:\n          - id: claude-sonnet-5-5\n            name: Claude Sonnet\n            contextWindow: 131072\n            reasoningEfforts:\n              off:\n              low: low\n`);
 const apiKey=store.credential('claude');if(!apiKey)throw Error('Claude model credential missing');
 save('credentials/model.env','CLAUDE_PROXY_KEY='+JSON.stringify(apiKey)+'\n',{owner:false});
 const onebotToken=randomBytes(24).toString('hex');
 const groups=(primary.allow?.groups||[]).map(String);
 const config={enabled:true,dryRun:false,setupDone:true,botQQ:QQ,ownerQQ:primary.ownerQQ,ownerName:primary.ownerName||'Kira',ownerLevel:'chat',persona:{current:'claude'},model:{provider:'claude-gateway',model:'claude-sonnet-5-5',reasoningEffort:'low'},allow:{private:[],groups},ignoreQQ:[...new Set([String(primary.botQQ),...(primary.ignoreQQ||[]).map(String)])],snowluma:{autoStart:false,autoAttach:false,httpUrl:'',wsUrl:'ws://127.0.0.1:3011',httpToken:'',wsToken:onebotToken},group:{wakeWords:['Claude','claude','克劳德'],interjectChance:0,quietHours:[],overrides:{}},voice:{enabled:false,asr:false},stickers:{enabled:false,collect:false},diary:{enabled:false},speakUp:{enabled:false},qzoneSocial:{enabled:false},bili:{enabled:false,autoBrowse:false},song:{enabled:false},mood:{enabled:false,judge:false},memory:{enabled:true,dailyConsolidate:true},modules:{},ext:{'dafeiyu-social-understanding':{enabled:false,mode:'active',groupIds:groups}},bridge:{http:false,dshTools:false}};
 for(const id of ['voice','song','imagegen','stickers','diary','speakup','qzone-social','bili','group-admin','mood'])config.modules[id]={enabled:false};
 save('plugins-data/aurabot/config.json',config,{json:true});
 save('plugins-data/aurabot/personas/claude.md','---\nname: Claude\ntags: [独立角色, 温和, 敏锐]\n---\n\n'+role.persona+'\n');
 const moduleSource='/srv/dsh/plugins-data/aurabot/modules/dafeiyu-social-understanding';
 for(const name of ['index.mjs','trace-store.mjs']){
  let source=readFileSync(join(moduleSource,name),'utf8');if(name==='index.mjs')source=source.replaceAll('大肥鱼','Claude');
  save('plugins-data/aurabot/modules/dafeiyu-social-understanding/'+name,source);
 }
 const websocket={enable:true,name:'claude-ws',host:'0.0.0.0',port:3001,reportSelfMessage:false,enableForcePushEvent:true,messagePostFormat:'array',token:onebotToken,debug:false,heartInterval:30000};
 const onebot={network:{httpServers:[],httpSseServers:[],httpClients:[],websocketServers:[websocket],websocketClients:[],plugins:[]},musicSignUrl:'',enableLocalFile2Url:false,parseMultMsg:false};
 save('napcat/config/onebot11.json',onebot,{owner:false,json:true});save('napcat/config/onebot11_'+QQ+'.json',onebot,{owner:false,json:true});
 save('napcat/config/webui.json',{host:'0.0.0.0',prefix:'',port:6099,token:randomBytes(24).toString('base64url'),loginRate:3},{owner:false,json:true});
 // The container operates on its own bind mounts; no existing QQ data is mounted.
 const image=execFileSync('docker',['inspect','napcat','--format','{{.Image}}'],{encoding:'utf8'}).trim();
 execFileSync('docker',['run','-d','--name','napcat-claude','--restart','unless-stopped','--memory','512m','--memory-swap','768m','--cpus','0.75','-e','ACCOUNT='+QQ,'-e','PUID=1000','-e','PGID=1000','-e','TZ=Asia/Shanghai','-p','127.0.0.1:3011:3001','-p','127.0.0.1:6098:6099','-v',join(HOME_DIR,'napcat/qq')+':/app/.config/QQ','-v',join(HOME_DIR,'napcat/config')+':/app/napcat/config','-v',join(HOME_DIR,'napcat/plugins')+':/app/napcat/plugins',image],{stdio:['ignore','pipe','pipe']});
 const unitSource=join(fileURLToPath(new URL('.',import.meta.url)),'claude-qqbot.service');
 copyFileSync(unitSource,'/etc/systemd/system/claude-qqbot.service');
 if(role.qqAccount!==QQ)store.update('claude',{qqAccount:QQ},role.version);
 const bindings=JSON.parse(store.setting('runtime-bindings')||'{}');
 bindings.claude={baseUrl:'http://127.0.0.1:63483',botDir:'/run/cohabit-console/claude-bot-data',napcatUrl:'http://127.0.0.1:6098',credentialName:'claude-napcat-webui'};
 store.setting('runtime-bindings',JSON.stringify(bindings));
 save('provisioned.json',{qqAccount:QQ,model:role.config.model,createdAt:new Date().toISOString(),runtimePort:63483,webuiPort:6098},{json:true});
 execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['enable','--now','claude-qqbot']);
 console.log(JSON.stringify({provisioned:true,qqAccount:QQ,model:role.config.model,waitingForPhoneLogin:true}));
}finally{store.close();}
