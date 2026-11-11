// trae-crypto.mjs — Trae CN 本地凭据读写
// 容器格式: [116,99,5,16,0,0] + key32(32B) + AES-128-CBC(SHA512(payload) || payload)
import { webcrypto as crypto } from "node:crypto";

const IHE = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37];
const RHE = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125];

const HEADER = [116, 99, 5, 16, 0, 0]; // WL, HL, $L, VL, jL, qL  -> AES 变体
const RV = 6, GS = 32, LP = 64, BL = 16, UL = 64;

const sha512 = async (x) => new Uint8Array(await crypto.subtle.digest("SHA-512", x));

async function derive(key32) {
  const mask = new Uint8Array(UL);
  for (let i = 0; i < UL; i++) mask[i] = IHE[i] ^ RHE[i];
  const buf = new Uint8Array(LP + UL);
  buf.set(await sha512(key32), 0);
  buf.set(mask, LP);
  const digest = await sha512(buf);      // Gue(): n.set(c,0)
  buf.set(digest, 0);
  return { aesKey: buf.slice(0, BL), iv: buf.slice(BL, BL + BL) };
}

export async function decryptContainer(b64) {
  const raw = new Uint8Array(Buffer.from(String(b64).trim(), "base64"));
  for (let i = 0; i < HEADER.length; i++) {
    if (raw[i] !== HEADER[i]) throw new Error(`unknown container header: ${[...raw.slice(0, 6)].join(",")}`);
  }
  const { aesKey, iv } = await derive(raw.slice(RV, RV + GS));
  const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, raw.slice(GS + RV)));
  const digest = await sha512(plain.slice(LP));
  for (let i = 0; i < LP; i++) if (digest[i] !== plain[i]) throw new Error("digest mismatch (凭据被其他进程改写或格式不符)");
  return new TextDecoder().decode(plain.slice(LP));
}

export async function encryptContainer(text) {
  const payload = new TextEncoder().encode(text);
  const key32 = new Uint8Array(GS);
  crypto.getRandomValues(key32);
  const { aesKey, iv } = await derive(key32);
  const key = await crypto.subtle.importKey("raw", aesKey, { name: "AES-CBC" }, false, ["encrypt"]);
  const body = new Uint8Array(LP + payload.length);
  body.set(await sha512(payload), 0);
  body.set(payload, LP);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, body));
  const out = new Uint8Array(RV + GS + ct.length);
  out.set(HEADER, 0);
  out.set(key32, RV);
  out.set(ct, RV + GS);
  return Buffer.from(out).toString("base64");
}
