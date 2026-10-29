import {join,isAbsolute} from 'node:path';
import {DshAdapter} from './adapters.mjs';
import {NapcatAdapter} from './napcat.mjs';
function loopbackUrl(raw){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw Error('Runtime endpoints must be local services');return u.toString().replace(/\/$/,'');}
export function createRuntimeRegistry({store,dsh,napcat,extra={},credentialsDirectory=process.env.CREDENTIALS_DIRECTORY||''}){
 const registry=new Map([['dafeiyu',{dsh,napcat}]]);
 const raw=store.setting('runtime-bindings');const saved=raw?JSON.parse(raw):{};
 const urls=new Set(['http://127.0.0.1:63482','http://127.0.0.1:6099']);
 const dirs=new Set(['/run/cohabit-console/bot-data']);
 const credentials=new Set(['napcat-webui']);
 for(const [id,cfg]of Object.entries(saved)){
  if(id==='dafeiyu'||!store.get(id))throw Error('Invalid runtime role registration');
  const baseUrl=loopbackUrl(cfg.baseUrl),napcatUrl=loopbackUrl(cfg.napcatUrl);
  if(!isAbsolute(cfg.botDir||'')||!String(cfg.botDir).startsWith('/run/cohabit-console/'))throw Error('Invalid runtime log directory');
  if(!/^[a-z0-9-]{2,60}$/.test(cfg.credentialName||''))throw Error('Invalid runtime credential name');
  if(urls.has(baseUrl)||urls.has(napcatUrl)||baseUrl===napcatUrl||dirs.has(cfg.botDir)||credentials.has(cfg.credentialName))throw Error('Runtime identities must not share endpoints, logs or credentials');
  urls.add(baseUrl);urls.add(napcatUrl);dirs.add(cfg.botDir);credentials.add(cfg.credentialName);
  registry.set(id,{dsh:new DshAdapter({baseUrl,botDir:cfg.botDir}),napcat:new NapcatAdapter({baseUrl:napcatUrl,credentialFile:credentialsDirectory?join(credentialsDirectory,cfg.credentialName):''})});
 }
 // Dependency injection is server-side only, for isolated integration tests.
 for(const[id,binding]of Object.entries(extra))registry.set(id,binding);
 return registry;
}
