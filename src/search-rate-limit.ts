/**
 * Original `middleware.SearchRateLimit` leftover empty HTTP 429.
 * Mark `SR`, 10 req / 60s, user-id keyed after UserAuth on token/log search.
 * Missing user ID is empty HTTP 401. Redis/KV failure is empty HTTP 500.
 */
import { envOrDefaultBool, envOrDefaultInt } from "./constants.js";
import { takeKeyedRateLimit } from "./critical-rate-limit.js";
import {
  memoryUserRateLimitKey,
  redisUserRateLimitKey,
  writeUserRateLimitUnauthorized,
} from "./user-critical-rate-limit.js";
import type { Env } from "./types.js";

/** Original `middleware.SearchRateLimit` mark. */
export const SEARCH_RATE_LIMIT_MARK = "SR";
/** Original `common.SearchRateLimitNum`. */
export const SEARCH_RATE_LIMIT_NUM = 10;
/** Original `common.SearchRateLimitDuration` (seconds). */
export const SEARCH_RATE_LIMIT_DURATION = 60;

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Original `api-router` routes that `Use(SearchRateLimit)`.
 * Trailing slash is ignored like gin `/token/search` vs `/token/search/`.
 */
export function searchRateLimitApplies(method: string, path: string): boolean {
  if (method !== "GET") return false;
  const p = stripTrailingSlash(path);
  return p === "/api/token/search" || p === "/api/log/self/search";
}

/** Original `common.SearchRateLimitEnable` (default true). */
export function searchRateLimitEnabled(env: Env): boolean {
  return envOrDefaultBool(env.SEARCH_RATE_LIMIT_ENABLE, true);
}

/** Original `common.SearchRateLimitNum`. */
export function searchRateLimitNum(env: Env): number {
  return envOrDefaultInt(env.SEARCH_RATE_LIMIT, SEARCH_RATE_LIMIT_NUM);
}

/** Original `common.SearchRateLimitDuration`. */
export function searchRateLimitDuration(env: Env): number {
  return envOrDefaultInt(env.SEARCH_RATE_LIMIT_DURATION, SEARCH_RATE_LIMIT_DURATION);
}

/**
 * Original `SearchRateLimit` after UserAuth.
 * `userID == 0` is empty HTTP 401. Enable/num/duration are SEARCH_RATE_LIMIT_*.
 */
export async function searchRateLimit(env: Env, userID: number): Promise<Response | null> {
  if (!searchRateLimitEnabled(env)) return null;
  if (!userID) return writeUserRateLimitUnauthorized();
  return takeKeyedRateLimit(
    env,
    redisUserRateLimitKey(SEARCH_RATE_LIMIT_MARK, userID),
    memoryUserRateLimitKey(SEARCH_RATE_LIMIT_MARK, userID),
    searchRateLimitNum(env),
    searchRateLimitDuration(env),
  );
}
