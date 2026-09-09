import { bytesToHex, sha256Bytes } from "./crypto.js";
import type { PageQuery } from "./types.js";

export function json(status: number, body: unknown, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiOk(data: unknown = null, message = ""): Response {
  return json(200, { success: true, message, data });
}

export function apiOkExtra(data: unknown, extra: Record<string, unknown>, message = ""): Response {
  return json(200, { success: true, message, data, ...extra });
}

export function apiFail(message: string, data: unknown = null, status = 200): Response {
  return json(status, { success: false, message, data });
}

export function apiFailCode(message: string, code: string, status = 200): Response {
  return json(status, { success: false, message, code, data: null });
}

/** Original Stripe/Epay/Creem/Waffo checkout envelope: `{message, data}` plus extra `success`. */
export function payOk(data: unknown): Response {
  return json(200, { message: "success", data, success: true });
}

export function payErr(data: unknown): Response {
  return json(200, { message: "error", data, success: false });
}

const PUBLIC_CONTENT_ETAG_NS = "public-content:v1";

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const raw = ifNoneMatch.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const want = etag.replace(/^W\//, "");
  for (const part of raw.split(",")) {
    const candidate = part.trim().replace(/^W\//, "");
    if (candidate === want) return true;
  }
  return false;
}

/** Original GetNotice/GetAbout/GetHomePageContent/GetUserAgreement/GetPrivacyPolicy. */
export async function serveRevalidatedJSON(req: Request, content: string): Promise<Response> {
  const data = content ?? "";
  const digest = await sha256Bytes(new TextEncoder().encode(`${PUBLIC_CONTENT_ETAG_NS}\0${data}`));
  const etag = `W/"${bytesToHex(digest)}"`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    etag,
    "cache-control": "no-cache",
    vary: "Accept-Encoding",
  };
  if (etagMatches(req.headers.get("if-none-match") || "", etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(JSON.stringify({ success: true, message: "", data }), { status: 200, headers });
}

export function openaiError(
  status: number,
  message: string,
  code = "new_api_error",
  type = "new_api_error",
): Response {
  return json(status, {
    error: { message, type, param: "", code },
  });
}

/** Original `controller.RelayNotImplemented`. */
export function relayNotImplemented(): Response {
  return json(501, {
    error: { message: "API not implemented", type: "new_api_error", param: "", code: "api_not_implemented" },
  });
}

export function corsHeaders(req: Request): Headers {
  const h = new Headers();
  h.set("access-control-allow-origin", req.headers.get("origin") || "*");
  h.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  h.set(
    "access-control-allow-headers",
    req.headers.get("access-control-request-headers") ||
      "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,openai-organization,mj-api-secret,x-security-proof",
  );
  h.set("access-control-allow-credentials", "true");
  h.set("access-control-max-age", "86400");
  return h;
}

export function withCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  const c = corsHeaders(req);
  c.forEach((v, k) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

/** Original `strconv.ParseInt(c.Query(name), 10, 64)`: missing/invalid → 0. */
export function parseUnixQuery(url: URL, name: string): number {
  const raw = url.searchParams.get(name);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function pageQuery(url: URL): PageQuery {
  const page = Math.max(1, Number(url.searchParams.get("p") || url.searchParams.get("page") || "1") || 1);
  const page_size = Math.min(
    100,
    Math.max(
      1,
      Number(
        url.searchParams.get("page_size") ||
          url.searchParams.get("ps") ||
          url.searchParams.get("size") ||
          "10",
      ) || 10,
    ),
  );
  return { page, page_size, offset: (page - 1) * page_size };
}

export function pageData(items: unknown, total: number, q: PageQuery, extra: Record<string, unknown> = {}) {
  return { items, total, page: q.page, page_size: q.page_size, ...extra };
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  return JSON.parse(text);
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    ""
  );
}

export function cookieGet(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionCookie(
  token: string,
  maxAge: number,
  secure: boolean,
  name = "session",
  path = "/",
  sameSite: "Lax" | "Strict" = "Strict",
): string {
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    `Path=${path}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionHintCookie(maxAge: number, secure: boolean): string {
  const parts = ["new_api_has_session=1", "Path=/", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function refreshCookie(token: string, maxAge: number, secure: boolean): string {
  return sessionCookie(token, maxAge, secure, "new_api_refresh", "/api/user/auth", "Strict");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

export function clearAuthCookies(secure: boolean): string[] {
  return [
    sessionCookie("", 0, secure, "session", "/"),
    sessionCookie("", 0, secure, "new_api_refresh", "/api/user/auth"),
    sessionCookie("", 0, secure, "new_api_refresh", "/"),
    "new_api_has_session=; Path=/; Max-Age=0; SameSite=Strict",
  ];
}

export function isSecureRequest(req: Request): boolean {
  const url = new URL(req.url);
  return url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}
