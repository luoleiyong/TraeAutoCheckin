#!/usr/bin/env node
// tools/dump-auth.mjs — 打印本地解密后的凭据（默认脱敏）
// 用法: node tools/dump-auth.mjs [--raw]
import { loadAuthContext } from "../src/trae-auth.mjs";

const raw = process.argv.includes("--raw");
const ctx = await loadAuthContext();
const mask = (s, keep = 12) => (raw ? s : String(s || "").slice(0, keep) + `…(${String(s || "").length})`);

console.log("deviceId      :", ctx.deviceId);
console.log("userId        :", ctx.auth.userId);
console.log("account       :", ctx.auth.account?.username, "/", ctx.auth.account?.scope);
console.log("host          :", ctx.auth.host);
console.log("expiredAt     :", ctx.auth.expiredAt);
console.log("refreshExpire :", ctx.auth.refreshExpiredAt);
console.log("token         :", mask(ctx.auth.token));
console.log("refreshToken  :", mask(ctx.auth.refreshToken));
console.log("devicePubKey  :", String(ctx.keys.publicKeyPEM).split("\n").slice(0, 2).join(" / "));
