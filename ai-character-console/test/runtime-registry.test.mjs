import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeRegistry} from '../lib/runtime-registry.mjs';
const base={baseUrl:'http://127.0.0.1:63483',napcatUrl:'http://127.0.0.1:6098',botDir:'/run/cohabit-console/claude-bot-data',credentialName:'claude-napcat-webui'};
const build=cfg=>createRuntimeRegistry({store:{get:()=>({id:'claude'}),setting:()=>JSON.stringify({claude:cfg})},dsh:{},napcat:{},credentialsDirectory:'/run/credentials/test'});
test('runtime registrations reject reused gateways, log paths and credentials',()=>{for(const patch of [{baseUrl:'http://127.0.0.1:63482'},{napcatUrl:'http://127.0.0.1:6099'},{botDir:'/run/cohabit-console/bot-data'},{credentialName:'napcat-webui'},{baseUrl:'https://external.example'},{botDir:'/srv/dsh/plugins-data/aurabot'}])assert.throws(()=>build({...base,...patch}));const r=build(base);assert.equal(r.get('claude').dsh.botDir,base.botDir);assert.equal(r.get('claude').napcat.file,'/run/credentials/test/claude-napcat-webui');});
