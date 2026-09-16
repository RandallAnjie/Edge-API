/**
 * Original `middleware.DecompressRequestMiddleware` leftover empty HTTP 400.
 * `SetRelayRouter` `router.Use` (gzip/br/zstd). GET / nil body skip.
 * `gzip.NewReader` / `zstd.NewReader` fail is `AbortWithStatus(400)` empty.
 * `br` has no open-fail path. `MaxRequestBodyMB` default 128, middleware
 * fallback 32 when `<= 0`. `Header.Del("Content-Encoding")` after decompress.
 */
import { envOrDefaultInt, MAX_REQUEST_BODY_MB } from "./constants.js";
import { carryRequestTrustedProxies } from "./trusted-proxies.js";
import type { Env } from "./types.js";

/** Original `constant.MaxRequestBodyMB` default from `MAX_REQUEST_BODY_MB`. */
export const DEFAULT_MAX_REQUEST_BODY_MB = MAX_REQUEST_BODY_MB;

/** Original `DecompressRequestMiddleware` fallback when `MaxRequestBodyMB <= 0`. */
export const DECOMPRESS_MAX_REQUEST_BODY_MB_FALLBACK = 32;

const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_DEFLATE = 8;
const GZIP_FLAG_HDR_CRC = 1 << 1;
const GZIP_FLAG_EXTRA = 1 << 2;
const GZIP_FLAG_NAME = 1 << 3;
const GZIP_FLAG_COMMENT = 1 << 4;

/** Original `c.Request.Method == http.MethodGet` skip. HEAD still runs. */
export function decompressRequestApplies(method: string): boolean {
  return method !== "GET";
}

/**
 * Original `constant.MaxRequestBodyMB` then middleware `if maxMB <= 0 { maxMB = 32 }`.
 * Init default is 128; `"0"` uses the middleware fallback, not GetRequestBody's 128.
 */
export function getDecompressMaxRequestBodyBytes(env: Env): number {
  let maxMB = envOrDefaultInt(env.MAX_REQUEST_BODY_MB, DEFAULT_MAX_REQUEST_BODY_MB);
  if (maxMB <= 0) maxMB = DECOMPRESS_MAX_REQUEST_BODY_MB_FALLBACK;
  return maxMB << 20;
}

/** Original `c.AbortWithStatus(http.StatusBadRequest)` on gzip/zstd open fail. */
export function writeDecompressRequestFailed(): Response {
  return new Response(null, { status: 400 });
}

/**
 * Original `gzip.NewReader` header parse (`compress/gzip.readHeader`).
 * Short body / bad magic / truncated extra,name,comment,FHCRC are errors.
 */
export function gzipNewReaderFailed(buf: Uint8Array): boolean {
  if (buf.byteLength < 10) return true;
  if (buf[0] !== GZIP_ID1 || buf[1] !== GZIP_ID2 || buf[2] !== GZIP_DEFLATE) return true;
  const flg = buf[3];
  let i = 10;
  if (flg & GZIP_FLAG_EXTRA) {
    if (i + 2 > buf.byteLength) return true;
    const xlen = buf[i] | (buf[i + 1] << 8);
    i += 2 + xlen;
    if (i > buf.byteLength) return true;
  }
  if (flg & GZIP_FLAG_NAME) {
    const z = buf.indexOf(0, i);
    if (z < 0) return true;
    i = z + 1;
  }
  if (flg & GZIP_FLAG_COMMENT) {
    const z = buf.indexOf(0, i);
    if (z < 0) return true;
    i = z + 1;
  }
  if (flg & GZIP_FLAG_HDR_CRC) {
    if (i + 2 > buf.byteLength) return true;
  }
  return false;
}

function compressionFormatSupported(format: string): boolean {
  try {
    new DecompressionStream(format as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

async function inflateWithDecompressionStream(data: Uint8Array, format: string): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const ds = new DecompressionStream(format as CompressionFormat);
  const stream = new Blob([copy]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Original `Header.Del("Content-Encoding")` after a successful wrap. Extra-OK: set Content-Length. */
export function replaceDecompressedRequest(req: Request, body: Uint8Array): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(body.byteLength));
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return carryRequestTrustedProxies(req, new Request(req.url, { method: req.method, headers, body: copy }));
}

/**
 * Original `DecompressRequestMiddleware` on relay `Engine.Use` and later NoRoute.
 * Uncompressed bodies stay untouched (Extra-OK: MaxBytesReader is not a stream wrap).
 */
export async function decompressRequest(
  env: Env,
  req: Request,
): Promise<{ req: Request; error?: undefined } | { req: Request; error: Response }> {
  if (!decompressRequestApplies(req.method)) return { req };
  const encoding = req.headers.get("Content-Encoding");
  if (encoding !== "gzip" && encoding !== "br" && encoding !== "zstd") return { req };
  // Original wrapMaxBytes on the decompressed stream; Extra-OK: do not Abort 400 on oversize.
  void getDecompressMaxRequestBodyBytes(env);

  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await req.arrayBuffer());
  } catch {
    return { req, error: writeDecompressRequestFailed() };
  }

  if (encoding === "gzip") {
    if (gzipNewReaderFailed(buf)) return { req, error: writeDecompressRequestFailed() };
    try {
      const out = await inflateWithDecompressionStream(buf, "gzip");
      return { req: replaceDecompressedRequest(req, out) };
    } catch {
      return { req, error: writeDecompressRequestFailed() };
    }
  }

  if (encoding === "br") {
    if (!compressionFormatSupported("br")) return { req };
    try {
      const out = await inflateWithDecompressionStream(buf, "br");
      return { req: replaceDecompressedRequest(req, out) };
    } catch {
      return { req, error: writeDecompressRequestFailed() };
    }
  }

  if (!compressionFormatSupported("zstd")) return { req };
  try {
    const out = await inflateWithDecompressionStream(buf, "zstd");
    return { req: replaceDecompressedRequest(req, out) };
  } catch {
    return { req, error: writeDecompressRequestFailed() };
  }
}
