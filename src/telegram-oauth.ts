import { b64urlToBytes, randomOpaqueToken, s256ChallengeFromVerifier } from "./crypto.js";
import type { Store } from "./store.js";

/** Original `oauth.TelegramIssuer`. */
export const TELEGRAM_ISSUER = "https://oauth.telegram.org";

/** Original `oauth.ErrTelegramOAuthNotConfigured`. */
export const ERR_TELEGRAM_OAUTH_NOT_CONFIGURED =
  "Telegram OAuth is not configured or enabled. Please contact your administrator.";

/** Original `oauth.ErrTelegramOAuthConflict`. */
export const ERR_TELEGRAM_OAUTH_CONFLICT =
  "The telegram OAuth provider name is reserved. Ask your administrator to rename the conflicting custom provider.";

/** Original `oauth.ErrTelegramOAuthFailed`. */
export const ERR_TELEGRAM_OAUTH_FAILED = "Telegram authorization failed. Please try again.";

/** Original `oauth.ErrTelegramAccountNotBound`. */
export const ERR_TELEGRAM_ACCOUNT_NOT_BOUND =
  "This Telegram account is not linked. Sign in using another method and link it first.";

export type TelegramConfigErrorCode = "TELEGRAM_OAUTH_NOT_CONFIGURED" | "TELEGRAM_OAUTH_CONFLICT";

export interface TelegramOAuthFlow {
  code_verifier: string;
  client_id: string;
  redirect_uri: string;
}

export type TelegramOAuthStart =
  | { ok: true; flow: TelegramOAuthFlow }
  | { ok: false; code: TelegramConfigErrorCode; message: string };

/** Original `system_setting.TelegramSettings.IsConfigured`. */
export async function telegramSettingsConfigured(store: Store): Promise<boolean> {
  const client = (await store.option("telegram.client_id")).trim();
  const secret = (await store.option("telegram.client_secret")).trim();
  return Boolean(client && secret);
}

/**
 * Original `oauth.HasCustomProviderConflict("telegram")` after `LoadCustomProviders`:
 * a custom provider row with slug `telegram` cannot register over the built-in.
 */
export async function telegramCustomProviderConflict(store: Store): Promise<boolean> {
  const providers = (await store.listOAuthProviders()) as { slug?: unknown }[];
  return providers.some((p) => String(p.slug || "").toLowerCase() === "telegram");
}

