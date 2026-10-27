#!/usr/bin/env node
// wb-proxy.mjs — WorkBuddy 免费 deepseek-v4.1-flash 的 OpenAI 兼容反代
//
// 用法:
//   node wb-proxy.mjs login                  # 浏览器扫码/登录一次, 保存 token 到 ~/.wb-proxy/auth.json
//   node wb-proxy.mjs serve [--port 8377] [--key <local-api-key>]
//
// 客户端接入: baseURL=http://127.0.0.1:8377/v1 , apiKey=<local-api-key 或任意值>, model=deepseek-v4.1-flash
// 同时支持 Chat Completions (/v1/chat/completions) 和 Responses (/v1/responses, Codex 用)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.WB_ENDPOINT || 'https://www.workbuddy.ai';
const PREFIX = '/v2/plugin';
const CHAT_URL = `${ENDPOINT}/v2/chat/completions`;
const DEFAULT_MODEL = process.env.WB_DEFAULT_MODEL || 'deepseek-v4.1-flash';
// 别名: 给客户端用的短名字, 映射到上游真实 model id
const ALIASES = {
  'wb-flash': 'deepseek-v4.1-flash',
  'wb-codex': 'gpt-5.3-codex',
  'wb-hy3': 'hy3',
  'wb-step': 'step-5-preview',
  'wb-sg': 'deepseek-v4.1-flash-sg',
  'wb-glm': 'glm-5.3',
  'wb-kimi': 'kimi-k3',
};
function deref(m) {
  return ACTIVE_ALIASES[m] || m;
}
// 强制模型: 设了就把客户端传的 model 全部改写, 客户端填什么都不影响实际调用
const FORCE_MODEL = process.env.WB_FORCE_MODEL || '';
function resolveModel(m) {
  if (FORCE_MODEL) return deref(FORCE_MODEL);
  return m && m !== 'default' ? deref(m) : DEFAULT_MODEL;
}
// WorkBuddy 国际版模型目录
// available 字段来自 2026-10-24 对 personal_free_user 账号的逐个实测：
// 11158 = 该账号类型无权使用；改账号套餐后需重跑 probe-all.mjs 更新
const MODELS = [
  { id: 'deepseek-v4.1-flash',    credits: 'x0.00', free: true,  available: true,  note: 'DeepSeek 旗舰, 1M 上下文, 免费至 2026-11-01' },
  { id: 'hy3',                    credits: 'x0.00', free: true,  available: true,  note: '腾讯混元思考模型, 免费至 2026-11-01' },
  { id: 'step-5-preview',         credits: 'x0.00', free: true,  available: true,  note: '阶跃星辰旗舰, 免费至 2026-10-26' },
  { id: 'gpt-5.3-codex',          credits: 'x0.59', free: false, available: true,  note: 'GPT Codex 线, 免费号可用的最强档' },
  { id: 'deepseek-v4.1-flash-sg', credits: 'x0.03', free: false, available: true,  note: 'DeepSeek 付费通道(新加坡), 限流时的备胎' },
  { id: 'glm-5.3-flash',          credits: 'x0.08', free: false, available: true },
  { id: 'minimax-m3.1-flash',     credits: 'x0.08', free: false, available: true },
  { id: 'hy4-preview',            credits: 'x0.29', free: false, available: true },
  { id: 'fast-model',             credits: 'x0.34', free: false, available: true,  note: 'Fast 别名' },
  { id: 'kimi-k2.6',              credits: 'x0.52', free: false, available: true },
  { id: 'balanced-model',         credits: 'x0.59', free: false, available: true,  note: 'Balanced 别名' },
  { id: 'glm-5.3',                credits: 'x0.69', free: false, available: true },
  { id: 'kimi-k2.8-preview',      credits: 'x0.77', free: false, available: true },
  { id: 'glm-5.2',                credits: 'x0.79', free: false, available: true },
  { id: 'kimi-k3',                credits: 'x1.62', free: false, available: true },
  { id: 'default-model',          credits: '',      free: false, available: true,  note: 'Auto 别名, 由平台路由' },
  // 以下对 personal_free_user 返回 11158 (not allowed for user type)，付费套餐可用
  { id: 'gpt-6-luna',             credits: 'x0.07', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-5.6-luna',           credits: 'x0.14', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gemini-3.8-flash',       credits: 'x0.95', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gemini-3.5-flash',       credits: 'x0.99', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-6.1-sol',            credits: 'x1.33', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-6-sol',              credits: 'x1.33', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-5.6-terra',          credits: 'x1.39', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-5.4',                credits: 'x1.65', free: false, available: false, note: '11158 免费号无权' },
  { id: 'grok-4.7',               credits: 'x1.90', free: false, available: false, note: '11158 免费号无权' },
  { id: 'primary-model',          credits: 'x3.31', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-5.5',                credits: 'x3.31', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-5.6-sol',            credits: 'x3.47', free: false, available: false, note: '11158 免费号无权' },
  { id: 'gpt-6-astra',            credits: 'x6.67', free: false, available: false, note: '11158 免费号无权' },
];
// 国内版（workbuddy.cn）模型目录 —— 与海外版完全不同的清单
const CN_MODELS = [
  { id: 'hy3',                    credits: 'x0.00', free: true,  available: true, note: '混元思考模型，国内唯一 x0.00' },
  { id: 'deepseek-v4.1-flash',    credits: 'x0.11', free: false, available: true, note: '国内为收费档（海外免费）' },
  { id: 'deepseek-v4-pro',        credits: 'x0.51', free: false, available: true, note: '国内独有旗舰' },
  { id: 'deepseek-v4-flash',      credits: 'x0.17', free: false, available: true },
  { id: 'glm-5.3',                credits: 'x0.69', free: false, available: true },
  { id: 'glm-5.3-flash',          credits: 'x0.08', free: false, available: true },
  { id: 'glm-5.2',                credits: 'x0.79', free: false, available: true },
  { id: 'kimi-k3.1-pro',          credits: 'x0.97', free: false, available: true, note: 'Kimi 最高档' },
  { id: 'kimi-k3-1',              credits: 'x1.62', free: false, available: true },
  { id: 'kimi-k2.8-preview',      credits: 'x0.77', free: false, available: true },
  { id: 'minimax-m3',             credits: 'x0.25', free: false, available: true },
  { id: 'minimax-m3.1-flash',     credits: 'x0.08', free: false, available: true },
  { id: 'mimo-v2.6-pro',          credits: 'x0.18', free: false, available: true },
  { id: 'hy4-preview',            credits: 'x0.29', free: false, available: true },
  { id: 'step-5-preview',         credits: 'x0.43', free: false, available: true },
  { id: 'auto',                   credits: '',       free: false, available: true, note: '平台自动路由' },
];
const CN_ALIASES = {
  'cn-free': 'hy3',
  'cn-flash': 'deepseek-v4.1-flash',
  'cn-pro': 'deepseek-v4-pro',
  'cn-glm': 'glm-5.3',
  'cn-kimi': 'kimi-k3.1-pro',
};

// 端点决定用哪套目录/别名
const IS_CN = /workbuddy\.cn/i.test(ENDPOINT);
const ACTIVE_MODELS = IS_CN ? CN_MODELS : MODELS;
const ACTIVE_ALIASES = IS_CN ? CN_ALIASES : ALIASES;

const AUTH_DIR = path.join(os.homedir(), '.wb-proxy');
const AUTH_FILE = process.env.WB_AUTH_FILE || path.join(AUTH_DIR, 'auth.json');
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 对端实例（另一个 endpoint 的 wb-proxy），用于控制台聚合展示
// 国服实例默认指向国际版（经 SSH 隧道），国际版实例默认不设对端
const PEER_LABEL = process.env.WB_PEER_LABEL || (IS_CN ? '国际版' : '国服');
const PEER_URL = process.env.WB_PEER || (IS_CN ? 'http://127.0.0.1:8377' : '');
const CONSOLE_DIR = path.join(ROOT_DIR, 'console');

// ---------------- 弹性网络层 ----------------
// 本机若有 fake-ip 模式 VPN(Clash/Surge 等), 系统 DNS 会返回 198.18.x.x 假地址,
// 依赖 VPN 隧道转发; 隧道故障时自动改用公共 DoH 解析真实 IP 直连。

const dohCache = new Map();

async function dohResolve(host) {
  if (dohCache.has(host)) return dohCache.get(host);
  const res = await fetch(`https://223.5.5.5/resolve?name=${host}&type=A`, { signal: AbortSignal.timeout(5000) });
  const j = await res.json();
  const ip = j?.Answer?.find(a => a.type === 1)?.data;
  if (!ip) throw new Error('DoH 解析失败: ' + host);
  dohCache.set(host, ip);
  return ip;
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}, forcedIp = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { method, headers };
    if (forcedIp) {
      opts.servername = u.hostname;
      opts.lookup = (_h, _o, cb) => cb(null, forcedIp, 4);
    }
    const req = https.request(urlStr, opts, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resilientRequest(urlStr, opts = {}) {
  try {
    return await httpsRequest(urlStr, opts);
  } catch (e) {
    const host = new URL(urlStr).hostname;
    const ip = await dohResolve(host).catch(() => null);
    if (!ip) throw e;
    return httpsRequest(urlStr, opts, ip);
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function apiJson(method, p, { body, headers = {} } = {}) {
  const res = await resilientRequest(`${ENDPOINT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await readAll(res);
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.statusCode, json };
}

// 逐条解析 SSE data: 事件
async function* sseEvents(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        yield ev;
      }
    }
  }
}

// ---------------- auth ----------------

function loadAuth(file = AUTH_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function saveAuth(a, file = AUTH_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(a, null, 2), { mode: 0o600 });
}

async function login(targetFile = AUTH_FILE, label = '') {
  const { json } = await apiJson('POST', `${PREFIX}/auth/state?platform=CLI`, { body: {} });
  const d = json?.data;
  if (!d?.authUrl || !d?.state) { console.error('获取 authUrl 失败:', JSON.stringify(json)); process.exit(1); }
  if (label) console.log(`\n[${label}] 请用浏览器打开下面链接, 登录对应的 WorkBuddy 账号:\n`);
  else console.log('\n请用浏览器打开下面链接, 登录你的 WorkBuddy 账号(与桌面 App 同一账号):\n');
  console.log('  ' + d.authUrl + '\n');
  exec(`open ${JSON.stringify(d.authUrl)}`);
  console.log('等待登录完成(最长 10 分钟)...');
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const { json: t } = await apiJson('GET', `${PREFIX}/auth/token?state=${d.state}`);
    const data = t?.data?.data ?? t?.data;
    if (data?.accessToken) {
      const auth = { ...data, savedAt: Date.now() };
      if (!auth.expiresAt && auth.expiresIn) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
      saveAuth(auth, targetFile);
      console.log(`\n登录成功! token 已保存到 ${targetFile}`);
      return;
    }
    if (t?.code && t.code !== 11217) { console.error('登录失败:', JSON.stringify(t)); process.exit(1); }
    process.stdout.write('.');
  }
  console.error('\n登录超时'); process.exit(1);
}

async function refreshIfNeeded(auth, file = AUTH_FILE) {
  if (!auth?.refreshToken) return auth;
  const expiresAt = auth.expiresAt ?? 0;
  if (Date.now() < expiresAt - 120_000) return auth; // 还有 2 分钟以上
  console.log('[auth] accessToken 快过期, 刷新中...');
  const { status, json } = await apiJson('POST', `${PREFIX}/auth/token/refresh`, {
    body: {},
    headers: { 'X-Refresh-Token': auth.refreshToken, Authorization: `Bearer ${auth.accessToken}` },
  });
  const data = json?.data?.data ?? json?.data;
  if (status === 200 && data?.accessToken) {
    const next = { ...auth, ...data, savedAt: Date.now() };
    if (next.expiresIn) next.expiresAt = Date.now() + next.expiresIn * 1000;
    saveAuth(next, file);
    console.log('[auth] 刷新成功');
    return next;
  }
  console.error('[auth] 刷新失败, 沿用旧 token:', status, JSON.stringify(json).slice(0, 300));
  return auth;
}

// ---------------- 账号池 ----------------
// 扫描 AUTH_DIR 下所有 auth*.json 作为可用账号; 单账号时行为与旧版一致。
// 切号策略:
//   - 429(限流)       → 该号冷却 60s, 立刻换号重试
//   - 额度耗尽类错误   → 该号标记 exhausted 到额度重置时间, 换号
//   - 401             → 先刷新 token, 失败则换号
// 额度未知的号按"可用"处理, 首次使用时顺手探测一次。

const POOL_COOLDOWN_MS = Number(process.env.WB_POOL_COOLDOWN_MS || 60_000);
const POOL_MIN_CREDITS = Number(process.env.WB_POOL_MIN_CREDITS || 5);
const poolState = new Map(); // file -> { id, cooldownUntil, exhaustedUntil, lastError, credits, creditsAt, inFlight }

// 账号所属端点：从 JWT 的 iss 判断，避免国际版/国服凭据互相串池
const EXPECTED_HOST = new URL(ENDPOINT).hostname.replace(/^www\./, '');

function tokenIssuer(file) {
  const auth = loadAuth(file);
  if (!auth?.accessToken) return '';
  try {
    return JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).iss || '';
  } catch { return ''; }
}

function listAccountFiles() {
  const files = [];
  try {
    for (const f of fs.readdirSync(AUTH_DIR)) {
      if (/^auth.*\.json$/.test(f)) files.push(path.join(AUTH_DIR, f));
    }
  } catch {}
  if (fs.existsSync(AUTH_FILE) && !files.includes(AUTH_FILE)) files.unshift(AUTH_FILE);

  // 只保留签发域与当前 endpoint 一致的凭据
  const kept = files.filter((f) => {
    const iss = tokenIssuer(f);
    if (!iss) return true;
    return iss.includes(EXPECTED_HOST);
  });

  return kept.sort((a, b) => (a === AUTH_FILE ? -1 : b === AUTH_FILE ? 1 : a.localeCompare(b)));
}

function poolEntry(file) {
  let st = poolState.get(file);
  if (!st) {
    st = {
      id: path.basename(file, '.json'),
      file,
      cooldownUntil: 0,
      exhaustedUntil: 0,
      lastError: '',
      credits: null,
      creditsAt: 0,
      inFlight: 0,
      used: 0,
      ok: 0,
      fail: 0,
    };
    poolState.set(file, st);
  }
  return st;
}

function listAccounts() {
  const allFiles = listAccountFiles();
  const { dropped } = dedupeBySub(allFiles);
  return allFiles.map((f) => {
    const st = poolEntry(f);
    const auth = loadAuth(f);
    let account = '';
    let sub = '';
    try {
      const pj = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8'));
      account = pj.preferred_username || pj.email || '';
      sub = pj.sub || '';
    } catch {}
    const now = Date.now();
    return {
      sub,
      duplicate: dropped.includes(f),
      id: st.id,
      account,
      file: f,
      has_token: !!auth?.accessToken,
      credits: st.credits,
      credits_at: st.creditsAt || null,
      cooldown_s: Math.max(0, Math.ceil((st.cooldownUntil - now) / 1000)),
      exhausted_s: Math.max(0, Math.ceil((st.exhaustedUntil - now) / 1000)),
      last_error: st.lastError,
      used: st.used,
      ok: st.ok,
      fail: st.fail,
      healthy: !!auth?.accessToken && st.cooldownUntil <= now && st.exhaustedUntil <= now
        && (st.credits === null || st.credits >= POOL_MIN_CREDITS),
    };
  });
}

async function refreshAccountCredits(file) {
  const st = poolEntry(file);
  const auth = loadAuth(file);
  if (!auth?.accessToken) { st.credits = 0; return; }
  try {
    const headers = { Authorization: `Bearer ${auth.accessToken}`, ...officialClientHeaders() };
    const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
    if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));
    const { status, json } = await apiJson('POST', '/billing/meter/get-user-resource', { body: {}, headers });
    if (status === 200 && json?.code === 0) {
      const accs = json?.data?.Response?.Data?.Accounts || [];
      const total = accs
        .filter(a => Number(a.CapacityRemain || 0) > 0)
        .reduce((s, a) => s + Number(a.CapacityRemain || 0), 0);
      st.credits = total;
      st.creditsAt = Date.now();
    }
  } catch {}
}

function accountSub(file) {
  const auth = loadAuth(file);
  if (!auth?.accessToken) return '';
  try {
    return JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')).sub || '';
  } catch { return ''; }
}

// 同一账号(sub 相同)只算一个号: 多份文件只是多个会话, 额度不叠加
function dedupeBySub(files) {
  const seen = new Set();
  const out = [];
  const dropped = [];
  for (const f of files) {
    const sub = accountSub(f);
    if (sub && seen.has(sub)) { dropped.push(f); continue; }
    if (sub) seen.add(sub);
    out.push(f);
  }
  return { files: out, dropped };
}

function pickAccount(exclude = new Set()) {
  const now = Date.now();
  const { files } = dedupeBySub(listAccountFiles().filter(f => !exclude.has(f)));
  const cands = [];
  for (const f of files) {
    const st = poolEntry(f);
    const auth = loadAuth(f);
    if (!auth?.accessToken) continue;
    if (st.cooldownUntil > now) continue;
    if (st.exhaustedUntil > now) continue;
    // 已知额度低于门槛的直接跳过，不必等请求失败
    if (st.credits !== null && st.credits < POOL_MIN_CREDITS) continue;
    cands.push(st);
  }

  if (process.env.WB_POOL_DEBUG) console.log('[pick] files=', files.length, 'cands=', cands.length, 'exclude=', [...exclude]);
  if (!cands.length) return null;

  cands.sort((a, b) => {
    // 1) 已知余额的优先(降序)；余额未知的排在后面，避免新号抢占
    const av = a.credits ?? -1;
    const bv = b.credits ?? -1;
    if (av !== bv) return bv - av;
    // 2) 再按并发数少的
    if (a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
    // 3) 再按用得少的
    return a.used - b.used;
  });

  const chosen = cands[0];
  if (chosen.credits === null && now - chosen.creditsAt > 120_000) {
    refreshAccountCredits(chosen.file).catch(() => {});
  }
  return chosen;
}

// 判断上游失败是否属于"该换号"
function classifyFailure(status, text) {
  const t = String(text || '');
  if (/14017|trial version is not yet activated/i.test(t)) return 'trial';
  if (/quota|insufficient|balance|额度|超出|exceeded/i.test(t)) return 'quota';
  if (/11158|not allowed for user type/i.test(t)) return 'permission';
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 402 || status === 403) return 'quota';
  return 'other';
}

async function withPool(fn, { retries = 3 } = {}) {
  const tried = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    const st = pickAccount(tried);
    if (process.env.WB_POOL_DEBUG) console.log('[pool] attempt', attempt, 'picked=', st?.id || 'none');
    if (!st) break;
    tried.add(st.file);

    let auth = loadAuth(st.file);
    auth = await refreshIfNeeded(auth, st.file);
    st.inFlight++;
    st.used++;
    try {
      const up = await fn(auth, st);
      if (process.env.WB_POOL_DEBUG) console.log('[pool] upstream status=', up?.status, 'ok=', up?.ok);
      if (up.ok) {
        st.ok++;
        st.fail = Math.max(0, st.fail - 1);
        return { up, account: st.id };
      }

      const text = await up.text().catch(() => '');
      const kind = classifyFailure(up.status, text);

      if (kind === 'rate_limit' || kind === 'trial') {
        st.cooldownUntil = Date.now() + POOL_COOLDOWN_MS;
        st.lastError = `${up.status} ${kind}`;
      } else if (kind === 'auth') {
        auth.expiresAt = 0;
        saveAuth(auth, st.file);
        const refreshed = await refreshIfNeeded(loadAuth(st.file), st.file);
        if (!refreshed?.accessToken) {
          st.cooldownUntil = Date.now() + POOL_COOLDOWN_MS * 5;
          st.lastError = '401 refresh failed';
        }
      } else if (kind === 'quota') {
        // 账号级余额耗尽：整个账号拉黑 1 小时
        st.exhaustedUntil = Date.now() + 3600_000;
        st.credits = 0;
        st.lastError = `${up.status} ${kind}`;
      } else if (kind === 'permission') {
        // 11158 是「该账号类型无权使用这个模型」，属于模型级限制，
        // 不是账号级配额耗尽：绝不能拉黑账号或把 credits 置 0，
        // 否则测一个不可用模型就会废掉整个账号池（实测踩过）。
        // 只记录模型级黑名单，换模型即可恢复。
        st.deniedModels ??= new Set();
        st.lastError = `${up.status} ${kind} (model denied)`;
      } else {
        st.lastError = `${up.status} ${kind}`;
      }

      st.fail++;
      lastError = { status: up.status, text, kind, account: st.id };
      console.log(`[pool] ${st.id} 失败(${kind} ${up.status})，切换下一账号`);
    } catch (e) {
      st.fail++;
      st.lastError = e.message;
      lastError = { status: 0, text: e.message, kind: 'network', account: st.id };
      console.log(`[pool] ${st.id} 网络异常，切换下一账号: ${e.message}`);
    } finally {
      st.inFlight = Math.max(0, st.inFlight - 1);
    }
  }

  return {
    error: lastError || {
      status: 0,
      text: 'no available account in pool',
      kind: 'no_account',
      account: '',
    },
  };
}

// ---------------- 公共 ----------------

const DEFAULT_SYSTEM_PROMPT = process.env.WB_SYSTEM_PROMPT || 'You are a helpful assistant.';

// 从 JWT 里解出用户 id (sub), 网关头要求 X-User-Id
function jwtSub(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).sub || null;
  } catch { return null; }
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

// ---------------- 调用埋点 (任意客户端) ----------------
// 设计: 网关出入口不区分调用方, 所有经 /v1/chat/completions 与 /v1/responses
// 的请求都落一条记录。平台靠 UA / 自定义头 / Referer / Origin 指纹推断,
// token 靠拦 SSE 里的 usage 事件 (上游只在流末尾给一次)。
const CALLS_FILE = process.env.WB_CALLS_FILE || path.join(ROOT_DIR, 'logs', 'calls.jsonl');
const CALLS_MAX_BYTES = 5 * 1024 * 1024;
const CALLS_KEEP = 5000;  // 内存里保留的最近条数
const callLog = [];        // 运行期环形缓冲, /v1/calls 直接读它

function ensureLogsDir() {
  try { fs.mkdirSync(path.dirname(CALLS_FILE), { recursive: true }); } catch {}
}

function rotateCallsIfNeeded() {
  try {
    const st = fs.statSync(CALLS_FILE);
    if (st.size > CALLS_MAX_BYTES) fs.renameSync(CALLS_FILE, `${CALLS_FILE}.1`);
  } catch {}
}

function appendCallRecord(rec) {
  ensureLogsDir();
  rotateCallsIfNeeded();
  try { fs.appendFileSync(CALLS_FILE, JSON.stringify(rec) + '\n'); } catch {}
  callLog.push(rec);
  if (callLog.length > CALLS_KEEP) callLog.splice(0, callLog.length - CALLS_KEEP);
}

// 启动时把历史读回内存, 控制台重启后趋势不丢
function loadCallLog() {
  try {
    const raw = fs.readFileSync(CALLS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-CALLS_KEEP);
    for (const l of lines) {
      try { callLog.push(JSON.parse(l)); } catch {}
    }
  } catch {}
}

// 平台指纹: 按特异性从高到低匹配, 命中即停
const UA_RULES = [
  // DSH / pi-ai: 走 OpenAI SDK 风格 UA, 靠自定义头兜底
  { re: /deepseek[- _]?harness|dsh\//i, name: 'DSH' },
  { re: /codex/i, name: 'Codex' },
  { re: /claude[- _]?code|anthropic/i, name: 'ClaudeCode' },
  { re: /cursor/i, name: 'Cursor' },
  { re: /cline/i, name: 'Cline' },
  { re: /continue\.dev|continue\//i, name: 'Continue' },
  { re: /windsurf|codeium/i, name: 'Windsurf' },
  { re: /roo[- _]?code/i, name: 'RooCode' },
  { re: /zed/i, name: 'Zed' },
  { re: /aider/i, name: 'Aider' },
  { re: /cherry[- _]?studio/i, name: 'CherryStudio' },
  { re: /cline|librechat|open[- _]?webui/i, name: 'WebUI' },
  { re: /node[- ]?fetch|undici|axios|got \(|node\.js|^node$|node v?\d/i, name: 'Node' },
  { re: /python|httpx|openai\/|aiohttp|requests\//i, name: 'Python' },
  { re: /okhttp|java\//i, name: 'Java' },
  { re: /curl\//i, name: 'curl' },
  { re: /postman/i, name: 'Postman' },
  { re: /mozilla\/5\.0.*chrome/i, name: 'Browser' },
  { re: /mozilla\/5\.0/i, name: 'Browser' },
  { re: /^$/, name: 'Unknown' },
];

// 谁更容易暴露自己: 显式头 > UA > Referer。返回 {platform, via}
function detectPlatform(headers = {}) {
  const hdr = (k) => String(headers[k] ?? headers[k.toLowerCase()] ?? '');
  const explicit = [
    ['x-client-name', 'x-client'],
    ['x-app-name', 'x-app'],
    ['x-platform', 'x-platform'],
    ['x-tool', 'x-tool'],
  ];
  for (const [k, tag] of explicit) {
    const v = hdr(k).trim();
    if (v) return { platform: v.slice(0, 32), via: tag };
  }
  const ua = hdr('user-agent').trim();
  for (const r of UA_RULES) {
    if (r.re.test(ua)) {
      // 浏览器里跑的是控制台测试台, 单独标出来
      const ref = hdr('referer');
      if (r.name === 'Browser' && /\/console/.test(ref)) return { platform: 'Console', via: 'referer' };
      return { platform: r.name, via: 'ua' };
    }
  }
  const ref = hdr('referer') || hdr('origin');
  if (ref) return { platform: 'HTTP:' + (() => { try { return new URL(ref).hostname; } catch { return 'ref'; } })(), via: 'referer' };
  return { platform: 'Unknown', via: 'none' };
}

// 把各种形态的错误压成一行可读文本（含 pool 的 {status,text,kind,account} 结构体）
function errText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object') {
    const parts = [];
    if (e.kind) parts.push(e.kind);
    if (e.status) parts.push(`http ${e.status}`);
    if (e.text) parts.push(String(e.text).slice(0, 200));
    if (e.account) parts.push(`acct ${e.account}`);
    if (parts.length) return parts.join(' / ');
    try { return JSON.stringify(e).slice(0, 300); } catch { return String(e); }
  }
  return String(e);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function countChars(v) {
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((s, x) => s + countChars(x?.text ?? x?.content ?? x), 0);
  return 0;
}

// 粗估入参 token: 中英混排按 2.2 字符/token。只用于上游没回 usage 时兜底
function estimateTokens(messages = []) {
  let chars = 0;
  for (const m of messages) {
    chars += countChars(m?.content);
    for (const tc of m?.tool_calls || []) chars += countChars(tc?.function?.arguments);
  }
  return Math.round(chars / 2.2);
}

// SSE 透传时的 usage 提取器: 边转发边嗅探, 不改写任何字节
function usageSniffer() {
  // credit 随流增量下发(前面几条 events 是 0, 最后一条才是真实扣减), 必须取最后一个非零值
  const s = { usage: null, credit: null, firstByteAt: null, bytes: 0, chunks: 0, model: null, error: null };
  let buf = '';
  s.transform = new Transform({
    transform(chunk, _enc, cb) {
      if (s.firstByteAt === null) s.firstByteAt = Date.now();
      s.bytes += chunk.length;
      s.chunks++;
      buf += chunk.toString('utf8');
      // 只保留尾部, 防止无限增长
      if (buf.length > 65536) buf = buf.slice(-32768);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (!p || p === '[DONE]') continue;
          try {
            const ev = JSON.parse(p);
            if (ev.model) s.model = ev.model;
            if (ev.usage) {
              s.usage = ev.usage;
              const c = Number(ev.usage.credit);
              if (Number.isFinite(c) && c > 0) s.credit = (s.credit ?? 0) + c;
            }
            if (ev.error) s.error = ev.error?.message || JSON.stringify(ev.error).slice(0, 200);
          } catch {}
        }
      }
      cb(null, chunk);
    },
  });
  return s;
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': contentType });
  res.end(text);
}

function sendFile(res, filePath, contentType = 'text/plain; charset=utf-8') {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    sendText(res, 200, content, contentType);
  } catch {
    sendJson(res, 404, { error: { message: 'not found' } });
  }
}

// 模拟官方 WorkBuddy CLI 客户端的完整请求头(从 CODEBUDDY_BASE_URL 抓包获得),
// 网关按渠道分配限流桶, 裸请求会被当成外部调用更容易 429
const CLIENT_VERSION = '2.156.0';
const CONVERSATION_ID = crypto.randomUUID(); // 每个代理进程一个会话 id
function officialClientHeaders() {
  const msgId = crypto.randomUUID().replace(/-/g, '');
  const convReqId = crypto.randomUUID().replace(/-/g, '');
  return {
    'User-Agent': `CLI/${CLIENT_VERSION} WorkBuddy AI/${CLIENT_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CLIENT_VERSION,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-CodeBuddy-Request': '1',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Domain': new URL(ENDPOINT).hostname,
    'X-Conversation-ID': CONVERSATION_ID,
    'X-Request-ID': msgId,
    'X-Conversation-Message-ID': msgId,
    'X-Conversation-Request-ID': convReqId,
    'X-Root-Request-ID': convReqId,
  };
}

async function callUpstream(auth, upstreamBody) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'text/event-stream',
    ...officialClientHeaders(),
  };
  const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
  if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));
  if (process.env.WB_DEBUG) {
    fs.writeFileSync(path.join(AUTH_DIR, 'last-request.json'), JSON.stringify(upstreamBody, null, 2));
  }
  const res = await resilientRequest(CHAT_URL, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    stream: res,
    text: () => readAll(res),
  };
}

// 上游只支持流式; 聚合 SSE 成单个 chat.completion 对象
async function collectChatCompletion(stream) {
  let content = '', reasoning = '', id = '', model = DEFAULT_MODEL, created = Math.floor(Date.now() / 1000), usage = null, finish = 'stop';
  const toolCalls = {};
  for await (const ev of sseEvents(stream)) {
    id = ev.id || id; model = ev.model || model; created = ev.created || created;
    if (ev.usage) usage = ev.usage;
    const ch = ev.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const t = toolCalls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) t.id += tc.id;
      if (tc.function?.name) t.function.name += tc.function.name;
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
    }
  }
  const msg = { role: 'assistant', content };
  if (reasoning) msg.reasoning_content = reasoning;
  const tcs = Object.values(toolCalls).filter(t => t.function.name || t.function.arguments);
  if (tcs.length) msg.tool_calls = tcs;
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage };
}

