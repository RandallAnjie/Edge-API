/**
 * Original `middleware.ModelRequestRateLimit` on RandallFlare.
 *
 * Redis path (KV) uses `abortWithOpenAiMessage` 429/500 JSON with empty `code`.
 * In-memory path (no KV) matches gin `c.Status(429); c.Abort()` empty body.
 */
import { parseJson } from "./constants.js";
import { abortWithOpenAiMessage } from "./http.js";
import type { Store } from "./store.js";
import type { AuthToken, Env, KVNamespace } from "./types.js";

/** Original `middleware.ModelRequestRateLimitCountMark`. */
export const MODEL_REQUEST_RATE_LIMIT_COUNT_MARK = "MRRL";
/** Original `middleware.ModelRequestRateLimitSuccessCountMark`. */
export const MODEL_REQUEST_RATE_LIMIT_SUCCESS_COUNT_MARK = "MRRLS";
/** Original `modelRateLimitTimeFormat`. */
export const MODEL_RATE_LIMIT_TIME_FORMAT = "2006-01-02T15:04:05.000Z";

/** Original `setting.maxRateLimitDurationSeconds`. */
export const MAX_RATE_LIMIT_DURATION_SECONDS = 24 * 60 * 60;
/** Original `setting.maxModelRequestRateLimitCount` (int64/MaxInt64 approximated in JS). */
export const MAX_MODEL_REQUEST_RATE_LIMIT_COUNT = Math.floor(Number.MAX_SAFE_INTEGER / MAX_RATE_LIMIT_DURATION_SECONDS);

const memoryByEnv = new WeakMap<object, Map<string, number[]>>();

export function modelRequestRateLimitSuccessMessage(durationMinutes: number, successMaxCount: number): string {
  return `您已达到请求数限制：${durationMinutes}分钟内最多请求${successMaxCount}次`;
}

export function modelRequestRateLimitTotalMessage(durationMinutes: number, totalMaxCount: number): string {
  return `您已达到总请求数限制：${durationMinutes}分钟内最多请求${totalMaxCount}次，包括失败次数，请检查您的请求是否正确`;
}

/** Original `setting.rateLimitDurationSeconds`. */
export function rateLimitDurationSeconds(durationMinutes: number): number {
  if (durationMinutes <= 0) return 0;
  if (durationMinutes > Number.MAX_SAFE_INTEGER / 60) return Number.MAX_SAFE_INTEGER;
  return durationMinutes * 60;
}

/** Original `middleware.rateLimitCapacity`. */
export function rateLimitCapacity(count: number, durationSeconds: number): number {
  if (count <= 0 || durationSeconds <= 0) return 0;
  if (count > Number.MAX_SAFE_INTEGER / durationSeconds) return Number.MAX_SAFE_INTEGER;
  return count * durationSeconds;
}

/** Original `setting.GetGroupRateLimit`. */
export function getGroupRateLimit(
  group: string,
  raw: string,
): { totalCount: number; successCount: number; found: boolean } {
  const map = parseModelRequestRateLimitGroup(raw);
  if (!map) return { totalCount: 0, successCount: 0, found: false };
  const limits = map[group];
  if (!limits) return { totalCount: 0, successCount: 0, found: false };
  return { totalCount: limits[0], successCount: limits[1], found: true };
}

function parseModelRequestRateLimitGroup(raw: string): Record<string, [number, number]> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, [number, number]> = {};
    for (const [group, value] of Object.entries(parsed as Record<string, unknown>)) {
      const pair = pairFromJson(value);
      if (!pair) return null;
      out[group] = pair;
    }
    return out;
  } catch {
    return null;
  }
}

function pairFromJson(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = value[0];
  const b = value[1];
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  return [a, b];
}

/**
 * Original `setting.CheckModelRequestRateLimitGroup`.
 * Returns an error message or null when valid.
 */
export function checkModelRequestRateLimitGroup(jsonStr: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    return `json: cannot unmarshal ${jsonTypeName(parsed)} into Go value of type map[string][2]int`;
  }
  for (const [group, value] of Object.entries(parsed as Record<string, unknown>)) {
    const pair = pairFromJson(value);
    if (!pair) {
      return `json: cannot unmarshal ${jsonTypeName(value)} into Go value of type [2]int`;
    }
    if (pair[0] < 0 || pair[1] < 1) {
      return `group ${group} has negative rate limit values: [${pair[0]}, ${pair[1]}]`;
    }
    if (pair[0] > MAX_MODEL_REQUEST_RATE_LIMIT_COUNT || pair[1] > MAX_MODEL_REQUEST_RATE_LIMIT_COUNT) {
      return `group ${group} [${pair[0]}, ${pair[1]}] exceeds max rate limit ${MAX_MODEL_REQUEST_RATE_LIMIT_COUNT}`;
    }
  }
  return null;
}

