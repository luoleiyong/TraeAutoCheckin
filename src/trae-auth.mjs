// trae-auth.mjs — 解密本地凭据 / 构造设备证明 / 刷新 Token / 回写 storage.json
import crypto from "node:crypto";
import { decryptContainer, encryptContainer } from "./trae-crypto.mjs";
import {
  AUTH_KEY, DC_KEY_PREFIX, CLIENT_ID, APP_VERSION,
  readStorage, writeStorage, detectDeviceId, detectMachineId, systemInfo, deviceName
} from "./trae-platform.mjs";

export async function loadAuthContext({ storage } = {}) {
  const st = storage ?? readStorage();
  const blob = st[AUTH_KEY];
  if (!blob) throw new Error(`本地未找到 ${AUTH_KEY}，请先在 Trae CN 中登录`);
  const auth = JSON.parse(await decryptContainer(blob));

  const deviceId = detectDeviceId(st);
  const dcBlob = st[DC_KEY_PREFIX + deviceId];
  let keys = null;
  if (dcBlob) {
    try { keys = JSON.parse(await decryptContainer(dcBlob)); } catch { keys = null; }
  }
  if (!keys?.privateKeyPEM) {
    const pair = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    keys = { privateKeyPEM: pair.privateKey, publicKeyPEM: pair.publicKey };
  }
  return { storage: st, auth, deviceId, keys };
}

export function tokenExpired(auth, skewSeconds = 120) {
  const exp = Date.parse(auth.expiredAt || 0);
  if (!Number.isFinite(exp)) {
    try {
      const payload = JSON.parse(Buffer.from(String(auth.token).split(".")[1], "base64url").toString("utf8"));
      return Date.now() / 1000 + skewSeconds >= payload.exp;
    } catch { return true; }
  }
  return Date.now() + skewSeconds * 1000 >= exp;
}

/** DeviceProof 签名：ECDSA-P256-SHA256( method \n path \n clientId \n refreshToken \n ts \n nonce ) */
export function buildDeviceProof(keys, method, apiPath, refreshToken) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = [method, apiPath, CLIENT_ID, refreshToken, String(timestamp), nonce].join("\n");
  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), keys.privateKeyPEM).toString("base64");
  return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

export function buildDeviceInfo(deviceId, publicKeyPEM) {
  const sys = systemInfo();
  const { machineId } = detectMachineId();
  return {
    DeviceID: deviceId,
    MachineID: machineId,
    PlatformCode: "IDE_PC",
    DeviceType: "PC",
    DeviceName: deviceName(),
    DeviceModel: sys.deviceModel,
    ClientVersion: APP_VERSION,
    DevicePublicKey: publicKeyPEM,
    DeviceBrand: sys.deviceManufacturer,
    DeviceCPU: sys.cpuBrand,
    OSInfo: "windows",
    OSVersion: sys.osVersion
  };
}

export async function refreshAuth({ storage, auth, deviceId, keys }) {
  const host = auth.host || "https://api.trae.cn";
  const apiPath = "/trae/api/v3/oauth/ExchangeToken";
  const body = {
    ClientID: CLIENT_ID,
    ClientSecret: "",
    RefreshToken: auth.refreshToken,
    DeviceInfo: buildDeviceInfo(deviceId, keys.publicKeyPEM),
    DeviceProof: buildDeviceProof(keys, "POST", apiPath, auth.refreshToken),
    IDEVersion: APP_VERSION
  };
  const res = await fetch(host + apiPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cloudide-token": auth.token || "" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  const result = json?.Result || json?.result;
  if (res.status !== 200 || !result?.Token) {
    throw new Error(`刷新 Token 失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const refreshedAt = new Date();
  // 服务端通常不回 TokenExpiredAt，直接解析 JWT 的 exp 更准
  let expiredAt = result.TokenExpiredAt || result.ExpiredAt;
  if (!expiredAt) {
    try {
      const payload = JSON.parse(Buffer.from(String(result.Token).split(".")[1], "base64url").toString("utf8"));
      if (payload.exp) expiredAt = new Date(payload.exp * 1000).toISOString();
    } catch { /* ignore */ }
  }
  const next = {
    ...auth,
    token: result.Token,
    refreshToken: result.RefreshToken || auth.refreshToken,
    expiredAt: expiredAt || auth.expiredAt,
    refreshExpiredAt: result.RefreshTokenExpiredAt || result.RefreshTokenExpiredAt || auth.refreshExpiredAt,
    tokenReleaseAt: refreshedAt.toISOString()
  };
  return next;
}

export async function persistAuth(storage, auth) {
  const next = { ...storage, [AUTH_KEY]: await encryptContainer(JSON.stringify(auth)) };
  const backup = writeStorage(next);
  return { storage: next, backup };
}

export async function ensureFreshAuth(ctx, { allowRefresh = true, log = () => {} } = {}) {
  if (!tokenExpired(ctx.auth)) return ctx;
  if (!allowRefresh) throw new Error("本地 Token 已过期，且已禁用自动刷新");
  log("本地 Token 已过期，正在用 RefreshToken 续期…");
  const auth = await refreshAuth(ctx);
  const { backup } = await persistAuth(ctx.storage, auth);
  log(`续期成功，已回写本地凭据（备份: ${backup}）`);
  return { ...ctx, auth, storage: readStorage() };
}