async function fetchCredits(auth) {
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    ...officialClientHeaders(),
  };
  const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
  if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));

  const { status, json } = await apiJson('POST', '/billing/meter/get-user-resource', {
    body: {},
    headers,
  });
  if (status !== 200 || json?.code !== 0) {
    return { ok: false, status, detail: json };
  }
  const data = json?.data?.Response?.Data;
  if (!data) return { ok: false, status, detail: json };

  const accounts = (data.Accounts || []).map((a) => {
    const endMs = a.CycleEndTime ? Date.parse(a.CycleEndTime.replace(' ', 'T') + '+08:00') : NaN;
    const daysLeft = Number.isFinite(endMs) ? Math.ceil((endMs - Date.now()) / 86400000) : null;
    return {
      package_name: a.PackageName,
      remain: Number(a.CapacityRemain || 0),
      size: Number(a.CapacitySize || 0),
      used: Number(a.CapacityUsed || 0),
      unit: a.CapacityUnit || 'credits',
      cycle_start: a.CycleStartTime || '',
      cycle_end: a.CycleEndTime || '',
      expires_in_days: daysLeft,
      expired: daysLeft !== null && daysLeft <= 0,
      expiring_soon: daysLeft !== null && daysLeft > 0 && daysLeft <= 7,
      product: a.SubProductName || '',
    };
  });

  const total_remain = accounts.reduce((sum, a) => sum + a.remain, 0);
  const total_size = accounts.reduce((sum, a) => sum + a.size, 0);
  const expiring = accounts.filter(a => a.expiring_soon || a.expired)
    .map(a => ({ package_name: a.package_name, remain: a.remain, cycle_end: a.cycle_end, expires_in_days: a.expires_in_days }));

  return {
    ok: true,
    summary: {
      total_count: Number(data.TotalCount || accounts.length),
      total_dosage: Number(data.TotalDosage || total_size),
      total_remain,
      total_size,
      expiring,
    },
    accounts,
  };
}

