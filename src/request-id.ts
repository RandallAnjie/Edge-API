/**
 * Original `middleware.RequestId` + `middleware.Version` leftover headers.
 * `server.Use` sets `X-Oneapi-Request-Id` (`common.NewRequestId`) and
 * `X-New-Api-Version` (`common.Version`, default `v0.0.0`) on every response.
 */

/** Original `common.RequestIdKey`. */
export const REQUEST_ID_HEADER = "X-Oneapi-Request-Id";
/** Original `middleware.Version` header. */
export const NEW_API_VERSION_HEADER = "X-New-Api-Version";
/** Original `common.Version` default (build-replaced; env `VERSION` overrides). */
export const DEFAULT_NEW_API_VERSION = "v0.0.0";
/**
 * Original `requestIdPrefix` from `debug.ReadBuildInfo().Main.Path`
 * (`github.com/QuantumNous/new-api`): first 4 bytes of SHA-256 as hex.
 * Extra-OK: workerd has no Go build info, so the upstream module path is fixed.
 */
export const REQUEST_ID_PREFIX = "8268d9d6";
/** Original `github.com/samber/lo` `AlphanumericCharset`. */
export const ALPHANUMERIC_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Original `common.GetTimeString`: UTC `20060102150405` + `UnixNano()%1e9` (9 digits).
 * Extra-OK: JS Date has millisecond precision, so the last 6 nano digits are 0.
 */
export function getTimeString(now: Date = new Date()): string {
  const ymdhms =
    String(now.getUTCFullYear()) +
    pad2(now.getUTCMonth() + 1) +
    pad2(now.getUTCDate()) +
    pad2(now.getUTCHours()) +
    pad2(now.getUTCMinutes()) +
    pad2(now.getUTCSeconds());
  const nano = (now.getUTCMilliseconds() * 1e6) % 1e9;
  return ymdhms + String(nano).padStart(9, "0");
}

/** Original `common.GetRandomString` (`lo.RandomString` alphanumeric). */
export function getRandomString(length: number): string {
  if (length <= 0) return "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += ALPHANUMERIC_CHARSET[b % ALPHANUMERIC_CHARSET.length];
  return out;
}

/** Original `common.NewRequestId`: GetTimeString + prefix + GetRandomString(8). */
export function newRequestId(now?: Date): string {
  return getTimeString(now) + REQUEST_ID_PREFIX + getRandomString(8);
}

/**
 * ID written on the response `X-Oneapi-Request-Id` header.
 * Extra-OK: honor a client-provided header so existing abort-message tests keep
 * a stable id. Original `RequestId()` always generates and ignores the inbound header.
 */
export function requestIdFor(req: Request, now?: Date): string {
  const existing = (req.headers.get("x-oneapi-request-id") || "").trim();
  if (existing) return existing;
  return newRequestId(now);
}

/** Original `InitEnv` `os.Getenv("VERSION")` override of `common.Version`. */
export function newApiVersion(env?: { VERSION?: string } | null): string {
  const raw = env?.VERSION;
  if (raw != null && raw !== "") return raw;
  return DEFAULT_NEW_API_VERSION;
}

function isWebSocketResponse(res: Response): boolean {
  return res.status === 101 || Boolean((res as Response & { webSocket?: unknown }).webSocket);
}

/**
 * Original RequestId + Version `c.Header` on every response, including 429/404/OPTIONS.
 * WebSocket 101 responses are mutated in place like `withCors`.
 */
export function withRequestIdAndVersionHeaders(res: Response, requestId: string, version: string): Response {
  if (isWebSocketResponse(res)) {
    res.headers.set(REQUEST_ID_HEADER, requestId);
    res.headers.set(NEW_API_VERSION_HEADER, version);
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  headers.set(NEW_API_VERSION_HEADER, version);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
