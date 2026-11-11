import fs from 'node:fs';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const src = fs.readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
const worker = mod.default;

class MockKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
  async list() { return { keys: [...this.m.keys()].map((name) => ({ name })) }; }
}

const kv = new MockKV();
const master = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
const env = { KV: kv, ADMIN_TOKEN: 'test-pass-123', MASTER_KEY: master, CRON_SECRET: 'cron-secret', CRON_ENABLED: '1' };

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

async function call(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const req = new Request('https://x.example' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  let json = null, text = '';
  text = await res.text();
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

console.log('\n[1] 页面与鉴权');
let r = await call('GET', '/');
ok('GET / 返回 200', r.status === 200);
ok('页面标题存在', r.text.includes('Trae 云端签到'));
ok('页面含生成链接按钮', r.text.includes('生成登录链接'));
ok('页面未残留未插值模板', !r.text.includes('${'));

r = await call('POST', '/api/login', { body: { token: 'wrong' } });
ok('错误口令 401', r.status === 401, JSON.stringify(r.json));

r = await call('POST', '/api/login', { body: { token: 'test-pass-123' } });
ok('正确口令通过', r.status === 200 && r.json.ok === true);

r = await call('GET', '/api/state');
ok('无口令访问 state 401', r.status === 401);

r = await call('GET', '/api/state', { token: 'test-pass-123' });
ok('带口令 state 200', r.status === 200);
ok('初始账号为空', Array.isArray(r.json.accounts) && r.json.accounts.length === 0);
ok('today 为 UTC+8 日期', /^\d{4}-\d{2}-\d{2}$/.test(r.json.today), r.json.today);
ok('cronEnabled 反映环境变量', r.json.cronEnabled === true);

console.log('\n[2] 登录链接生成');
r = await call('POST', '/api/accounts/start', { token: 'test-pass-123' });
ok('start 返回 200', r.status === 200, r.text.slice(0, 120));
const authUrl = r.json && r.json.authUrl || '';
ok('authUrl 指向 /authorization', authUrl.includes('www.trae.cn/authorization?'));
ok('含 PKCE challenge', authUrl.includes('code_challenge=') && authUrl.includes('code_challenge_method=S256'));
ok('含 client_id', authUrl.includes('client_id=ono9krqynydwx5'));
ok('回调固定 127.0.0.1', authUrl.includes('127.0.0.1%3A17388') || authUrl.includes('127.0.0.1:17388'));
ok('含 device_id 与 machine_id', authUrl.includes('device_id=') && authUrl.includes('machine_id='));
ok('返回 trace', typeof r.json.trace === 'string' && r.json.trace.length > 0);

console.log('\n[3] 加密存储');
const loginRaw = kv.m.get('login:' + r.json.trace);
ok('登录会话已落 KV', !!loginRaw);
ok('记录为密文前缀 v1.', String(loginRaw).startsWith('v1.'), String(loginRaw).slice(0, 12));
ok('密文不含明文 verifier', !String(loginRaw).includes('verifier'));
const parts = String(loginRaw).split('.');
ok('密文四段结构', parts.length === 4, 'segments=' + parts.length);

console.log('\n[4] 参数校验');
r = await call('POST', '/api/accounts/paste', { token: 'test-pass-123', body: { url: 'not-a-url' } });
ok('非法链接 400', r.status === 400);
r = await call('POST', '/api/accounts/paste', { token: 'test-pass-123', body: { url: 'http://127.0.0.1:17388/authorize?foo=1' } });
ok('无授权码 400', r.status === 400);

console.log('\n[5] 定时入口');
r = await call('POST', '/cron', { body: {} });
ok('无密钥 401', r.status === 401, JSON.stringify(r.json));
const req2 = new Request('https://x.example/cron', { method: 'POST', headers: { 'X-Cron-Secret': 'cron-secret' } });
const res2 = await worker.fetch(req2, env, { waitUntil() {} });
const j2 = await res2.json();
ok('正确密钥可运行', res2.status === 200 && j2.total === 0, JSON.stringify(j2));

console.log('\n[6] 404');
r = await call('GET', '/nope');
ok('未知路径 404', r.status === 404);

console.log('\n[7] 账号视图脱敏');
// 用同样的派生规则写入一条假账号，检查接口是否泄露密钥
async function sealForTest(master, obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('trae-kv-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'v1.' + b64u(salt) + '.' + b64u(iv) + '.' + b64u(new Uint8Array(ct));
}

const fakeAcct = {
  id: 'abcd12345', label: '测试号',
  refreshToken: 'SECRET_REFRESH_TOKEN_XYZ',
  accessToken: 'SECRET_ACCESS_TOKEN_XYZ',
  tokenExp: 0,
  deviceId: '123456789012345', machineId: '123456789012346',
  privateKeyPem: 'SECRET_PRIVATE_KEY_PEM',
  publicKeyPem: 'PUBLIC_KEY_PEM',
  clientId: 'ono9krqynydwx5', platformCode: 'IDE_PC',
  createdAt: Date.now(), lastState: 'checked', lastMsg: '今日已签',
  lastRun: Date.now(), lastCredit: null, credits: 120,
  cooldownUntil: 0, streak: 1, lastCheckDate: '2026-11-11',
};
kv.m.set('account:abcd12345', await sealForTest(Buffer.from(master, 'base64'), fakeAcct));
kv.m.set('accounts:index', JSON.stringify([{ id: 'abcd12345', label: '测试号', createdAt: Date.now() }]));

r = await call('GET', '/api/state', { token: 'test-pass-123' });
ok('读到 1 个账号', r.json.accounts.length === 1, JSON.stringify(r.json.accounts));
const a = r.json.accounts[0] || {};
ok('返回 label', a.label === '测试号');
ok('返回积分', a.credits === 120);
ok('不泄露 refreshToken', !r.text.includes('SECRET_REFRESH_TOKEN_XYZ'));
ok('不泄露 accessToken', !r.text.includes('SECRET_ACCESS_TOKEN_XYZ'));
ok('不泄露私钥', !r.text.includes('SECRET_PRIVATE_KEY_PEM'));
ok('不返回 deviceId', !r.text.includes('123456789012345'));

console.log('\n[8] 删除账号');
r = await call('DELETE', '/api/accounts/abcd12345', { token: 'test-pass-123' });
ok('删除返回 ok', r.status === 200 && r.json.ok === true);
r = await call('GET', '/api/state', { token: 'test-pass-123' });
ok('列表已清空', r.json.accounts.length === 0);
ok('KV 记录已删', !kv.m.has('account:abcd12345'));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);