async function fetchCheckin(auth) {
  const headers = { Authorization: `Bearer ${auth.accessToken}`, ...officialClientHeaders() };
  const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
  if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));

  const { status, json } = await apiJson('POST', '/billing/meter/checkin-status', { body: {}, headers });
  if (status !== 200 || json?.code !== 0) return { ok: false, status, detail: json };
  const d = json.data || {};
  return {
    ok: true,
    active: !!d.active,
    today_checked_in: !!d.today_checked_in,
    streak_days: Number(d.streak_days || 0),
    daily_credit: Number(d.daily_credit || 0),
    today_credit: Number(d.today_credit || 0),
    week_progress: d.week_progress || [],
    week_checkin_days: Number(d.week_checkin_days || 0),
    total_credits: Number(d.total_credits || 0),
    start_time: d.start_time || '',
    end_time: d.end_time || '',
    activity_name: d.activity_name || '',
    next_streak_day: Number(d.next_streak_day || 0),
    streak_bonus_days: Number(d.streak_bonus_days || 0),
    streak_bonus_credit: Number(d.streak_bonus_credit || 0),
    claim_button_text: d.claim_button_text || '',
  };
}

async function claimCheckin(auth) {
  const headers = { Authorization: `Bearer ${auth.accessToken}`, ...officialClientHeaders() };
  const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
  if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));

  const { status, json } = await apiJson('POST', '/billing/meter/daily-checkin', { body: {}, headers });
  const code = json?.code ?? null;
  return {
    ok: status === 200 && code === 0,
    http: status,
    code,
    msg: json?.msg || '',
    data: json?.data ?? null,
  };
}

