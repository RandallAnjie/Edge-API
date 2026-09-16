/**
 * Original `middleware.AnonymousRequestBodyLimit` leftover empty HTTP 413 / 400.
 * Default 512 KiB (`ANONYMOUS_REQUEST_BODY_LIMIT_KB`). `<= 0` disables.
 * Too-large is `AbortWithStatus(413)`; any other read error is `AbortWithStatus(400)`.
 */
import { envOrDefaultInt } from "./constants.js";
import { carryRequestTrustedProxies } from "./trusted-proxies.js";
import type { Env } from "./types.js";

/** Original `common.defaultAnonymousRequestBodyLimitKB`. */
export const DEFAULT_ANONYMOUS_REQUEST_BODY_LIMIT_KB = 512;

/** Original `common.ErrRequestBodyTooLarge`. */
export const ERR_REQUEST_BODY_TOO_LARGE = "request body too large";

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super(ERR_REQUEST_BODY_TOO_LARGE);
    this.name = "RequestBodyTooLargeError";
  }
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

const EXACT = new Set([
  "POST /api/setup",
  "POST /api/user/reset",
  "POST /api/oauth/state",
  "POST /api/stripe/webhook",
  "POST /api/creem/webhook",
  "POST /api/waffo/webhook",
  "POST /api/user/register",
  "POST /api/user/login",
  "POST /api/user/login/2fa",
  "POST /api/user/login/verify",
  "POST /api/user/login/passkey/begin",
  "POST /api/user/login/passkey/finish",
  "POST /api/user/passkey/login/begin",
  "POST /api/user/passkey/login/finish",
  "POST /api/user/epay/notify",
  "POST /api/subscription/epay/notify",
  "POST /api/subscription/epay/return",
]);

/**
 * Original `api-router` routes that `Use(AnonymousRequestBodyLimit)`.
 * Trailing slash is ignored like gin `/setup` vs `/setup/`.
 */
export function anonymousRequestBodyLimitApplies(method: string, path: string): boolean {
  const p = stripTrailingSlash(path);
  if (EXACT.has(`${method} ${p}`)) return true;
  if (method === "POST" && /^\/api\/waffo-pancake\/webhook\/[^/]+$/.test(p)) return true;
  return false;
}

/** Original `common.GetAnonymousRequestBodyLimitBytes`. */
export function getAnonymousRequestBodyLimitBytes(env: Env): number {
  let limitKB = envOrDefaultInt(env.ANONYMOUS_REQUEST_BODY_LIMIT_KB, DEFAULT_ANONYMOUS_REQUEST_BODY_LIMIT_KB);
  if (limitKB < 0) limitKB = DEFAULT_ANONYMOUS_REQUEST_BODY_LIMIT_KB;
  return limitKB << 10;
}

/** Original `c.AbortWithStatus(http.StatusRequestEntityTooLarge)`. */
export function writeRequestEntityTooLarge(): Response {
  return new Response(null, { status: 413 });
}

/** Original `c.AbortWithStatus(http.StatusBadRequest)` on body read error. */
export function writeRequestBodyReadFailed(): Response {
  return new Response(null, { status: 400 });
}

export function isRequestBodyTooLargeError(err: unknown): boolean {
  return err instanceof RequestBodyTooLargeError;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Original `readAnonymousRequestBody`: `io.ReadAll(io.LimitReader(body, maxBytes+1))`.
 * Throws `RequestBodyTooLargeError` when the capped read exceeds `maxBytes`.
 */
export async function readAnonymousRequestBody(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cap = maxBytes + 1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const next = total + value.byteLength;
      if (next > cap) {
        const take = cap - total;
        if (take > 0) chunks.push(value.subarray(0, take));
        total = cap;
        break;
      }
      chunks.push(value);
      total = next;
      if (total >= cap) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed or failed */
    }
  }
  const data = concatBytes(chunks, total);
  if (data.byteLength > maxBytes) throw new RequestBodyTooLargeError();
  return data;
}

/** Original middleware replaces `c.Request.Body` with the buffered limited bytes. */
export function replaceRequestBody(req: Request, body: Uint8Array): Request {
  const headers = new Headers(req.headers);
  headers.set("content-length", String(body.byteLength));
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return carryRequestTrustedProxies(req, new Request(req.url, { method: req.method, headers, body: copy }));
}

/**
 * Original `AnonymousRequestBodyLimit` on setup/login/register/reset/oauth-state/webhooks.
 * `maxBytes <= 0` or a nil body skips like original.
 */
export async function anonymousRequestBodyLimit(env: Env, req: Request): Promise<{ req: Request; error?: undefined } | { req: Request; error: Response }> {
  const url = new URL(req.url);
  if (!anonymousRequestBodyLimitApplies(req.method, url.pathname)) return { req };
  const maxBytes = getAnonymousRequestBodyLimitBytes(env);
  if (maxBytes <= 0 || req.body == null) return { req };
  try {
    const buf = await readAnonymousRequestBody(req.body, maxBytes);
    return { req: replaceRequestBody(req, buf) };
  } catch (err) {
    if (isRequestBodyTooLargeError(err)) return { req, error: writeRequestEntityTooLarge() };
    return { req, error: writeRequestBodyReadFailed() };
  }
}
