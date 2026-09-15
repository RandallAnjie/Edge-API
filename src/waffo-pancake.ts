import { bytesToHex, sha256Bytes } from "./crypto.js";

/** Original `pancake.DefaultBaseURL`. */
export const WAFFO_PANCAKE_DEFAULT_BASE_URL = "https://api.waffo.ai";

const SHORT_ID_RE = /^[A-Z]{2,5}_[0-9A-Za-z]{22}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;
const RSA_OID_ALG_ID = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

export class WaffoPancakeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WaffoPancakeError";
  }
}

/** Original `service.WaffoPancakeBuyerIdentityFromUserID`. */
export function waffoPancakeBuyerIdentityFromUserId(userId: number): string {
  return `new-api-user-${userId}`;
}

/** Original `controller.formatWaffoPancakeAmount` (`decimal.StringFixed(2)`). */
export function formatWaffoPancakeAmount(payMoney: number): string {
  return (Math.round(payMoney * 100 + Number.EPSILON) / 100).toFixed(2);
}

export type WaffoPancakeCreateSessionParams = {
  productId: string;
  buyerIdentity: string;
  priceAmount: string;
  buyerEmail: string;
  orderMerchantExternalId: string;
  expiresInSeconds?: number;
};

export type WaffoPancakeCheckoutSession = {
  sessionId: string;
  checkoutUrl: string;
  expiresAt: string;
  token: string;
  tokenExpiresAt: string;
};

type PancakeNotice = { message?: string };

type PancakeEnvelope = {
  data?: unknown;
  errors?: PancakeNotice[];
  warnings?: PancakeNotice[];
};

function pancakeSdkError(message: string): WaffoPancakeError {
  return new WaffoPancakeError(400, message);
}

function validateRequired(field: string, v: string): void {
  if (!v) throw pancakeSdkError(`Missing required field: ${field}`);
}

function validateShortId(field: string, v: string, prefix: string): void {
  validateRequired(field, v);
  const labels: Record<string, string> = {
    STO: "Store",
    PROD: "Product",
    ORD: "Order",
    PAY: "Payment",
    REF: "Refund",
    TKT: "Ticket",
    MER: "Merchant",
  };
  const label = labels[prefix] || prefix;
  if (!SHORT_ID_RE.test(v)) {
    throw pancakeSdkError(`Invalid ${field}: expected ${label} Short ID format (${prefix}_xxx), got ${JSON.stringify(v)}`);
  }
  if (!v.startsWith(prefix + "_")) {
    throw pancakeSdkError(`Invalid ${field}: expected ${prefix}_ prefix (${label})`);
  }
}

function validateCurrency(field: string, v: string): void {
  validateRequired(field, v);
  if (!CURRENCY_RE.test(v)) {
    throw pancakeSdkError(`Invalid ${field}: expected 3-letter ISO 4217 currency code (e.g., "USD"), got ${JSON.stringify(v)}`);
  }
}

function validateAmountString(field: string, v: string): void {
  validateRequired(field, v);
  if (!AMOUNT_RE.test(v)) {
    throw pancakeSdkError(`Invalid ${field}: expected numeric string in display format (e.g., "9.99", "1000"), got ${JSON.stringify(v)}`);
  }
}

function stdB64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToStdB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function copyBytes(u: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(u.byteLength);
  out.set(u);
  return out.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  if (n < 0x100) return Uint8Array.of(0x81, n);
  if (n < 0x10000) return Uint8Array.of(0x82, (n >> 8) & 0xff, n & 0xff);
  return Uint8Array.of(0x83, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
}

function wrapPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const octet = concatBytes(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const inner = concatBytes(version, RSA_OID_ALG_ID, octet);
  return concatBytes(Uint8Array.of(0x30), derLength(inner.length), inner);
}

function stripWhitespace(s: string): string {
  return s.replace(/[ \t\n\r]/g, "");
}

function wrap64(s: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < s.length; i += 64) chunks.push(s.slice(i, i + 64));
  return chunks.join("\n");
}