async function handleCheckin(res, doClaim) {
  let auth = loadAuth();
  if (!auth?.accessToken) return sendJson(res, 401, { error: { message: 'proxy 未登录' } });
  auth = await refreshIfNeeded(auth);

  const before = await fetchCheckin(auth);
  if (!before.ok) return sendJson(res, 502, { error: { message: 'checkin status failed', detail: before.detail } });

  if (!doClaim) return sendJson(res, 200, before);

  if (!before.active) {
    return sendJson(res, 200, { ...before, claimed: false, reason: '签到活动未开启（国际版当前无此活动）' });
  }
  if (before.today_checked_in) {
    return sendJson(res, 200, { ...before, claimed: false, reason: '今日已签到' });
  }

  const result = await claimCheckin(auth);
  const after = await fetchCheckin(auth);
  sendJson(res, result.ok ? 200 : 502, {
    ...(after.ok ? after : before),
    claimed: result.ok,
    claim_result: { code: result.code, msg: result.msg, data: result.data },
  });
}

async function handleCredits(res, file = AUTH_FILE) {
  let auth = loadAuth(file);
  if (!auth?.accessToken) return sendJson(res, 401, { error: { message: 'proxy 未登录, 先运行: node wb-proxy.mjs login' } });
  auth = await refreshIfNeeded(auth, file);
  const result = await fetchCredits(auth);
  if (!result.ok) return sendJson(res, 502, { error: { message: 'credits fetch failed', detail: result.detail } });
  const st = poolEntry(file);
  st.credits = result.summary.total_remain;
  st.creditsAt = Date.now();
  sendJson(res, 200, { ...result, account_id: st.id });
}

async function handleAccounts(res) {
  await Promise.all(listAccountFiles().map(f => refreshAccountCredits(f)));
  const accounts = listAccounts();
  sendJson(res, 200, {
    object: 'list',
    count: accounts.length,
    healthy: accounts.filter(a => a.healthy).length,
    min_credits: POOL_MIN_CREDITS,
    cooldown_ms: POOL_COOLDOWN_MS,
    data: accounts,
  });
}

// ---------------- Chat Completions ----------------

