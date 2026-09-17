/**
 * Original `middleware.Cache` on `SetWebRouter` NoRoute after GlobalWebRateLimit.
 * `/` is `Cache-Control: no-cache`; every other RequestURI is `max-age=604800`.
 * Always sets `Cache-Version` to the original hardcoded SHA-256.
 * SPA index fallback overwrites Cache-Control to `no-cache` like the last NoRoute handler.
 * RelayNotFound overwrites Cache-Control but keeps Cache-Version.
 */

/** Original `middleware.Cache` `Cache-Version` header value. */
export const WEB_CACHE_VERSION = "b688f2fb5be447c25e5aa3bd063087a83db32a288bf6a4f35f2d8db310e40b14";

/** Original gin `c.Request.RequestURI` (path + query, no host). */
export function requestURI(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}

/** Original `middleware.Cache` Cache-Control for a RequestURI. */
export function webCacheControl(uri: string): string {
  return uri === "/" ? "no-cache" : "max-age=604800";
}

function withHeaders(res: Response, patch: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(patch)) headers.set(key, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Original `middleware.Cache` before `static.Serve`.
 * `/` is `no-cache`; other URIs are `max-age=604800` (one week).
 */
export function withWebCacheHeaders(req: Request, res: Response): Response {
  return withHeaders(res, {
    "Cache-Control": webCacheControl(requestURI(req)),
    "Cache-Version": WEB_CACHE_VERSION,
  });
}

/**
 * Original NoRoute SPA fallback `c.Header("Cache-Control", "no-cache")` after Cache().
 * Cache-Version from Cache() remains.
 */
export function withSpaCacheHeaders(res: Response): Response {
  return withHeaders(res, {
    "Cache-Control": "no-cache",
    "Cache-Version": WEB_CACHE_VERSION,
  });
}

/**
 * Original Cache() then `controller.RelayNotFound`: Cache-Control is overwritten
 * to no-store; Cache-Version from Cache() remains.
 */
export function withRelayNotFoundWebCache(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Version", WEB_CACHE_VERSION);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
