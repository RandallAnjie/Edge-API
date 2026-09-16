/**
 * Original `middleware.TokenOrTaskArtifactAccessAuth` leftover JSON/headers.
 * Capability `?access=` is verified before any database read. Missing access
 * falls through to TokenAuth. Invalid access is HTTP 404 `artifact_not_found`;
 * limiter deny is HTTP 429 `artifact_access_limited` + `Retry-After: 60`.
 * Extra-OK: limiter state is WeakMap-keyed by D1 so parallel npm tests isolate.
 */
import { envOrDefaultInt } from "./constants.js";
import { hmacSha256Raw, timingSafeEqualStr } from "./crypto.js";
import { clientIp, json } from "./http.js";
import { carryRequestTrustedProxies } from "./trusted-proxies.js";
import type { Env } from "./types.js";

/** Original `service.TaskArtifactAccessQueryParameter`. */
export const TASK_ARTIFACT_ACCESS_QUERY_PARAMETER = "access";
/** Original `service.taskArtifactAccessVersion`. */
export const TASK_ARTIFACT_ACCESS_VERSION = "v1";
/** Original `service.taskArtifactAccessLength` (raw-URL SHA-256). */
export const TASK_ARTIFACT_ACCESS_LENGTH = 43;
/** Original `service.maxTaskArtifactTaskIDLength`. */
export const MAX_TASK_ARTIFACT_TASK_ID_LENGTH = 191;
/** Original `service.maxTaskArtifactKeyLength`. */
export const MAX_TASK_ARTIFACT_KEY_LENGTH = 128;
/** Original `middleware.maxEncodedTaskArtifactAccessQuerySize`. */
export const MAX_ENCODED_TASK_ARTIFACT_ACCESS_QUERY_SIZE = 128;
/** Original `sha256.Size`. */
export const TASK_ARTIFACT_ACCESS_HMAC_SIZE = 32;

/** Original `system_setting.DefaultTaskArtifactInvalidRateLimitPerMinute`. */
export const DEFAULT_TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE = 60;
/** Original `system_setting.DefaultTaskArtifactGlobalConcurrency`. */
export const DEFAULT_TASK_ARTIFACT_GLOBAL_CONCURRENCY = 128;
/** Original `system_setting.DefaultTaskArtifactIPConcurrency`. */
export const DEFAULT_TASK_ARTIFACT_IP_CONCURRENCY = 64;
/** Original `system_setting.DefaultTaskArtifactObjectConcurrency`. */
export const DEFAULT_TASK_ARTIFACT_OBJECT_CONCURRENCY = 16;

/** Original `middleware.taskArtifactAccessRateWindow`. */
export const TASK_ARTIFACT_ACCESS_RATE_WINDOW_MS = 60_000;
/** Original `middleware.taskArtifactAccessCleanupInterval`. */
export const TASK_ARTIFACT_ACCESS_CLEANUP_INTERVAL_MS = 60_000;

/** Original `writeTaskArtifactAccessNotFound` / `writeTaskArtifactError` collapse. */
export const ARTIFACT_NOT_FOUND = "artifact_not_found";
export const ARTIFACT_NOT_FOUND_MESSAGE = "Task or artifact not found";
/** Original `writeTaskArtifactAccessLimited`. */
export const ARTIFACT_ACCESS_LIMITED = "artifact_access_limited";
export const ARTIFACT_ACCESS_LIMITED_TYPE = "rate_limit_error";
export const ARTIFACT_ACCESS_LIMITED_MESSAGE = "Artifact access limit exceeded";
/** Original `http.StatusTooManyRequests` Retry-After seconds. */
export const ARTIFACT_ACCESS_RETRY_AFTER = "60";
/** Original `c.Header("Cache-Control", "private, no-store")`. */
export const TASK_ARTIFACT_CACHE_CONTROL = "private, no-store";

export type TaskArtifactAccessLimits = {
  invalidRatePerMinute: number;
  globalConcurrency: number;
  ipConcurrency: number;
  objectConcurrency: number;
};

export type TaskArtifactAccessPop = {
  rawAccess: string;
  present: boolean;
  invalid: boolean;
  rawQuery: string;
};

type RateEntry = { windowStart: number; count: number };

export class TaskArtifactAccessLimiter {
  global = 0;
  readonly byIP = new Map<string, number>();
  readonly byObject = new Map<string, number>();
  readonly rates = new Map<string, RateEntry>();
  nextCleanup = 0;

  constructor(readonly limits: TaskArtifactAccessLimits) {}

