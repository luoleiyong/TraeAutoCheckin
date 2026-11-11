#!/usr/bin/env node
// checkin.mjs — Trae CN 自动签到 / 积分领取 CLI
// 用法:
//   node src/checkin.mjs            仅签到（默认）
//   node src/checkin.mjs status     查看签到状态 / 活动 / 额度
//   node src/checkin.mjs run --grants   签到 + 自动领取所有可领活动奖励
//   node src/checkin.mjs watch      常驻，每天定时签到
//   node src/checkin.mjs token      导出当前本地 Token（调试用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAuthContext, ensureFreshAuth, tokenExpired, refreshAuth, persistAuth } from "./trae-auth.mjs";
import { TraeApi, EP } from "./trae-api.mjs";
import { loadDb, saveDb, findAccount, removeAccount, parseJwt, deriveMarketUserId, upsertAccount } from "./trae-accounts.mjs";
import { checkinAccount, checkinAll, importCurrent, addFromToken } from "./trae-checkin-core.mjs";
import { businessDay, sleep, homeDataDir, setUserDataDir, userDataDir, storagePath, resolveTraeExe, candidateUserDataDirs, readStorage, detectDeviceId } from "./trae-platform.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) || "run";
const flag = (name) => argv.includes("--" + name);
const opt = (name, def = null) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