/** Original `oauth.TelegramConfigurationError`. */
export async function telegramConfigurationError(
  store: Store,
): Promise<{ code: TelegramConfigErrorCode; message: string } | null> {
  if (await telegramCustomProviderConflict(store)) {
    return { code: "TELEGRAM_OAUTH_CONFLICT", message: ERR_TELEGRAM_OAUTH_CONFLICT };
  }
  if (!(await store.optionBool("TelegramOAuthEnabled", false)) || !(await telegramSettingsConfigured(store))) {
    return { code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  return null;
}

/** Original `oauth.NewTelegramOAuthFlow`. */
export async function newTelegramOAuthFlow(store: Store): Promise<TelegramOAuthStart> {
  const err = await telegramConfigurationError(store);
  if (err) return { ok: false, ...err };
  const server = (await store.option("ServerAddress")).replace(/\/+$/, "");
  const redirectURI = `${server}/oauth/telegram`;
  let parsed: URL;
  try {
    parsed = new URL(redirectURI);
  } catch {
    return { ok: false, code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  if (!parsed.host || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return { ok: false, code: "TELEGRAM_OAUTH_NOT_CONFIGURED", message: ERR_TELEGRAM_OAUTH_NOT_CONFIGURED };
  }
  return {
    ok: true,
    flow: {
      code_verifier: randomOpaqueToken(32),
      client_id: (await store.option("telegram.client_id")).trim(),
      redirect_uri: redirectURI,
    },
  };
}

/** Original `oauth.TelegramOAuthFlow.AuthorizationURL`. */
export async function telegramAuthorizationURL(flow: TelegramOAuthFlow, state: string): Promise<string> {
  const values = new URLSearchParams({
    client_id: flow.client_id,
    redirect_uri: flow.redirect_uri,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: await s256ChallengeFromVerifier(flow.code_verifier),
    code_challenge_method: "S256",
  });
  return `${TELEGRAM_ISSUER}/auth?${values.toString()}`;
}

export type TelegramOAuthErrorCode =
  | TelegramConfigErrorCode
  | "TELEGRAM_OAUTH_FAILED"
  | "TELEGRAM_ACCOUNT_NOT_BOUND";

/** Original telegram OAuth errors returned through `writeSecurityOperationError`. */
export class TelegramOAuthError extends Error {
  readonly code: TelegramOAuthErrorCode;
  constructor(code: TelegramOAuthErrorCode, message: string) {
    super(message);
    this.name = "TelegramOAuthError";
    this.code = code;
  }
}

export function telegramOAuthFailed(): TelegramOAuthError {
  return new TelegramOAuthError("TELEGRAM_OAUTH_FAILED", ERR_TELEGRAM_OAUTH_FAILED);
}

export interface TelegramOAuthUser {
  id: string;
  username: string;
  display_name: string;
}

function decodeJwtJson(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  } catch {
    throw telegramOAuthFailed();
  }
}

function audienceMatches(aud: unknown, clientId: string): boolean {
  if (typeof aud === "string") return aud === clientId;
  if (Array.isArray(aud)) return aud.some((item) => item === clientId);
  return false;
}

/** Original `strconv.ParseUint(claims.ID.String(), 10, 64)` plus `id == 0`. */
export function parseTelegramProviderUserId(raw: unknown): string | null {
  let text = "";
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) return null;
    text = String(raw);
  } else if (typeof raw === "string") {
    text = raw;
  } else return null;
  if (!/^[0-9]+$/.test(text)) return null;
  try {
    const n = BigInt(text);
    if (n === 0n || n > 2n ** 64n - 1n) return null;
    return n.toString(10);
  } catch {
    return null;
  }
}

async function importTelegramJwk(jwk: JsonWebKey, alg: string): Promise<CryptoKey> {
  if (alg === "RS256") {
    if (!jwk.n || !jwk.e) throw telegramOAuthFailed();
    return crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  if (alg === "ES256") {
    if (!jwk.x || !jwk.y) throw telegramOAuthFailed();
    return crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: jwk.crv || "P-256", x: jwk.x, y: jwk.y, alg: "ES256", ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  throw telegramOAuthFailed();
}

async function fetchLimitedJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw telegramOAuthFailed();
  }
  const buf = await response.arrayBuffer();
  if (buf.byteLength > 1 << 20) throw telegramOAuthFailed();
  if (!response.ok) throw telegramOAuthFailed();
  try {
    return { status: response.status, body: JSON.parse(new TextDecoder().decode(buf)) as unknown };
  } catch {
    throw telegramOAuthFailed();
  }
}

async function verifyTelegramIdToken(idToken: string, clientId: string): Promise<TelegramOAuthUser> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw telegramOAuthFailed();
  const header = decodeJwtJson(parts[0]) as { alg?: string; kid?: string };
  const alg = header.alg || "";
  if (alg !== "RS256" && alg !== "ES256") throw telegramOAuthFailed();
  const jwks = await fetchLimitedJson(`${TELEGRAM_ISSUER}/.well-known/jwks.json`);
  const keys = ((jwks.body as { keys?: (JsonWebKey & { kid?: string })[] }).keys || []).filter((k) => k && typeof k === "object");
  const jwk = header.kid ? keys.find((k) => k.kid === header.kid) : keys[0];
  if (!jwk) throw telegramOAuthFailed();
  let key: CryptoKey;
  try {
    key = await importTelegramJwk(jwk, alg);
  } catch {
    throw telegramOAuthFailed();
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlToBytes(parts[2]);
  const algorithm: AlgorithmIdentifier | EcdsaParams =
    alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  let ok = false;
  try {
    ok = await crypto.subtle.verify(algorithm, key, signature as BufferSource, data);
  } catch {
    throw telegramOAuthFailed();
  }
  if (!ok) throw telegramOAuthFailed();
  const claims = decodeJwtJson(parts[1]) as {
    iss?: string;
    aud?: unknown;
    exp?: unknown;
    sub?: unknown;
    id?: unknown;
    name?: unknown;
    preferred_username?: unknown;
  };
  const exp = typeof claims.exp === "number" ? claims.exp : Number(claims.exp);
  if (claims.iss !== TELEGRAM_ISSUER || !audienceMatches(claims.aud, clientId) || !Number.isFinite(exp) || exp <= Date.now() / 1000) {
    throw telegramOAuthFailed();
  }
  const sub = typeof claims.sub === "string" ? claims.sub : "";
  const id = parseTelegramProviderUserId(claims.id);
  if (!id || !sub) throw telegramOAuthFailed();
  return {
    id,
    username: typeof claims.preferred_username === "string" ? claims.preferred_username : "",
    display_name: typeof claims.name === "string" ? claims.name : "",
  };
}

/** Original `TelegramProvider.ExchangeToken` + `GetUserInfo`. */
export async function exchangeTelegramOAuth(store: Store, code: string, flow: TelegramOAuthFlow): Promise<TelegramOAuthUser> {
  const err = await telegramConfigurationError(store);
  if (err) throw new TelegramOAuthError(err.code, err.message);
  const clientId = (await store.option("telegram.client_id")).trim();
  const secret = (await store.option("telegram.client_secret")).trim();
  const redirectURI = `${(await store.option("ServerAddress")).replace(/\/+$/, "")}/oauth/telegram`;
  if (!flow.code_verifier || !code || flow.client_id !== clientId || flow.redirect_uri !== redirectURI) {
    throw telegramOAuthFailed();
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: flow.client_id,
    redirect_uri: flow.redirect_uri,
    code_verifier: flow.code_verifier,
  });
  const token = await fetchLimitedJson(`${TELEGRAM_ISSUER}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${flow.client_id}:${secret}`)}`,
    },
    body,
  });
  const idToken = String((token.body as { id_token?: unknown }).id_token || "");
  if (!idToken) throw telegramOAuthFailed();
  return verifyTelegramIdToken(idToken, clientId);
}