  /** Original `taskArtifactAccessLimiter.invalidAttempt`. */
  invalidAttempt(now: number, ip: string): boolean {
    if (!this.nextCleanup || now - this.nextCleanup >= 0) {
      for (const [key, entry] of this.rates) {
        if (now - entry.windowStart >= TASK_ARTIFACT_ACCESS_RATE_WINDOW_MS) this.rates.delete(key);
      }
      this.nextCleanup = now + TASK_ARTIFACT_ACCESS_CLEANUP_INTERVAL_MS;
    }
    let rate = this.rates.get(ip);
    if (!rate || now - rate.windowStart >= TASK_ARTIFACT_ACCESS_RATE_WINDOW_MS) {
      rate = { windowStart: now, count: 0 };
    }
    if (rate.count >= this.limits.invalidRatePerMinute) return false;
    rate.count += 1;
    this.rates.set(ip, rate);
    return true;
  }

  /** Original `taskArtifactAccessLimiter.acquire`. */
  acquire(ip: string, taskID: string, artifactKey: string): { release: () => void; ok: true } | { ok: false } {
    const objectKey = `${taskID}\0${artifactKey}`;
    if (
      this.global >= this.limits.globalConcurrency ||
      (this.byIP.get(ip) || 0) >= this.limits.ipConcurrency ||
      (this.byObject.get(objectKey) || 0) >= this.limits.objectConcurrency
    ) {
      return { ok: false };
    }
    this.global += 1;
    this.byIP.set(ip, (this.byIP.get(ip) || 0) + 1);
    this.byObject.set(objectKey, (this.byObject.get(objectKey) || 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.global -= 1;
        const nextIP = (this.byIP.get(ip) || 1) - 1;
        if (nextIP <= 0) this.byIP.delete(ip);
        else this.byIP.set(ip, nextIP);
        const nextObj = (this.byObject.get(objectKey) || 1) - 1;
        if (nextObj <= 0) this.byObject.delete(objectKey);
        else this.byObject.set(objectKey, nextObj);
      },
    };
  }
}

const limiterByDb = new WeakMap<object, TaskArtifactAccessLimiter>();
const poppedByReq = new WeakMap<Request, TaskArtifactAccessPop>();
const capabilityReqs = new WeakSet<Request>();

/** Original `system_setting.positiveTaskArtifactLimit` (`GetEnvOrDefault` then `<= 0` fallback). */
export function positiveTaskArtifactLimit(raw: string | undefined, defaultValue: number): number {
  const value = envOrDefaultInt(raw, defaultValue);
  if (value <= 0) return defaultValue;
  return value;
}

/** Original `system_setting.LoadTaskArtifactAccessLimits`. */
export function loadTaskArtifactAccessLimits(env: Env = {} as Env): TaskArtifactAccessLimits {
  return {
    invalidRatePerMinute: positiveTaskArtifactLimit(
      env.TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE,
      DEFAULT_TASK_ARTIFACT_INVALID_RATE_LIMIT_PER_MINUTE,
    ),
    globalConcurrency: positiveTaskArtifactLimit(
      env.TASK_ARTIFACT_GLOBAL_CONCURRENCY,
      DEFAULT_TASK_ARTIFACT_GLOBAL_CONCURRENCY,
    ),
    ipConcurrency: positiveTaskArtifactLimit(env.TASK_ARTIFACT_IP_CONCURRENCY, DEFAULT_TASK_ARTIFACT_IP_CONCURRENCY),
    objectConcurrency: positiveTaskArtifactLimit(
      env.TASK_ARTIFACT_OBJECT_CONCURRENCY,
      DEFAULT_TASK_ARTIFACT_OBJECT_CONCURRENCY,
    ),
  };
}

export function newTaskArtifactAccessLimiter(limits: TaskArtifactAccessLimits): TaskArtifactAccessLimiter {
  return new TaskArtifactAccessLimiter(limits);
}

function limiterFor(db: object | undefined, env: Env): TaskArtifactAccessLimiter {
  const key = db || env;
  let limiter = limiterByDb.get(key);
  if (!limiter) {
    limiter = new TaskArtifactAccessLimiter(loadTaskArtifactAccessLimits(env));
    limiterByDb.set(key, limiter);
  }
  return limiter;
}

/** Original `redactTaskArtifactAccessQuery` path match. */
export function redactTaskArtifactAccessApplies(path: string): boolean {
  const isArtifactContent =
    path.startsWith("/v1/tasks/") && path.includes("/artifacts/") && path.endsWith("/content");
  const isLegacyVideoContent = path.startsWith("/v1/videos/") && path.endsWith("/content");
  return isArtifactContent || isLegacyVideoContent;
}

/** Original `SetTaskRouter` `TokenOrTaskArtifactAccessAuth` on GET/HEAD content. */
export function tokenOrTaskArtifactAccessAuthApplies(method: string, path: string): boolean {
  return (method === "GET" || method === "HEAD") && /^\/v1\/tasks\/[^/]+\/artifacts\/[^/]+\/content$/.test(path);
}

