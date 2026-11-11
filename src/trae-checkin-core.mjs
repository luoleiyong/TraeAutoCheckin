// trae-checkin-core.mjs — 单账号 / 多账号签到流程（含错误分类、冷却、积分记录）
import { TraeApi } from "./trae-api.mjs";
import {
  loadDb, saveDb, findAccount, upsertAccount, parseJwt, deriveMarketUserId,
  classifyError, recordCredits, streakDays, loadHistory
} from "./trae-accounts.mjs";
import { businessDay } from "./trae-platform.mjs";

export function accountToAuth(acc) {
  return {
    token: acc.token,
    refreshToken: acc.refreshToken || "",
    userId: acc.userId,
    host: acc.host || "https://api.trae.cn",
    expiredAt: acc.expiredAt || "",
    refreshExpiredAt: acc.refreshExpiredAt || "",
    account: { username: acc.name || "", scope: acc.scope || "marscode" }
  };
}

function makeApi(acc) {
  return new TraeApi({
    auth: accountToAuth(acc),
    deviceId: acc.deviceId || "",
    marketUserId: acc.marketUserId || deriveMarketUserId(acc.userId)
  });
}

/** 单账号签到：返回结构化结果，不抛异常 */
export async function checkinAccount(acc, opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const day = businessDay();
  const out = {
    userId: acc.userId,
    name: acc.name || acc.userId,
    ok: false,
    status: "unknown",
    claimed: false,
    credits: null,
    delta: 0,
    errorType: "",
    hint: "",
    message: "",
    streak: 0,
    at: new Date().toISOString()
  };

  // 冷却中直接跳过
  if (acc.cooldownUntil && Date.now() < acc.cooldownUntil) {
    out.status = "cooldown";
    out.errorType = acc.errorType || "Cooldown";
    out.hint = "冷却中，预计 " + new Date(acc.cooldownUntil).toLocaleString() + " 后重试";
    return out;
  }

  const api = makeApi(acc);
  let httpStatus = 0;
  let code = null;
  let message = "";

  try {
    const st = await api.checkinStatus();
    httpStatus = st.status;
    const d = st.data || {};
    code = typeof d.code === "number" ? d.code : null;
    message = d.message || "";

    if (httpStatus !== 200 || (code !== null && code !== 0)) {
      const cls = classifyError(httpStatus, code, message);
      out.status = "error";
      out.errorType = cls.type;
      out.hint = cls.hint;
      out.message = message;
      applyCooldown(acc, cls, out);
      return out;
    }

    const before = typeof d.credits === "number" ? d.credits : null;
    const prevDay = loadHistory().records.find((r) => r.userId === acc.userId && r.date === day);
    const prevCredits = prevDay ? prevDay.credits : null;

    if (d.enable === false) {
      out.status = "disabled";
      out.hint = "签到活动未开启";
      out.credits = before;
      return out;
    }

    if (d.checked_in === true) {
      out.status = "already";
      out.hint = "今日已签到";
      out.credits = before;
    } else {
      log("执行签到…");
      const cl = await api.checkinClaim();
      httpStatus = cl.status;
      const cd = cl.data || {};
      code = typeof cd.code === "number" ? cd.code : null;
      if (httpStatus !== 200 || (code !== null && code !== 0)) {
        const cls = classifyError(httpStatus, code, cd.message || "");
        out.status = "error";
        out.errorType = cls.type;
        out.hint = cls.hint;
        out.message = cd.message || "";
        applyCooldown(acc, cls, out);
        return out;
      }
      out.claimed = true;
      out.status = "claimed";
      out.hint = "签到成功";
      // 顺带尝试签到抽奖活动（服务端未开启时忽略）
      if (o.lottery !== false) {
        try { await api.activityAction("checkin_1024"); } catch { /* ignore */ }
      }
    }

    // 重新取一次积分
    try {
      const again = await api.checkinStatus();
      const ad = again.data || {};
      if (typeof ad.credits === "number") out.credits = ad.credits;
      else if (typeof ad.extra_credits === "number") out.credits = ad.extra_credits;
    } catch { /* ignore */ }

    if (lastKnownCredits(acc) === null && out.credits === null) out.credits = before;

    if (typeof out.credits === "number") {
      const base = prevCredits !== null ? prevCredits : null;
      out.delta = base === null ? 0 : out.credits - base;
      recordCredits(acc.userId, out.credits, out.delta);
    }

    if (o.grants) {
      try { out.grants = await collectGrants(api, log); } catch { out.grants = []; }
    }

    out.ok = out.status === "claimed" || out.status === "already";
    out.streak = streakDays(acc.userId);
    return out;
  } catch (e) {
    const cls = classifyError(httpStatus || 0, code, e.message);
    out.status = "error";
    out.errorType = cls.type;
    out.hint = cls.hint || e.message;
    out.message = e.message;
    applyCooldown(acc, cls, out);
    return out;
  }
}

function lastKnownCredits(acc) { return typeof acc.credits === "number" ? acc.credits : null; }

