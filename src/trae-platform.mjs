// trae-platform.mjs — Trae 路径自动探测 / 设备信息 / storage.json 读写（可移植版）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const APP_VERSION = "3.4.15";
export const CLIENT_ID = "ono9krqynydwx5";           // product.json -> iCubeApp.authConfig.TRAE.stable
export const AUTH_KEY = "iCubeAuthInfo://icube.cloudide";
export const DC_KEY_PREFIX = "iCubeAuthInfo://icube-dc:";

let _userDataOverride = null;
export function setUserDataDir(p) { if (p) _userDataOverride = p; }

function appDataRoot() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

/** 候选数据目录：环境变量 > APPDATA 下所有含 Trae 的配置目录（按 storage.json 修改时间倒序） > 默认 */
export function candidateUserDataDirs() {
  const list = [];
  const env = process.env.TRAE_USERDATA || process.env.TRAE_HOME;
  if (env) list.push(env);
  const root = appDataRoot();
  try {
    const hit = [];
    for (const d of fs.readdirSync(root)) {
      if (!/trae/i.test(d)) continue;
      const p = path.join(root, d);
      const st = path.join(p, "User", "globalStorage", "storage.json");
      if (fs.existsSync(st)) hit.push({ p, t: fs.statSync(st).mtimeMs });
    }
    hit.sort((a, b) => b.t - a.t).forEach((h) => list.push(h.p));
  } catch { /* ignore */ }
  list.push(path.join(root, "Trae CN"));
  return [...new Set(list)];
}

export function userDataDir() {
  if (_userDataOverride) return _userDataOverride;
  const all = candidateUserDataDirs();
  for (const p of all) if (fs.existsSync(path.join(p, "User", "globalStorage", "storage.json"))) return p;
  return all[all.length - 1];
}

export function storagePath() { return path.join(userDataDir(), "User", "globalStorage", "storage.json"); }

/** 本程序自己的数据目录（账号库 / 积分历史 / 冷却状态） */
export function dataDir() {
  const env = process.env.TRAE_APPDATA;
  if (env) return path.join(env, "data");
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "TraeAutoCheckin", "data");
}

export function ensureDataDir() {
  const d = dataDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}
export function homeDataDir() { return path.join(os.homedir(), ".trae-cn"); }
export function logsDir() { return path.join(userDataDir(), "logs"); }

/** Trae 安装目录探测（供 ELECTRON_RUN_AS_NODE 兜底使用） */
export function candidateTraeExes() {
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  push(process.env.TRAE_EXE);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  for (const name of ["Trae CN", "Trae", "Trae CN Insiders"]) {
    push(path.join(local, "Programs", name, name + ".exe"));
  }
  for (const pf of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!pf) continue;
    for (const name of ["Trae CN", "Trae"]) push(path.join(pf, name, name + ".exe"));
  }
  push("D:\\Trae CN\\Trae CN.exe");
  push("C:\\Program Files\\Trae CN\\Trae CN.exe");
  return [...new Set(out)];
}

export function resolveTraeExe() {
  for (const p of candidateTraeExes()) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return "";
}

export function readStorage() {
  const p = storagePath();
  if (!fs.existsSync(p)) throw new Error(`找不到 Trae 本地存储: ${p}\n请先启动一次 Trae 并完成登录。`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeStorage(obj) {
  const p = storagePath();
  const backup = `${p}.autocheckin.bak`;
  try { fs.copyFileSync(p, backup); } catch { /* ignore */ }
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, p);
  return backup;
}

export function detectDeviceId(storage) {
  const key = Object.keys(storage).find((k) => k.startsWith(DC_KEY_PREFIX));
  if (key) return key.slice(DC_KEY_PREFIX.length);
  const dirs = fs.existsSync(homeDataDir())
    ? fs.readdirSync(homeDataDir()).filter((d) => /^\d{12,}$/.test(d))
    : [];
  return dirs[0] || "";
}

/** MachineID: 与 IDE 上报一致（main.log 的 mid= 参数 / exchangeToken 日志里都有） */
export function detectMachineId() {
  const cache = path.join(homeDataDir(), "autocheckin-device.json");
  if (fs.existsSync(cache)) {
    try {
      const c = JSON.parse(fs.readFileSync(cache, "utf8"));
      if (c && c.machineId) return c;
    } catch { /* ignore */ }
  }
  let machineId = "";
  try {
    const dir = logsDir();
    if (fs.existsSync(dir)) {
      const subdirs = fs.readdirSync(dir).filter((d) => /^\d{8}T\d{6}$/.test(d)).sort().reverse().slice(0, 8);
      for (const sd of subdirs) {
        const f = path.join(dir, sd, "main.log");
        if (!fs.existsSync(f)) continue;
        const text = fs.readFileSync(f, "utf8");
        const m = text.match(/[?&]mid=([0-9a-f]{64})/) || text.match(/"MachineID":"([0-9a-f]{64})"/);
        if (m) { machineId = m[1]; break; }
      }
    }
  } catch { /* ignore */ }
  if (!machineId) {
    const f = path.join(userDataDir(), "machineid");
    const raw = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : os.hostname();
    machineId = crypto.createHash("sha256").update(raw).digest("hex");
  }
  try {
    fs.mkdirSync(homeDataDir(), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify({ machineId }, null, 2));
  } catch { /* ignore */ }
  return { machineId };
}

function ps(script) {
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch { return ""; }
}

let cachedSysInfo = null;
export function systemInfo() {
  if (cachedSysInfo) return cachedSysInfo;
  const info = { deviceModel: "", deviceManufacturer: "", cpuBrand: "", osName: "windows", osVersion: "" };
  const cs = ps("(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress)");
  if (cs) {
    try {
      const o = JSON.parse(cs);
      if (o.Manufacturer) info.deviceManufacturer = String(o.Manufacturer);
      if (o.Model) info.deviceModel = String(o.Model);
    } catch { /* ignore */ }
  }
  const cpu = ps("(Get-CimInstance Win32_Processor | Select-Object -First 1 -Property Name | ConvertTo-Json -Compress)");
  if (cpu) {
    try { const o = JSON.parse(cpu); if (o.Name) info.cpuBrand = String(o.Name).trim(); } catch { /* ignore */ }
  }
  const osCap = ps("(Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 -Property Caption | ConvertTo-Json -Compress)");
  if (osCap) {
    try { const o = JSON.parse(osCap); if (o.Caption) info.osVersion = String(o.Caption); } catch { /* ignore */ }
  }
  if (!info.osVersion || /[^\x00-\xFF]/.test(info.osVersion)) info.osVersion = `Windows ${os.release()}`;
  cachedSysInfo = info;
  return info;
}

export function deviceName() {
  const user = (os.userInfo().username || "").trim();
  return user ? `${user}的电脑` : os.hostname();
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function businessDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
