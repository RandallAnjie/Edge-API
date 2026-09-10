const PBKDF2_ITERS = 100_000;

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS },
    key,
    256,
  );
  return `$pbkdf2-sha256$i=${PBKDF2_ITERS}$${b64url(salt)}$${b64url(bits)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const m = encoded.match(/^\$pbkdf2-sha256\$i=(\d+)\$([^$]+)\$([^$]+)$/);
  if (!m) return false;
  const iterations = Number(m[1]);
  const salt = b64urlToBytes(m[2]);
  const expected = b64urlToBytes(m[3]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
      key,
      expected.length * 8,
    ),
  );
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

export interface SessionPayload {
  uid: number;
  role: number;
  username: string;
  exp: number;
  sid?: string;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `${body}.${sig}`;
}

export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(sig) as BufferSource,
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as SessionPayload;
    if (!payload.uid || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Original TokenAuth: strip sk-, split on `-`; parts[0] is the key, parts[1] may pin a channel. */
export function parseApiKeyParts(raw: string): { key: string; extra: string[] } {
  let key = raw.trim();
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice(7).trim();
  if (key.startsWith("sk-")) key = key.slice(3);
  const parts = key.split("-");
  return { key: parts[0] || "", extra: parts.slice(1) };
}

export function parseApiKey(raw: string): string {
  return parseApiKeyParts(raw).key;
}

export function extractRequestApiKeyParts(req: Request, url: URL): { key: string; extra: string[] } {
  const proto = req.headers.get("sec-websocket-protocol") || "";
  if (proto) {
    for (const part of proto.split(",")) {
      const p = part.trim();
      if (p.startsWith("openai-insecure-api-key.")) {
        return parseApiKeyParts(p.slice("openai-insecure-api-key.".length));
      }
    }
  }
  const xApi = req.headers.get("x-api-key");
  const goog = req.headers.get("x-goog-api-key");
  const q = url.searchParams.get("key");
  const mj = req.headers.get("mj-api-secret");
  const auth = req.headers.get("authorization") || "";
  if (auth) return parseApiKeyParts(auth);
  if (xApi) return parseApiKeyParts(xApi);
  if (goog) return parseApiKeyParts(goog);
  if (q) return parseApiKeyParts(q);
  if (mj) return parseApiKeyParts(mj);
  return { key: "", extra: [] };
}

export function extractRequestApiKey(req: Request, url: URL): string {
  return extractRequestApiKeyParts(req, url).key;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "*".repeat(key.length);
  if (key.length <= 8) return key.slice(0, 2) + "****" + key.slice(-2);
  return key.slice(0, 4) + "**********" + key.slice(-4);
}

export function displayTokenKey(key: string): string {
  return "sk-" + key;
}

export function generateTokenKey(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateAffCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateRedemptionKey(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

export async function hmacSha256Raw(secret: string | Uint8Array, message: string | Uint8Array): Promise<Uint8Array> {
  const keyData = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const key = await crypto.subtle.importKey("raw", keyData as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = typeof message === "string" ? new TextEncoder().encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msg as BufferSource));
}

export async function hmacSha256Hex(secret: string | Uint8Array, message: string): Promise<string> {
  const sig = await hmacSha256Raw(secret, message);
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authSigningKey(sessionSecret: string, purpose: string): Promise<Uint8Array> {
  return hmacSha256Raw(sessionSecret, `new-api/auth/${purpose}/v1`);
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha1Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(buf));
}

export async function hashRefreshSecret(sessionSecret: string, secret: string): Promise<string> {
  return bytesToHex(await hmacSha256Raw(await authSigningKey(sessionSecret, "refresh"), secret));
}

export async function deriveNextRefreshSecret(sessionSecret: string, sid: string, currentSecret: string): Promise<string> {
  return bytesToHex(await hmacSha256Raw(await authSigningKey(sessionSecret, "refresh-rotate"), `${sid}.${currentSecret}`));
}

const KEY_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function randomCharsKey(length: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(length * 2);
  crypto.getRandomValues(buf);
  for (let i = 0; out.length < length && i < buf.length; i++) {
    if (buf[i] >= KEY_CHARS.length * Math.floor(256 / KEY_CHARS.length)) continue;
    out.push(KEY_CHARS[buf[i] % KEY_CHARS.length]);
  }
  while (out.length < length) {
    const extra = crypto.getRandomValues(new Uint8Array(1))[0];
    out.push(KEY_CHARS[extra % KEY_CHARS.length]);
  }
  return out.join("");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function splitRefreshToken(raw: string): { sid: string; secret: string } | null {
  const trimmed = raw.trim();
  const dot = trimmed.indexOf(".");
  if (dot <= 0) return null;
  const sid = trimmed.slice(0, dot);
  const secret = trimmed.slice(dot + 1);
  if (!sid || !secret || secret.includes(".")) return null;
  if (!UUID_RE.test(sid)) return null;
  return { sid, secret };
}

export const AUTH_TOKEN_ISS = "new-api";
export const AUTH_TOKEN_AUD = "new-api-dashboard";
export const ACCESS_TOKEN_USE = "access";
export const SECURITY_PROOF_TOKEN_USE = "security_proof";

export function randomOpaqueToken(byteLen = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLen)));
}

export async function authFlowTokenHash(sessionSecret: string, token: string): Promise<string> {
  return hmacSha256Hex(`auth-flow-v1:${sessionSecret}`, token);
}

export async function verificationContextHash(sessionSecret: string, payload: string): Promise<string> {
  const key = await authSigningKey(sessionSecret, "verification-context");
  return bytesToHex(await hmacSha256Raw(key, payload));
}

export async function accessTokenFingerprint(token: string): Promise<string> {
  const trimmed = token.replace(/ +$/, "");
  if (!trimmed) return "";
  return bytesToHex(await sha256Bytes(trimmed));
}

export interface AccessJwtPayload {
  token_use: string;
  sid: string;
  uv: number;
  sv: number;
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
}

export async function signAccessJwt(
  sessionSecret: string,
  identity: { userId: number; sid: string; userAuthVersion: number; sessionVersion: number },
  now: number,
  exp: number,
): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload: AccessJwtPayload = {
    token_use: ACCESS_TOKEN_USE,
    sid: identity.sid,
    uv: identity.userAuthVersion,
    sv: identity.sessionVersion,
    iss: AUTH_TOKEN_ISS,
    sub: String(identity.userId),
    aud: AUTH_TOKEN_AUD,
    exp,
    nbf: now - 5,
    iat: now,
    jti: crypto.randomUUID(),
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await authSigningKey(sessionSecret, "access");
  const sig = b64url(await hmacSha256Raw(key, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

export async function verifyAccessJwt(token: string, sessionSecret: string): Promise<AccessJwtPayload | null> {
  return verifyAuthJwt<AccessJwtPayload>(token, sessionSecret, "access", ACCESS_TOKEN_USE);
}

export interface SecurityProofJwtPayload extends AccessJwtPayload {
  method: string;
  scopes: string[];
  context_hash: string;
}

export async function signSecurityProofJwt(
  sessionSecret: string,
  identity: { userId: number; sid: string; userAuthVersion: number; sessionVersion: number },
  extra: { method: string; scopes: string[]; contextHash: string; jti: string },
  now: number,
  exp: number,
): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload: SecurityProofJwtPayload = {
    token_use: SECURITY_PROOF_TOKEN_USE,
    sid: identity.sid,
    uv: identity.userAuthVersion,
    sv: identity.sessionVersion,
    method: extra.method,
    scopes: extra.scopes,
    context_hash: extra.contextHash,
    iss: AUTH_TOKEN_ISS,
    sub: String(identity.userId),
    aud: AUTH_TOKEN_AUD,
    exp,
    nbf: now - 5,
    iat: now,
    jti: extra.jti,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await authSigningKey(sessionSecret, "security_proof");
  const sig = b64url(await hmacSha256Raw(key, `${header}.${body}`));
  return `${header}.${body}.${sig}`;
}

export async function verifySecurityProofJwt(token: string, sessionSecret: string): Promise<SecurityProofJwtPayload | null> {
  const payload = await verifyAuthJwt<SecurityProofJwtPayload>(token, sessionSecret, "security_proof", SECURITY_PROOF_TOKEN_USE);
  if (!payload) return null;
  if (!payload.method || !Array.isArray(payload.scopes) || payload.scopes.length !== 1 || !payload.context_hash || !payload.jti) {
    return null;
  }
  return payload;
}

async function verifyAuthJwt<T extends AccessJwtPayload>(
  token: string,
  sessionSecret: string,
  purpose: string,
  expectedUse: string,
): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const key = await authSigningKey(sessionSecret, purpose);
  const expected = b64url(await hmacSha256Raw(key, `${header}.${body}`));
  if (!timingSafeEqualStr(expected, sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))) as T;
    const now = Math.floor(Date.now() / 1000);
    if (payload.token_use !== expectedUse) return null;
    if (payload.iss !== AUTH_TOKEN_ISS) return null;
    if (payload.aud !== AUTH_TOKEN_AUD) return null;
    if (!payload.sid || !payload.sub || payload.uv <= 0 || payload.sv <= 0) return null;
    if (payload.exp + 5 < now) return null;
    if (payload.nbf - 5 > now) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function md5Hex(message: string): Promise<string> {
  const subtle = crypto.subtle as SubtleCrypto & { digest(a: string, d: BufferSource): Promise<ArrayBuffer> };
  try {
    const buf = await subtle.digest("MD5", new TextEncoder().encode(message));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return await hmacSha256Hex("md5-fallback", message);
  }
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Original `common.DecryptPassword` (RSA-OAEP SHA-256, plus v2 AES-GCM wrap). */
export async function decryptPassword(
  ciphertextBase64: string,
  keyId: string,
  privateKeyPem: string,
  activeKeyId: string,
): Promise<string | null> {
  if (!privateKeyPem || !keyId || keyId !== activeKeyId) return null;
  try {
    const der = pemToDer(privateKeyPem);
    const key = await crypto.subtle.importKey("pkcs8", der as BufferSource, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
      "decrypt",
    ]);
    if (ciphertextBase64.startsWith("v2.")) {
      const parts = ciphertextBase64.split(".");
      if (parts.length !== 4) return null;
      const wrappedKey = Uint8Array.from(atob(parts[1]), (c) => c.charCodeAt(0));
      const nonce = Uint8Array.from(atob(parts[2]), (c) => c.charCodeAt(0));
      const ciphertext = Uint8Array.from(atob(parts[3]), (c) => c.charCodeAt(0));
      if (nonce.length !== 12) return null;
      const wrapped = await crypto.subtle.decrypt({ name: "RSA-OAEP", label: new TextEncoder().encode("password-v2") }, key, wrappedKey);
      const aesKey = await crypto.subtle.importKey("raw", wrapped, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`password-v2:${keyId}`) },
        aesKey,
        ciphertext,
      );
      return new TextDecoder().decode(plain);
    }
    const ciphertext = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, ciphertext);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
