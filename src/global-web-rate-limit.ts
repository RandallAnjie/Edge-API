/**
 * Original `middleware.GlobalWebRateLimit` leftover empty HTTP 429.
 * Mark `GW`, 120 req / 180s, IP-keyed on `SetWebRouter` NoRoute (SPA/static
 * and unmatched `/api` `/v1` `/assets`). Redis/KV deny uses TTL `Retry-After`;
 * memory deny uses the full window. Redis/KV failure is empty HTTP 500 (no memory fallback).
 */
import { envOrDefaultBool, envOrDefaultInt } from "./constants.js";
import { takeIpRateLimit } from "./critical-rate-limit.js";
import type { Env } from "./types.js";

/** Original `middleware.rateLimitFactory` mark for GlobalWebRateLimit. */
export const GLOBAL_WEB_RATE_LIMIT_MARK = "GW";
/** Original `common.GlobalWebRateLimitNum`. */
export const GLOBAL_WEB_RATE_LIMIT_NUM = 120;
/** Original `common.GlobalWebRateLimitDuration` (seconds). */
export const GLOBAL_WEB_RATE_LIMIT_DURATION = 180;

/** Original `common.GlobalWebRateLimitEnable` (default true). */
export function globalWebRateLimitEnabled(env: Env): boolean {
  return envOrDefaultBool(env.GLOBAL_WEB_RATE_LIMIT_ENABLE, true);
}

/** Original `common.GlobalWebRateLimitNum`. */
export function globalWebRateLimitNum(env: Env): number {
  return envOrDefaultInt(env.GLOBAL_WEB_RATE_LIMIT, GLOBAL_WEB_RATE_LIMIT_NUM);
}

/** Original `common.GlobalWebRateLimitDuration`. */
export function globalWebRateLimitDuration(env: Env): number {
  return envOrDefaultInt(env.GLOBAL_WEB_RATE_LIMIT_DURATION, GLOBAL_WEB_RATE_LIMIT_DURATION);
}

/**
 * Original `GlobalWebRateLimit` on `SetWebRouter` NoRoute.
 * `env.KV` is the Redis path (same binding as GlobalAPIRateLimit).
 * Callers invoke this only on NoRoute-equivalent fallthrough (not registered api/relay).
 */
export async function globalWebRateLimit(env: Env, req: Request): Promise<Response | null> {
  if (!globalWebRateLimitEnabled(env)) return null;
  return takeIpRateLimit(env, req, GLOBAL_WEB_RATE_LIMIT_MARK, globalWebRateLimitNum(env), globalWebRateLimitDuration(env));
}
