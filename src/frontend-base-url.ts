/**
 * Original `SetRouter` slave `FRONTEND_BASE_URL` leftover HTTP 301.
 * Master (`NODE_TYPE != "slave"`) ignores the env and keeps SetWebRouter.
 * Slave NoRoute is pluginDispatcher then `c.Redirect(301, base+RequestURI)`
 * (no gzip, GW, or Cache). Extra-OK: hop 307 unmatched `/api` may still
 * consume GlobalAPIRateLimit before this redirect.
 */
import type { Env } from "./types.js";

/** Original `http.StatusMovedPermanently`. */
export const FRONTEND_BASE_URL_STATUS = 301;

/** Original `http.StatusText(http.StatusMovedPermanently)`. */
export const FRONTEND_BASE_URL_STATUS_TEXT = "Moved Permanently";

/** Original gin Redirect GET/HEAD `Content-Type`. */
export const FRONTEND_BASE_URL_CONTENT_TYPE = "text/html; charset=utf-8";

/** Original `common.IsMasterNode` (`NODE_TYPE != "slave"`). */
export function isMasterNode(env: Pick<Env, "NODE_TYPE">): boolean {
  return String(env.NODE_TYPE || "") !== "slave";
}

/** Original `strings.TrimSuffix(frontendBaseUrl, "/")`. */
export function trimFrontendBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/** Original `os.Getenv("FRONTEND_BASE_URL")` after master-node ignore. */
export function frontendBaseUrl(env: Pick<Env, "NODE_TYPE" | "FRONTEND_BASE_URL">): string {
  if (isMasterNode(env)) return "";
  return trimFrontendBaseUrl(String(env.FRONTEND_BASE_URL || ""));
}

export function frontendBaseUrlRedirectApplies(env: Pick<Env, "NODE_TYPE" | "FRONTEND_BASE_URL">): boolean {
  return frontendBaseUrl(env) !== "";
}

/** Original `c.Request.RequestURI` (path + raw query, no hash). */
export function requestURI(req: Request): string {
  const url = new URL(req.url);
  return `${url.pathname}${url.search}`;
}

/** Original `html.EscapeString` used by `net/http.Redirect`. */
export function htmlEscapeString(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
}

/** Original `fmt.Sprintf("%s%s", frontendBaseUrl, c.Request.RequestURI)`. */
export function frontendBaseUrlLocation(base: string, req: Request): string {
  return `${trimFrontendBaseUrl(base)}${requestURI(req)}`;
}

/**
 * Original `net/http.Redirect` body on GET:
 * `<a href="{escaped}">Moved Permanently</a>.\n\n`
 */
export function frontendBaseUrlRedirectBody(location: string): string {
  return `<a href="${htmlEscapeString(location)}">${FRONTEND_BASE_URL_STATUS_TEXT}</a>.\n\n`;
}

/** Original `c.Redirect(http.StatusMovedPermanently, …)`. */
export function writeFrontendBaseUrlRedirect(base: string, req: Request): Response {
  const location = frontendBaseUrlLocation(base, req);
  const headers = new Headers({ location });
  if (req.method === "GET" || req.method === "HEAD") {
    headers.set("content-type", FRONTEND_BASE_URL_CONTENT_TYPE);
  }
  const body = req.method === "GET" ? frontendBaseUrlRedirectBody(location) : null;
  return new Response(body, { status: FRONTEND_BASE_URL_STATUS, headers });
}

export function frontendBaseUrlRedirect(
  env: Pick<Env, "NODE_TYPE" | "FRONTEND_BASE_URL">,
  req: Request,
): Response | null {
  const base = frontendBaseUrl(env);
  if (!base) return null;
  return writeFrontendBaseUrlRedirect(base, req);
}
