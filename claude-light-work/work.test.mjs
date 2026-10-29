import test from 'node:test';import assert from 'node:assert/strict';import {createTools} from './index.mjs';import {publicV4} from './download.mjs';
const calls=[];let group=true;
const api={config:()=>({allow:{groups:group?['123']:[]}}),defineTool:x=>x,onebot:async(a,p)=>{calls.push([a,p]);return a==='get_group_file_url'?{url:'https://example.com/file'}:{files:[{file_id:'abc',file_name:'report.txt',file_size:20}]};}};
const tools=createTools(api,{kind:'group',groupId:'123'},{fetchFile:async()=>Buffer.from('report'),extract:async b=>({text:b.toString()})});
test('read only current group files and reject invented file ids',async()=>{await assert.rejects(()=>tools[1].execute({fileId:'other'}));const r=await tools[1].execute({fileId:'abc'});assert.equal(JSON.parse(r.message).text,'report');assert.ok(calls.every(([,p])=>p.group_id===123));});
test('revoked group access applies to existing tool instances',async()=>{group=false;await assert.rejects(()=>tools[0].execute({}));group=true;});
test('download addresses reject private, reserved and IPv6 addresses',()=>{for(const a of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','224.0.0.1'])assert.equal(publicV4(a),false);assert.equal(publicV4('1.1.1.1'),true);});
