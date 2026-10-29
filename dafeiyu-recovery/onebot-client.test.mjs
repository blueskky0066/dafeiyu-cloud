import test from 'node:test';
import assert from 'node:assert/strict';
import {createOneBotClient} from './onebot-client.mjs';
class Socket{
 static all=[];
 constructor(){this.readyState=0;this.sent=[];Socket.all.push(this);}
 close(){this.readyState=3;}
 send(raw){this.sent.push(JSON.parse(raw));}
 open(){this.readyState=1;this.onopen?.();}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+400;while(!fn()){if(Date.now()>end)throw Error('condition timeout');await sleep(2);}}
function harness(t,options={}){const original=globalThis.WebSocket;globalThis.WebSocket=Socket;Socket.all=[];const events=[];const client=createOneBotClient({endpoint:()=>({httpUrl:'',wsUrl:'ws://localhost'}),onEvent:x=>events.push(x),onState(){},log:{warn(){},info(){}},connectTimeoutMs:50,reconnectMinMs:5,reconnectMaxMs:20,...options});t.after(()=>{client.stop();globalThis.WebSocket=original;});return {client,events};}
test('late events from old socket neither reject new requests nor create duplicate connections',async t=>{const {client,events}=harness(t);client.start();const old=Socket.all[0];old.open();client.restart();const current=Socket.all[1];current.open();const result=client.call('get_login_info');old.onclose({code:1005});old.onmessage({data:JSON.stringify({post_type:'message',message_id:'stale'})});const req=current.sent[0];current.onmessage({data:JSON.stringify({echo:req.echo,status:'ok',data:{user_id:2708089138}})});assert.equal((await result).user_id,2708089138);await sleep(20);assert.equal(Socket.all.length,2);assert.equal(client.state,'connected');assert.equal(events.length,0);});
test('handshake timeout retries instead of staying in connecting forever',async t=>{const {client}=harness(t,{connectTimeoutMs:15});client.start();await until(()=>Socket.all.length===2);Socket.all[1].open();assert.equal(client.state,'connected');});
test('error without close is retried; stopped client ignores old open event',async t=>{const {client}=harness(t);client.start();Socket.all[0].onerror();await until(()=>Socket.all.length===2);const last=Socket.all[1];client.stop();last.open();await sleep(20);assert.equal(client.state,'stopped');assert.equal(Socket.all.length,2);});
