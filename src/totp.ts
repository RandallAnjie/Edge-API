const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/g, "").toUpperCase().replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(secret: Uint8Array, counter: number): Promise<number> {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1] & 0xf;
  const bin =
    ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) | ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
  return bin % 1_000_000;
}

export async function totpCode(secret: string, t = Date.now()): Promise<string> {
  const counter = Math.floor(Math.floor(t / 1000) / 30);
  const n = await hotp(base32Decode(secret), counter);
  return n.toString().padStart(6, "0");
}

export async function verifyTotp(secret: string, code: string, window = 1): Promise<boolean> {
  if (!secret || !code) return false;
  const want = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if ((await totpCode(secret, now + i * 30_000)) === want) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, username: string, issuer = "Edge API"): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

export function generateBackupCodes(n = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const buf = crypto.getRandomValues(new Uint8Array(4));
    out.push([...buf].map((b) => b.toString(16).padStart(2, "0")).join(""));
  }
  return out;
}

export function verifyBackupCode(stored: string, code: string): { ok: boolean; rest: string } {
  const want = code.trim().toLowerCase();
  const codes = stored
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const idx = codes.indexOf(want);
  if (idx < 0) return { ok: false, rest: stored };
  codes.splice(idx, 1);
  return { ok: true, rest: codes.join(",") };
}