/** Original `pancake/internal/signing.NormalizePrivateKey`. */
function normalizePrivateKeyPem(raw: string): { pem: string; pkcs1: boolean } {
  if (!raw.trim()) throw pancakeSdkError("private key is empty; provide an RSA private key in PEM format");
  let pemStr = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  const pkcs8Header = "-----BEGIN PRIVATE KEY-----";
  const pkcs8Footer = "-----END PRIVATE KEY-----";
  const pkcs1Header = "-----BEGIN RSA PRIVATE KEY-----";
  const pkcs1Footer = "-----END RSA PRIVATE KEY-----";
  const hasPkcs1 = pemStr.includes(pkcs1Header);
  const hasPkcs8 = pemStr.includes(pkcs8Header);
  if (hasPkcs1 || hasPkcs8) {
    const stripped = pemStr
      .replace(pkcs8Header, "")
      .replace(pkcs8Footer, "")
      .replace(pkcs1Header, "")
      .replace(pkcs1Footer, "");
    const b64 = stripWhitespace(stripped);
    if (!b64) throw pancakeSdkError("private key contains PEM headers but no key data");
    const header = hasPkcs1 ? pkcs1Header : pkcs8Header;
    const footer = hasPkcs1 ? pkcs1Footer : pkcs8Footer;
    return { pem: `${header}\n${wrap64(b64)}\n${footer}`, pkcs1: hasPkcs1 };
  }
  const b64 = stripWhitespace(pemStr);
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) {
    throw pancakeSdkError("private key is not valid PEM or base64; expected an RSA private key in PEM format or raw base64");
  }
  return { pem: `${pkcs8Header}\n${wrap64(b64)}\n${pkcs8Footer}`, pkcs1: false };
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s/g, "");
  return stdB64ToBytes(b64);
}

async function importPancakePrivateKey(raw: string): Promise<CryptoKey> {
  const { pem, pkcs1 } = normalizePrivateKeyPem(raw);
  let der = pemToDer(pem);
  if (pkcs1) der = wrapPkcs1ToPkcs8(der);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      copyBytes(der) as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    if (!pkcs1) {
      try {
        return await crypto.subtle.importKey(
          "pkcs8",
          copyBytes(wrapPkcs1ToPkcs8(der)) as BufferSource,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["sign"],
        );
      } catch {
        /* fall through */
      }
    }
    throw pancakeSdkError("private key could not be parsed");
  }
}

