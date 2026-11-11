// trae-api.mjs — Trae CN 签到与积分接口客户端
import crypto from "node:crypto";
import { APP_VERSION, systemInfo } from "./trae-platform.mjs";
import { deriveMarketUserId } from "./trae-accounts.mjs";

/** HTTP 头必须是 Latin-1，剔除非法字符（对齐 IDE 的 iB() 过滤） */
export function headerSafe(v) {
  return String(v ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim();
}

export const EP = {
  CHECKIN_STATUS: "/trae/api/v2/ug/checkin_credits/status",
  CHECKIN_CLAIM: "/trae/api/v2/ug/checkin_credits/claim",
  ACTIVITY_INFO: "/trae/api/v2/ug/activity/info",
  ACTIVITY_ACTION: "/trae/api/v2/ug/activity/action",
  WORK_FISSION_GRANT: "/trae/api/v2/ug/work_fission/grant",
  CODE_FISSION_GRANT: "/trae/api/v2/ug/code_fission/grant",
  GRANT_WORK_BENEFIT: "/trae/api/v2/pay/grant_work_benefit",
  PAY_STATUS: "/trae/api/v2/pay/ide_user_pay_status",
  ENT_USAGE: "/trae/api/v2/pay/ide_user_ent_usage",
  USER_INFO: "/cloudide/api/v3/trae/GetUserInfo"
};

export class TraeApi {
  constructor({ auth, deviceId, marketUserId, timeout = 30000 }) {
    this.auth = auth;
    this.deviceId = deviceId;
    this.marketUserId = marketUserId || deriveMarketUserId(auth.userId || "");
    this.base = (auth.host || "https://api.trae.cn").replace(/\/+$/, "");
    this.timeout = timeout;
    this.reqSource = 1; // 1 = IDE 客户端
  }

  headers() {
    const sys = systemInfo();
    const h = {
      "accept": "*/*",
      "accept-language": "zh-CN",
      "authorization": "Cloud-IDE-JWT " + this.auth.token,
      "content-type": "application/json",
      "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
      "x-market-client-id": "VSCode 1.107.1",
      "x-market-user-id": this.marketUserId,
      "x-user-region": "CN",
      "x-device-id": this.deviceId,
      "x-lgw-req-sdk-type": "3",
      "package-type": "stable_cn",
      "x-request-id": crypto.randomUUID(),
      "x-lscbd-aid": "787976",
      "x-app-version": APP_VERSION,
      "x-device-type": "windows"
    };
    if (sys.osVersion) h["x-os-version"] = headerSafe(sys.osVersion);
    if (sys.deviceModel) h["x-device-brand"] = headerSafe(sys.deviceModel);
    for (const k of Object.keys(h)) h[k] = headerSafe(h[k]);
    return h;
  }

  async post(apiPath, body = {}, { retry = 2, retryDelay = 1500, token } = {}) {
    const headers = this.headers();
    if (token) headers["x-cloudide-token"] = token;
    let lastErr;
    for (let attempt = 0; attempt <= retry; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeout);
      try {
        const res = await fetch(this.base + apiPath, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: ac.signal
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, ok: res.ok, data, raw: text };
      } catch (e) {
        lastErr = e;
        if (attempt < retry) await new Promise((r) => setTimeout(r, retryDelay));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // ---- 签到 ----
  checkinStatus() { return this.post(EP.CHECKIN_STATUS, { req_source: this.reqSource }); }
  checkinClaim() { return this.post(EP.CHECKIN_CLAIM, { req_source: this.reqSource }, { retry: 0 }); }

  // ---- 活动 ----
  activityInfo() { return this.post(EP.ACTIVITY_INFO, { version_code: APP_VERSION, req_source: this.reqSource }); }
  activityAction(activityId, extra = {}) {
    return this.post(EP.ACTIVITY_ACTION, { ...extra, activity_id: activityId, req_source: this.reqSource }, { retry: 0 });
  }
  workFissionGrant(activityId) { return this.post(EP.WORK_FISSION_GRANT, { activity_id: activityId }, { retry: 0 }); }
  codeFissionGrant(activityId) { return this.post(EP.CODE_FISSION_GRANT, { activity_id: activityId }, { retry: 0 }); }
  grantWorkBenefit() {
    return this.post(EP.GRANT_WORK_BENEFIT, { trae_client: "Lite", device_id: this.deviceId }, { retry: 0 });
  }

  // ---- 额度 ----
  payStatus() { return this.post(EP.PAY_STATUS, {}); }
  entUsage() { return this.post(EP.ENT_USAGE, {}); }
}