export function parseTaskArtifactContentParams(path: string): { taskID: string; artifactKey: string } | null {
  const m = path.match(/^\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)\/content$/);
  if (!m) return null;
  try {
    return { taskID: decodeURIComponent(m[1]), artifactKey: decodeURIComponent(m[2]) };
  } catch {
    return { taskID: m[1], artifactKey: m[2] };
  }
}

/** Original `url.QueryUnescape`. */
export function goQueryUnescape(raw: string): { ok: true; value: string } | { ok: false } {
  try {
    return { ok: true, value: decodeURIComponent(raw.replace(/\+/g, "%20")) };
  } catch {
    return { ok: false };
  }
}

/**
 * Original `popTaskArtifactAccessQuery`. Splits `RawQuery` on `&` (not
 * `url.ParseQuery`) so duplicate `access` is detected. Mutates RawQuery by
 * dropping `access` parts.
 */
export function popTaskArtifactAccessQuery(rawQuery: string): TaskArtifactAccessPop {
  let rawAccess = "";
  let count = 0;
  let invalid = false;
  const kept: string[] = [];
  for (const part of rawQuery.split("&")) {
    const eq = part.indexOf("=");
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);
    const key = goQueryUnescape(rawKey);
    if (!key.ok || key.value !== TASK_ARTIFACT_ACCESS_QUERY_PARAMETER) {
      kept.push(part);
      continue;
    }
    count += 1;
    if (rawValue.length > MAX_ENCODED_TASK_ARTIFACT_ACCESS_QUERY_SIZE) {
      invalid = true;
      continue;
    }
    if (count === 1) {
      const value = goQueryUnescape(rawValue);
      if (!value.ok) invalid = true;
      else rawAccess = value.value;
    }
  }
  if (count === 0) return { rawAccess: "", present: false, invalid: false, rawQuery };
  return { rawAccess, present: true, invalid: invalid || count !== 1, rawQuery: kept.join("&") };
}

function cloneRequestQuery(req: Request, rawQuery: string): Request {
  const url = new URL(req.url);
  url.search = rawQuery;
  return carryRequestTrustedProxies(req, new Request(url, req));
}

/** Original `SetUpLogger` `redactTaskArtifactAccessQuery()`. */
export function redactTaskArtifactAccessQuery(req: Request): Request {
  const url = new URL(req.url);
  if (!redactTaskArtifactAccessApplies(url.pathname)) return req;
  const popped = popTaskArtifactAccessQuery(url.search.startsWith("?") ? url.search.slice(1) : url.search);
  if (!popped.present) return req;
  const next = cloneRequestQuery(req, popped.rawQuery);
  poppedByReq.set(next, popped);
  return next;
}

function encodeRawURL(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Original `base64.RawURLEncoding.Strict().DecodeString`. */
export function decodeBase64RawURLStrict(access: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(access)) return null;
  try {
    const pad = "=".repeat((4 - (access.length % 4)) % 4);
    const b64 = (access + pad).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (encodeRawURL(bytes) !== access) return null;
    return bytes;
  } catch {
    return null;
  }
}

function hmacEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let hexA = "";
  let hexB = "";
  for (let i = 0; i < a.byteLength; i++) {
    hexA += a[i].toString(16).padStart(2, "0");
    hexB += b[i].toString(16).padStart(2, "0");
  }
  return timingSafeEqualStr(hexA, hexB);
}

/** Original `service.taskArtifactAccessMessage`. */
export function taskArtifactAccessMessage(taskID: string, artifactKey: string): Uint8Array {
  return new TextEncoder().encode(`${TASK_ARTIFACT_ACCESS_VERSION}\0${taskID}\0${artifactKey}`);
}

/** Original `service.IssueTaskArtifactAccess`. */
export async function issueTaskArtifactAccess(secret: string, taskID: string, artifactKey: string): Promise<string> {
  taskID = taskID.trim();
  artifactKey = artifactKey.trim();
  if (
    !taskID ||
    taskID.length > MAX_TASK_ARTIFACT_TASK_ID_LENGTH ||
    !artifactKey ||
    artifactKey.length > MAX_TASK_ARTIFACT_KEY_LENGTH ||
    !secret
  ) {
    throw new Error("task artifact access is invalid");
  }
  return encodeRawURL(await hmacSha256Raw(secret, taskArtifactAccessMessage(taskID, artifactKey)));
}

/** Original `service.VerifyTaskArtifactAccess` (constant-time HMAC). */
export async function verifyTaskArtifactAccess(
  access: string,
  taskID: string,
  artifactKey: string,
  secret: string,
): Promise<boolean> {
  taskID = taskID.trim();
  artifactKey = artifactKey.trim();
  if (
    access.length !== TASK_ARTIFACT_ACCESS_LENGTH ||
    !taskID ||
    taskID.length > MAX_TASK_ARTIFACT_TASK_ID_LENGTH ||
    !artifactKey ||
    artifactKey.length > MAX_TASK_ARTIFACT_KEY_LENGTH ||
    !secret
  ) {
    return false;
  }
  const actual = decodeBase64RawURLStrict(access);
  if (!actual || actual.byteLength !== TASK_ARTIFACT_ACCESS_HMAC_SIZE) return false;
  const expected = await hmacSha256Raw(secret, taskArtifactAccessMessage(taskID, artifactKey));
  return hmacEqual(actual, expected);
}

