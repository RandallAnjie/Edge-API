/**
 * Original `middleware.GlobalAPIRateLimit` leftover empty HTTP 429.
 * Mark `GA`, 360 req / 180s, IP-keyed on `/api` and dashboard billing.
 * Redis/KV deny uses TTL `Retry-After`; memory deny uses the full window.
 * Redis/KV failure is empty HTTP 500 (no memory fallback).
 */
import { envOrDefaultBool, envOrDefaultInt } from "./constants.js";
import { takeIpRateLimit } from "./critical-rate-limit.js";
import type { Env } from "./types.js";

/** Original `middleware.rateLimitFactory` mark for GlobalAPIRateLimit. */
export const GLOBAL_API_RATE_LIMIT_MARK = "GA";
/** Original `common.GlobalApiRateLimitNum`. */
export const GLOBAL_API_RATE_LIMIT_NUM = 360;
/** Original `common.GlobalApiRateLimitDuration` (seconds). */
export const GLOBAL_API_RATE_LIMIT_DURATION = 180;

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Original `SetApiRouter` `/api` group plus `SetDashboardRouter` billing paths
 * that `Use(GlobalAPIRateLimit)`. Relay `/v1` (except dashboard billing) is not on this limiter.
 */
export function globalApiRateLimitApplies(path: string): boolean {
  if (path === "/api" || path.startsWith("/api/")) return true;
  const p = stripTrailingSlash(path);
  return (
    p === "/dashboard/billing/subscription" ||
    p === "/dashboard/billing/usage" ||
    p === "/v1/dashboard/billing/subscription" ||
    p === "/v1/dashboard/billing/usage"
  );
}

/** Original `common.GlobalApiRateLimitEnable` (default true). */
export function globalApiRateLimitEnabled(env: Env): boolean {
  return envOrDefaultBool(env.GLOBAL_API_RATE_LIMIT_ENABLE, true);
}

/** Original `common.GlobalApiRateLimitNum`. */
export function globalApiRateLimitNum(env: Env): number {
  return envOrDefaultInt(env.GLOBAL_API_RATE_LIMIT, GLOBAL_API_RATE_LIMIT_NUM);
}

/** Original `common.GlobalApiRateLimitDuration`. */
export function globalApiRateLimitDuration(env: Env): number {
  return envOrDefaultInt(env.GLOBAL_API_RATE_LIMIT_DURATION, GLOBAL_API_RATE_LIMIT_DURATION);
}

/**
 * Original `GlobalAPIRateLimit` on the `/api` group and dashboard billing.
 * `env.KV` is the Redis path (same binding as CriticalRateLimit).
 */
export async function globalApiRateLimit(env: Env, req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!globalApiRateLimitApplies(url.pathname)) return null;
  if (!globalApiRateLimitEnabled(env)) return null;
  return takeIpRateLimit(env, req, GLOBAL_API_RATE_LIMIT_MARK, globalApiRateLimitNum(env), globalApiRateLimitDuration(env));
}
