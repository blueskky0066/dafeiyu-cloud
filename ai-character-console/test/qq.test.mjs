import test from 'node:test';
import assert from 'node:assert/strict';
import {NapcatAdapter} from '../lib/napcat.mjs';
import {createQqMonitor} from '../lib/qq-monitor.mjs';
import {createHash} from 'node:crypto';
function nativeFixture({phase='waiting_qrcode',account='2708089138'}={}){
 const calls=[];let qr=0;
 const fetcher=async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body),headers:options.headers});
  if(url.endsWith('/auth/login'))return {code:0,data:{Credential:'private-management-credential'}};
  if(url.endsWith('/CheckLoginStatus'))return {code:0,data:{loginPhase:phase,isLogin:phase==='ready',coreReady:phase==='ready',qrLoginAccepted:phase==='qrcode_scanned',qrcodeurl:'https://example.test/login?ticket='+qr}};
  if(url.endsWith('/GetQQLoginInfo'))return {code:0,data:{uin:account}};
  if(url.endsWith('/RefreshQRcode'))return {code:0,data:{qrcodeurl:'https://example.test/login?ticket='+(++qr)}};
  throw Error('Unexpected request');
 };
 return {adapter:new NapcatAdapter({token:'native-admin-secret',fetcher}),calls};
}
test('QR is encoded from current ticket and never exposes management credentials',async()=>{
 const {adapter,calls}=nativeFixture();const qr=await adapter.qr('2708089138',{refresh:true});assert.match(qr.image,/^data:image\/png;base64,/);assert.equal(qr.refreshAfterMs,35000);assert.equal(qr.state.phase,'waiting_qrcode');assert.ok(!JSON.stringify(qr).includes('private-management-credential'));assert.ok(!JSON.stringify(qr).includes('native-admin-secret'));assert.equal(calls[0].body.hash,createHash('sha256').update('native-admin-secret.napcat').digest('hex'));await adapter.status('2708089138');assert.equal(calls.filter(x=>x.url.endsWith('/auth/login')).length,1);
});
test('accepted QR and initialized login do not rotate QR tickets',async()=>{
 for(const phase of ['qrcode_scanned','initializing','ready']){const {adapter,calls}=nativeFixture({phase});const r=await adapter.qr('2708089138',{refresh:true});assert.equal(r.image,null);assert.equal(calls.filter(x=>x.url.endsWith('/RefreshQRcode')).length,0);}
});
test('wrong logged-in account is visible and blocks the reconnect monitor',async()=>{
 const {adapter}=nativeFixture({phase:'ready',account:'999999999'});const status=await adapter.status('2708089138');assert.equal(status.wrongAccount,true);let reconnects=0;
 const monitor=createQqMonitor({napcat:{configured:true,status:async()=>status},dsh:{state:async()=>({qqState:'disconnected',enabled:true}),reconnect:async()=>{reconnects++;}},store:{get:()=>({id:'dafeiyu',qqAccount:'2708089138'}),audit(){}}});await monitor.check();assert.equal(reconnects,0);
});
test('monitor only reconnects a ready matching account and backs off',async()=>{
 let clock=0,phase='waiting_qrcode',reconnects=0;const audits=[];
 const monitor=createQqMonitor({now:()=>clock,napcat:{configured:true,status:async()=>({available:true,phase,isLogin:phase==='ready',coreReady:phase==='ready',account:'2708089138'})},dsh:{state:async()=>({qqState:'disconnected',enabled:true}),reconnect:async()=>{reconnects++;}},store:{get:()=>({id:'dafeiyu',qqAccount:'2708089138'}),audit:(...a)=>audits.push(a)}});
 await monitor.check();assert.equal(reconnects,0);phase='ready';await monitor.check();await monitor.check();assert.equal(reconnects,1);clock=31000;await monitor.check();assert.equal(reconnects,2);assert.equal(audits.filter(x=>x[1]==='QQ 已登录，DSH 等待重连').length,1);monitor.stop();clock=65000;await monitor.check();assert.equal(reconnects,2);
});
test('authentication failures are bounded and do not expose native token',async()=>{
 let calls=0;const adapter=new NapcatAdapter({token:'secret',fetcher:async()=>{calls++;return {code:-1,message:'token is invalid'};}});
 const r=await adapter.status('2708089138');assert.equal(r.available,false);await adapter.status('2708089138');assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('secret'));
});