export function isTaskArtifactAccess(req: Request): boolean {
  return capabilityReqs.has(req);
}

export function markTaskArtifactAccess(req: Request): void {
  capabilityReqs.add(req);
}

/** Original `writeTaskArtifactAccessNotFound`. */
export function writeTaskArtifactAccessNotFound(): Response {
  return json(
    404,
    { error: { message: ARTIFACT_NOT_FOUND_MESSAGE, type: ARTIFACT_NOT_FOUND, code: ARTIFACT_NOT_FOUND } },
    { "cache-control": TASK_ARTIFACT_CACHE_CONTROL },
  );
}

/** Original `writeTaskArtifactAccessLimited`. */
export function writeTaskArtifactAccessLimited(): Response {
  return json(
    429,
    {
      error: {
        message: ARTIFACT_ACCESS_LIMITED_MESSAGE,
        type: ARTIFACT_ACCESS_LIMITED_TYPE,
        code: ARTIFACT_ACCESS_LIMITED,
      },
    },
    { "cache-control": TASK_ARTIFACT_CACHE_CONTROL, "retry-after": ARTIFACT_ACCESS_RETRY_AFTER },
  );
}

/** Original middleware `c.Header("Cache-Control", "private, no-store")` before Next. */
export function withTaskArtifactCacheControl(res: Response): Response {
  const ws = (res as Response & { webSocket?: unknown }).webSocket;
  if (res.status === 101 || ws) {
    res.headers.set("cache-control", TASK_ARTIFACT_CACHE_CONTROL);
    return res;
  }
  const headers = new Headers(res.headers);
  headers.set("cache-control", TASK_ARTIFACT_CACHE_CONTROL);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * Original `writeTaskArtifactError` when `IsTaskArtifactAccess`: always 404
 * `artifact_not_found` / "Task or artifact not found".
 */
export function collapseTaskArtifactAccessError(req: Request, status: number, code: string, message: string): {
  status: number;
  code: string;
  message: string;
} {
  if (!isTaskArtifactAccess(req)) return { status, code, message };
  return { status: 404, code: ARTIFACT_NOT_FOUND, message: ARTIFACT_NOT_FOUND_MESSAGE };
}

export type TokenOrTaskArtifactAccessResult = {
  req: Request;
  denied?: Response;
  capability?: boolean;
  release?: () => void;
};

/**
 * Original `TokenOrTaskArtifactAccessAuth`. Sets Cache-Control on the route.
 * Present `access` never falls through to TokenAuth.
 */
export async function tokenOrTaskArtifactAccessAuth(
  req: Request,
  env: Env,
  secret: string,
): Promise<TokenOrTaskArtifactAccessResult> {
  const path = new URL(req.url).pathname;
  const params = parseTaskArtifactContentParams(path);
  let rawAccess = "";
  let present = false;
  let invalid = false;
  const stored = poppedByReq.get(req);
  if (stored?.present) {
    present = true;
    rawAccess = stored.rawAccess;
    invalid = stored.invalid;
  }
  const url = new URL(req.url);
  const again = popTaskArtifactAccessQuery(url.search.startsWith("?") ? url.search.slice(1) : url.search);
  if (again.present) {
    present = true;
    if (!rawAccess) rawAccess = again.rawAccess;
    invalid = invalid || again.invalid;
    if (again.rawQuery !== (url.search.startsWith("?") ? url.search.slice(1) : url.search)) {
      req = cloneRequestQuery(req, again.rawQuery);
      poppedByReq.set(req, again);
    }
  }
  if (!present) return { req };

  const taskID = params?.taskID || "";
  const artifactKey = params?.artifactKey || "";
  const ip = clientIp(req) || "unknown";
  const limiter = limiterFor(env.DB, env);
  if (invalid || !params || !(await verifyTaskArtifactAccess(rawAccess, taskID, artifactKey, secret))) {
    if (!limiter.invalidAttempt(Date.now(), ip)) return { req, denied: writeTaskArtifactAccessLimited() };
    return { req, denied: writeTaskArtifactAccessNotFound() };
  }
  const acquired = limiter.acquire(ip, taskID, artifactKey);
  if (!acquired.ok) return { req, denied: writeTaskArtifactAccessLimited() };
  markTaskArtifactAccess(req);
  return { req, capability: true, release: acquired.release };
}
