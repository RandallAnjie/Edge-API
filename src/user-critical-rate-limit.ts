/**
 * Original `middleware.UserCriticalRateLimit` leftover empty HTTP 429.
 * Mark `UC:{scope}`, 20 req / 20*60s, user-id keyed after UserAuth.
 * Missing user ID is empty HTTP 401. Redis/KV failure is empty HTTP 500.
 * Shares `CRITICAL_RATE_LIMIT_ENABLE` / num / duration with CriticalRateLimit.
 */
import { REDIS_RATE_LIMIT_NAMESPACE } from "./email-verification-rate-limit.js";
import {
  criticalRateLimitDuration,
  criticalRateLimitEnabled,
  criticalRateLimitNum,
  takeKeyedRateLimit,
} from "./critical-rate-limit.js";
import type { Env } from "./types.js";

/** Original `UserCriticalRateLimit` mark prefix `"UC:" + scope`. */
export const USER_CRITICAL_RATE_LIMIT_MARK_PREFIX = "UC:";

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const SCOPES = new Map<string, string>([
  ["POST /api/oauth/email/bind/start", "account-security"],
  ["POST /api/oauth/email/bind/resend", "account-security"],
  ["POST /api/oauth/email/bind", "account-security"],
  ["POST /api/verify", "security-verification"],
  ["GET /api/user/token", "access-token"],
  ["POST /api/user/token", "access-token"],
  ["DELETE /api/user/token", "access-token"],
  ["POST /api/user/passkey/register/begin", "security-verification"],
  ["POST /api/user/passkey/register/finish", "security-verification"],
  ["POST /api/user/passkey/verify/begin", "security-verification"],
  ["POST /api/user/passkey/verify/finish", "security-verification"],
  ["POST /api/user/aff_transfer", "aff-transfer"],
  ["POST /api/user/2fa/setup", "security-verification"],
  ["POST /api/user/2fa/enable", "security-verification"],
]);

/**
 * Original `api-router` routes that `Use(UserCriticalRateLimit(scope))`.
 * Returns the original scope string, or null when the limiter does not apply.
 */
export function userCriticalRateLimitScope(method: string, path: string): string | null {
  return SCOPES.get(`${method} ${stripTrailingSlash(path)}`) ?? null;
}

export function userCriticalRateLimitApplies(method: string, path: string): boolean {
  return userCriticalRateLimitScope(method, path) != null;
}

/** Original `UserCriticalRateLimit` mark `"UC:"+scope`. */
export function userCriticalRateLimitMark(scope: string): string {
  return `${USER_CRITICAL_RATE_LIMIT_MARK_PREFIX}${scope}`;
}

/** Original `middleware.redisUserRateLimitKey`. */
export function redisUserRateLimitKey(mark: string, userID: number): string {
  return `${REDIS_RATE_LIMIT_NAMESPACE}:user:${mark}:${userID}`;
}

/** Original memory limiter key `fmt.Sprintf("%s:user:%d", mark, userID)`. */
export function memoryUserRateLimitKey(mark: string, userID: number): string {
  return `${mark}:user:${userID}`;
}

/** Original `userRateLimitFactory` leftover `c.Status(http.StatusUnauthorized); c.Abort()`. */
export function writeUserRateLimitUnauthorized(): Response {
  return new Response(null, { status: 401 });
}

/**
 * Original `UserCriticalRateLimit` after UserAuth.
 * `userID == 0` is empty HTTP 401. Enable/num/duration follow CriticalRateLimit.
 */
export async function userCriticalRateLimit(env: Env, userID: number, scope: string): Promise<Response | null> {
  if (!criticalRateLimitEnabled(env)) return null;
  if (!userID) return writeUserRateLimitUnauthorized();
  const mark = userCriticalRateLimitMark(scope);
  return takeKeyedRateLimit(
    env,
    redisUserRateLimitKey(mark, userID),
    memoryUserRateLimitKey(mark, userID),
    criticalRateLimitNum(env),
    criticalRateLimitDuration(env),
  );
}