setUserDataDir(opt("userdata"));
const AS_JSON = flag("json");
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}`;
  if (!AS_JSON) console.log(line);
  try { fs.appendFileSync(path.join(LOG_DIR, "checkin.log"), line + "\n"); } catch { /* ignore */ }
}
function out(obj) {
  if (AS_JSON) console.log(JSON.stringify(obj, null, 2));
  else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") console.log(`  ${k}: ${JSON.stringify(v)}`);
      else console.log(`  ${k}: ${v}`);
    }
  }
}

async function withApi(fn) {
  const ctx = await loadAuthContext();
  const fresh = await ensureFreshAuth(ctx, { allowRefresh: !flag("no-refresh"), log });
  const api = new TraeApi({ auth: fresh.auth, deviceId: fresh.deviceId });
  return fn(api, fresh);
}

function dayStatePath() { return path.join(LOG_DIR, `state-${businessDay()}.json`); }
function readDayState() {
  const p = dayStatePath();
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function writeDayState(obj) {
  try { fs.writeFileSync(dayStatePath(), JSON.stringify(obj, null, 2)); } catch { /* ignore */ }
}

// ---------------- commands ----------------

async function cmdEnv() {
  const ud = userDataDir();
  const sp = storagePath();
  let deviceId = "";
  let ok = false;
  try { deviceId = detectDeviceId(readStorage()); ok = true; } catch { ok = false; }
  const result = {
    userDataDir: ud,
    storagePath: sp,
    storageExists: fs.existsSync(sp),
    candidateDirs: candidateUserDataDirs(),
    traeExe: resolveTraeExe(),
    nodeExe: process.execPath,
    isElectron: !!process.versions.electron,
    deviceId,
    readable: ok
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
async function cmdStatus() {
  return withApi(async (api, ctx) => {
    const st = await api.checkinStatus();
    const info = await api.activityInfo();
    const usage = await api.entUsage();
    const d = st.data || {};
    const result = {
      user: ctx.auth.account?.username || "",
      userId: ctx.auth.userId,
      checkin: { enable: d.enable, checked_in: d.checked_in, credits: d.credits, extra_credits: d.extra_credits, code: d.code, message: d.message },
      token: { expired: tokenExpired(ctx.auth), expiredAt: ctx.auth.expiredAt },
      activities: (info.data?.commercial_activities || []).map((a) => ({
        id: a.activity_id, type: a.activity_type, enabled: a.Enabled, work_extra: a.work_extra
      })),
      usage: usage.data?.usage_summary
    };
    if (AS_JSON) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`账号: ${result.user} (${result.userId})`);
      console.log(`Token: ${result.token.expired ? "已过期" : "有效"}  到期: ${result.token.expiredAt}`);
      console.log(`签到: enable=${d.enable} checked_in=${d.checked_in} credits=${d.credits} extra=${d.extra_credits} (code=${d.code})`);
      console.log(`额度: ${JSON.stringify(result.usage)}`);
      console.log("活动:");
      for (const a of result.activities) console.log(`  - ${a.id} type=${a.type} enabled=${a.enabled} ${JSON.stringify(a.work_extra || {})}`);
    }
    return result;
  });
}

async function cmdToken() {
  const ctx = await loadAuthContext();
  if (AS_JSON) console.log(JSON.stringify({ token: ctx.auth.token, refreshToken: ctx.auth.refreshToken, expiredAt: ctx.auth.expiredAt, userId: ctx.auth.userId, deviceId: ctx.deviceId, host: ctx.auth.host }, null, 2));
  else console.log(ctx.auth.token);
  return { ok: true };
}

async function claimCheckin(api) {
  log("开始每日签到…");
  const before = await api.checkinStatus();
  const b = before.data || {};
  if (b.enable === false) {
    log(`签到活动当前未开启（enable=false, code=${b.code}）: ${b.message || ""}`);
    return { claimed: false, enable: false, before: b };
  }
  if (b.checked_in === true) {
    log(`今天已签到（credits=${b.credits}），跳过领取`);
    return { claimed: false, already: true, before: b };
  }
  const claim = await api.checkinClaim();
  const c = claim.data || {};
  const ok = claim.status === 200 && (c.code === 0 || c.code === undefined);
  log(ok ? `签到成功: ${JSON.stringify(c)}` : `签到失败 HTTP ${claim.status}: ${JSON.stringify(c)}`);

  // IDE 签到成功后会顺带参与 checkin_1024 抽奖（服务端未开启时返回 9090，忽略）
  try {
    const lottery = await api.activityAction("checkin_1024");
    log(`checkin_1024 抽奖: ${JSON.stringify(lottery.data)}`);
  } catch (e) {
    log(`checkin_1024 抽奖请求异常: ${e.message}`);
  }

  const after = await api.checkinStatus();
  return { claimed: ok, before: b, after: after.data };
}

async function collectGrants(api) {
  const info = await api.activityInfo();
  const acts = info.data?.commercial_activities || [];
  const results = [];
  for (const a of acts) {
    const id = a.activity_id;
    const we = a.work_extra || {};
    if (a.Enabled === false) continue;
    if (we.granted === true) { results.push({ id, skipped: "already granted" }); continue; }

    let r = null;
    try {
      if (a.activity_type === 103) {
        r = id.startsWith("code_fission") ? await api.codeFissionGrant(id) : await api.workFissionGrant(id);
      } else if (a.activity_type === 101) {
        r = await api.grantWorkBenefit();
      } else if (a.activity_type === 104 || a.activity_type === 102 || a.activity_type === 105 || a.activity_type === 106 || a.activity_type === 107) {
        if (we.grantable !== true && we.auto_grant !== true) { results.push({ id, skipped: "not grantable" }); continue; }
        r = await api.activityAction(id);
      } else {
        results.push({ id, skipped: `unsupported type ${a.activity_type}` });
        continue;
      }
      results.push({ id, status: r.status, data: r.data });
      log(`活动 ${id}: ${JSON.stringify(r.data)}`);
    } catch (e) {
      results.push({ id, error: e.message });
      log(`活动 ${id} 请求异常: ${e.message}`);
    }
  }
  return results;
}

async function cmdRun() {
  return withApi(async (api, ctx) => {
    const res = await claimCheckin(api);
    const state = readDayState();
    state[businessDay()] = { at: new Date().toISOString(), checkin: res };

    let grants = null;
    if (flag("grants") || flag("grant")) {
      log("领取可领活动奖励…");
      grants = await collectGrants(api);
      state[businessDay()].grants = grants;
    }

    const st = await api.checkinStatus();
    state[businessDay()].final = st.data;
    writeDayState(state);

    const summary = {
      user: ctx.auth.account?.username || "",
      checked_in: st.data?.checked_in,
      credits: st.data?.credits,
      extra_credits: st.data?.extra_credits,
      claimed: res.claimed,
      enable: st.data?.enable
    };
    log(`完成: checked_in=${summary.checked_in} credits=${summary.credits} extra=${summary.extra_credits}`);
    if (AS_JSON) console.log(JSON.stringify({ ...summary, checkin: res, grants }, null, 2));
    return summary;
  });
}

async function cmdWatch() {
  const hhmm = opt("at", "09:05");
  log(`常驻模式启动，每日 ${hhmm} 执行签到（Ctrl+C 退出）`);
  const runOnce = async () => { try { await cmdRun(); } catch (e) { log("执行失败: " + e.message); } };
  await runOnce();
  for (;;) {
    const now = new Date();
    const [h, m] = hhmm.split(":").map(Number);
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const wait = next - now;
    log(`下次执行: ${next.toLocaleString()} (${Math.round(wait / 60000)} 分钟后)`);
    await sleep(wait);
    await runOnce();
  }
}

async function cmdTestToken() {
  return withApi(async (api) => {
    const r = await api.post(EP.CHECKIN_STATUS, { req_source: 1 }, { retry: 0 });
    console.log(JSON.stringify(r, null, 2));
  });
}

async function cmdRefresh() {
  const ctx = await loadAuthContext();
  log("强制刷新本地 Token…");
  const auth = await refreshAuth(ctx);
  const { backup } = await persistAuth(ctx.storage, auth);
  log(`刷新成功，新到期时间 ${auth.expiredAt}，已回写 storage.json（备份 ${backup}）`);
  const api = new TraeApi({ auth, deviceId: ctx.deviceId });
  const st = await api.checkinStatus();
  const result = { ok: st.data?.code === 0, expiredAt: auth.expiredAt, backup, status: st.data };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function emitKv(pairs) {
  for (const k of Object.keys(pairs)) console.log(k + "=" + (pairs[k] === undefined || pairs[k] === null ? "" : String(pairs[k])));
}

async function cmdEnvKv() {
  const ud = userDataDir();
  const sp = storagePath();
  let deviceId = "";
  let ok = false;
  try { deviceId = detectDeviceId(readStorage()); ok = true; } catch { ok = false; }
  emitKv({
    USER_DATA_DIR: ud,
    STORAGE_PATH: sp,
    STORAGE_EXISTS: fs.existsSync(sp) ? "true" : "false",
    TRAE_EXE: resolveTraeExe(),
    NODE_EXE: process.execPath,
    IS_ELECTRON: process.versions.electron ? "true" : "false",
    DEVICE_ID: deviceId,
    READABLE: ok ? "true" : "false",
    HOST: "https://api.trae.cn"
  });
  return { ok };
}

async function cmdBrief() {
  return withApi(async (api, ctx) => {
    const st = await api.checkinStatus();
    const d = st.data || {};
    emitKv({
      ACCOUNT: ctx.auth.account?.username || "",
      SCOPE: ctx.auth.account?.scope || "",
      USER_ID: ctx.auth.userId || "",
      DEVICE_ID: ctx.deviceId || "",
      TOKEN_EXPIRED: tokenExpired(ctx.auth) ? "true" : "false",
      TOKEN_EXP: ctx.auth.expiredAt || "",
      REFRESH_EXP: ctx.auth.refreshExpiredAt || "",
      ENABLE: d.enable === true ? "true" : "false",
      CHECKED_IN: d.checked_in === true ? "true" : "false",
      CREDITS: d.credits ?? "",
      EXTRA_CREDITS: d.extra_credits ?? "",
      CODE: d.code ?? "",
      MESSAGE: d.message || "",
      HTTP: st.status
    });
    try { syncCurrentAccount(ctx, { CREDITS: d.credits, CHECKED_IN: d.checked_in ? "true" : "false", ENABLE: d.enable ? "true" : "false" }); } catch { /* ignore */ }
    return { ok: d.code === 0 };
  });
}
// ---------------- 多账号 ----------------

function syncCurrentAccount(ctx, briefKv) {
  try {
    const parsed = parseJwt(ctx.auth.token);
    const userId = ctx.auth.userId || (parsed && parsed.userId) || "";
    if (!userId) return null;
    const db = loadDb();
    const old = findAccount(db, userId) || {};
    const acc = {
      ...old,
      userId,
      name: (ctx.auth.account && ctx.auth.account.username) || old.name || userId,
      scope: (ctx.auth.account && ctx.auth.account.scope) || old.scope || "marscode",
      token: ctx.auth.token,
      refreshToken: ctx.auth.refreshToken || old.refreshToken || "",
      expiredAt: ctx.auth.expiredAt || (parsed && parsed.exp) || old.expiredAt || "",
      refreshExpiredAt: ctx.auth.refreshExpiredAt || old.refreshExpiredAt || "",
      host: ctx.auth.host || "https://api.trae.cn",
      deviceId: ctx.deviceId || old.deviceId || "",
      marketUserId: old.marketUserId || deriveMarketUserId(userId),
      isCurrent: true,
      addedAt: old.addedAt || new Date().toISOString(),
      syncedAt: new Date().toISOString()
    };
    for (const a of db.accounts) a.isCurrent = a.userId === userId;
    if (briefKv) {
      if (briefKv.CREDITS !== "" && briefKv.CREDITS !== undefined) {
        const n = Number(briefKv.CREDITS);
        if (Number.isFinite(n)) acc.credits = n;
      }
      if (briefKv.CHECKED_IN === "true") acc.lastStatus = "already";
      else if (briefKv.ENABLE === "true") acc.lastStatus = "pending";
    }
    upsertAccount(db, acc);
    saveDb(db);
    return acc;
  } catch { return null; }
}

async function cmdImport() {
  const ctx = await loadAuthContext();
  const acc = importCurrent(ctx);
  log("已导入账号 " + acc.name + " (" + acc.userId + ")");
  if (AS_JSON) console.log(JSON.stringify(acc, null, 2));
  return acc;
}

function cmdAccountsKv() {
  const db = loadDb();
  console.log("COUNT=" + db.accounts.length);
  let i = 0;
  for (const a of db.accounts) {
    i++;
    const cooldown = a.cooldownUntil && Date.now() < a.cooldownUntil ? "1" : "0";
    const fields = [
      a.userId || "",
      (a.name || "").replace(/\|/g, "/"),
      typeof a.credits === "number" ? String(a.credits) : "",
      a.lastStatus || "",
      a.isCurrent ? "1" : "0",
      cooldown,
      a.expiredAt || ""
    ];
    console.log("ACC" + i + "=" + fields.join("|"));
  }
  return { ok: true, count: db.accounts.length };
}

function cmdAccounts() {
  const db = loadDb();
  if (AS_JSON) { console.log(JSON.stringify(db.accounts, null, 2)); return { ok: true, count: db.accounts.length }; }
  if (!db.accounts.length) {
    console.log("账号库为空。先运行本程序一次（或 import）导入当前登录账号。");
    return { ok: true, count: 0 };
  }
  console.log("账号列表：");
  for (const a of db.accounts) {
    const exp = a.expiredAt ? new Date(a.expiredAt).toLocaleDateString() : "-";
    const cd = a.cooldownUntil && Date.now() < a.cooldownUntil ? " [冷却]" : "";
    console.log("  " + (a.isCurrent ? "* " : "  ") + a.name + " (" + a.userId + ")  积分=" +
      (a.credits === undefined ? "-" : a.credits) + "  状态=" + (a.lastStatus || "-") + cd + "  到期=" + exp);
  }
  return { ok: true, count: db.accounts.length };
}

function cmdAdd() {
  const token = opt("token");
  if (!token) throw new Error("用法: add --token <JWT> [--name 名称]");
  const acc = addFromToken(token, { name: opt("name") });
  log("已添加账号 " + acc.name + " (" + acc.userId + ")");
  if (AS_JSON) console.log(JSON.stringify(acc, null, 2));
  return acc;
}

function cmdRemove() {
  const id = opt("id") || opt("account");
  if (!id) throw new Error("用法: remove --id <userId>");
  const db = loadDb();
  const acc = findAccount(db, id);
  if (!acc) throw new Error("账号不存在: " + id);
  removeAccount(db, acc.userId);
  saveDb(db);
  log("已删除账号 " + acc.name);
  return { ok: true };
}

async function cmdRunAll() {
  const interval = Number(opt("interval", "1500"));
  const results = await checkinAll({ grants: flag("grants"), intervalMs: interval, log });
  const ok = results.filter((r) => r.ok).length;
  log("批量完成：成功 " + ok + " / " + results.length);
  if (AS_JSON) console.log(JSON.stringify(results, null, 2));
  return { ok: true, total: results.length, success: ok };
}

async function cmdRunAccount() {
  const id = opt("account");
  if (!id) throw new Error("用法: run --account <userId>");
  const db = loadDb();
  const acc = findAccount(db, id);
  if (!acc) throw new Error("账号不存在: " + id);
  const r = await checkinAccount(acc, { grants: flag("grants"), log });
  acc.lastRunAt = r.at;
  acc.lastStatus = r.status;
  acc.lastHint = r.hint;
  if (typeof r.credits === "number") acc.credits = r.credits;
  upsertAccount(db, acc);
  saveDb(db);
  if (AS_JSON) console.log(JSON.stringify(r, null, 2));
  return r;
}

const commands = {
  env: cmdEnv,
  import: cmdImport,
  accounts: cmdAccounts,
  accountskv: cmdAccountsKv,
  add: cmdAdd,
  remove: cmdRemove,
  runall: cmdRunAll,
  account: cmdRunAccount,
  envkv: cmdEnvKv,
  brief: cmdBrief,
  run: cmdRun,
  refresh: cmdRefresh,
  status: cmdStatus,
  claim: cmdRun,
  grant: async () => withApi(async (api) => console.log(JSON.stringify(await collectGrants(api), null, 2))),
  watch: cmdWatch,
  token: cmdToken,
  probe: cmdTestToken
};

const main = commands[cmd] || cmdRun;
Promise.resolve().then(() => main()).then((r) => {
  if (r && r.ok === false) process.exitCode = 1;
}).catch((e) => {
  log("错误: " + (e?.stack || e?.message || e));
  if (!AS_JSON) console.error("错误: " + (e?.message || e));
  else console.log(JSON.stringify({ ok: false, error: e?.message || String(e) }));
  process.exitCode = 1;
});



