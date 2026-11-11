/**
 * Trae 自动签到 · Cloudflare Worker 版
 *
 * 把每日签到搬到云端：不用开电脑、不用装客户端。
 * 扫码托管一次，之后 Worker 自己续期令牌、按时签到、记录结果。
 *
 * 依赖绑定：
 *   KV        KV 命名空间
 *   MASTER_KEY  Secret，32 字节随机值的 base64（加密所有令牌）
 *   ADMIN_TOKEN Secret，控制台登录口令
 *   CRON_SECRET Secret（可选），外部定时器口令，不设则回退 ADMIN_TOKEN
 *
 * 部署步骤见同目录 README.md。
 */

const API = 'https://api.trae.cn';

const EP = {
  claim: '/trae/api/v2/ug/checkin_credits/claim',
  status: '/trae/api/v2/ug/checkin_credits/status',
  exchange: '/trae/api/v3/oauth/ExchangeToken',
};

/* 客户端身份 */
const CLIENT_ID = 'ono9krqynydwx5';
const IDE_VERSION = '1.107.1';
const UA = 'VSCode ' + IDE_VERSION + ' (TRAE SOLO CN)';
const MARKET_CLIENT_ID = '787976';
const MARKET_AID = '787976';

/* 网页授权固定参数 */
const AUTHORIZE_BASE = 'https://www.trae.cn';
const OAUTH_APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const OAUTH_APP_VERSION = '3.3.100';
const OAUTH_PLUGIN_VERSION = '2.3.83560';

/* 回调必须指向本机回环地址，官网只往 127.0.0.1 回送 AuthCode */
const CALLBACK_LOCAL = 'http://127.0.0.1:17388/authorize';

const LOGIN_TTL = 900;
const LOGIN_LATEST = 'login:latest';
const REQ_BODY = '{"req_source":1}';

/* 业务返回码 */
const CODE_OK = 0;
const CODE_ALREADY = 9095;
const CODE_RATE = 9074;
const AUTH_FAIL = [1001, 1002, 401, 403];

