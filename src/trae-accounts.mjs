// trae-accounts.mjs — 多账号库 / 积分历史 / 错误分类 / 连续签到统计
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDir, ensureDataDir, businessDay } from "./trae-platform.mjs";

export function accountsPath() { return path.join(ensureDataDir(), "accounts.json"); }
export function historyPath() { return path.join(ensureDataDir(), "credits-history.json"); }

function readJson(p, def) {
  try {
    if (!fs.existsSync(p)) return def;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return def; }
}
function writeJson(p, obj) {
  try {
    ensureDataDir();
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, p);
  } catch { /* ignore */ }
}

export function loadDb() {
  const db = readJson(accountsPath(), { version: 2, accounts: [] });
  if (!Array.isArray(db.accounts)) db.accounts = [];
  return db;
}
export function saveDb(db) { writeJson(accountsPath(), db); }

export function findAccount(db, key) {
  if (!key) return null;
  const k = String(key).trim();
  return db.accounts.find((a) => a.userId === k || a.name === k || (a.name && a.name.toLowerCase() === k.toLowerCase())) || null;
}

export function upsertAccount(db, acc) {
  const i = db.accounts.findIndex((a) => a.userId === acc.userId);
  if (i >= 0) db.accounts[i] = { ...db.accounts[i], ...acc };
  else db.accounts.push(acc);
  return db.accounts[i >= 0 ? i : db.accounts.length - 1];
}

export function removeAccount(db, userId) {
  const before = db.accounts.length;
  db.accounts = db.accounts.filter((a) => a.userId !== userId);
  return before !== db.accounts.length;
}

// ---------------- JWT ----------------

export function stripBearer(token) {
  let t = String(token || "").trim().replace(/^["']|["']$/g, "");
  if (/^Cloud-IDE-JWT\s+/i.test(t)) t = t.replace(/^Cloud-IDE-JWT\s+/i, "");
  if (/^Bearer\s+/i.test(t)) t = t.replace(/^Bearer\s+/i, "");
  return t.trim();
}

export function parseJwt(token) {
  const t = stripBearer(token);
  const parts = t.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const data = payload.data || {};
    const userId = data.id || data.user_id || payload.auth_id || payload.sub || "";
    const exp = payload.exp ? new Date(payload.exp * 1000).toISOString() : "";
    return { userId: String(userId), exp, raw: payload };
  } catch { return null; }
}

/** 确定性 UUID v4：同一 userId 永远得到同一个 market_user_id */
export function deriveMarketUserId(userId) {
  const h = crypto.createHash("sha256").update("market|" + String(userId)).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveSessionId(userId) {
  return crypto.createHash("sha256").update("sess|" + String(userId)).digest("hex");
}

// ---------------- 错误分类（对齐官方行为） ----------------

export function classifyError(httpStatus, code, message) {
  const c = typeof code === "number" ? code : null;
  if (httpStatus === 200 && c === 1005) {
    return { type: "PlanLimit", cooldown: 43200, hint: "当前套餐不支持签到（冷却 12 小时）" };
  }
  if (httpStatus === 429) return { type: "RateLimit", cooldown: 60, hint: "请求过于频繁，稍后自动重试" };
  if (httpStatus === 401) return { type: "SessionDead", cooldown: -1, hint: "登录态已失效，需要重新登录 Trae" };
  if (httpStatus === 404) return { type: "NotFound", cooldown: 60, hint: "接口不存在（版本可能已变更）" };
  if (c === 1001) return { type: "Unauthorized", cooldown: -1, hint: "Token 无效或已过期" };
  if (httpStatus === 0) return { type: "Network", cooldown: 60, hint: "网络异常" };
  if (httpStatus >= 500) return { type: "Server", cooldown: 600, hint: "服务端错误（冷却 10 分钟）" };
  if (httpStatus >= 400) return { type: "Client", cooldown: 600, hint: "请求被拒绝（冷却 10 分钟）" };
  if (c !== null && c !== 0) return { type: "Business", cooldown: 300, hint: message || "业务错误" };
  return { type: "Unknown", cooldown: 0, hint: message || "" };
}

// ---------------- 积分历史 ----------------

export function loadHistory() {
  const d = readJson(historyPath(), { records: [] });
  if (!Array.isArray(d.records)) d.records = [];
  return d;
}

export function recordCredits(userId, credits, delta) {
  if (typeof credits !== "number" || !Number.isFinite(credits)) return;
  const d = loadHistory();
  const today = businessDay();
  const recs = d.records.filter((r) => !(r.date === today && r.userId === userId));
  recs.push({ date: today, userId, credits, delta: typeof delta === "number" ? delta : 0, at: new Date().toISOString() });
  // 保留 120 天
  const cutoff = businessDay(new Date(Date.now() - 120 * 86400000));
  d.records = recs.filter((r) => (r.date || "") >= cutoff);
  writeJson(historyPath(), d);
}

export function creditsForDay(userId, day) {
  const d = loadHistory();
  const r = d.records.find((x) => x.userId === userId && x.date === day);
  return r ? r.credits : null;
}

/** 连续签到天数：从今天往前，连续存在记录的天数 */
export function streakDays(userId) {
  const d = loadHistory();
  const set = new Set(d.records.filter((r) => r.userId === userId).map((r) => r.date));
  let n = 0;
  let cursor = new Date();
  // 今天没记录时从昨天开始算，避免早上还没签到时把连续打断
  if (!set.has(businessDay(cursor))) cursor = new Date(cursor.getTime() - 86400000);
  for (;;) {
    const day = businessDay(cursor);
    if (!set.has(day)) break;
    n++;
    cursor = new Date(cursor.getTime() - 86400000);
    if (n > 400) break;
  }
  return n;
}

/** 最近 N 天的积分序列（用于趋势） */
export function creditsSeries(userId, days) {
  const n = days || 7;
  const d = loadHistory();
  const byDay = new Map();
  for (const r of d.records) if (r.userId === userId) byDay.set(r.date, r.credits);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = businessDay(new Date(Date.now() - i * 86400000));
    out.push({ date: day, credits: byDay.has(day) ? byDay.get(day) : null });
  }
  return out;
}