import {DshAdapter} from '../lib/adapters.mjs';
import {NapcatAdapter} from '../lib/napcat.mjs';
const d=new DshAdapter({baseUrl:process.env.DSH_BASE_URL,botDir:process.env.BOT_DATA_DIR});
for(const [name,fn] of [['runtime',()=>d.state(true)],['persona',()=>d.persona()],['memories',()=>d.memories()],['conversations',()=>d.conversations()],['understanding',()=>d.understanding()],['diagnostics',()=>d.diagnostics()],['qq-management',()=>new NapcatAdapter().status('2708089138')]]){
 try{const v=await fn();console.log(JSON.stringify({check:name,ok:name==='runtime'?v.source==='live':name==='qq-management'?v.available:true,...(Array.isArray(v)?{count:v.length}:name==='runtime'?{status:v.status,account:v.account}:name==='persona'?{characters:v.body?.length}:name==='understanding'?{mode:v.settings?.mode}:name==='diagnostics'?{records:v.items?.length}:name==='qq-management'?{phase:v.phase,isLogin:v.isLogin,accountMatches:!v.wrongAccount&&v.account==='2708089138'}:{})}));}
 catch(e){console.log(JSON.stringify({check:name,ok:false,error:e.message}));process.exitCode=1;}
}
