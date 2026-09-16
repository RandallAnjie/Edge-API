/**
 * Original `middleware.SetUpLogger` / `RouteTag` leftover gin log line.
 * Format is `LoggerWithFormatter` (not gin's default color formatter):
 * `[GIN] 2006/01/02 - 15:04:05 | tag | requestID | %3d | %13v | %15s | %7s path\n`
 * Tag defaults to `web`; `/api` registered routes are `api`; dashboard billing
 * is `old_api`; registered relay `/v1` `/pg` `/mj` is `relay`. Unmatched
 * `/api` `/v1` NoRoute stays `web`. Extra-OK: skip stdout in node:test unless
 * a sink is installed so TAP is not flooded.
 */
import { ginClientIP } from "./trusted-proxies.js";
import { ginFullPath } from "./router.js";
import {
  popTaskArtifactAccessQuery,
  redactTaskArtifactAccessApplies,
} from "./task-artifact-access.js";
import type { Env } from "./types.js";

/** Original `middleware.RouteTagKey` default when unset. */
export const GIN_ROUTE_TAG_DEFAULT = "web";
/** Original `SetApiRouter` `RouteTag("api")`. */
export const GIN_ROUTE_TAG_API = "api";
/** Original `SetDashboardRouter` `RouteTag("old_api")`. */
export const GIN_ROUTE_TAG_OLD_API = "old_api";
/** Original relay / playground / MJ / plugin `RouteTag("relay")`. */
export const GIN_ROUTE_TAG_RELAY = "relay";

const NS_SECOND = 1_000_000_000n;
const NS_MINUTE = 60n * NS_SECOND;

type GinLogSink = (line: string) => void;
let ginLogSink: GinLogSink | null = null;

/** Original `gin.DefaultWriter` swap used by `TestSetUpLoggerNeverWritesTaskArtifactAccess`. */
export function setGinLogSink(sink: GinLogSink | null): void {
  ginLogSink = sink;
}

/** Original gin `LogFormatterParams.TimeStamp.Format("2006/01/02 - 15:04:05")`. Extra-OK: UTC. */
export function formatGinTimeStamp(now: Date): string {
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return `${y}/${m}/${d} - ${hh}:${mm}:${ss}`;
}

/** Original `time.fmtFrac`: write trailing fractional digits from the right. */
function fmtFrac(buf: string[], w: number, v: bigint, prec: number): { w: number; v: bigint } {
  let print = false;
  for (let i = 0; i < prec; i++) {
    const digit = v % 10n;
    print = print || digit !== 0n;
    if (print) {
      w -= 1;
      buf[w] = String(Number(digit));
    }
    v /= 10n;
  }
  if (print) {
    w -= 1;
    buf[w] = ".";
  }
  return { w, v };
}

/** Original `time.fmtInt`. */
function fmtInt(buf: string[], w: number, v: bigint): number {
  if (v === 0n) {
    w -= 1;
    buf[w] = "0";
  } else {
    while (v > 0n) {
      w -= 1;
      buf[w] = String(Number(v % 10n));
      v /= 10n;
    }
  }
  return w;
}

/**
 * Original `time.Duration.String` used by gin `%13v` Latency.
 * Extra-OK: JS clocks have millisecond precision so leftover nanos are 0.
 */
export function formatGoDuration(ns: number): string {
  let neg = false;
  let u = BigInt(Math.round(ns));
  if (u < 0n) {
    neg = true;
    u = -u;
  }
  const buf = new Array<string>(32);
  let w = 32;
  if (u < NS_SECOND) {
    w -= 1;
    buf[w] = "s";
    if (u === 0n) return "0s";
    w -= 1;
    if (u < 1000n) {
      buf[w] = "n";
    } else if (u < 1_000_000n) {
      buf[w] = "\u00b5";
      const frac = fmtFrac(buf, w, u, 3);
      w = frac.w;
      u = frac.v;
    } else {
      buf[w] = "m";
      const frac = fmtFrac(buf, w, u, 6);
      w = frac.w;
      u = frac.v;
    }
    w = fmtInt(buf, w, u);
  } else {
    w -= 1;
    buf[w] = "s";
    const frac = fmtFrac(buf, w, u, 9);
    w = frac.w;
    u = frac.v;
    w = fmtInt(buf, w, u % 60n);
    u /= 60n;
    if (u > 0n) {
      w -= 1;
      buf[w] = "m";
      w = fmtInt(buf, w, u % 60n);
      u /= 60n;
      if (u > 0n) {
        w -= 1;
        buf[w] = "h";
        w = fmtInt(buf, w, u);
      }
    }
  }
  if (neg) {
    w -= 1;
    buf[w] = "-";
  }
  return buf.slice(w).join("");
}

