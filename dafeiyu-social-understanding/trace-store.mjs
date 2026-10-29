import {appendFileSync,existsSync,readFileSync,renameSync,statSync} from 'node:fs';
export function createTraceStore(file,{maxBytes=4*1024*1024,maxItems=500}={}){
  const records=new Map();
  function remember(record){records.delete(record.id);records.set(record.id,record);while(records.size>maxItems)records.delete(records.keys().next().value);}
  if(file){for(const path of [file+'.previous',file]){if(!existsSync(path))continue;const size=statSync(path).size;if(size>maxBytes+100000)continue;for(const line of readFileSync(path,'utf8').split('\n')){try{const r=JSON.parse(line);if(r.id)remember(r);}catch{}}}}
  return {
    put(record){
      const next={...record,updatedAt:new Date().toISOString()};
      if(file){const encoded=JSON.stringify(next)+'\n';if(Buffer.byteLength(encoded)>100000)throw Error('diagnostic record too large');if(existsSync(file)&&statSync(file).size+Buffer.byteLength(encoded)>maxBytes)renameSync(file,file+'.previous');appendFileSync(file,encoded,{mode:0o600});}
      remember(next);return next;
    },
    get(id){return records.get(id);},
    list(limit=150){return [...records.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,limit);},
  };
}
