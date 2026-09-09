const PBKDF2_ITERS = 100_000;

function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
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

/** new-api TokenAuth: strip sk-, take segment before first extra hyphen group. */
export function parseApiKey(raw: string): string {
  let key = raw.trim();
  if (key.toLowerCase().startsWith("bearer ")) key = key.slice(7).trim();
  if (key.startsWith("sk-")) key = key.slice(3);
  const parts = key.split("-");
  return parts[0] || "";
}

export function extractRequestApiKey(req: Request, url: URL): string {
  const proto = req.headers.get("sec-websocket-protocol") || "";
  if (proto) {
    for (const part of proto.split(",")) {
      const p = part.trim();
      if (p.startsWith("openai-insecure-api-key.")) {
        return parseApiKey(p.slice("openai-insecure-api-key.".length));
      }
    }
  }
  const xApi = req.headers.get("x-api-key");
  const goog = req.headers.get("x-goog-api-key");
  const q = url.searchParams.get("key");
  const mj = req.headers.get("mj-api-secret");
  const auth = req.headers.get("authorization") || "";
  if (auth) return parseApiKey(auth);
  if (xApi) return parseApiKey(xApi);
  if (goog) return parseApiKey(goog);
  if (q) return parseApiKey(q);
  if (mj) return parseApiKey(mj);
  return "";
}

export function maskKey(key: string): string {
  if (!key) return "";
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

export async function hmacSha256Hex(secret: string | Uint8Array, message: string): Promise<string> {
  const keyData = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
  const key = await crypto.subtle.importKey("raw", keyData as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
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