/** Original gin logger `Latency > time.Minute` then `Truncate(time.Second)`. */
export function ginLogLatencyNs(ns: number): number {
  const v = BigInt(Math.round(ns));
  if (v > NS_MINUTE) return Number(v - (v % NS_SECOND));
  if (v < -NS_MINUTE) {
    const abs = -v;
    return -Number(abs - (abs % NS_SECOND));
  }
  return Number(v);
}

/**
 * Original gin logger Path: `URL.Path` plus `?`+`RawQuery`, after
 * `redactTaskArtifactAccessQuery` pops `access`, then OAuth query Cut.
 */
export function ginLogPath(pathname: string, rawQuery: string): string {
  let raw = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
  if (redactTaskArtifactAccessApplies(pathname) && raw) {
    raw = popTaskArtifactAccessQuery(raw).rawQuery;
  }
  let path = pathname;
  if (raw !== "") path = `${path}?${raw}`;
  if (path.startsWith("/api/oauth/") || path.startsWith("/oauth/")) {
    const cut = path.indexOf("?");
    if (cut >= 0) path = path.slice(0, cut);
  }
  return path;
}

function isDashboardBillingPath(path: string): boolean {
  return (
    path === "/dashboard/billing/subscription" ||
    path === "/dashboard/billing/usage" ||
    path === "/v1/dashboard/billing/subscription" ||
    path === "/v1/dashboard/billing/usage"
  );
}

/**
 * Original `RouteTag` on SetApiRouter / SetDashboardRouter / SetRelayRouter /
 * SetWebRouter NoRoute. `registeredRelay` is original relay-group match.
 */
export function ginRouteTag(method: string, pathname: string, registeredRelay = false): string {
  if (isDashboardBillingPath(pathname)) return GIN_ROUTE_TAG_OLD_API;
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return ginFullPath(method, pathname).startsWith("/api") ? GIN_ROUTE_TAG_API : GIN_ROUTE_TAG_DEFAULT;
  }
  if (method === "POST" && pathname === "/pg/chat/completions") return GIN_ROUTE_TAG_RELAY;
  if (registeredRelay) return GIN_ROUTE_TAG_RELAY;
  return GIN_ROUTE_TAG_DEFAULT;
}

export type GinLogParams = {
  timeStamp: Date;
  tag: string;
  requestId: string;
  statusCode: number;
  latencyNs: number;
  clientIP: string;
  method: string;
  path: string;
};

/** Original `fmt.Sprintf` in `SetUpLogger`. */
export function formatGinLog(param: GinLogParams): string {
  const tag = param.tag || GIN_ROUTE_TAG_DEFAULT;
  const status = String(param.statusCode).padStart(3, " ");
  const latency = formatGoDuration(ginLogLatencyNs(param.latencyNs)).padStart(13, " ");
  const ip = param.clientIP.padStart(15, " ");
  const method = param.method.padStart(7, " ");
  return `[GIN] ${formatGinTimeStamp(param.timeStamp)} | ${tag} | ${param.requestId} | ${status} | ${latency} | ${ip} | ${method} ${param.path}\n`;
}

function writeGinLog(line: string): void {
  if (ginLogSink) {
    ginLogSink(line);
    return;
  }
  if (typeof process !== "undefined" && process.env.NODE_TEST_CONTEXT) return;
  console.log(line.replace(/\n$/, ""));
}

/**
 * Original `SetUpLogger` after `c.Next()` (final status, gzip included).
 * Extra-OK: plugin-dispatcher relay tag is not applied unless `registeredRelay`.
 */
export function emitSetUpLogger(opts: {
  req: Request;
  env?: Pick<Env, "TRUSTED_PROXIES">;
  res: Response;
  requestId: string;
  startedMs: number;
  registeredRelay: boolean;
  now?: Date;
  endedMs?: number;
}): void {
  const url = new URL(opts.req.url);
  const path = ginLogPath(url.pathname, url.search.startsWith("?") ? url.search.slice(1) : url.search);
  const endedMs = opts.endedMs ?? performance.now();
  const line = formatGinLog({
    timeStamp: opts.now ?? new Date(),
    tag: ginRouteTag(opts.req.method, url.pathname, opts.registeredRelay),
    requestId: opts.requestId,
    statusCode: opts.res.status,
    latencyNs: (endedMs - opts.startedMs) * 1e6,
    clientIP: ginClientIP(opts.req, opts.env),
    method: opts.req.method,
    path,
  });
  writeGinLog(line);
}
