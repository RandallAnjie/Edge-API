/**
 * Original `middleware.CriticalRateLimit` leftover empty HTTP 429.
 * Mark `CT`, 20 req / 20*60s, IP-keyed. Redis/KV deny uses TTL `Retry-After`;
 * memory deny uses the full window. Redis/KV failure is empty HTTP 500 (no memory fallback).
 */
import { envOrDefaultBool, envOrDefaultInt } from "./constants.js";
import { redisFixedWindowTake, redisIPRateLimitKey } from "./email-verification-rate-limit.js";
import { clientIp } from "./http.js";
import { memoryRateLimitRequest } from "./model-rate-limit.js";
import type { Env } from "./types.js";

/** Original `middleware.rateLimitFactory` mark for CriticalRateLimit. */
export const CRITICAL_RATE_LIMIT_MARK = "CT";
/** Original `common.CriticalRateLimitNum`. */
export const CRITICAL_RATE_LIMIT_NUM = 20;
/** Original `common.CriticalRateLimitDuration` (seconds). */
export const CRITICAL_RATE_LIMIT_DURATION = 20 * 60;

const memoryByEnv = new WeakMap<object, Map<string, number[]>>();

/** Original memory limiter key `mark + c.ClientIP()`. */
export function memoryCriticalRateLimitKey(clientIP: string): string {
  return `${CRITICAL_RATE_LIMIT_MARK}${clientIP}`;
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const EXACT = new Set([
  "GET /api/reset_password",
  "POST /api/user/reset",
  "POST /api/oauth/state",
  "POST /api/oauth/email/bind/start",
  "POST /api/oauth/email/bind/resend",
  "POST /api/oauth/email/bind",
  "GET /api/oauth/wechat",
  "POST /api/oauth/wechat/bind",
  "GET /api/oauth/telegram/login",
  "POST /api/oauth/telegram/bind/start",
  "GET /api/ratio_config",
  "POST /api/verify",
  "POST /api/user/auth/refresh",
  "POST /api/user/auth/logout",
  "POST /api/user/register",
  "POST /api/user/login",
  "POST /api/user/login/2fa",
  "POST /api/user/login/verify",
  "POST /api/user/login/passkey/begin",
  "POST /api/user/login/passkey/finish",
  "POST /api/user/passkey/login/begin",
  "POST /api/user/passkey/login/finish",
  "PUT /api/user/self",
  "GET /api/user/token",
  "POST /api/user/token",
  "DELETE /api/user/token",
  "POST /api/user/topup",
  "POST /api/user/pay",
  "POST /api/user/stripe/pay",
  "POST /api/user/creem/pay",
  "POST /api/user/waffo/pay",
  "POST /api/user/waffo-pancake/pay",
  "POST /api/subscription/balance/pay",
  "POST /api/subscription/epay/pay",
  "POST /api/subscription/stripe/pay",
  "POST /api/subscription/creem/pay",
  "POST /api/subscription/waffo-pancake/pay",
  "POST /api/token/batch/keys",
  "GET /api/usage/token",
  "GET /api/log/token",
]);

/**
 * Original `api-router` / `channel-router` routes that `Use(CriticalRateLimit)`.
 * Trailing slash is ignored like gin `/usage/token` vs `/usage/token/`.
 */
export function criticalRateLimitApplies(method: string, path: string): boolean {
  const p = stripTrailingSlash(path);
  if (EXACT.has(`${method} ${p}`)) return true;
  if (method === "GET" && /^\/api\/oauth\/telegram\/bind\/[^/]+$/.test(p)) return true;
  if (method === "GET" && /^\/api\/oauth\/[^/]+$/.test(p)) return true;
  if (method === "POST" && /^\/api\/token\/[^/]+\/key$/.test(p)) return true;
  if (method === "POST" && /^\/api\/channel\/[^/]+\/key$/.test(p)) return true;
  return false;
}

/** Original `common.CriticalRateLimitEnable` (default true). */
export function criticalRateLimitEnabled(env: Env): boolean {
  return envOrDefaultBool(env.CRITICAL_RATE_LIMIT_ENABLE, true);
}

/** Original `common.CriticalRateLimitNum`. */
export function criticalRateLimitNum(env: Env): number {
  return envOrDefaultInt(env.CRITICAL_RATE_LIMIT, CRITICAL_RATE_LIMIT_NUM);
}

/** Original `common.CriticalRateLimitDuration`. */
export function criticalRateLimitDuration(env: Env): number {
  return envOrDefaultInt(env.CRITICAL_RATE_LIMIT_DURATION, CRITICAL_RATE_LIMIT_DURATION);
}

/**
 * Original `writeRateLimited`: empty HTTP 429 + `Retry-After` when seconds > 0.
 * In-memory callers pass the full window; Redis/KV callers pass TTL.
 */
export function writeRateLimited(retryAfterSeconds: number): Response {
  const headers = new Headers();
  if (retryAfterSeconds > 0) headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(null, { status: 429, headers });
}

/** Original Redis `rateLimit check failed` leftover: `c.Status(500); c.Abort()`. */
export function writeRateLimitCheckFailed(): Response {
  return new Response(null, { status: 500 });
}

function memoryQueues(env: Env): Map<string, number[]> {
  let q = memoryByEnv.get(env);
  if (!q) {
    q = new Map();
    memoryByEnv.set(env, q);
  }
  return q;
}

/** Original `memoryRateLimiter` key `mark + c.ClientIP()`, keyed per worker `Env`. */
export function memoryIpRateLimitRequest(
  env: Env,
  mark: string,
  clientIP: string,
  maxRequestNum: number,
  duration: number,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const store = memoryQueues(env);
  const key = `${mark}${clientIP}`;
  const cur = store.get(key);
  if (!cur) {
    store.set(key, [nowSec]);
    return true;
  }
  const next = memoryRateLimitRequest(cur, maxRequestNum, duration, nowSec);
  store.set(key, next.queue);
  return next.allowed;
}

/** Original `memoryRateLimiter` keyed per worker `Env` for mark `CT`. */
export function memoryCriticalRateLimitRequest(env: Env, clientIP: string, maxRequestNum: number, duration: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return memoryIpRateLimitRequest(env, CRITICAL_RATE_LIMIT_MARK, clientIP, maxRequestNum, duration, nowSec);
}

/**
 * Original `redisRateLimiter` / `memoryRateLimiter` leftover empty HTTP 429.
 * Redis/KV failure is empty HTTP 500 (no memory fallback).
 */
export async function takeIpRateLimit(env: Env, req: Request, mark: string, maxRequestNum: number, duration: number): Promise<Response | null> {
  const ip = clientIp(req);
  if (env.KV) {
    try {
      const taken = await redisFixedWindowTake(env.KV, redisIPRateLimitKey(mark, ip), maxRequestNum, duration);
      if (taken.allowed) return null;
      return writeRateLimited(taken.ttlSeconds);
    } catch {
      return writeRateLimitCheckFailed();
    }
  }
  if (!memoryIpRateLimitRequest(env, mark, ip, maxRequestNum, duration)) return writeRateLimited(duration);
  return null;
}

/**
 * Original `CriticalRateLimit` on login/register/reset/oauth/pay/token-key/etc.
 * `env.KV` is the Redis path (same binding as ModelRequestRateLimit).
 */
export async function criticalRateLimit(env: Env, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!criticalRateLimitApplies(req.method, url.pathname)) return null;
  if (!criticalRateLimitEnabled(env)) return null;
  return takeIpRateLimit(env, req, CRITICAL_RATE_LIMIT_MARK, criticalRateLimitNum(env), criticalRateLimitDuration(env));
}