async function handleChat(req, res, body, ctx = {}) {
  let inBody;
  try { inBody = JSON.parse(body); } catch { return sendJson(res, 400, { error: { message: 'invalid json body' } }); }

  const wantStream = inBody.stream === true;
  // 网关安全策略: 首条消息必须是 system prompt; 不认 developer 角色, 归一成 system
  const messages = (Array.isArray(inBody.messages) ? inBody.messages : [])
    .map(m => m?.role === 'developer' ? { ...m, role: 'system' } : m);
  if (!messages.length || messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }
  const model = resolveModel(inBody.model);
  const upstreamBody = {
    ...inBody,
    messages,
    model,
    stream: true, // 上游只支持流式
  };

  const t0 = Date.now();
  const base = {
    ts: t0,
    platform: ctx.platform,
    platformVia: ctx.platformVia,
    ua: ctx.ua,
    ip: ctx.ip,
    endpoint: ctx.endpoint,
    model,
    modelRequested: inBody.model || 'default',
    stream: wantStream,
    api: 'chat',
    msgs: messages.length,
    tools: Array.isArray(inBody.tools) ? inBody.tools.length : 0,
    account: ctx.account || null,
  };

  const { up, error, account } = await withPool(auth => callUpstream(auth, upstreamBody));
  if (error || !up) {
    appendCallRecord({ ...base, ok: false, status: 0, ms: Date.now() - t0, err: errText(error).slice(0, 300) });
    return sendJson(res, 502, {
      error: {
        message: `所有账号均不可用（已尝试 ${listAccountFiles().length} 个）`,
        last: error,
      },
    });
  }
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    appendCallRecord({ ...base, account, ok: false, status: up.status, ms: Date.now() - t0, err: text.slice(0, 300) });
    return sendJson(res, up.status, { error: { message: `upstream ${up.status}`, detail: text.slice(0, 2000) } });
  }

  const snif = usageSniffer();
  const finish = (extra = {}) => {
    const u = snif.usage || {};
    const inputTokens = u.prompt_tokens ?? extra.inputTokens;
    const outputTokens = u.completion_tokens ?? extra.outputTokens;
    appendCallRecord({
      ...base,
      account,
      ok: !snif.error,
      status: extra.status || 200,
      ms: Date.now() - t0,
      ttft: snif.firstByteAt ? snif.firstByteAt - t0 : null,
      modelUpstream: snif.model || model,
      inputTokens: inputTokens ?? null,
      outputTokens: outputTokens ?? null,
      totalTokens: u.total_tokens ?? (Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? inputTokens + outputTokens : null),
      estimated: !snif.usage,
      credit: snif.credit,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      bytes: snif.bytes,
      err: snif.error || null,
    });
  };

  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    snif.transform.on('end', () => finish());
    up.stream.pipe(snif.transform).pipe(res);
    up.stream.on('error', () => { finish({ status: 499 }); res.destroy(); });
    req.on('close', () => up.stream.destroy());
  } else {
    const cc = await collectChatCompletion(up.stream);
    const u = cc.usage || {};
    appendCallRecord({ ...base,
      account,
      ok: true, status: 200, ms: Date.now() - t0,
      ttft: null,
      modelUpstream: cc.model || model,
      inputTokens: u.prompt_tokens ?? null,
      outputTokens: u.completion_tokens ?? null,
      totalTokens: u.total_tokens ?? null,
      estimated: !cc.usage,
      credit: Number.isFinite(Number(u.credit)) ? Number(u.credit) : null,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
      reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      bytes: null, err: null });
    sendJson(res, 200, cc);
  }
}

// ---------------- Responses API (Codex 等新版客户端用) ----------------

// Responses 请求 → Chat Completions 请求 (只透传上游认识的字段)
function responsesToChat(inBody) {
  const messages = [];
  if (inBody.instructions) messages.push({ role: 'system', content: String(inBody.instructions) });
  const input = inBody.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingCalls = null; // 连续的 function_call 合并成一条 assistant 消息 (OpenAI 并行工具调用格式)
    const flushCalls = () => {
      if (pendingCalls?.length) messages.push({ role: 'assistant', content: '', tool_calls: pendingCalls });
      pendingCalls = null;
    };
    for (const item of input) {
      if (!item) continue;
      const t = item.type;
      if (t === 'message' || (!t && item.role)) {
        flushCalls();
        // WorkBuddy 网关不认 developer 角色, 归一成 system
        const role = (item.role === 'developer') ? 'system' : (item.role || 'user');
        let parts = item.content;
        if (typeof parts === 'string') { messages.push({ role, content: parts }); continue; }
        if (!Array.isArray(parts)) continue;
        const mapped = [];
        for (const p of parts) {
          if (!p) continue;
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') mapped.push({ type: 'text', text: p.text ?? '' });
          else if (p.type === 'input_image' && p.image_url) mapped.push({ type: 'image_url', image_url: { url: p.image_url } });
          else if (p.type === 'image_url') mapped.push(p);
        }
        if (!mapped.length) continue;
        messages.push({ role, content: mapped.length === 1 && mapped[0].type === 'text' ? mapped[0].text : mapped });
      } else if (t === 'function_call') {
        (pendingCalls ??= []).push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } });
        continue;
      } else if (t === 'function_call_output') {
        flushCalls();
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
      } else {
        flushCalls();
      }
      // reasoning / item_reference 等直接忽略
    }
    flushCalls();
  }
  const chat = { model: resolveModel(inBody.model), messages, stream: true };
  if (typeof inBody.temperature === 'number') chat.temperature = inBody.temperature;
  if (typeof inBody.top_p === 'number') chat.top_p = inBody.top_p;
  if (typeof inBody.max_output_tokens === 'number') chat.max_tokens = inBody.max_output_tokens;
  if (typeof inBody.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = inBody.parallel_tool_calls;
  if (inBody.stop) chat.stop = inBody.stop;
  if (Array.isArray(inBody.tools)) {
    const tools = inBody.tools.filter(t => t?.type === 'function')
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (tools.length) chat.tools = tools;
  }
  if (typeof inBody.tool_choice === 'string') chat.tool_choice = inBody.tool_choice;
  else if (inBody.tool_choice?.type === 'function' && inBody.tool_choice.name) chat.tool_choice = { type: 'function', function: { name: inBody.tool_choice.name } };
  const fmt = inBody.text?.format;
  if (fmt?.type === 'json_object') chat.response_format = { type: 'json_object' };
  else if (fmt?.type === 'json_schema') chat.response_format = { type: 'json_schema', json_schema: { name: fmt.name, schema: fmt.schema, strict: fmt.strict } };
  return chat;
}

function mapUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? 0,
  };
}