function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array of length ${value.length}`;
  return typeof value;
}

/**
 * Original routers that `Use(ModelRequestRateLimit)` vs TokenAuth-only groups.
 * Models list/retrieve, Midjourney, video/task retrieve, and TaskPluginEndpointOnly
 * video create/remix are not on the `/v1` rate-limit group.
 */
export function modelRequestRateLimitApplies(method: string, path: string): boolean {
  if (method === "GET" && (path === "/v1/models" || path === "/v1beta/models" || path === "/v1beta/openai/models")) {
    return false;
  }
  if (method === "GET" && path.startsWith("/v1/models/") && !path.includes(":")) return false;
  if (path === "/mj" || path.startsWith("/mj/")) return false;
  if (
    /^\/[^/]+\/mj(\/|$)/.test(path) &&
    !path.startsWith("/api/") &&
    !path.startsWith("/v1") &&
    !path.startsWith("/pg/") &&
    !path.startsWith("/dashboard/")
  ) {
    return false;
  }
  if (method === "GET" && path.startsWith("/v1/responses/")) return false;
  if (
    (method === "GET" || method === "HEAD") &&
    (path.startsWith("/v1/videos/") || path.startsWith("/v1/video/generations/") || path.startsWith("/v1/tasks/"))
  ) {
    return false;
  }
  if (method === "POST" && (path === "/v1/videos" || path === "/v1/video/generations")) return false;
  if (method === "POST" && /^\/v1\/videos\/[^/]+\/remix$/.test(path)) return false;
  return true;
}

export type ModelRequestRateLimitGate = {
  recordSuccess: (status: number) => Promise<void>;
};

const noopGate: ModelRequestRateLimitGate = { recordSuccess: async () => {} };

function requestIdOf(req: Request): string {
  return req.headers.get("x-oneapi-request-id") || "";
}

function tokenGroupOf(auth: AuthToken): string {
  const tokenGroup = String(auth.token.group || "");
  if (tokenGroup) return tokenGroup;
  return String(auth.user.group || "");
}

function nowRateLimitTime(): string {
  return new Date().toISOString();
}

function parseRateLimitTime(raw: string): number | null {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Original Redis lua token bucket `Allow`. */
export function tokenBucketAllow(
  bucket: { tokens: number; last_time: number } | null,
  nowSec: number,
  requested: number,
  rate: number,
  capacity: number,
): { allowed: boolean; bucket: { tokens: number; last_time: number } } {
  let tokens = bucket?.tokens;
  let lastTime = bucket?.last_time;
  if (tokens == null || lastTime == null) {
    tokens = capacity;
    lastTime = nowSec;
  } else {
    const elapsed = nowSec - lastTime;
    const addTokens = elapsed * rate;
    tokens = Math.min(capacity, tokens + addTokens);
    lastTime = nowSec;
  }
  let allowed = false;
  if (tokens >= requested) {
    tokens -= requested;
    allowed = true;
  }
  return { allowed, bucket: { tokens, last_time: lastTime } };
}

/** Original `common.InMemoryRateLimiter.Request` (duration in seconds). */
export function memoryRateLimitRequest(queue: number[], maxRequestNum: number, duration: number, nowSec: number): {
  allowed: boolean;
  queue: number[];
} {
  if (queue.length < maxRequestNum) {
    return { allowed: true, queue: [...queue, nowSec] };
  }
  if (nowSec - queue[0] >= duration) {
    return { allowed: true, queue: [...queue.slice(1), nowSec] };
  }
  return { allowed: false, queue };
}

function memoryQueues(env: Env): Map<string, number[]> {
  let q = memoryByEnv.get(env);
  if (!q) {
    q = new Map();
    memoryByEnv.set(env, q);
  }
  return q;
}

function memoryRequest(env: Env, key: string, maxRequestNum: number, duration: number): boolean {
  const store = memoryQueues(env);
  const now = Math.floor(Date.now() / 1000);
  const cur = store.get(key) || [];
  if (!store.has(key)) {
    store.set(key, [now]);
    return true;
  }
  const next = memoryRateLimitRequest(cur, maxRequestNum, duration, now);
  store.set(key, next.queue);
  return next.allowed;
}

async function checkRedisSuccessLimit(
  kv: KVNamespace,
  key: string,
  maxCount: number,
  durationSec: number,
  expireSec: number,
): Promise<boolean> {
  if (maxCount === 0) return true;
  const list = parseJson<string[]>((await kv.get(key)) || "[]", []);
  if (!Array.isArray(list)) throw new Error("rate_limit_check_failed");
  if (list.length < maxCount) return true;
  const oldTimeStr = list[list.length - 1];
  const oldMs = parseRateLimitTime(String(oldTimeStr || ""));
  if (oldMs == null) throw new Error("rate_limit_check_failed");
  const nowMs = Date.parse(nowRateLimitTime());
  const subTime = (nowMs - oldMs) / 1000;
  if (Math.trunc(subTime) < durationSec) {
    await kv.put(key, JSON.stringify(list), { expirationTtl: Math.max(60, expireSec) });
    return false;
  }
  return true;
}

async function recordRedisSuccess(kv: KVNamespace, key: string, maxCount: number, expireSec: number): Promise<void> {
  if (maxCount === 0) return;
  const list = parseJson<string[]>((await kv.get(key)) || "[]", []);
  const next = [nowRateLimitTime(), ...(Array.isArray(list) ? list : [])].slice(0, maxCount);
  await kv.put(key, JSON.stringify(next), { expirationTtl: Math.max(60, expireSec) });
}

async function redisTotalAllow(kv: KVNamespace, key: string, totalMaxCount: number, durationSec: number): Promise<boolean> {
  const raw = await kv.get(key);
  const parsed = raw ? parseJson<{ tokens?: number; last_time?: number }>(raw, {}) : null;
  const prev =
    parsed && typeof parsed.tokens === "number" && typeof parsed.last_time === "number"
      ? { tokens: parsed.tokens, last_time: parsed.last_time }
      : null;
  const nowSec = Math.floor(Date.now() / 1000);
  const capacity = rateLimitCapacity(totalMaxCount, durationSec);
  const next = tokenBucketAllow(prev, nowSec, durationSec, totalMaxCount, capacity);
  await kv.put(key, JSON.stringify(next.bucket));
  return next.allowed;
}

export async function applyModelRequestRateLimit(
  store: Store,
  env: Env,
  req: Request,
  auth: AuthToken,
  applies = true,
): Promise<Response | ModelRequestRateLimitGate> {
  if (!applies) return noopGate;
  if (!(await store.optionBool("ModelRequestRateLimitEnabled", false))) return noopGate;

  const durationMinutes = await store.optionNum("ModelRequestRateLimitDurationMinutes", 1);
  let totalMaxCount = await store.optionNum("ModelRequestRateLimitCount", 0);
  let successMaxCount = await store.optionNum("ModelRequestRateLimitSuccessCount", 1000);
  const group = tokenGroupOf(auth);
  const grouped = getGroupRateLimit(group, await store.option("ModelRequestRateLimitGroup"));
  if (grouped.found) {
    totalMaxCount = grouped.totalCount;
    successMaxCount = grouped.successCount;
  }
  const durationSec = rateLimitDurationSeconds(durationMinutes);
  const rid = requestIdOf(req);
  const userId = String(auth.user.id);
  const expireSec = Math.max(60, durationMinutes * 60);

  if (env.KV) {
    try {
      const successKey = `rateLimit:${MODEL_REQUEST_RATE_LIMIT_SUCCESS_COUNT_MARK}:${userId}`;
      const allowedSuccess = await checkRedisSuccessLimit(env.KV, successKey, successMaxCount, durationSec, expireSec);
      if (!allowedSuccess) {
        return abortWithOpenAiMessage(429, modelRequestRateLimitSuccessMessage(durationMinutes, successMaxCount), "", rid);
      }
      if (totalMaxCount > 0) {
        const totalKey = `rateLimit:${userId}`;
        const allowedTotal = await redisTotalAllow(env.KV, totalKey, totalMaxCount, durationSec);
        if (!allowedTotal) {
          return abortWithOpenAiMessage(429, modelRequestRateLimitTotalMessage(durationMinutes, totalMaxCount), "", rid);
        }
      }
      return {
        recordSuccess: async (status: number) => {
          if (status < 400) await recordRedisSuccess(env.KV!, successKey, successMaxCount, expireSec);
        },
      };
    } catch {
      return abortWithOpenAiMessage(500, "rate_limit_check_failed", "", rid);
    }
  }

  const totalKey = MODEL_REQUEST_RATE_LIMIT_COUNT_MARK + userId;
  const successKey = MODEL_REQUEST_RATE_LIMIT_SUCCESS_COUNT_MARK + userId;
  if (totalMaxCount > 0 && !memoryRequest(env, totalKey, totalMaxCount, durationSec)) {
    return new Response(null, { status: 429 });
  }
  const checkKey = `${successKey}_check`;
  if (!memoryRequest(env, checkKey, successMaxCount, durationSec)) {
    return new Response(null, { status: 429 });
  }
  return {
    recordSuccess: async (status: number) => {
      if (status < 400) memoryRequest(env, successKey, successMaxCount, durationSec);
    },
  };
}

export async function withModelRequestRateLimit(
  store: Store,
  env: Env,
  req: Request,
  auth: AuthToken,
  next: () => Promise<Response>,
  applies = true,
): Promise<Response> {
  const gate = await applyModelRequestRateLimit(store, env, req, auth, applies);
  if (gate instanceof Response) return gate;
  const res = await next();
  await gate.recordSuccess(res.status);
  return res;
}
