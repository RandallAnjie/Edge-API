/**
 * Original `middleware.EmailVerificationRateLimit` leftover gin.H (HTTP 429, no `data`).
 * Memory path: `发送过于频繁，请稍后再试`. Redis/KV path: `发送过于频繁，请等待 N 秒后再试`.
 * Redis/KV failure falls back to memory like original (not empty HTTP 500).
 */
import { clientIp, json } from "./http.js";
import { memoryRateLimitRequest } from "./model-rate-limit.js";
import type { Env, KVNamespace } from "./types.js";

/** Original `middleware.EmailVerificationRateLimitMark`. */
export const EMAIL_VERIFICATION_RATE_LIMIT_MARK = "EV";
/** Original `middleware.EmailVerificationMaxRequests`. */
export const EMAIL_VERIFICATION_MAX_REQUESTS = 2;
/** Original `middleware.EmailVerificationDuration` (seconds). */
export const EMAIL_VERIFICATION_DURATION = 30;
/** Original `middleware.redisRateLimitNamespace`. */
export const REDIS_RATE_LIMIT_NAMESPACE = "rateLimit:v2";
/** Original memory leftover gin.H message. */
export const MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY = "发送过于频繁，请稍后再试";

const memoryByEnv = new WeakMap<object, Map<string, number[]>>();

/** Original redis leftover `fmt.Sprintf("发送过于频繁，请等待 %d 秒后再试", waitSeconds)`. */
export function emailVerificationRateLimitWaitMessage(waitSeconds: number): string {
  return `发送过于频繁，请等待 ${waitSeconds} 秒后再试`;
}

/** Original `middleware.redisIPRateLimitKey`. */
export function redisIPRateLimitKey(mark: string, clientIP: string): string {
  return `${REDIS_RATE_LIMIT_NAMESPACE}:ip:${mark}:${clientIP}`;
}

/** Original memory limiter key `EmailVerificationRateLimitMark + ":" + c.ClientIP()`. */
export function memoryEmailVerificationKey(clientIP: string): string {
  return `${EMAIL_VERIFICATION_RATE_LIMIT_MARK}:${clientIP}`;
}

type RedisWindow = { count: number; exp: number };

/**
 * Original `middleware.redisFixedWindowTake` (INCR then deny when count > max).
 * KV stores `{count,exp}` because Workers KV has no Redis INCR/TTL.
 */
export async function redisFixedWindowTake(
  kv: KVNamespace,
  key: string,
  maxRequestNum: number,
  duration: number,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ allowed: boolean; count: number; ttlSeconds: number }> {
  if (!key) throw new Error("rate limit key is empty");
  if (maxRequestNum <= 0) throw new Error("rate limit maximum must be positive");
  if (duration <= 0) throw new Error("rate limit duration must be positive");

  const raw = await kv.get(key);
  let count = 0;
  let exp = nowSec + duration;
  if (raw) {
    let parsed: RedisWindow | null = null;
    try {
      parsed = JSON.parse(raw) as RedisWindow;
    } catch {
      throw new Error("unexpected Redis integer reply type");
    }
    if (!parsed || typeof parsed.count !== "number" || typeof parsed.exp !== "number") {
      throw new Error("unexpected Redis rate limit reply length 0");
    }
    if (parsed.exp > nowSec) {
      count = parsed.count;
      exp = parsed.exp;
    }
  }
  count += 1;
  if (count === 1) exp = nowSec + duration;
  let ttlSeconds = exp - nowSec;
  if (ttlSeconds < 0) {
    exp = nowSec + duration;
    ttlSeconds = duration;
  }
  await kv.put(key, JSON.stringify({ count, exp }), { expirationTtl: Math.max(60, ttlSeconds) });
  return { allowed: count <= maxRequestNum, count, ttlSeconds };
}

function memoryQueues(env: Env): Map<string, number[]> {
  let q = memoryByEnv.get(env);
  if (!q) {
    q = new Map();
    memoryByEnv.set(env, q);
  }
  return q;
}

/** Original `common.InMemoryRateLimiter.Request` keyed per worker `Env`. */
export function memoryEmailVerificationRequest(env: Env, clientIP: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const store = memoryQueues(env);
  const key = memoryEmailVerificationKey(clientIP);
  const cur = store.get(key);
  if (!cur) {
    store.set(key, [nowSec]);
    return true;
  }
  const next = memoryRateLimitRequest(cur, EMAIL_VERIFICATION_MAX_REQUESTS, EMAIL_VERIFICATION_DURATION, nowSec);
  store.set(key, next.queue);
  return next.allowed;
}

function tooMany(message: string): Response {
  return json(429, { success: false, message });
}

/**
 * Original `EmailVerificationRateLimit` on `/api/verification`,
 * `/api/oauth/email/bind/start`, and `/api/oauth/email/bind/resend`.
 * `env.KV` is the Redis path (same binding used by ModelRequestRateLimit).
 */
export async function emailVerificationRateLimit(env: Env, req: Request): Promise<Response | null> {
  const ip = clientIp(req);
  if (env.KV) {
    try {
      const taken = await redisFixedWindowTake(
        env.KV,
        redisIPRateLimitKey(EMAIL_VERIFICATION_RATE_LIMIT_MARK, ip),
        EMAIL_VERIFICATION_MAX_REQUESTS,
        EMAIL_VERIFICATION_DURATION,
      );
      if (taken.allowed) return null;
      const waitSeconds = taken.ttlSeconds > 0 ? taken.ttlSeconds : EMAIL_VERIFICATION_DURATION;
      return tooMany(emailVerificationRateLimitWaitMessage(waitSeconds));
    } catch {
      /* original redisEmailVerificationRateLimiter falls back to memory */
    }
  }
  if (!memoryEmailVerificationRequest(env, ip)) return tooMany(MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);
  return null;
}