// chat.completion 对象 → Responses 响应对象
function chatToResponseObject(cc, status = 'completed') {
  const output = [];
  const msg = cc.choices?.[0]?.message || {};
  if (msg.reasoning_content) {
    output.push({ id: 'rs_' + cc.id, type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  if (msg.content) {
    output.push({ id: 'msg_' + cc.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({ id: 'fc_' + (tc.id || cc.id), type: 'function_call', status: 'completed', call_id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' });
  }
  return {
    id: 'resp_' + cc.id, object: 'response', created_at: cc.created, status,
    model: cc.model, output, parallel_tool_calls: true,
    usage: mapUsage(cc.usage),
  };
}

// 把上游 chat SSE 实时翻译成 Responses SSE 事件流
async function streamChatAsResponses(upStream, res, onDone = null) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let seq = 0;
  const t0 = Date.now();
  let ttft = null;
  const respId = 'resp_' + Math.random().toString(36).slice(2);
  const created = Math.floor(Date.now() / 1000);
  let model = DEFAULT_MODEL, usage = null;
  const items = [];           // 已完成的 output items
  let cur = null;             // 当前打开的 item: {kind:'reasoning'|'message'|'function_call', ...}
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  const respObj = (status) => ({ id: respId, object: 'response', created_at: created, status, model, output: items, parallel_tool_calls: true, usage: mapUsage(usage) });
  const closeCur = () => {
    if (!cur) return;
    if (cur.kind === 'reasoning') {
      send('response.reasoning_summary_text.done', { item_id: cur.id, output_index: cur.index, summary_index: 0, text: cur.text });
      send('response.reasoning_summary_part.done', { item_id: cur.id, output_index: cur.index, summary_index: 0, part: { type: 'summary_text', text: cur.text } });
      send('response.output_item.done', { output_index: cur.index, item: { id: cur.id, type: 'reasoning', summary: [{ type: 'summary_text', text: cur.text }] } });
      items.push({ id: cur.id, type: 'reasoning', summary: [{ type: 'summary_text', text: cur.text }] });
    } else if (cur.kind === 'message') {
      send('response.output_text.done', { item_id: cur.id, output_index: cur.index, content_index: 0, text: cur.text });
      send('response.content_part.done', { item_id: cur.id, output_index: cur.index, content_index: 0, part: { type: 'output_text', text: cur.text, annotations: [] } });
      const item = { id: cur.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: cur.text, annotations: [] }] };
      send('response.output_item.done', { output_index: cur.index, item });
      items.push(item);
    } else if (cur.kind === 'function_call') {
      send('response.function_call_arguments.done', { item_id: cur.id, output_index: cur.index, arguments: cur.args });
      const item = { id: cur.id, type: 'function_call', status: 'completed', call_id: cur.callId, name: cur.name, arguments: cur.args };
      send('response.output_item.done', { output_index: cur.index, item });
      items.push(item);
    }
    cur = null;
  };
  const openReasoning = () => {
    closeCur();
    cur = { kind: 'reasoning', id: 'rs_' + respId + '_' + items.length, index: items.length, text: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'reasoning', summary: [] } });
    send('response.reasoning_summary_part.added', { item_id: cur.id, output_index: cur.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
  };
  const openMessage = () => {
    closeCur();
    cur = { kind: 'message', id: 'msg_' + respId + '_' + items.length, index: items.length, text: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: cur.id, output_index: cur.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const openFunctionCall = (tc) => {
    closeCur();
    cur = { kind: 'function_call', id: 'fc_' + (tc.id || respId + '_' + items.length), index: items.length, callId: tc.id || '', name: '', args: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'function_call', status: 'in_progress', call_id: cur.callId, name: '', arguments: '' } });
  };

  send('response.created', { response: respObj('in_progress') });
  send('response.in_progress', { response: respObj('in_progress') });

  for await (const ev of sseEvents(upStream)) {
    if (ttft === null) ttft = Date.now() - t0;
    model = ev.model || model;
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta || {};
    if (d.reasoning_content) {
      if (cur?.kind !== 'reasoning') openReasoning();
      cur.text += d.reasoning_content;
      send('response.reasoning_summary_text.delta', { item_id: cur.id, output_index: cur.index, summary_index: 0, delta: d.reasoning_content });
    }
    if (d.content) {
      if (cur?.kind !== 'message') openMessage();
      cur.text += d.content;
      send('response.output_text.delta', { item_id: cur.id, output_index: cur.index, content_index: 0, delta: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const isNew = cur?.kind !== 'function_call' || (tc.id && cur.callId && tc.id !== cur.callId);
      if (isNew) openFunctionCall(tc);
      if (tc.id) cur.callId = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      const a = tc.function?.arguments || '';
      if (a) {
        cur.args += a;
        send('response.function_call_arguments.delta', { item_id: cur.id, output_index: cur.index, delta: a });
      }
    }
  }
  closeCur();
  send('response.completed', { response: respObj('completed') });
  res.end();
  if (typeof onDone === 'function') onDone({ usage, model, ttft });
}

async function handleResponses(req, res, body, ctx = {}) {
  let inBody;
  try { inBody = JSON.parse(body); } catch { return sendJson(res, 400, { error: { message: 'invalid json body' } }); }
  const wantStream = inBody.stream === true;
  const chatBody = responsesToChat(inBody);
  if (!chatBody.messages.length || chatBody.messages[0]?.role !== 'system') {
    chatBody.messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }

  const t0 = Date.now();
  const base = {
    ts: t0,
    platform: ctx.platform,
    platformVia: ctx.platformVia,
    ua: ctx.ua,
    ip: ctx.ip,
    endpoint: ctx.endpoint,
    model: chatBody.model,
    modelRequested: inBody.model || 'default',
    stream: wantStream,
    api: 'responses',
    msgs: chatBody.messages.length,
    tools: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0,
    account: ctx.account || null,
  };

  const { up, error, account } = await withPool(auth => callUpstream(auth, chatBody));
  if (error || !up) {
    appendCallRecord({ ...base, ok: false, status: 0, ms: Date.now() - t0, err: errText(error).slice(0, 300) });
    return sendJson(res, 502, {
      error: {
        message: `所有账号均不可用（已尝试 ${listAccountFiles().length} 个）`,
        last: error,
      },
    });
  }
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    appendCallRecord({ ...base, account, ok: false, status: up.status, ms: Date.now() - t0, err: text.slice(0, 300) });
    return sendJson(res, up.status, { error: { message: `upstream ${up.status}`, detail: text.slice(0, 2000) } });
  }

  const record = (u, upstreamModel, ttft) => {
    const c = Number(u?.credit);
    appendCallRecord({ ...base,
      account,
      ok: true, status: 200, ms: Date.now() - t0, ttft: ttft ?? null,
      modelUpstream: upstreamModel || chatBody.model,
      inputTokens: u?.prompt_tokens ?? null,
      outputTokens: u?.completion_tokens ?? null,
      totalTokens: u?.total_tokens ?? null,
      estimated: !u,
      credit: Number.isFinite(c) && c > 0 ? c : null,
      cachedTokens: u?.prompt_tokens_details?.cached_tokens ?? null,
      reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
      bytes: null, err: null });
  };

  if (wantStream) {
    req.on('close', () => up.stream.destroy());
    await streamChatAsResponses(up.stream, res, ({ usage, model, ttft }) => record(usage, model, ttft));
  } else {
    const cc = await collectChatCompletion(up.stream);
    record(cc.usage, cc.model, null);
    sendJson(res, 200, chatToResponseObject(cc));
  }
}

// ---------------- CLIProxyAPI 透明代理 (埋点用) ----------------
// cpa 自身日志只有状态码+耗时, 拿不到模型和 token; management API 也没有用量。
// 所以把 cpa 的 /v1/* 透过 wb-proxy 转发一遍, 复用同一套 SSE 嗅探。
// 客户端只需把 baseURL 从 8317 换成 8377/v1/cpa/proxy。
// ---------------- Grok 引用剥离 ----------------
// Grok Web 会主动联网搜索, 在正文里插 [[1]](url)、[[2]] 这类引用标记,
// 网页端显示成小角标, 但走 API 就是一堆脏字符。上游 WS 协议没有关搜索的参数,
// 所以在代理层做可选的输出清洗。
// 开关: 请求头 X-Grok-Strip-Citations: 1, 或环境变量 GROK_STRIP_CITATIONS=1
const CITE_RE = /\[\[\d+\]\](?:\([^)\s]*\))?/g;

function stripCitations(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(CITE_RE, '').replace(/[ \t]+(?=\n)/g, '').replace(/[ \t]{2,}/g, ' ');
}

// 流式用: [[N]] 可能跨 chunk, 所以遇到 '[' 就缓冲, 直到确认不是引用标记
function citationFilterTransform() {
  let buf = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let out = '';
      while (buf.length) {
        const open = buf.indexOf('[[');
        if (open < 0) {
          // 没有引用起点: 保留尾部可能是半个 '['
          const keep = buf.endsWith('[') ? 1 : 0;
          out += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        out += buf.slice(0, open);
        buf = buf.slice(open);
        // 找闭合 ]]
        const close = buf.indexOf(']]');
        if (close < 0) {
          if (buf.length > 16) { out += buf; buf = ''; }  // 不像引用, 放行
          break;
        }
        let end = close + 2;
        // 可选 (url)
        if (buf[end] === '(') {
          const paren = buf.indexOf(')', end);
          if (paren < 0) { if (buf.length > 512) { out += buf; buf = ''; } break; }
          end = paren + 1;
        }
        const token = buf.slice(0, end);
        if (/^\[\[\d+\]\](\([^)]*\))?$/.test(token)) {
          buf = buf.slice(end);   // 丢弃引用
        } else {
          out += buf.slice(0, 2); // 不是引用, 放行 '[['
          buf = buf.slice(2);
        }
      }
      cb(null, Buffer.from(out, 'utf8'));
    },
    flush(cb) { cb(null, buf ? Buffer.from(buf, 'utf8') : undefined); },
  });
}

function wantsCitationStrip(req) {
  const h = req.headers['x-grok-strip-citations'];
  if (h != null) return !/^(0|false|no)$/i.test(String(h).trim());
  return /^(1|true|yes)$/i.test(String(process.env.GROK_STRIP_CITATIONS || ''));
}

function stripCitationsInJson(text, contentType) {
  if (!/json/.test(contentType || '')) return text;
  try {
    const j = JSON.parse(text);
    let touched = false;
    for (const ch of j?.choices || []) {
      if (typeof ch?.message?.content === 'string') {
        ch.message.content = stripCitations(ch.message.content); touched = true;
      }
      if (typeof ch?.text === 'string') { ch.text = stripCitations(ch.text); touched = true; }
      if (typeof ch?.delta?.content === 'string') {
        ch.delta.content = stripCitations(ch.delta.content); touched = true;
      }
    }
    return touched ? JSON.stringify(j) : text;
  } catch { return text; }
}

async function handleCpaProxy(req, res, body, ctx = {}) {
  // 通用透传: cpa(Antigravity) 与 grok(grok2api) 共用, 靠 ctx 区分
  const upstreamBase = ctx.upstreamBase || process.env.CPA_BASE || 'http://127.0.0.1:8317';
  const provider = ctx.provider || 'cpa';
  const defaultKey = ctx.defaultKey || process.env.CPA_CLIENT_KEY || 'wb-claude-local';
  const accountLabel = ctx.accountLabel || process.env.CPA_ACCOUNT_LABEL || (provider === 'grok' ? 'grok' : 'antigravity');
  const target = upstreamBase + ctx.cpaPath + (ctx.search || '');

  let inBody = null;
  if (body) { try { inBody = JSON.parse(body); } catch { inBody = null; } }

  // ---- 上下文体积闸门 ----
  // Antigravity 的 Claude 配额是「5 小时滚动窗口 + 周上限」双层的, 且按 token 计。
  // 2026-10-25 实测: DSH 一个 700+ 条消息的会话连打 4 次, 每次 35~40 万 token,
  // 合计 152 万 token, 20 分钟内就把 5 小时窗口(先)和周配额(后)全打穿,
  // 导致之后 6.6 天不可用。这里在代理层提前拦截, 不让它闷头撞墙。
  if (inBody) {
    const estIn = estimateTokens(inBody.messages || []) +
      (Array.isArray(inBody.tools) ? inBody.tools.reduce((n, t) => n + estimateTokens([{ content: JSON.stringify(t) }]), 0) : 0);
    const limit = Number(process.env.CPA_CTX_LIMIT || 200000);
    if (limit > 0 && estIn > limit) {
      const msg = `单次请求约 ${estIn.toLocaleString()} tokens, 超过闸门 ${limit.toLocaleString()}。`
        + `会话历史太长, 请开新会话再继续 —— 否则一次就能打穿 Antigravity 配额(实测 4 次 152 万 token 打穿, 冻结 6.6 天)。`
        + ` 确需放行: 设环境变量 CPA_CTX_LIMIT=0`;
      appendCallRecord({
        ts: Date.now(), platform: ctx.platform, platformVia: ctx.platformVia, ua: ctx.ua,
        ip: ctx.ip, endpoint: ctx.endpoint, model: inBody.model || 'unknown',
        modelRequested: inBody.model || 'unknown', stream: inBody.stream === true,
        api: 'cpa', provider: 'cpa', msgs: Array.isArray(inBody.messages) ? inBody.messages.length : 0,
        tools: Array.isArray(inBody.tools) ? inBody.tools.length : 0,
        account: accountLabel,
        ok: false, status: 413, ms: 0, ttft: null,
        inputTokens: estIn, outputTokens: null, totalTokens: null,
        estimated: true, credit: null, err: `context too large (${estIn} > ${limit})`,
      });
      return sendJson(res, 413, {
        error: {
          message: msg, type: 'context_too_large',
          estimated_input_tokens: estIn, limit, hint: '开新会话 / 精简工具 / CPA_CTX_LIMIT=0 放行',
        },
      });
    }
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'connection', 'accept-encoding'].includes(k)) continue;
    headers[k] = v;
  }
  if (!headers.authorization) {
    headers.authorization = `Bearer ${defaultKey}`;
  }
  headers['accept-encoding'] = 'identity';

  const t0 = Date.now();
  const wantStream = inBody?.stream === true;
  const model = inBody?.model || 'unknown';
  const upstream = inBody ? 'cpa' : 'cpa';

  const base = {
    ts: t0,
    platform: ctx.platform,
    platformVia: ctx.platformVia,
    ua: ctx.ua,
    ip: ctx.ip,
    endpoint: ctx.endpoint,
    model,
    modelRequested: model,
    stream: wantStream,
    api: provider,
    provider,
    msgs: Array.isArray(inBody?.messages) ? inBody.messages.length
      : (typeof inBody?.input === 'string' ? 1 : Array.isArray(inBody?.input) ? inBody.input.length : 0),
    tools: Array.isArray(inBody?.tools) ? inBody.tools.length : 0,
    account: process.env.CPA_ACCOUNT_LABEL || 'antigravity',
  };

  // 只有真正的推理端点才计入趋势；GET /models、count_tokens 等元数据查询不埋点
  const isInference = req.method === 'POST' && /\/(chat\/completions|messages|responses|completions)\b/.test(ctx.cpaPath);
  const rec = (extra) => { if (isInference) appendCallRecord({ ...base, ...extra }); };

  let r;
  try {
    r = await fetch(target, {
      method: req.method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    rec({ ok: false, status: 0, ms: Date.now() - t0, err: 'cpa unreachable: ' + e.message });
    return sendJson(res, 502, { error: { message: 'cpa unreachable: ' + e.message } });
  }

  const ct = r.headers.get('content-type') || '';
  const isSSE = ct.includes('text/event-stream');

  if (!r.ok && !isSSE) {
    const text = await r.text().catch(() => '');
    rec({ ok: false, status: r.status, ms: Date.now() - t0, err: text.slice(0, 300) });
    res.writeHead(r.status, { 'Content-Type': ct || 'application/json; charset=utf-8' });
    return res.end(text);
  }

  if (isSSE && r.body) {
    res.writeHead(r.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const snif = usageSniffer();
    const finish = () => {
      const u = snif.usage || {};
      rec({
        ok: !snif.error && r.status < 400,
        status: r.status,
        ms: Date.now() - t0,
        ttft: snif.firstByteAt ? snif.firstByteAt - t0 : null,
        modelUpstream: snif.model || model,
        inputTokens: u.prompt_tokens ?? null,
        outputTokens: u.completion_tokens ?? null,
        totalTokens: u.total_tokens ?? null,
        estimated: !snif.usage,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? null,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
        bytes: snif.bytes,
        err: snif.error || null,
      });
    };
    snif.transform.on('end', finish);
    snif.transform.on('error', () => { finish(); res.destroy(); });
    // fetch 的 body 是 Web ReadableStream, 必须转成 Node 流才能 pipe
    const nodeStream = Readable.fromWeb(r.body);
    const wantStrip = ctx.provider === 'grok' && wantsCitationStrip(req);
    if (wantStrip) {
      nodeStream.pipe(snif.transform).pipe(citationFilterTransform()).pipe(res);
    } else {
      nodeStream.pipe(snif.transform).pipe(res);
    }
    nodeStream.on('error', () => { finish(); res.destroy(); });
    req.on('close', () => { try { nodeStream.destroy(); } catch {} });
    return;
  }

  // 普通 JSON: 直接取 usage
  const text = await r.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const u = json?.usage || null;
  rec({
    ok: r.status < 400,
    status: r.status,
    ms: Date.now() - t0,
    ttft: null,
    modelUpstream: json?.model || model,
    inputTokens: u?.input_tokens ?? u?.prompt_tokens ?? null,
    outputTokens: u?.output_tokens ?? u?.completion_tokens ?? null,
    totalTokens: u?.total_tokens ?? null,
    estimated: !u,
    cachedTokens: u?.cache_read_input_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: u?.output_tokens_details?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens ?? null,
    bytes: null,
    err: r.status >= 400 ? text.slice(0, 300) : null,
  });
  const wantStrip2 = ctx.provider === 'grok' && wantsCitationStrip(req) && r.status < 400;
  const outText = wantStrip2 ? stripCitationsInJson(text, ct) : text;
  res.writeHead(r.status, { 'Content-Type': ct || 'application/json; charset=utf-8' });
  res.end(outText);
}

// ---------------- serve ----------------

// 一次请求的调用方画像, 供埋点记录
function requestContext(req, endpoint) {
  const { platform, via } = detectPlatform(req.headers);
  return {
    platform,
    platformVia: via,
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    ip: clientIp(req),
    endpoint,
  };
}

// /v1/calls: 明细 + 聚合。所有客户端一视同仁, 平台维度来自埋点
function handleCalls(res, url) {
  const q = url.searchParams;
  const limit = Math.max(1, Math.min(2000, Number(q.get('limit')) || 200));
  const sinceMs = Number(q.get('since')) || 0;
  const platform = q.get('platform');
  const model = q.get('model');
  const provider = q.get('provider');

  let rows = callLog;
  if (sinceMs) rows = rows.filter(r => r.ts >= sinceMs);
  if (platform) rows = rows.filter(r => r.platform === platform);
  if (model) rows = rows.filter(r => r.model === model);
  if (provider) rows = rows.filter(r => (r.provider || 'workbuddy') === provider);

  const agg = { total: rows.length, ok: 0, fail: 0, tokens: 0, inputTokens: 0, outputTokens: 0, estimated: 0, ms: 0, ttftSum: 0, ttftN: 0, credit: 0, creditN: 0 };
  const byPlatform = new Map();
  const byModel = new Map();
  const byProvider = new Map();
  const byAccount = new Map();
  const byHour = new Map();   // 'MM-DD HH' → {n, tokens}
  const byDay = new Map();

  const bump = (map, key, row) => {
    const e = map.get(key) ?? { key, n: 0, ok: 0, fail: 0, tokens: 0, inputTokens: 0, outputTokens: 0, ms: 0, credit: 0 };
    e.n++;
    row.ok ? e.ok++ : e.fail++;
    e.tokens += row.totalTokens || 0;
    e.inputTokens += row.inputTokens || 0;
    e.outputTokens += row.outputTokens || 0;
    e.ms += row.ms || 0;
    e.credit += Number(row.credit) || 0;
    map.set(key, e);
  };

  for (const r of rows) {
    if (r.ok) agg.ok++; else agg.fail++;
    agg.tokens += r.totalTokens || 0;
    agg.inputTokens += r.inputTokens || 0;
    agg.outputTokens += r.outputTokens || 0;
    if (r.estimated) agg.estimated++;
    agg.ms += r.ms || 0;
    if (Number.isFinite(r.ttft)) { agg.ttftSum += r.ttft; agg.ttftN++; }
    if (Number.isFinite(r.credit)) { agg.credit += r.credit; agg.creditN++; }

    bump(byPlatform, r.platform || 'Unknown', r);
    bump(byProvider, r.provider || 'workbuddy', r);
    if (r.account) bump(byAccount, r.account, r);
    bump(byModel, r.model || '?', r);
    const d = new Date(r.ts);
    const hh = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`;
    const dd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    bump(byHour, hh, r);
    bump(byDay, dd, r);
  }

  const sorted = (map) => [...map.values()].sort((a, b) => b.n - a.n);
  sendJson(res, 200, {
    object: 'list',
    now: Date.now(),
    summary: {
      total: agg.total,
      ok: agg.ok,
      fail: agg.fail,
      success_rate: agg.total ? +(agg.ok / agg.total * 100).toFixed(1) : null,
      total_tokens: agg.tokens,
      input_tokens: agg.inputTokens,
      output_tokens: agg.outputTokens,
      estimated: agg.estimated,
      avg_ms: agg.total ? Math.round(agg.ms / agg.total) : null,
      avg_ttft: agg.ttftN ? Math.round(agg.ttftSum / agg.ttftN) : null,
      total_credit: +agg.credit.toFixed(4),
      credit_calls: agg.creditN,
    },
    by_platform: sorted(byPlatform),
    by_model: sorted(byModel),
    by_provider: sorted(byProvider),
    by_account: sorted(byAccount),
    by_hour: [...byHour.values()].sort((a, b) => a.key.localeCompare(b.key)),
    by_day: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    data: rows.slice(-limit).reverse(),
  });
}

function clearCalls() {
  callLog.length = 0;
  try { fs.writeFileSync(CALLS_FILE, ''); } catch {}
  try { fs.rmSync(CALLS_FILE + '.1', { force: true }); } catch {}
}

function handleClearCalls(res) {
  clearCalls();
  sendJson(res, 200, { ok: true, cleared: true });
}

// 自动签到：活动开启时每天领一次；活动未开启时静默跳过
async function autoCheckinTick() {
  try {
    let auth = loadAuth();
    if (!auth?.accessToken) return;
    auth = await refreshIfNeeded(auth);
    const st = await fetchCheckin(auth);
    if (!st.ok || !st.active) return;
    if (st.today_checked_in) return;
    const r = await claimCheckin(auth);
    console.log(`[checkin] 自动签到${r.ok ? '成功' : '失败'} code=${r.code} ${r.msg}`);
  } catch (e) {
    console.log('[checkin] 自动签到异常:', e.message);
  }
}

function serve(port, localKey, host = '127.0.0.1') {
  loadCallLog();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isConsolePath = url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/' || url.pathname.startsWith('/console/');

    if (localKey && !isConsolePath && url.pathname !== '/health') {
      const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (k !== localKey) return sendJson(res, 401, { error: { message: 'invalid local api key' } });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/')) {
      return sendFile(res, path.join(CONSOLE_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/console/app.js') {
      return sendFile(res, path.join(CONSOLE_DIR, 'app.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/console/style.css') {
      return sendFile(res, path.join(CONSOLE_DIR, 'style.css'), 'text/css; charset=utf-8');
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      const aliasEntries = Object.entries(ACTIVE_ALIASES).map(([alias, real]) => {
        const src = ACTIVE_MODELS.find(m => m.id === real) || {};
        return {
          id: alias, object: 'model', owned_by: 'workbuddy',
          free: src.free ?? false,
          credits: src.credits,
          available: src.available ?? false,
          alias_of: real,
        };
      });
      return sendJson(res, 200, { object: 'list', data: ACTIVE_MODELS.map(m => ({
        id: m.id, object: 'model', owned_by: 'workbuddy',
        free: m.free, credits: m.credits, available: m.available,
        ...(m.note ? { note: m.note } : {}),
      })).concat(aliasEntries) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/credits') {
      const acc = url.searchParams.get('account');
      const file = acc
        ? path.join(AUTH_DIR, acc.endsWith('.json') ? acc : acc + '.json')
        : AUTH_FILE;
      return handleCredits(res, fs.existsSync(file) ? file : AUTH_FILE);
    }
    // 对端实例代理（控制台双实例聚合用）
    if (PEER_URL && url.pathname.startsWith('/v1/peer/')) {
      const sub = url.pathname.slice('/v1/peer'.length);
      try {
        const r = await fetch(PEER_URL + sub, {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(text);
      } catch (e) {
        return sendJson(res, 502, { error: { message: 'peer unreachable: ' + e.message } });
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/meta') {
      return sendJson(res, 200, {
        role: IS_CN ? 'cn' : 'intl',
        label: IS_CN ? 'WorkBuddy 国服' : 'WorkBuddy 国际版',
        endpoint: ENDPOINT,
        default_model: DEFAULT_MODEL,
        peer: PEER_URL || null,
        peer_label: PEER_URL ? PEER_LABEL : null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/v1/accounts') {
      return handleAccounts(res);
    }
    // ---- CLIProxyAPI 透明代理（必须先于 /v1/cpa/ 管理转发匹配）----
    if (url.pathname.startsWith('/v1/cpa/proxy/')) {
      const cpaPath = url.pathname.slice('/v1/cpa/proxy'.length);
      const ctx = { ...requestContext(req, url.pathname), cpaPath, search: url.search };
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readAll(req);
      return handleCpaProxy(req, res, body, ctx);
    }
    // ---- grok2api 透明代理 (Grok via grok.com) ----
    if (url.pathname.startsWith('/v1/grok/proxy/')) {
      const grokPath = url.pathname.slice('/v1/grok/proxy'.length);
      const ctx = {
        ...requestContext(req, url.pathname),
        cpaPath: grokPath,
        search: url.search,
        upstreamBase: process.env.GROK_BASE || 'http://127.0.0.1:8000',
        provider: 'grok',
        defaultKey: process.env.GROK_CLIENT_KEY || 'grok-local',
        accountLabel: 'grok.com',
      };
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await readAll(req);
      return handleCpaProxy(req, res, body, ctx);
    }
    // ---- CLIProxyAPI（Claude/Gemini via Antigravity）管理转发 ----
    if (url.pathname.startsWith('/v1/cpa/')) {
      const sub = url.pathname.slice('/v1/cpa'.length);
      const target = (process.env.CPA_BASE || 'http://127.0.0.1:8317') + '/v0/management' + sub;
      try {
        const r = await fetch(target, {
          headers: {
            Authorization: `Bearer ${process.env.CPA_ADMIN_KEY || 'cpa-admin-local'}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(15000),
        });
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(text);
      } catch (e) {
        return sendJson(res, 502, { error: { message: 'cpa unreachable: ' + e.message } });
      }
    }
    if (url.pathname === '/v1/checkin' || url.pathname === '/v1/checkin/claim') {
      const doClaim = url.pathname.endsWith('/claim');
      if (doClaim && req.method !== 'POST') return sendJson(res, 405, { error: { message: 'use POST' } });
      return handleCheckin(res, doClaim);
    }
    // ---- 调用趋势 ----
    if (req.method === 'GET' && (url.pathname === '/v1/calls' || url.pathname === '/calls')) {
      return handleCalls(res, url);
    }
    if (req.method === 'DELETE' && url.pathname === '/v1/calls') {
      return handleClearCalls(res);
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      const ctx = requestContext(req, url.pathname);
      return handleChat(req, res, await readAll(req), ctx);
    }
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      const ctx = requestContext(req, url.pathname);
      return handleResponses(req, res, await readAll(req), ctx);
    }
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, authed: !!loadAuth()?.accessToken });
    sendJson(res, 404, { error: { message: 'not found' } });
  });
  server.listen(port, host, () => {
    console.log(`wb-proxy 已启动: http://${host}:${port}/v1  (model: ${DEFAULT_MODEL})`);
    console.log(`控制台: http://${host}:${port}/console`);
    console.log('端点: /v1/models /v1/credits /v1/checkin /v1/checkin/claim /v1/chat/completions /v1/responses /v1/calls');

    // 自动签到：启动 20s 后首检，之后每 6 小时一次；WB_AUTO_CHECKIN=0 可关闭
    if (process.env.WB_AUTO_CHECKIN !== '0') {
      setTimeout(autoCheckinTick, 20_000);
      setInterval(autoCheckinTick, 6 * 3600_000);
    }
  });
}