/* 冷却时长（分钟） */
const COOL_RATE = 55;
const COOL_PEAK = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();
const ecdsaAlg = { name: 'ECDSA', namedCurve: 'P-256' };

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function b64encode(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(String(str).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlEncode(buf) {
  return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return b64decode(s + '='.repeat((4 - (s.length % 4)) % 4));
}

function randomHex(bytes = 16) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function randomId(bytes = 9) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function timingSafeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    },
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* 加密：每条记录随机 salt + IV，主密钥经 HKDF 派生 AES-256-GCM 密钥    */
/* ------------------------------------------------------------------ */

async function masterKeyBytes(env) {
  const raw = String(env.MASTER_KEY || '').trim();
  if (!raw) throw new Error('未配置 MASTER_KEY');
  const bytes = b64decode(raw);
  if (bytes.length !== 32) throw new Error('MASTER_KEY 必须是 32 字节（base64 后 44 字符，以 = 结尾）');
  return bytes;
}

async function deriveKey(master, salt) {
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('trae-kv-v1') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function seal(env, obj) {
  const master = await masterKeyBytes(env);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(master, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return 'v1.' + b64urlEncode(salt) + '.' + b64urlEncode(iv) + '.' + b64urlEncode(new Uint8Array(ct));
}

async function open(env, blob) {
  const parts = String(blob || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('记录格式不正确');
  const master = await masterKeyBytes(env);
  const salt = b64urlDecode(parts[1]);
  const iv = b64urlDecode(parts[2]);
  const key = await deriveKey(master, salt);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, b64urlDecode(parts[3]));
  return JSON.parse(dec.decode(pt));
}
/* ------------------------------------------------------------------ */
/* KV：账号索引 + 每条账号一条加密记录                                  */
/* ------------------------------------------------------------------ */

const INDEX_KEY = 'accounts:index';
const acctKey = (id) => 'account:' + id;
const loginKey = (trace) => 'login:' + trace;

async function kv(env) {
  if (!env.KV) throw new Error('未绑定 KV（绑定名必须是 KV）');
  return env.KV;
}

async function listIndex(env) {
  const store = await kv(env);
  const raw = await store.get(INDEX_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveIndex(env, list) {
  const store = await kv(env);
  await store.put(INDEX_KEY, JSON.stringify(list));
}

async function getAccount(env, id) {
  const store = await kv(env);
  const raw = await store.get(acctKey(id));
  if (!raw) return null;
  try {
    return await open(env, raw);
  } catch {
    return null;
  }
}

async function putAccount(env, acct) {
  const store = await kv(env);
  await store.put(acctKey(acct.id), await seal(env, acct));
}

async function delAccount(env, id) {
  const store = await kv(env);
  await store.delete(acctKey(id));
  const list = await listIndex(env);
  await saveIndex(env, list.filter((x) => x.id !== id));
}

async function putLoginSession(env, sess) {
  const store = await kv(env);
  await store.put(loginKey(sess.trace), await seal(env, sess), { expirationTtl: LOGIN_TTL });
  await store.put(LOGIN_LATEST, sess.trace, { expirationTtl: LOGIN_TTL });
}

async function getLoginSession(env, trace) {
  const store = await kv(env);
  const raw = await store.get(loginKey(trace));
  if (!raw) return null;
  try {
    return await open(env, raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Trae 协议层                                                         */
/* ------------------------------------------------------------------ */

async function traeFetch(path, { method = 'POST', headers = {}, body = '{}', timeout = 20000 } = {}) {
  const url = path.startsWith('http') ? path : API + path;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 交给调用方看原文 */
    }
    return { status: res.status, json: data, text };
  } finally {
    clearTimeout(timer);
  }
}

/** JWT 载荷 */
function jwtPayload(token) {
  try {
    return JSON.parse(dec.decode(b64urlDecode(String(token).split('.')[1])));
  } catch {
    return {};
  }
}

/** 过期时间（秒） */
function jwtExp(token) {
  const p = jwtPayload(token);
  let v = Number(p.exp || p.TokenExpireAt || 0) || 0;
  if (v > 1e12) v = Math.floor(v / 1000);
  return v;
}

/** 由 userId 派生 market 用户标识（UUIDv4 形态，同账号恒定） */
async function deriveMarketUserId(userId) {
  const seed = String(userId || '').trim();
  if (!seed) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('trae-market:' + seed)));
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}

/** 签到 / 积分接口请求头 */
async function ugHeaders(token, acct) {
  const payload = jwtPayload(token);
  const uid = String(acct?.userId || payload.userId || payload.sub || payload.uid || '');
  const h = {
    Authorization: 'Cloud-IDE-JWT ' + token,
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    'User-Agent': UA,
    'Content-Type': 'application/json',
    'x-user-region': 'CN',
    'x-market-client-id': MARKET_CLIENT_ID,
    'x-lgw-req-sdk-type': '3',
    'x-lscbd-aid': MARKET_AID,
    'package-type': 'stable_cn',
    'x-request-id': crypto.randomUUID(),
    'x-app-version': IDE_VERSION,
  };
  const muid = await deriveMarketUserId(uid);
  if (muid) h['x-market-user-id'] = muid;
  const did = String(acct?.deviceId || '').trim();
  if (did) h['x-device-id'] = did;
  h['x-device-type'] = String(acct?.deviceType || 'Windows');
  h['x-os-version'] = String(acct?.osVersion || '10.0.19045');
  const brand = String(acct?.deviceBrand || '').trim();
  if (brand) h['x-device-brand'] = brand;
  return h;
}

async function importPrivKey(pem) {
  const body = String(pem || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return crypto.subtle.importKey('pkcs8', b64decode(body), ecdsaAlg, false, ['sign']);
}

/** ECDSA-P256-SHA256 签名，输出 base64（IEEE P1363） */
async function ecSign(privatePem, data) {
  const key = await importPrivKey(privatePem);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return b64encode(new Uint8Array(sig));
}

/** 设备证明 + 设备信息 */
async function buildProof(acct, path, clientId, platformCode, refreshToken) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const canonical = ['POST', path, clientId, refreshToken, String(ts), nonce].join('\n');
  const signature = await ecSign(acct.privateKeyPem, enc.encode(canonical));
  return {
    proof: { Timestamp: ts, Nonce: nonce, Signature: signature },
    info: {
      DeviceID: String(acct.deviceId || ''),
      MachineID: String(acct.machineId || ''),
      PlatformCode: platformCode,
      DeviceType: 'PC',
      DeviceName: String(acct.deviceName || 'PC'),
      DeviceModel: String(acct.deviceModel || ''),
      ClientVersion: IDE_VERSION,
      DevicePublicKey: String(acct.publicKeyPem || ''),
      DeviceBrand: String(acct.deviceBrand || ''),
      DeviceCPU: '',
      OSInfo: String(acct.osInfo || 'Windows'),
      OSVersion: String(acct.osVersion || '10.0.19045'),
    },
  };
}

function explainErr(j, text) {
  const err = (j && j.ResponseMetadata && j.ResponseMetadata.Error) || {};
  const code = err.Code ?? j?.code ?? '?';
  const msg = (err.Data && err.Data['__Message.error']) || err.Message || j?.message || String(text || '').slice(0, 160);
  const hint =
    {
      20101: 'refreshToken 已失效或在别处被轮换，请删除该账号重新扫码',
      10101: 'refreshToken 与当前产品线不匹配，请重新扫码',
      20405: '服务端要求设备证明，但该账号缺少设备密钥，请重新扫码',
      20403: '设备密钥与令牌不匹配，请重新扫码',
    }[code] || '';
  return 'code=' + code + ' ' + msg + (hint ? '（' + hint + '）' : '');
}

/** 用 refreshToken 换新令牌 */
async function refreshTokens(acct) {
  const rt = String(acct.refreshToken || '').trim();
  if (!rt) throw new Error('账号没有 refreshToken');
  if (!acct.privateKeyPem || !acct.publicKeyPem) throw new Error('账号缺少设备密钥，请重新扫码');

  const combos = [
    [acct.clientId || CLIENT_ID, acct.platformCode || 'IDE_PC'],
    [CLIENT_ID, 'IDE_PC'],
  ];

  let lastErr = '';
  for (const [clientId, platformCode] of combos) {
    let built;
    try {
      built = await buildProof(acct, EP.exchange, clientId, platformCode, rt);
    } catch (e) {
      throw new Error('设备签名失败：' + e.message);
    }
    const body = JSON.stringify({
      ClientID: clientId,
      ClientSecret: '',
      RefreshToken: rt,
      DeviceInfo: built.info,
      DeviceProof: built.proof,
      IDEVersion: IDE_VERSION,
    });
    const r = await traeFetch(EP.exchange, { headers: { 'x-cloudide-token': '' }, body });
    const token = r.json?.Result?.Token;
    if (r.status < 400 && token) {
      return { accessToken: token, refreshToken: r.json.Result.RefreshToken || rt };
    }
    lastErr = explainErr(r.json, r.text);
    if (!String(r.text || '').includes('10101')) break;
  }
  throw new Error('刷新令牌失败：' + (lastErr || '未知错误'));
}

/** 签到状态 */
async function queryStatus(token, acct) {
  const r = await traeFetch(EP.status, { headers: await ugHeaders(token, acct), body: REQ_BODY });
  const d = r.json?.data || {};
  return {
    http: r.status,
    code: r.json?.code ?? -1,
    checkedIn: !!d.checked_in,
    credits: d.credits ?? null,
    extra: d.extra_credits ?? null,
    message: r.json?.message || '',
  };
}

/** 提交签到 */
async function claim(token, acct) {
  const r = await traeFetch(EP.claim, { headers: await ugHeaders(token, acct), body: REQ_BODY });
  const d = r.json?.data;
  return {
    http: r.status,
    code: r.json?.code ?? -1,
    message: r.json?.message || String(r.text || '').slice(0, 160),
    points: d && typeof d === 'object' ? d.points ?? d.credits ?? null : null,
  };
}
/* ------------------------------------------------------------------ */
/* 扫码登录：设备身份 → 授权链接 → 粘贴回调 → 换令牌                    */
/*                                                                     */
/* 1. 现场生成 P-256 设备密钥对 + 15 位 deviceId + PKCE                 */
/* 2. 拼 /authorization 链接，回调固定 127.0.0.1:<端口>                 */
/* 3. 抖音扫码，官网只往本机地址回送 AuthCode                            */
/* 4. 把那段打不开的地址粘回控制台，用 AuthCode + PKCE + 设备公钥换令牌  */
/* ------------------------------------------------------------------ */

function toPem(der, label) {
  const b = b64encode(der);
  const lines = b.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----';
}

/** 全新设备身份 */
async function genDeviceIdentity() {
  const kp = await crypto.subtle.generateKey(ecdsaAlg, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
  return { privateKeyPem: toPem(pkcs8, 'PRIVATE KEY'), publicKeyPem: toPem(spki, 'PUBLIC KEY') };
}

/** 15 位数字设备号，首位非 0 */
function genDeviceId() {
  const a = crypto.getRandomValues(new Uint8Array(15));
  let s = String(1 + (a[0] % 9));
  for (let i = 1; i < 15; i++) s += String(a[i] % 10);
  return s;
}

async function pkcePair() {
  const verifier = randomHex(32);
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return { verifier, challenge: b64urlEncode(digest) };
}

function qsQuote(v) {
  return encodeURIComponent(String(v)).replace(/%2F/g, '/');
}

function buildAuthorizeUrl(o) {
  const params = [
    ['login_version', '1'],
    ['auth_from', 'trae'],
    ['login_channel', 'native_ide'],
    ['plugin_version', OAUTH_PLUGIN_VERSION],
    ['auth_type', 'local'],
    ['client_id', o.clientId],
    ['redirect', '0'],
    ['login_trace_id', o.trace],
    ['auth_callback_url', o.callback],
    ['machine_id', o.machineId],
    ['device_id', o.deviceId],
    ['x_device_id', o.deviceId],
    ['x_machine_id', o.machineId],
    ['x_device_brand', 'PC'],
    ['x_device_type', 'Windows'],
    ['x_os_version', '10.0.19045'],
    ['x_env', ''],
    ['x_app_version', OAUTH_APP_VERSION],
    ['x_app_type', 'stable'],
    ['code_challenge', o.challenge],
    ['code_challenge_method', 'S256'],
    ['channel_name', 'common'],
  ];
  return AUTHORIZE_BASE + '/authorization?' + params.map(([k, v]) => k + '=' + qsQuote(v)).join('&');
}

function hostBase(h) {
  const s = String(h || '').trim();
  if (!s) return API;
  if (/^https?:\/\//i.test(s)) return s.replace(/\/+$/, '');
  return 'https://' + s.replace(/\/+$/, '');
}

/** 递归找 token 字段，兑换响应外层结构各版本不一致 */
function deepFind(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(obj)) {
    const got = deepFind(v, keys, depth + 1);
    if (got) return got;
  }
  return '';
}

const REFRESH_KEYS = ['RefreshToken', 'refreshToken', 'refresh_token'];
const ACCESS_KEYS = ['Token', 'AccessToken', 'accessToken', 'access_token'];

function describeExchangeErr(j, text, status) {
  const err = (j && j.ResponseMetadata && j.ResponseMetadata.Error) || j?.error || {};
  const code = err.Code ?? j?.code ?? '?';
  const msg = (err.Data && err.Data['__Message.error']) || err.Message || j?.message || j?.msg || String(text || '').slice(0, 160);
  return 'code=' + code + ' ' + msg + ' (HTTP ' + status + ')';
}

function nicknameFromToken(token) {
  const p = jwtPayload(token);
  return String(p.nickname || p.name || p.userName || p.displayName || '').trim();
}

/** AuthCode → 双令牌，三个端点变体依次尝试 */
async function exchangeAuthCode({ authCode, verifier, device, clientId, platform, host }) {
  const dev = {
    DeviceID: String(device.deviceId || ''),
    MachineID: String(device.machineId || ''),
    PlatformCode: platform,
    DeviceType: 'PC',
    DeviceName: 'PC',
    DeviceModel: '',
    ClientVersion: OAUTH_APP_VERSION,
    DevicePublicKey: String(device.publicKeyPem || ''),
    DeviceBrand: '',
    DeviceCPU: '',
    OSInfo: 'Windows',
    OSVersion: '10.0.19045',
  };
  const baseHeaders = {
    Accept: '*/*',
    'User-Agent': 'Trae/' + OAUTH_APP_VERSION,
    'x-device-id': dev.DeviceID,
    'x-app-id': OAUTH_APP_ID,
    'x-platform-code': platform,
  };

  const variants = [
    {
      tag: 'DeviceInfo',
      url: hostBase(host) + EP.exchange,
      headers: { ...baseHeaders, 'x-cloudide-token': '' },
      body: {
        ClientID: clientId,
        AuthCode: authCode,
        CodeVerifier: verifier,
        DeviceInfo: dev,
        IDEVersion: OAUTH_APP_VERSION,
      },
    },
    {
      tag: 'AuthCode',
      url: 'https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken',
      headers: baseHeaders,
      body: { ClientID: clientId, AuthCode: authCode, CodeVerifier: verifier, DeviceID: dev.DeviceID, PlatformCode: platform },
    },
    {
      tag: 'Code',
      url: 'https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken',
      headers: baseHeaders,
      body: { ClientID: clientId, Code: authCode, CodeVerifier: verifier, DeviceID: dev.DeviceID, PlatformCode: platform },
    },
  ];

  const errors = [];
  for (const v of variants) {
    const r = await traeFetch(v.url, { method: 'POST', headers: v.headers, body: JSON.stringify(v.body) });
    const refreshToken = deepFind(r.json, REFRESH_KEYS);
    const accessToken = deepFind(r.json, ACCESS_KEYS);
    if (refreshToken) {
      return { tokens: { refreshToken, accessToken }, tag: v.tag, name: nicknameFromToken(accessToken) };
    }
    errors.push(v.tag + ': ' + describeExchangeErr(r.json, r.text, r.status));
  }
  throw new Error('登录失败 → ' + errors.join(' | '));
}

/** 解析粘贴回来的回调链接 */
function parseCallbackParams(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error('不是有效链接，请复制地址栏里 127.0.0.1 开头的那一整段');
  }
  const q = u.searchParams;
  let authCode = '';
  const info = q.get('authCodeInfo');
  if (info) {
    try {
      authCode = String(JSON.parse(info).AuthCode || '').trim();
    } catch {
      /* 不是 JSON 就继续找 code */
    }
  }
  if (!authCode) authCode = String(q.get('code') || q.get('AuthCode') || '').trim();

  let refreshToken = '';
  for (const k of ['refreshToken', 'refresh_token', 'RefreshToken']) {
    const v = String(q.get(k) || '').trim().replace(/^"+|"+$/g, '');
    if (v) {
      refreshToken = v;
      break;
    }
  }
  if (!authCode && !refreshToken) throw new Error('链接里没找到 authCodeInfo，请确认复制的是扫码后跳转的那一整段地址');

  return {
    authCode,
    refreshToken,
    clientId: String(q.get('client_id') || q.get('clientId') || '').trim(),
    trace: String(q.get('loginTraceID') || q.get('login_trace_id') || q.get('state') || '').trim(),
    host: String(q.get('host') || '').trim(),
    name: String(q.get('name') || q.get('nickname') || '').trim(),
  };
}

async function saveScannedAccount(env, { label, refreshToken, device, clientId, platform }) {
  const rt = String(refreshToken || '').trim();
  if (!rt) throw new Error('登录响应里没有 refreshToken');
  const id = randomId(9);
  const acct = {
    id,
    label: String(label || '').trim().slice(0, 40) || 'Trae-' + String(device.deviceId || '').slice(-4),
    refreshToken: rt,
    accessToken: '',
    tokenExp: 0,
    deviceId: String(device.deviceId || ''),
    machineId: String(device.machineId || ''),
    privateKeyPem: String(device.privateKeyPem || ''),
    publicKeyPem: String(device.publicKeyPem || ''),
    deviceName: 'PC',
    deviceModel: '',
    deviceBrand: '',
    deviceType: 'Windows',
    osInfo: 'Windows',
    osVersion: '10.0.19045',
    clientId: String(clientId || ''),
    platformCode: String(platform || ''),
    createdAt: Date.now(),
    lastState: 'new',
    lastMsg: '已托管，等待首次运行',
    lastRun: 0,
    lastCredit: null,
    credits: null,
    cooldownUntil: 0,
    streak: 0,
    lastCheckDate: '',
  };
  await putAccount(env, acct);
  const list = await listIndex(env);
  list.push({ id, label: acct.label, createdAt: acct.createdAt });
  await saveIndex(env, list);
  return acct;
}
/* ------------------------------------------------------------------ */
/* 业务：单个账号签到 / 批量签到                                       */
/* ------------------------------------------------------------------ */

function nowMin() {
  return Date.now();
}

/** 拿一个可用 accessToken（过期则续期） */
async function ensureToken(env, acct) {
  const exp = Number(acct.tokenExp || 0);
  const left = exp ? exp * 1000 - Date.now() : -1;
  if (acct.accessToken && left > 5 * 60 * 1000) {
    return { token: acct.accessToken, refreshed: false, exp };
  }
  const r = await refreshTokens(acct);
  acct.accessToken = r.accessToken;
  acct.refreshToken = r.refreshToken;
  acct.tokenExp = jwtExp(r.accessToken);
  return { token: r.accessToken, refreshed: true, exp: acct.tokenExp };
}

function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 单账号签到
 * 返回 { id, label, state, msg, credit, credits }
 * state: checked | already | rate | cooldown | token_dead | error
 */
async function checkOne(env, acct, force = false) {
  const out = { id: acct.id, label: acct.label, state: 'error', msg: '', credit: null, credits: null };

  if (!force && acct.cooldownUntil && acct.cooldownUntil > Date.now()) {
    const min = Math.ceil((acct.cooldownUntil - Date.now()) / 60000);
    out.state = 'cooldown';
    out.msg = '冷却中，' + min + ' 分钟后重试';
    out.credits = acct.credits ?? null;
    return out;
  }

  if (!force && acct.lastCheckDate === todayCN() && acct.lastState === 'checked') {
    out.state = 'already';
    out.msg = '今日已签';
    out.credits = acct.credits ?? null;
    return out;
  }

  let token;
  try {
    const got = await ensureToken(env, acct);
    token = got.token;
  } catch (e) {
    const msg = String(e.message || e);
    const dead = /20101|10101|refreshToken 已失效|缺少设备密钥/.test(msg);
    acct.lastState = dead ? 'token_dead' : 'error';
    acct.lastMsg = msg;
    acct.lastRun = Date.now();
    await putAccount(env, acct);
    out.state = acct.lastState;
    out.msg = msg;
    return out;
  }

  try {
    const st = await queryStatus(token, acct);
    acct.credits = st.credits;
    if (st.checkedIn) {
      out.state = 'already';
      out.msg = '今日已签 · 余额 ' + (st.credits ?? '?');
      out.credits = st.credits;
      acct.lastState = 'checked';
      acct.lastMsg = out.msg;
      acct.lastCredit = null;
      acct.lastCheckDate = todayCN();
      acct.lastRun = Date.now();
      await putAccount(env, acct);
      return out;
    }

    const c = await claim(token, acct);
    if (c.code === CODE_OK) {
      out.state = 'checked';
      out.credit = c.points;
      out.credits = c.points != null ? c.points : st.credits;
      out.msg = '领取成功' + (c.points != null ? ' +' + c.points + ' 积分' : '');
      acct.lastState = 'checked';
      acct.lastMsg = out.msg;
      acct.lastCredit = c.points;
      acct.lastCheckDate = todayCN();
      acct.cooldownUntil = 0;
      if (acct.lastCheckDate !== todayCN()) acct.streak = 1;
    } else if (c.code === CODE_ALREADY) {
      out.state = 'already';
      out.msg = '今日已签';
      acct.lastState = 'checked';
      acct.lastMsg = out.msg;
      acct.lastCheckDate = todayCN();
    } else if (c.code === CODE_RATE) {
      const until = Date.now() + COOL_RATE * 60000;
      acct.cooldownUntil = until;
      acct.lastState = 'rate';
      acct.lastMsg = c.message || '服务端限流';
      out.state = 'rate';
      out.msg = (c.message || '服务端限流') + '，' + COOL_RATE + ' 分钟后重试';
    } else if (AUTH_FAIL.includes(c.code) || AUTH_FAIL.includes(c.http)) {
      acct.lastState = 'token_dead';
      acct.lastMsg = c.message || '登录态失效';
      out.state = 'token_dead';
      out.msg = (c.message || '登录态失效') + '，请删除后重新扫码';
    } else {
      acct.lastState = 'error';
      acct.lastMsg = 'code=' + c.code + ' ' + (c.message || '');
      out.state = 'error';
      out.msg = acct.lastMsg;
    }
    acct.lastRun = Date.now();
    await putAccount(env, acct);
    return out;
  } catch (e) {
    const msg = String(e.message || e);
    acct.lastState = 'error';
    acct.lastMsg = msg;
    acct.lastRun = Date.now();
    await putAccount(env, acct);
    out.state = 'error';
    out.msg = msg;
    return out;
  }
}

/** 批量签到：串行，避免同 IP 并发触发限流 */
async function runAll(env, force = false) {
  const list = await listIndex(env);
  const results = [];
  for (const item of list) {
    const acct = await getAccount(env, item.id);
    if (!acct) continue;
    results.push(await checkOne(env, acct, force));
  }
  return {
    at: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' +08:00',
    total: results.length,
    checked: results.filter((r) => r.state === 'checked').length,
    already: results.filter((r) => r.state === 'already').length,
    failed: results.filter((r) => ['error', 'token_dead'].includes(r.state)).length,
    cooling: results.filter((r) => ['rate', 'cooldown'].includes(r.state)).length,
    results,
  };
}
/* ------------------------------------------------------------------ */
/* 控制台页面（手机浏览器可操作）                                       */
/* ------------------------------------------------------------------ */

function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Trae 云端签到</title>
<style>
  :root{--bg:#f5f6f8;--card:#fff;--bd:#e5e7eb;--tx:#111827;--sub:#6b7280;--pri:#2f6bff;--ok:#16a34a;--warn:#d97706;--err:#dc2626}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:780px;margin:0 auto;padding:16px 14px 60px}
  h1{font-size:20px;margin:6px 0 2px}
  .sub{color:var(--sub);font-size:12px;margin-bottom:14px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin-bottom:12px}
  .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .between{justify-content:space-between}
  .stat{display:flex;gap:10px;margin-top:4px}
  .stat div{flex:1;text-align:center;background:#f9fafb;border-radius:8px;padding:8px 4px}
  .stat b{display:block;font-size:18px}
  .stat span{font-size:11px;color:var(--sub)}
  button{font:inherit;border:1px solid var(--bd);background:#fff;color:var(--tx);border-radius:8px;padding:8px 14px;cursor:pointer}
  button:active{transform:scale(.98)}
  button.pri{background:var(--pri);border-color:var(--pri);color:#fff;font-weight:600}
  button.dg{color:var(--err);border-color:#fecaca}
  button:disabled{opacity:.5;cursor:default}
  input{font:inherit;width:100%;padding:9px 11px;border:1px solid var(--bd);border-radius:8px;background:#fff;color:var(--tx)}
  input:focus{outline:2px solid #dbe3ff;border-color:var(--pri)}
  .lab{font-size:12px;color:var(--sub);margin:10px 0 4px}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
  .link{background:#f9fafb;border:1px dashed var(--bd);border-radius:8px;padding:10px;margin-top:8px;user-select:all}
  .tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2ff;color:#3730a3}
  .tag.ok{background:#dcfce7;color:#166534}
  .tag.warn{background:#fef3c7;color:#92400e}
  .tag.err{background:#fee2e2;color:#991b1b}
  .acct{border-top:1px solid var(--bd);padding-top:12px;margin-top:12px}
  .acct:first-child{border-top:0;padding-top:0;margin-top:0}
  .acct .h{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .acct .n{font-weight:600}
  .acct .m{font-size:12px;color:var(--sub);margin-top:2px}
  .acct .ops{display:flex;gap:8px;margin-top:8px}
  .acct .ops button{flex:1;padding:7px 10px;font-size:13px}
  .hide{display:none!important}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#111827;color:#fff;padding:10px 18px;border-radius:999px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:9}
  .toast.on{opacity:1}
  .hint{font-size:12px;color:var(--sub);margin-top:6px}
  .steps{font-size:12px;color:var(--sub);margin:6px 0 0;padding-left:18px}
  .steps li{margin:2px 0}
</style>
</head>
<body>
<div class="wrap">
  <h1>Trae 云端签到</h1>
  <div class="sub">托管在 Cloudflare · 每天自动签到，不用开电脑</div>

  <div class="card" id="gate">
    <div class="lab">管理口令</div>
    <input id="token" type="password" placeholder="部署时设置的 ADMIN_TOKEN" autocomplete="current-password">
    <div class="row" style="margin-top:10px">
      <button class="pri" onclick="login()">进入</button>
    </div>
    <div class="hint">口令只保存在本机浏览器，不会发送给任何第三方。</div>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <div class="row between">
        <div><b id="sum_title">账号总览</b><div class="m sub" id="sum_time" style="font-size:12px"></div></div>
        <div class="row">
          <button onclick="load()">刷新</button>
          <button class="pri" id="btn_run" onclick="runAll()">全部签到</button>
        </div>
      </div>
      <div class="stat">
        <div><b id="n_total">0</b><span>账号</span></div>
        <div><b id="n_ok" style="color:var(--ok)">0</b><span>今天就绪</span></div>
        <div><b id="n_bad" style="color:var(--warn)">0</b><span>需处理</span></div>
      </div>
    </div>

    <div class="card">
      <div class="row between">
        <b>添加账号</b>
        <button id="btn_add" onclick="toggleAdd()">扫码托管</button>
      </div>
      <div id="addbox" class="hide">
        <ol class="steps">
          <li>点「生成登录链接」，用手机浏览器打开</li>
          <li>登录 Trae 账号并确认授权</li>
          <li>页面会跳到 127.0.0.1 打不开，<b>把地址栏整段复制</b></li>
          <li>粘到下面第二个框，点「完成托管」</li>
        </ol>
        <div class="row" style="margin-top:10px">
          <button class="pri" id="btn_gen" onclick="genLink()">生成登录链接</button>
        </div>
        <div id="linkbox" class="hide">
          <div class="lab">① 在手机上打开这个链接</div>
          <div class="link mono" id="authurl"></div>
          <div class="row" style="margin-top:8px">
            <button onclick="copyText(document.getElementById('authurl').textContent)">复制链接</button>
            <button onclick="openUrl(document.getElementById('authurl').textContent)">直接打开</button>
          </div>
          <div class="lab">② 授权后把打不开的地址粘到这里</div>
          <input id="cburl" placeholder="http://127.0.0.1:17388/authorize?authCodeInfo=...">
          <div class="lab">③ 备注（可留空）</div>
          <input id="label" placeholder="例如：主号">
          <div class="row" style="margin-top:10px">
            <button class="pri" id="btn_paste" onclick="pasteUrl()">完成托管</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <b>账号列表</b>
      <div id="list" style="margin-top:12px"></div>
    </div>

    <div class="card" style="font-size:12px;color:var(--sub)">
      <div class="row between">
        <span>免登录自动运行</span>
        <span class="tag" id="cron_tag">—</span>
      </div>
      <div class="hint" id="cron_hint"></div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var T = localStorage.getItem('trae_admin') || '';
var TRACE = '';

function $(id){ return document.getElementById(id); }
function toast(msg){
  var el = $('toast'); el.textContent = msg; el.className = 'toast on';
  clearTimeout(window.__t); window.__t = setTimeout(function(){ el.className = 'toast'; }, 2200);
}
function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}
function copyText(t){
  if (navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ toast('已复制'); }, function(){ toast('复制失败，请长按选择'); });
  else { var i = $('cburl'); i.value = t; i.select(); document.execCommand('copy'); toast('已复制'); }
}
function openUrl(u){ window.open(u, '_blank'); }

async function api(path, opt){
  opt = opt || {};
  var h = { 'Content-Type': 'application/json' };
  if (T) h['Authorization'] = 'Bearer ' + T;
  var r = await fetch(path, { method: opt.method || 'GET', headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
  var j = null;
  try { j = await r.json(); } catch(e){}
  if (r.status === 401) { localStorage.removeItem('trae_admin'); T = ''; $('app').className = 'hide'; $('gate').className = 'card'; throw new Error('口令不正确'); }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

async function login(){
  var v = $('token').value.trim();
  if (!v) return toast('请输入口令');
  T = v;
  try {
    await api('/api/state');
    localStorage.setItem('trae_admin', v);
    $('gate').className = 'hide';
    $('app').className = '';
    load();
  } catch(e){ toast(e.message); }
}

function stateTag(a){
  if (a.lastState === 'checked') return 'ok|已签到';
  if (a.lastState === 'token_dead') return 'err|需重新扫码';
  if (a.cooldownUntil && a.cooldownUntil > Date.now()) return 'warn|冷却中';
  if (a.lastState === 'error') return 'err|失败';
  return '|待运行';
}
function fmtTime(ms){
  if (!ms) return '从未';
  var d = new Date(ms + 8 * 3600e3);
  return d.toISOString().replace('T',' ').slice(5,16);
}

async function load(){
  try {
    var s = await api('/api/state');
    var list = s.accounts || [];
    $('n_total').textContent = list.length;
    var ok = 0, bad = 0;
    list.forEach(function(a){
      if (a.lastCheckDate === s.today && a.lastState === 'checked') ok++;
      if (a.lastState === 'token_dead' || a.lastState === 'error') bad++;
    });
    $('n_ok').textContent = ok;
    $('n_bad').textContent = bad;
    $('sum_time').textContent = '服务端时间 ' + s.now + ' · 每日 ' + (s.cron || '—') + ' 自动执行';

    var cronOk = s.cronEnabled;
    $('cron_tag').className = 'tag ' + (cronOk ? 'ok' : 'warn');
    $('cron_tag').textContent = cronOk ? '已开启' : '未开启';
    $('cron_hint').textContent = cronOk ? '由定时触发器在每天固定时间运行，无需电脑开机。' : '在 Cloudflare 控制台给本 Worker 添加 Cron 触发器（见部署说明）。';

    if (!list.length) {
      $('list').innerHTML = '<div class="m" style="color:var(--sub);font-size:12px">还没有账号，点上方「扫码托管」开始。</div>';
      return;
    }
    var html = '';
    list.forEach(function(a){
      var t = stateTag(a).split('|');
      html += '<div class="acct">'
        + '<div class="h"><div class="n">' + esc(a.label || a.id) + ' <span class="tag ' + t[0] + '">' + t[1] + '</span></div>'
        + '<div style="font-size:12px;color:var(--sub)">' + (a.credits == null ? '—' : a.credits + ' 分') + '</div></div>'
        + '<div class="m">' + esc(a.lastMsg || '等待首次运行') + ' · 上次 ' + fmtTime(a.lastRun) + '</div>'
        + '<div class="ops">'
        + '<button onclick="runOne(\'' + a.id + '\')">立即签到</button>'
        + '<button class="dg" onclick="delOne(\'' + a.id + '\',\'' + esc(a.label || '') + '\')">删除</button>'
        + '</div></div>';
    });
    $('list').innerHTML = html;
  } catch(e){ toast(e.message); }
}

function toggleAdd(){ var b = $('addbox'); b.className = b.className === 'hide' ? '' : 'hide'; }

async function genLink(){
  $('btn_gen').disabled = true;
  try {
    var r = await api('/api/accounts/start', { method: 'POST' });
    TRACE = r.trace;
    $('authurl').textContent = r.authUrl;
    $('linkbox').className = '';
    toast('链接已生成，15 分钟内有效');
  } catch(e){ toast(e.message); }
  $('btn_gen').disabled = false;
}

async function pasteUrl(){
  var u = $('cburl').value.trim();
  if (!u) return toast('请粘贴回调地址');
  $('btn_paste').disabled = true;
  try {
    var r = await api('/api/accounts/paste', { method: 'POST', body: { url: u, trace: TRACE, label: $('label').value.trim() } });
    toast('托管成功：' + (r.label || r.id));
    $('cburl').value = ''; $('label').value = ''; $('linkbox').className = 'hide'; $('addbox').className = 'hide';
    load();
  } catch(e){ toast(e.message); }
  $('btn_paste').disabled = false;
}

async function runAll(){
  $('btn_run').disabled = true; $('btn_run').textContent = '运行中…';
  try {
    var r = await api('/api/run', { method: 'POST', body: { force: false } });
    toast('成功 ' + r.checked + ' · 已签 ' + r.already + ' · 失败 ' + r.failed);
    load();
  } catch(e){ toast(e.message); }
  $('btn_run').disabled = false; $('btn_run').textContent = '全部签到';
}

async function runOne(id){
  try {
    var r = await api('/api/accounts/' + id + '/run', { method: 'POST' });
    toast(r.label + '：' + r.msg);
    load();
  } catch(e){ toast(e.message); }
}

async function delOne(id, label){
  if (!confirm('删除账号「' + label + '」？本地不会删除你的 Trae 登录，只是不再托管。')) return;
  try { await api('/api/accounts/' + id, { method: 'DELETE' }); toast('已删除'); load(); }
  catch(e){ toast(e.message); }
}

(function init(){
  if (T) {
    api('/api/state').then(function(){
      $('gate').className = 'hide';
      $('app').className = '';
      load();
    }).catch(function(){});
  }
})();
</script>
</body>
</html>`;
}
/* ------------------------------------------------------------------ */
/* 路由                                                               */
/* ------------------------------------------------------------------ */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Cron-Secret',
  };
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() },
  });
}

function authOk(req, env, url) {
  const want = String(env.ADMIN_TOKEN || '').trim();
  if (!want) return { ok: false, why: '服务端未设置 ADMIN_TOKEN' };
  const h = req.headers.get('Authorization') || '';
  const bearer = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  const q = url ? String(url.searchParams.get('key') || '').trim() : '';
  const got = bearer || q;
  if (!got) return { ok: false, why: '需要口令' };
  if (!timingSafeEqual(got, want)) return { ok: false, why: '口令不正确' };
  return { ok: true };
}

/** 对外展示的账号视图：绝不带 token / 私钥 */
function publicView(acct, today) {
  return {
    id: acct.id,
    label: acct.label,
    lastState: acct.lastState,
    lastMsg: acct.lastMsg,
    lastRun: acct.lastRun,
    lastCheckDate: acct.lastCheckDate,
    lastCredit: acct.lastCredit,
    credits: acct.credits,
    cooldownUntil: acct.cooldownUntil,
    createdAt: acct.createdAt,
    ok: acct.lastCheckDate === today && acct.lastState === 'checked',
  };
}

async function handleStart(req, env) {
  const device = await genDeviceIdentity();
  const pkce = await pkcePair();
  const trace = randomId(12);
  const deviceId = genDeviceId();
  const machineId = genDeviceId();
  const clientId = CLIENT_ID;
  const platform = 'IDE_PC';
  const authUrl = buildAuthorizeUrl({
    clientId,
    trace,
    callback: CALLBACK_LOCAL,
    machineId,
    deviceId,
    challenge: pkce.challenge,
  });

  await putLoginSession(env, {
    trace,
    deviceId,
    machineId,
    verifier: pkce.verifier,
    clientId,
    platform,
    device,
    createdAt: Date.now(),
  });

  return jsonResp({ trace, authUrl, callback: CALLBACK_LOCAL, ttl: LOGIN_TTL });
}

async function handlePaste(req, env, body) {
  const raw = String(body.url || '').trim();
  if (!raw) return jsonResp({ error: '缺少回调地址' }, 400);

  let parsed;
  try {
    parsed = parseCallbackParams(raw);
  } catch (e) {
    return jsonResp({ error: e.message }, 400);
  }

  // 定位这次登录上下文：优先前端带回的 trace，其次回调里的 trace，最后取最新一条
  const store = await kv(env);
  let trace = String(body.trace || '').trim() || parsed.trace;
  if (!trace) trace = String((await store.get('login:latest')) || '');
  let sess = trace ? await getLoginSession(env, trace) : null;
  if (!sess) {
    const latest = String((await store.get('login:latest')) || '');
    if (latest && latest !== trace) sess = await getLoginSession(env, latest);
  }
  if (!sess) return jsonResp({ error: '登录上下文已过期（15 分钟），请重新生成登录链接' }, 400);

  const clientId = parsed.clientId || sess.clientId || CLIENT_ID;
  const platform = sess.platform || 'IDE_PC';
  const device = {
    deviceId: sess.deviceId,
    machineId: sess.machineId,
    privateKeyPem: sess.device && sess.device.privateKeyPem,
    publicKeyPem: sess.device && sess.device.publicKeyPem,
  };

  let refreshToken = parsed.refreshToken;
  let nick = parsed.name;

  if (!refreshToken) {
    if (!parsed.authCode) return jsonResp({ error: '回调地址里没有授权码' }, 400);
    let ex;
    try {
      ex = await exchangeAuthCode({
        authCode: parsed.authCode,
        verifier: sess.verifier,
        device,
        clientId,
        platform,
        host: parsed.host,
      });
    } catch (e) {
      return jsonResp({ error: e.message }, 400);
    }
    refreshToken = ex.tokens.refreshToken;
    nick = ex.name || nick;
  }

  const acct = await saveScannedAccount(env, {
    label: body.label || nick,
    refreshToken,
    device,
    clientId,
    platform,
  });

  await store.delete(loginKey(sess.trace));

  // 立刻跑一次，把「能不能用」当场验证
  const fresh = await getAccount(env, acct.id);
  const first = fresh ? await checkOne(env, fresh, true) : null;

  return jsonResp({ id: acct.id, label: acct.label, first });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    // 控制台页面
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(renderPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // 定时触发器的手动入口（供外部 cron / UptimeRobot 调用）
    if (url.pathname === '/cron') {
      const secret = String(env.CRON_SECRET || '').trim();
      const got = String(req.headers.get('X-Cron-Secret') || url.searchParams.get('secret') || '').trim();
      if (secret && !timingSafeEqual(got, secret)) return jsonResp({ error: '密钥不正确' }, 401);
      if (!secret) return jsonResp({ error: '服务端未设置 CRON_SECRET' }, 400);
      const r = await runAll(env, false);
      return jsonResp(r);
    }

    if (!url.pathname.startsWith('/api/')) return jsonResp({ error: 'not found' }, 404);

    // 登录口令校验（口令本身不落库）
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = {};
      try {
        body = await req.json();
      } catch {
        /* 空体 */
      }
      const want = String(env.ADMIN_TOKEN || '').trim();
      if (!want) return jsonResp({ error: '服务端未设置 ADMIN_TOKEN' }, 400);
      if (!timingSafeEqual(String(body.token || '').trim(), want)) return jsonResp({ error: '口令不正确' }, 401);
      return jsonResp({ ok: true });
    }

    const auth = authOk(req, env, url);
    if (!auth.ok) return jsonResp({ error: auth.why }, 401);

    if (url.pathname === '/api/state' && req.method === 'GET') {
      const list = await listIndex(env);
      const accounts = [];
      for (const item of list) {
        const a = await getAccount(env, item.id);
        if (a) accounts.push(publicView(a, todayCN()));
      }
      accounts.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
      return jsonResp({
        accounts,
        today: todayCN(),
        now: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19) + ' +08:00',
        cron: '08:10',
        cronEnabled: String(env.CRON_ENABLED || '') === '1',
      });
    }

    if (url.pathname === '/api/accounts/start' && req.method === 'POST') {
      return handleStart(req, env);
    }

    if (url.pathname === '/api/accounts/paste' && req.method === 'POST') {
      let body = {};
      try {
        body = await req.json();
      } catch {
        return jsonResp({ error: '请求体不是 JSON' }, 400);
      }
      return handlePaste(req, env, body);
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      let body = {};
      try {
        body = await req.json();
      } catch {
        /* 允许空体 */
      }
      return jsonResp(await runAll(env, !!body.force));
    }

    const mOne = url.pathname.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)\/run$/);
    if (mOne && req.method === 'POST') {
      const acct = await getAccount(env, mOne[1]);
      if (!acct) return jsonResp({ error: '账号不存在' }, 404);
      return jsonResp(await checkOne(env, acct, true));
    }

    const mDel = url.pathname.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)$/);
    if (mDel && req.method === 'DELETE') {
      await delAccount(env, mDel[1]);
      return jsonResp({ ok: true });
    }

    return jsonResp({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAll(env, false).catch((e) => {
        console.log('[cron] 失败', e && e.message);
      })
    );
  },
};