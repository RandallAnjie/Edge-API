/**
 * Original `middleware.SessionCookieOriginGuard` leftover HTTP 403 gin.H
 * `{success:false,code:"AUTH_ORIGIN_FORBIDDEN",message:"request origin is not allowed"}`
 * (omit `data`) on POST `/api/user/auth/refresh` and `/logout` when
 * `SESSION_COOKIE_SECURE=true`. Runs before CriticalRateLimit / DisableCache.
 * Does not trust `X-Forwarded-Proto`. Extra-OK: invalid env does not fail the
 * Worker (original `InitSessionCookieSettings` fatals); the guard stays off.
 */
import { apiFailCode } from "./http.js";
import type { Env } from "./types.js";

/** Original `AUTH_ORIGIN_FORBIDDEN` code. */
export const AUTH_ORIGIN_FORBIDDEN_CODE = "AUTH_ORIGIN_FORBIDDEN";
/** Original SessionCookieOriginGuard message. */
export const AUTH_ORIGIN_FORBIDDEN_MESSAGE = "request origin is not allowed";

export type SessionCookieSettings = {
  secure: boolean;
  trustedOrigins: string[];
};

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Original refresh/logout routes that `Use(SessionCookieOriginGuard)`. */
export function sessionCookieOriginGuardApplies(method: string, path: string): boolean {
  const p = stripTrailingSlash(path);
  return method === "POST" && (p === "/api/user/auth/refresh" || p === "/api/user/auth/logout");
}

function headerValues(req: Request, name: string): string[] {
  const needle = name.toLowerCase();
  const out: string[] = [];
  req.headers.forEach((value, key) => {
    if (key.toLowerCase() === needle) out.push(value);
  });
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/**
 * Original `common.NormalizeOrigin`: exact scheme/host/effective-port.
 * Paths, userinfo, query, fragment, `null`, and wildcards are rejected.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null" || /[\r\n]/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname && parsed.pathname !== "/") return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.includes("*")) return null;
  const scheme = parsed.protocol.slice(0, -1);
  const port = parsed.port;
  const dropPort =
    port === "" || (scheme === "http" && port === "80") || (scheme === "https" && port === "443");
  const bracketHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  if (dropPort) return `${scheme}://${bracketHost}`;
  return `${scheme}://${hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`}`;
}

function parseTrustedOrigins(trustedURLsRaw: string): string[] | null {
  if (!trustedURLsRaw) return null;
  const origins: string[] = [];
  for (const part of trustedURLsRaw.split(",")) {
    const trustedURL = part.trim();
    if (!trustedURL) return null;
    const origin = normalizeOrigin(trustedURL);
    if (!origin) return null;
    if (!origin.startsWith("https://")) return null;
    origins.push(origin);
  }
  return origins;
}

/**
 * Original `common.InitSessionCookieSettings`.
 * Extra-OK: parse failures leave the guard off instead of FatalLog.
 */
export function sessionCookieSettings(env: Env): SessionCookieSettings {
  const secureRaw = String(env.SESSION_COOKIE_SECURE || "").trim();
  const trustedRaw = String(env.SESSION_COOKIE_TRUSTED_URL || "").trim();
  if (secureRaw === "" || secureRaw.toLowerCase() === "false") {
    return { secure: false, trustedOrigins: [] };
  }
  if (secureRaw.toLowerCase() !== "true") {
    return { secure: false, trustedOrigins: [] };
  }
  const trustedOrigins = parseTrustedOrigins(trustedRaw);
  if (!trustedOrigins) return { secure: false, trustedOrigins: [] };
  return { secure: true, trustedOrigins };
}

/** Original `requestBrowserOrigin`. */
export function requestBrowserOrigin(req: Request): string | null {
  const originValues = headerValues(req, "origin");
  if (originValues.length > 1) return null;
  if (originValues.length === 1) {
    const raw = originValues[0] || "";
    if (raw.includes(",")) return null;
    return normalizeOrigin(raw);
  }
  const refererValues = headerValues(req, "referer");
  if (refererValues.length !== 1) return null;
  try {
    const referer = new URL((refererValues[0] || "").trim());
    if (!referer.protocol || !referer.host || referer.username || referer.password) return null;
    return normalizeOrigin(`${referer.protocol.replace(":", "")}://${referer.host}`);
  } catch {
    return null;
  }
}

/**
 * Original `isAllowedSessionOrigin`. Scheme comes from the request URL
 * (Go `request.TLS != nil`), not `X-Forwarded-Proto`.
 */
export function isAllowedSessionOrigin(req: Request, origin: string, trustedOrigins: string[]): boolean {
  const scheme = new URL(req.url).protocol === "https:" ? "https" : "http";
  const host = (req.headers.get("host") || new URL(req.url).host).trim();
  const requestOrigin = normalizeOrigin(`${scheme}://${host}`);
  if (requestOrigin && constantTimeEqual(origin, requestOrigin)) return true;
  for (const trusted of trustedOrigins) {
    if (constantTimeEqual(origin, trusted)) return true;
  }
  return false;
}

function originForbidden(): Response {
  return apiFailCode(AUTH_ORIGIN_FORBIDDEN_MESSAGE, AUTH_ORIGIN_FORBIDDEN_CODE, 403);
}

/** Original `middleware.SessionCookieOriginGuard`. */
export function sessionCookieOriginGuard(env: Env, req: Request): Response | null {
  if (!sessionCookieOriginGuardApplies(req.method, new URL(req.url).pathname)) return null;
  const settings = sessionCookieSettings(env);
  if (!settings.secure) return null;
  const origin = requestBrowserOrigin(req);
  if (!origin || !isAllowedSessionOrigin(req, origin, settings.trustedOrigins)) {
    return originForbidden();
  }
  return null;
}