// ---------------- main ----------------

const [, , cmd, ...rest] = process.argv;
const argOf = (name, fallback = null) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};

if (cmd === 'login') {
  const as = argOf('--as');
  const target = as ? path.join(AUTH_DIR, `auth-${as}.json`) : AUTH_FILE;
  login(target, as || '');
} else if (cmd === 'serve') {
  const port = Number(argOf('--port', 8377)) || 8377;
  const key = argOf('--key');
  const host = argOf('--host', '127.0.0.1');
  if (host !== '127.0.0.1' && host !== '::1' && !key) {
    console.error('监听非本机地址时必须加 --key 保护接口, 否则任何人都能用你的额度');
    process.exit(1);
  }
  serve(port, key, host);
} else if (cmd === 'accounts') {
  const files = listAccountFiles();
  if (!files.length) { console.log('还没有任何账号，先跑 node wb-proxy.mjs login'); process.exit(0); }
  await Promise.all(files.map(f => refreshAccountCredits(f)));
  for (const a of listAccounts()) {
    console.log(
      `${a.healthy ? '✓' : '✗'} ${String(a.id).padEnd(12)} ${String(a.account || '-').padEnd(30)} ` +
      `credits=${a.credits ?? '?'} used=${a.used} ok=${a.ok} fail=${a.fail}` +
      (a.duplicate ? ' [重复账号-已忽略]' : '') +
      (a.cooldown_s ? ` cooldown=${a.cooldown_s}s` : '') +
      (a.exhausted_s ? ` exhausted=${a.exhausted_s}s` : '') +
      (a.last_error ? ` last=${a.last_error}` : '')
    );
  }
} else {
  console.log([
    '用法:',
    '  node wb-proxy.mjs login [--as 账号名]     # 登录并保存为 auth-<账号名>.json',
    '  node wb-proxy.mjs accounts                # 查看账号池状态',
    '  node wb-proxy.mjs serve [--port 8377] [--host 0.0.0.0] [--key xxx]',
  ].join('\n'));
}
