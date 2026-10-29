import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTraceStore} from './trace-store.mjs';
test('trace rotation preserves latest state across reloads and bounds file size',t=>{const dir=mkdtempSync(join(tmpdir(),'dafeiyu-traces-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'traces.jsonl'),s=createTraceStore(file,{maxBytes:1000,maxItems:5});for(let i=0;i<15;i++)s.put({id:String(i),createdAt:new Date(1700000000000+i).toISOString(),input:'x'.repeat(160)});assert.equal(s.list(100).length,5);assert.ok(existsSync(file+'.previous'));assert.ok(statSync(file).size<=1000);const again=createTraceStore(file,{maxBytes:1000,maxItems:5});assert.equal(again.list()[0].id,'14');});
