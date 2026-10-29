import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.dir = dir;
    const keyFile = join(dir, 'encryption.key');
    if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyFile);
    this.db = new DatabaseSync(join(dir, 'console.sqlite'));
    chmodSync(join(dir, 'console.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, color TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', persona TEXT NOT NULL DEFAULT '', qq_account TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}', secret TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_qq ON characters(qq_account) WHERE qq_account <> '';
      CREATE TABLE IF NOT EXISTS revisions (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), session_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, character_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trace_feedback (character_id TEXT NOT NULL REFERENCES characters(id), trace_id TEXT NOT NULL, label TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(character_id,trace_id));
      CREATE TABLE IF NOT EXISTS runtime_changes (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), kind TEXT NOT NULL, title TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    if (!this.db.prepare('SELECT id FROM characters LIMIT 1').get()) this.seed();
  }
  seal(text) {
    if (!text) return null;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), value]).toString('base64');
  }
  unseal(value) {
    if (!value) return '';
    const b = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12,28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
  seed() {
    const defaults = [
      ['dafeiyu','大肥鱼','dsh','blue','住在 QQ 里的大肥鱼，有自己的心情与日常。','2708089138',{model:'deepseek-v4.1-flash',baseUrl:'http://127.0.0.1:8377/v1',protocol:'chat-completions'}],
      ['gemini','Gemini','gemini','violet','独立的身份与记忆，等待建立连接。','',{model:'',baseUrl:'https://generativelanguage.googleapis.com/v1beta',protocol:'gemini'}],
      ['grok','Grok','grok','orange','独立的身份与记忆，等待建立连接。','',{model:'',baseUrl:'https://api.x.ai/v1',protocol:'responses'}],
      ['chatgpt','ChatGPT','openai','green','独立的身份与记忆，等待建立连接。','',{model:'',baseUrl:'https://api.openai.com/v1',protocol:'responses'}]
    ];
    for (const [id,name,provider,color,summary,qq,config] of defaults) this.create({id,name,provider,color,summary,qqAccount:qq,config}, false);
  }
  map(row) {
    if (!row) return null;
    const {secret,qq_account,created_at,updated_at,...c}=row;
    return {...c,qqAccount:qq_account,createdAt:created_at,updatedAt:updated_at,config:JSON.parse(c.config),hasKey:!!secret};
  }
  get(id) { return this.map(this.db.prepare('SELECT * FROM characters WHERE id=?').get(id)); }
  list() { return this.db.prepare('SELECT * FROM characters ORDER BY created_at, rowid').all().map(r=>this.map(r)); }
  credential(id) { return this.unseal(this.db.prepare('SELECT secret FROM characters WHERE id=?').get(id)?.secret); }
  create(c, audit=true) {
    const id=c.id||randomUUID(), at=new Date().toISOString();
    this.db.prepare('INSERT INTO characters(id,name,provider,color,summary,persona,qq_account,config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,c.name,c.provider,c.color||'blue',c.summary||'',c.persona||'',c.qqAccount||'',JSON.stringify(c.config||{}),at,at);
    if(audit)this.audit(id,'角色已创建',c.name);
    return this.get(id);
  }
  update(id, patch, expected) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.get(id); if(!old)throw Object.assign(Error('角色不存在'),{status:404});
      if(expected!==old.version)throw Object.assign(Error('配置已被修改，请刷新后重试'),{status:409});
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(randomUUID(),id,old.version,JSON.stringify(old),new Date().toISOString());
      const next={...old,...patch,config:{...old.config,...patch.config}};
      let secret=this.db.prepare('SELECT secret FROM characters WHERE id=?').get(id).secret;
      if(patch.apiKey!==undefined && patch.apiKey!=='')secret=this.seal(patch.apiKey);
      if(patch.clearKey===true)secret=null;
      this.db.prepare('UPDATE characters SET name=?,summary=?,persona=?,qq_account=?,config=?,secret=?,version=version+1,updated_at=? WHERE id=?').run(next.name,next.summary,next.persona,next.qqAccount,JSON.stringify(next.config),secret,new Date().toISOString(),id);
      this.audit(id,'角色配置已保存','版本 '+(old.version+1));
      this.db.exec('COMMIT'); return this.get(id);
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  revisions(id) {return this.db.prepare('SELECT id,version,created_at FROM revisions WHERE character_id=? ORDER BY created_at DESC LIMIT 30').all(id);}
  revision(id,rid) {const r=this.db.prepare('SELECT snapshot FROM revisions WHERE id=? AND character_id=?').get(rid,id);return r?JSON.parse(r.snapshot):null;}
  beginRuntimeChange(id,kind,title,before,after) {
    const rid=randomUUID();
    this.db.prepare('INSERT INTO runtime_changes VALUES(?,?,?,?,?,?,?,?)').run(rid,id,kind,title,JSON.stringify(before),JSON.stringify(after),'pending',new Date().toISOString());
    return rid;
  }
  finishRuntimeChange(rid,status){this.db.prepare('UPDATE runtime_changes SET status=? WHERE id=?').run(status,rid);}
  runtimeChanges(id){return this.db.prepare('SELECT id,kind,title,status,created_at FROM runtime_changes WHERE character_id=? ORDER BY rowid DESC LIMIT 50').all(id);}
  runtimeChange(id,rid){const r=this.db.prepare('SELECT * FROM runtime_changes WHERE character_id=? AND id=?').get(id,rid);if(!r)return null;const {before_json,after_json,...meta}=r;return {...meta,before:JSON.parse(before_json),after:JSON.parse(after_json)};}
  traceFeedback(id){return this.db.prepare('SELECT trace_id,label,note,updated_at FROM trace_feedback WHERE character_id=? ORDER BY updated_at DESC LIMIT 1000').all(id);}
  saveTraceFeedback(id,traceId,label,note){this.db.prepare('INSERT INTO trace_feedback VALUES(?,?,?,?,?) ON CONFLICT(character_id,trace_id) DO UPDATE SET label=excluded.label,note=excluded.note,updated_at=excluded.updated_at').run(id,traceId,label,note,new Date().toISOString());this.audit(id,'聊天诊断已标注',label);}
  audit(id,action,detail='') {this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),id,action,detail,new Date().toISOString());}
  audits(id) {return (id?this.db.prepare('SELECT * FROM audit WHERE character_id=? ORDER BY rowid DESC LIMIT 80').all(id):this.db.prepare('SELECT * FROM audit ORDER BY rowid DESC LIMIT 80').all());}
  memories(id) {return this.db.prepare('SELECT * FROM memories WHERE character_id=? ORDER BY rowid DESC LIMIT 300').all(id);}
  addMemory(id,text){const m={id:randomUUID(),character_id:id,text,created_at:new Date().toISOString()};this.db.prepare('INSERT INTO memories VALUES(?,?,?,?)').run(m.id,id,text,m.created_at);this.audit(id,'记忆已添加');return m;}
  deleteMemory(id,mid){const r=this.db.prepare('DELETE FROM memories WHERE id=? AND character_id=?').run(mid,id);if(!r.changes)throw Object.assign(Error('记忆不存在'),{status:404});this.audit(id,'记忆已删除');}
  messages(id,sid){return this.db.prepare('SELECT * FROM (SELECT rowid AS n,* FROM messages WHERE character_id=? AND session_id=? ORDER BY rowid DESC LIMIT 40) ORDER BY n').all(id,sid);}
  message(id,sid,role,text){this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(randomUUID(),id,sid,role,text,new Date().toISOString());}
  setting(key,value){if(value!==undefined)this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;}
  close(){this.db.close();}
}