/** Original `pancake/internal/signing.SignRequest`. */
async function signPancakeRequest(method: string, path: string, timestamp: string, body: Uint8Array, key: CryptoKey): Promise<string> {
  const bodyB64 = bytesToStdB64(await sha256Bytes(body));
  const canonical = `${method}\n${path}\n${timestamp}\n${bodyB64}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(canonical));
  return bytesToStdB64(sig);
}

async function sha256HexUtf8(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

async function pancakeIdempotencyKey(
  merchantId: string,
  path: string,
  body: string,
  tsSec: number,
  windowSec: number,
): Promise<string> {
  let input = `${merchantId}:${path}:${body}`;
  if (windowSec > 0) input = `${input}:${Math.floor(tsSec / windowSec)}`;
  return sha256HexUtf8(input);
}

function unwrapEnvelope<T>(status: number, env: PancakeEnvelope): T {
  const errors = env.errors || [];
  if (errors.length > 0) {
    throw new WaffoPancakeError(status, String(errors[0]?.message || `waffo pancake error (status ${status})`));
  }
  return (env.data ?? {}) as T;
}

async function postAction<T>(
  baseURL: string,
  merchantId: string,
  key: CryptoKey,
  path: string,
  payload: Record<string, unknown>,
  idempotencyWindow: number,
): Promise<T> {
  const body = JSON.stringify(payload);
  const bodyBytes = new TextEncoder().encode(body);
  const tsSec = Math.floor(Date.now() / 1000);
  const timestamp = String(tsSec);
  const signature = await signPancakeRequest("POST", path, timestamp, bodyBytes, key);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Merchant-Id": merchantId,
    "X-Timestamp": timestamp,
    "X-Signature": signature,
  };
  if (idempotencyWindow >= 0) {
    headers["X-Idempotency-Key"] = await pancakeIdempotencyKey(merchantId, path, body, tsSec, idempotencyWindow);
  }
  let res: Response;
  try {
    res = await fetch(baseURL.replace(/\/+$/, "") + path, { method: "POST", headers, body });
  } catch (err) {
    throw err instanceof Error ? err : new Error("waffo pancake transport failed");
  }
  const raw = await res.text();
  if (!raw.trim()) {
    if (res.status >= 400) throw new WaffoPancakeError(res.status, `waffo pancake error (status ${res.status})`);
    return {} as T;
  }
  let env: PancakeEnvelope;
  try {
    env = JSON.parse(raw) as PancakeEnvelope;
  } catch {
    throw new WaffoPancakeError(res.status, `Non-JSON response from ${path}`);
  }
  return unwrapEnvelope<T>(res.status, env);
}

function checkoutSessionBody(params: WaffoPancakeCreateSessionParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    productId: params.productId,
    currency: "USD",
  };
  if (params.priceAmount) {
    body.priceSnapshot = { amount: params.priceAmount, taxCategory: "saas" };
  }
  const email = params.buyerEmail.trim();
  if (email) body.buyerEmail = email;
  const expires = params.expiresInSeconds ?? 45 * 60;
  body.expiresInSeconds = expires;
  body.orderMerchantExternalId = params.orderMerchantExternalId;
  return body;
}

function validateCheckoutCommon(params: WaffoPancakeCreateSessionParams): void {
  validateShortId("productId", params.productId, "PROD");
  validateCurrency("currency", "USD");
  if (params.priceAmount) {
    validateAmountString("priceSnapshot.amount", params.priceAmount);
    validateRequired("priceSnapshot.taxCategory", "saas");
  }
  const expires = params.expiresInSeconds ?? 45 * 60;
  if (expires <= 0) throw pancakeSdkError(`Invalid expiresInSeconds: expected positive integer, got ${expires}`);
  if (params.orderMerchantExternalId.length > 128) {
    throw pancakeSdkError(
      `orderMerchantExternalId must be at most 128 characters, got ${params.orderMerchantExternalId.length}`,
    );
  }
}

/**
 * Original `service.CreateWaffoPancakeCheckoutSession` →
 * `client.Checkout.Authenticated.Create` (issue-session-token + create-session).
 */
export async function createWaffoPancakeCheckoutSession(
  merchantId: string,
  privateKey: string,
  params: WaffoPancakeCreateSessionParams,
  baseURL = WAFFO_PANCAKE_DEFAULT_BASE_URL,
): Promise<WaffoPancakeCheckoutSession> {
  if (!params.buyerIdentity.trim()) throw new Error("missing buyer identity");
  if (!params.orderMerchantExternalId.trim()) throw new Error("missing order merchant external id");
  validateShortId("merchantId", merchantId, "MER");
  if (!privateKey) throw pancakeSdkError("Missing required field: privateKey");
  const key = await importPancakePrivateKey(privateKey);
  validateCheckoutCommon(params);
  validateRequired("buyerIdentity", params.buyerIdentity);

  const tokenBody = { productId: params.productId, buyerIdentity: params.buyerIdentity };
  const sessionBody = checkoutSessionBody(params);
  const tokenPath = "/v1/actions/auth/issue-session-token";
  const sessionPath = "/v1/actions/checkout/create-session";
  const settled = await Promise.allSettled([
    postAction<{ token?: string; expiresAt?: string }>(baseURL, merchantId, key, tokenPath, tokenBody, 60),
    postAction<{ sessionId?: string; checkoutUrl?: string; expiresAt?: string }>(
      baseURL,
      merchantId,
      key,
      sessionPath,
      sessionBody,
      60,
    ),
  ]);
  if (settled[0].status === "rejected") throw settled[0].reason;
  if (settled[1].status === "rejected") throw settled[1].reason;
  const tok = settled[0].value;
  const session = settled[1].value;
  const checkoutUrl = String(session.checkoutUrl || "") + "#token=" + String(tok.token || "");
  const sessionId = String(session.sessionId || "");
  if (!sessionId.trim() || !checkoutUrl.trim()) {
    throw new Error("Waffo Pancake returned empty checkout session");
  }
  return {
    sessionId,
    checkoutUrl,
    expiresAt: String(session.expiresAt || ""),
    token: String(tok.token || ""),
    tokenExpiresAt: String(tok.expiresAt || ""),
  };
}