function applyCooldown(acc, cls, out) {
  acc.errorType = cls.type;
  acc.lastError = out.hint || out.message || "";
  if (cls.cooldown === -1) {
    acc.cooldownUntil = Date.now() + 30 * 86400000;
  } else if (cls.cooldown > 0) {
    acc.cooldownUntil = Date.now() + cls.cooldown * 1000;
  } else {
    acc.cooldownUntil = 0;
  }
}

export async function collectGrants(api, log) {
  const info = await api.activityInfo();
  const acts = (info.data && info.data.commercial_activities) || [];
  const results = [];
  for (const a of acts) {
    const id = a.activity_id;
    const we = a.work_extra || {};
    if (a.Enabled === false) continue;
    if (we.granted === true) { results.push({ id, skipped: "already granted" }); continue; }
    try {
      let r = null;
      if (a.activity_type === 103) {
        r = id.indexOf("code_fission") === 0 ? await api.codeFissionGrant(id) : await api.workFissionGrant(id);
      } else if (a.activity_type === 101) {
        r = await api.grantWorkBenefit();
      } else if (we.grantable === true || we.auto_grant === true) {
        r = await api.activityAction(id);
      } else {
        results.push({ id, skipped: "not grantable" });
        continue;
      }
      results.push({ id, status: r.status, data: r.data });
      if (log) log("活动 " + id + ": " + JSON.stringify(r.data));
    } catch (e) {
      results.push({ id, error: e.message });
    }
  }
  return results;
}

/** 批量签到：串行 + 账号间间隔，避免触发风控 */
export async function checkinAll(opts) {
  const o = opts || {};
  const log = o.log || function () {};
  const db = loadDb();
  const targets = o.userIds && o.userIds.length
    ? db.accounts.filter((a) => o.userIds.indexOf(a.userId) >= 0)
    : db.accounts;

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const acc = targets[i];
    log("── [" + (i + 1) + "/" + targets.length + "] " + (acc.name || acc.userId));
    if (acc.expiredAt && Date.parse(acc.expiredAt) < Date.now()) {
      results.push({ userId: acc.userId, name: acc.name, ok: false, status: "expired", hint: "Token 已过期，请重新登录该账号后导入" });
      log("Token 已过期，跳过");
      continue;
    }
    const r = await checkinAccount(acc, { grants: o.grants, log });
    acc.lastRunAt = r.at;
    acc.lastStatus = r.status;
    acc.lastHint = r.hint;
    if (typeof r.credits === "number") acc.credits = r.credits;
    if (r.status === "claimed" || r.status === "already") acc.cooldownUntil = 0;
    upsertAccount(db, acc);
    saveDb(db);
    results.push(r);
    log((r.name || r.userId) + " → " + r.status + (r.hint ? "（" + r.hint + "）" : ""));
    if (i < targets.length - 1 && o.intervalMs) await new Promise((res) => setTimeout(res, o.intervalMs));
  }
  return results;
}

/** 把当前 Trae 登录态导入账号库 */
export function importCurrent(ctx) {
  const db = loadDb();
  const auth = ctx.auth;
  const parsed = parseJwt(auth.token);
  const userId = auth.userId || (parsed && parsed.userId) || "";
  if (!userId) throw new Error("无法从当前凭据解析出 userId");
  const acc = {
    userId,
    name: (auth.account && auth.account.username) || userId,
    scope: (auth.account && auth.account.scope) || "marscode",
    token: auth.token,
    refreshToken: auth.refreshToken || "",
    expiredAt: auth.expiredAt || (parsed && parsed.exp) || "",
    refreshExpiredAt: auth.refreshExpiredAt || "",
    host: auth.host || "https://api.trae.cn",
    deviceId: ctx.deviceId || "",
    marketUserId: deriveMarketUserId(userId),
    isCurrent: true,
    addedAt: new Date().toISOString()
  };
  // 只允许一个 isCurrent
  for (const a of db.accounts) a.isCurrent = a.userId === userId;
  upsertAccount(db, acc);
  saveDb(db);
  return acc;
}

/** 从粘贴的 JWT 添加账号 */
export function addFromToken(token, opts) {
  const o = opts || {};
  const parsed = parseJwt(token);
  if (!parsed || !parsed.userId) throw new Error("无法解析该 JWT，请确认复制完整（形如 eyJhbGciOi...）");
  const db = loadDb();
  const acc = {
    userId: parsed.userId,
    name: o.name || ("账号 " + parsed.userId.slice(-6)),
    scope: o.scope || "marscode",
    token: String(token).replace(/^Cloud-IDE-JWT\s+/i, "").trim(),
    refreshToken: o.refreshToken || "",
    expiredAt: parsed.exp,
    host: o.host || "https://api.trae.cn",
    deviceId: o.deviceId || "",
    marketUserId: deriveMarketUserId(parsed.userId),
    isCurrent: false,
    addedAt: new Date().toISOString()
  };
  upsertAccount(db, acc);
  saveDb(db);
  return acc;
}

export { loadDb, saveDb, findAccount, upsertAccount, streakDays, classifyError };