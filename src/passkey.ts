import { randomHex } from "./constants.js";

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

export function newChallenge(): { id: string; challenge: string } {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { id: randomHex(16), challenge: b64url(raw) };
}

/** Convert ECDSA ASN.1 DER signature to IEEE P1363 (r||s) if needed. */
export function derToRaw(sig: Uint8Array): Uint8Array {
  if (sig.length === 64) return sig;
  if (sig[0] !== 0x30) return sig;
  let i = 2;
  if (sig[1] & 0x80) i += sig[1] & 0x7f;
  if (sig[i] !== 0x02) return sig;
  const rLen = sig[i + 1];
  let r = sig.slice(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (sig[i] !== 0x02) return sig;
  const sLen = sig[i + 1];
  let s = sig.slice(i + 2, i + 2 + sLen);
  if (r.length > 32) r = r.slice(r.length - 32);
  if (s.length > 32) s = s.slice(s.length - 32);
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

export async function verifyAssertion(opts: {
  publicKeySpki: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin?: string;
}): Promise<boolean> {
  try {
    const client = b64urlToBytes(opts.clientDataJSON);
    const parsed = JSON.parse(new TextDecoder().decode(client)) as { challenge?: string; origin?: string; type?: string };
    if (parsed.challenge !== opts.expectedChallenge && parsed.challenge !== opts.expectedChallenge.replace(/-/g, "+")) {
      if (parsed.challenge !== opts.expectedChallenge) {
        const want = opts.expectedChallenge.replace(/-/g, "+").replace(/_/g, "/");
        const got = String(parsed.challenge || "");
        if (got !== opts.expectedChallenge && got !== want) return false;
      }
    }
    if (parsed.type && parsed.type !== "webauthn.get") return false;
    if (opts.expectedOrigin && parsed.origin && parsed.origin !== opts.expectedOrigin) return false;
    const auth = b64urlToBytes(opts.authenticatorData);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", client as BufferSource));
    const signed = new Uint8Array(auth.length + hash.length);
    signed.set(auth, 0);
    signed.set(hash, auth.length);
    const spki = b64urlToBytes(opts.publicKeySpki);
    const key = await crypto.subtle.importKey(
      "spki",
      spki as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const sig = derToRaw(b64urlToBytes(opts.signature));
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig as BufferSource, signed as BufferSource);
  } catch {
    return false;
  }
}

export function rpFromRequest(req: Request): { rpId: string; origin: string; name: string } {
  const url = new URL(req.url);
  return { rpId: url.hostname, origin: url.origin, name: "Edge API" };
}
