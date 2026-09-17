/**
 * Original `github.com/gin-contrib/gzip` v0.0.6 `gzip.Gzip(gzip.DefaultCompression)`.
 * `/api` group, dashboard billing group, and `SetWebRouter` NoRoute wrap the
 * writer when `Accept-Encoding` contains `gzip`. Registered relay `/v1` `/pg`
 * `/mj` stay off (SetRelayRouter has no gzip). PluginDispatcher runs first on
 * NoRoute so plugin routes stay uncompressed.
 */
const skipGzipRequests = new WeakSet<Request>();

/** Original `gzip.DefaultCompression` (`compress/gzip` / `flate.DefaultCompression` = -1). */
export const GZIP_DEFAULT_COMPRESSION = -1;

/** Original `DefaultExcludedExtentions`. */
export const GZIP_EXCLUDED_EXTENSIONS = [".png", ".gif", ".jpeg", ".jpg"] as const;

const excludedExt = new Set<string>(GZIP_EXCLUDED_EXTENSIONS);

/** Original filepath.Ext on Unix (`/` is the only separator). */
export function gzipPathExt(path: string): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const ch = path[i];
    if (ch === "/") return "";
    if (ch === ".") return path.slice(i);
  }
  return "";
}

/**
 * Original `gzipHandler.shouldCompress`.
 * `Accept-Encoding` contains `gzip`; `Connection` contains `Upgrade` skips;
 * `Accept` contains `text/event-stream` skips; excluded image extensions skip.
 */
export function gzipShouldCompress(req: Request): boolean {
  const acceptEncoding = req.headers.get("Accept-Encoding") || "";
  if (!acceptEncoding.includes("gzip")) return false;
  const connection = req.headers.get("Connection") || "";
  if (connection.includes("Upgrade")) return false;
  const accept = req.headers.get("Accept") || "";
  if (accept.includes("text/event-stream")) return false;
  const ext = gzipPathExt(new URL(req.url).pathname);
  if (excludedExt.has(ext)) return false;
  return true;
}

/** Skip gzip for SetRelayRouter / pluginDispatcher responses (original groups have no gzip). */
export function markSkipGzipResponse(req: Request): void {
  skipGzipRequests.add(req);
}

function isWebSocketResponse(res: Response): boolean {
  return res.status === 101 || Boolean((res as Response & { webSocket?: unknown }).webSocket);
}

function toArrayBuffer(buf: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return copy;
}

async function gzipBytes(buf: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  await writer.write(new Uint8Array(toArrayBuffer(buf)));
  await writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Original gzip wrap: `Content-Encoding: gzip`, `Vary: Accept-Encoding`,
 * `Content-Length` = compressed size after `gzip.Writer.Close`.
 * Extra-OK: 101/204 skip (worker OPTIONS 204 is before this middleware).
 * Extra-OK: already-encoded responses are left as-is.
 */
export async function withGzipResponse(req: Request, res: Response): Promise<Response> {
  if (skipGzipRequests.has(req)) return res;
  if (isWebSocketResponse(res)) return res;
  if (res.status === 204) return res;
  if (res.headers.get("Content-Encoding")) return res;
  if (!gzipShouldCompress(req)) return res;

  const buf = res.body ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
  const compressed = await gzipBytes(buf);
  const headers = new Headers(res.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Vary", "Accept-Encoding");
  headers.set("Content-Length", String(compressed.byteLength));
  return new Response(toArrayBuffer(compressed), { status: res.status, statusText: res.statusText, headers });
}
