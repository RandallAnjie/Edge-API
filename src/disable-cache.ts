/**
 * Original `middleware.DisableCache` leftover headers on security/auth routes.
 * `Cache-Control: no-store, no-cache, must-revalidate, private, max-age=0`,
 * `Pragma: no-cache`, `Expires: 0`. Applied after the handler like gin
 * `c.Header` + `c.Next()` (CT/GA/UC abort before this middleware still skip it).
 */

/** Original `middleware.DisableCache` Cache-Control. */
export const DISABLE_CACHE_CONTROL = "no-store, no-cache, must-revalidate, private, max-age=0";

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const EXACT = new Set([
  "POST /api/oauth/state",
  "POST /api/oauth/email/bind/start",
  "POST /api/oauth/email/bind/resend",
  "POST /api/oauth/email/bind",
  "GET /api/oauth/wechat",
  "GET /api/oauth/telegram/login",
  "POST /api/oauth/telegram/bind/start",
  "GET /api/verify/methods",
  "POST /api/verify",
  "POST /api/user/auth/refresh",
  "POST /api/user/auth/logout",
  "GET /api/user/login/encryption-key",
  "POST /api/user/login",
  "POST /api/user/login/2fa",
  "POST /api/user/login/verify",
  "POST /api/user/login/passkey/begin",
  "POST /api/user/login/passkey/finish",
  "POST /api/user/passkey/login/begin",
  "POST /api/user/passkey/login/finish",
  "GET /api/user/sessions",
  "POST /api/user/sessions/revoke-others",
  "GET /api/user/self/groups",
  "GET /api/user/self",
  "GET /api/user/models",
  "PUT /api/user/self",
  "DELETE /api/user/self",
  "GET /api/user/token",
  "GET /api/user/token/status",
  "POST /api/user/token",
  "DELETE /api/user/token",
  "GET /api/user/passkey",
  "POST /api/user/passkey/register/begin",
  "POST /api/user/passkey/register/finish",
  "POST /api/user/passkey/verify/begin",
  "POST /api/user/passkey/verify/finish",
  "DELETE /api/user/passkey",
  "GET /api/user/aff",
  "GET /api/user/topup/info",
  "GET /api/user/topup/self",
  "POST /api/user/topup",
  "POST /api/user/pay",
  "POST /api/user/amount",
  "POST /api/user/stripe/pay",
  "POST /api/user/stripe/amount",
  "POST /api/user/creem/pay",
  "POST /api/user/waffo/amount",
  "POST /api/user/waffo/pay",
  "POST /api/user/waffo-pancake/amount",
  "POST /api/user/waffo-pancake/pay",
  "POST /api/user/aff_transfer",
  "PUT /api/user/setting",
  "GET /api/user/2fa/status",
  "POST /api/user/2fa/setup",
  "POST /api/user/2fa/enable",
  "POST /api/user/2fa/disable",
  "POST /api/user/2fa/backup_codes",
  "GET /api/user/checkin",
  "POST /api/user/checkin",
  "GET /api/user/oauth/bindings",
  "POST /api/token/batch/keys",
  "GET /api/audit",
  "GET /api/audit/self",
]);

/**
 * Original `api-router` / `channel-router` routes that `Use(DisableCache)`.
 * `selfRoute.Use(DisableCache(), UserAuth())` covers the logged-in user group.
 */
export function disableCacheApplies(method: string, path: string): boolean {
  const p = stripTrailingSlash(path);
  if (EXACT.has(`${method} ${p}`)) return true;
  if (method === "GET" && /^\/api\/oauth\/telegram\/bind\/[^/]+$/.test(p)) return true;
  if (method === "GET" && /^\/api\/oauth\/[^/]+$/.test(p)) return true;
  if (method === "POST" && /^\/api\/token\/[^/]+\/key$/.test(p)) return true;
  if (method === "POST" && /^\/api\/channel\/[^/]+\/key$/.test(p)) return true;
  if (method === "DELETE" && /^\/api\/user\/sessions\/[^/]+$/.test(p)) return true;
  if (method === "DELETE" && /^\/api\/user\/oauth\/bindings\/[^/]+$/.test(p)) return true;
  return false;
}

/** Original `middleware.DisableCache` headers. */
export function withDisableCacheHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", DISABLE_CACHE_CONTROL);
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Original DisableCache after route middleware that did not Abort.
 * Callers apply this only on dispatched handler responses (not GA/CT/UC 429).
 */
export function applyDisableCache(req: Request, res: Response): Response {
  const url = new URL(req.url);
  if (!disableCacheApplies(req.method, url.pathname)) return res;
  return withDisableCacheHeaders(res);
}
