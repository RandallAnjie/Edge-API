/**
 * Original `middleware.SystemPerformanceCheck` leftover HTTP 503.
 * `/v1/messages` prefix uses `ToClaudeError`; every other path uses `ToOpenAIError`.
 * `common.GetSystemStatus` starts at zeros until gopsutil `StartSystemMonitor`;
 * `int(usage) > threshold` so default zeros never trip. Extra-OK: workerd has
 * no gopsutil, so live usage stays 0 unless tests inject `setSystemStatusForDb`.
 */
import { json } from "./http.js";
import { loadPerformanceSetting } from "./metrics.js";
import type { Store } from "./store.js";

/** Original `types.ErrorTypeNewAPIError`. */
export const NEW_API_ERROR_TYPE = "new_api_error";

/** Original `NewErrorWithStatusCode` codes on SystemPerformanceCheck. */
export const SYSTEM_CPU_OVERLOADED = "system_cpu_overloaded";
export const SYSTEM_MEMORY_OVERLOADED = "system_memory_overloaded";
export const SYSTEM_DISK_OVERLOADED = "system_disk_overloaded";

/** Original `http.StatusServiceUnavailable`. */
export const SYSTEM_PERFORMANCE_STATUS = 503;

/** Original `common.SystemStatus` (GetSystemStatus starts zeros). */
export type SystemStatus = {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
};

export const ZERO_SYSTEM_STATUS: SystemStatus = { cpuUsage: 0, memoryUsage: 0, diskUsage: 0 };

const injectedByDb = new WeakMap<object, SystemStatus>();

/** Original `common.GetSystemStatus` (zeros unless a test injects on this D1). */
export function getSystemStatus(db?: object | null): SystemStatus {
  if (db && injectedByDb.has(db)) return injectedByDb.get(db)!;
  return ZERO_SYSTEM_STATUS;
}

/** Test hook for original `latestSystemStatus.Store` (gopsutil is Extra-OK absent). */
export function setSystemStatusForDb(db: object, status: SystemStatus): void {
  injectedByDb.set(db, {
    cpuUsage: status.cpuUsage,
    memoryUsage: status.memoryUsage,
    diskUsage: status.diskUsage,
  });
}

export function resetSystemStatusForDb(db: object): void {
  injectedByDb.delete(db);
}

export type SystemPerformanceError = {
  statusCode: number;
  message: string;
  code: string;
};

/** Original `strings.HasPrefix(path, "/v1/messages")` Claude envelope. */
export function systemPerformanceUsesClaudeError(path: string): boolean {
  return path.startsWith("/v1/messages");
}

/**
 * Original video POST groups run TokenAuth then SystemPerformanceCheck
 * (`SetVideoRouter` `/v1/video/generations`, `openai_video.create` `/v1/videos`).
 */
export function systemPerformanceCheckAppliesAfterAuth(method: string, path: string): boolean {
  return method === "POST" && (path === "/v1/video/generations" || path === "/v1/videos");
}

/**
 * Original groups that do not `Use(SystemPerformanceCheck)`: `/v1/models`,
 * `/v1beta/models`, video retrieve/remix, responses retrieve, tasks.
 */
export function systemPerformanceCheckExempt(method: string, path: string): boolean {
  if (method === "GET" && (path === "/v1/models" || path === "/v1beta/models" || path === "/v1beta/openai/models")) {
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/models/") && !path.slice("/v1/models/".length).includes("/")) {
    return true;
  }
  if (method === "GET" && path.startsWith("/v1/video/generations/")) return true;
  if ((method === "GET" || method === "HEAD") && path.startsWith("/v1/videos/")) return true;
  if (method === "GET" && path.startsWith("/v1/responses/")) return true;
  if ((method === "GET" || method === "HEAD") && path.startsWith("/v1/tasks/")) return true;
  if (method === "POST" && /^\/v1\/videos\/[^/]+\/remix$/.test(path)) return true;
  return false;
}

function relayV1SystemPerformanceRoute(method: string, path: string): boolean {
  const post = method === "POST";
  if (method === "GET" && path === "/v1/realtime") return true;
  if (post && path === "/v1/messages") return true;
  if (post && path === "/v1/completions") return true;
  if (post && path === "/v1/chat/completions") return true;
  if (post && path === "/v1/responses/compact") return true;
  if (post && path === "/v1/responses") return true;
  if (post && path === "/v1/alpha/search") return true;
  if (post && (path === "/v1/edits" || path === "/v1/images/generations" || path === "/v1/images/edits")) return true;
  if (post && path === "/v1/embeddings") return true;
  if (post && (path === "/v1/audio/transcriptions" || path === "/v1/audio/translations" || path === "/v1/audio/speech")) {
    return true;
  }
  if (post && path === "/v1/rerank") return true;
  if (post && path.startsWith("/v1/engines/") && path.endsWith("/embeddings")) return true;
  if (post && path.startsWith("/v1/models/")) return true;
  if (post && path === "/v1/moderations") return true;
  if (post && path === "/v1/images/variations") return true;
  if (path.startsWith("/v1/files")) return true;
  if (path.startsWith("/v1/fine-tunes")) return true;
  if (method === "DELETE" && path.startsWith("/v1/models/")) return true;
  return false;
}

/**
 * Original SystemPerformanceCheck before TokenAuth/UserAuth:
 * playground `/pg`, relayV1 `/v1` (except models/video retrieve), Gemini
 * POST `/v1beta/models/*`, `openai_responses.create` POST `/v1/responses`.
 * Midjourney groups are OR'd by the worker via `isRegisteredMjRelay`.
 */
export function systemPerformanceCheckAppliesBeforeAuth(method: string, path: string): boolean {
  if (path === "/pg" || path.startsWith("/pg/")) return true;
  if (method === "POST" && path.startsWith("/v1beta/models")) return true;
  if (path.startsWith("/v1/dashboard")) return false;
  if (!path.startsWith("/v1/") && path !== "/v1") return false;
  if (systemPerformanceCheckAppliesAfterAuth(method, path)) return false;
  if (systemPerformanceCheckExempt(method, path)) return false;
  return relayV1SystemPerformanceRoute(method, path);
}

/** Original `fmt.Sprintf("%.1f", n)`. */
export function formatUsagePercent(n: number): string {
  return n.toFixed(1);
}

/** Original `int(status.CPUUsage)` toward-zero truncation. */
export function usageInt(n: number): number {
  return Math.trunc(n);
}

function overloadedMessage(kind: "cpu" | "memory" | "disk", current: number, threshold: number): string {
  return `system ${kind} overloaded (current: ${formatUsagePercent(current)}%, threshold: ${threshold}%)`;
}

/**
 * Original `checkSystemPerformance`. Thresholds and enable come from
 * `performance_setting` (`MonitorEnabled` default true, CPU/Memory 90, Disk 95).
 */
export async function checkSystemPerformance(store: Store, db?: object | null): Promise<SystemPerformanceError | null> {
  const setting = await loadPerformanceSetting(store);
  if (!setting.monitor_enabled) return null;

  const cpuThreshold = usageInt(setting.monitor_cpu_threshold);
  const memoryThreshold = usageInt(setting.monitor_memory_threshold);
  const diskThreshold = usageInt(setting.monitor_disk_threshold);
  const status = getSystemStatus(db);

  if (cpuThreshold > 0 && usageInt(status.cpuUsage) > cpuThreshold) {
    return {
      statusCode: SYSTEM_PERFORMANCE_STATUS,
      message: overloadedMessage("cpu", status.cpuUsage, cpuThreshold),
      code: SYSTEM_CPU_OVERLOADED,
    };
  }
  if (memoryThreshold > 0 && usageInt(status.memoryUsage) > memoryThreshold) {
    return {
      statusCode: SYSTEM_PERFORMANCE_STATUS,
      message: overloadedMessage("memory", status.memoryUsage, memoryThreshold),
      code: SYSTEM_MEMORY_OVERLOADED,
    };
  }
  if (diskThreshold > 0 && usageInt(status.diskUsage) > diskThreshold) {
    return {
      statusCode: SYSTEM_PERFORMANCE_STATUS,
      message: overloadedMessage("disk", status.diskUsage, diskThreshold),
      code: SYSTEM_DISK_OVERLOADED,
    };
  }
  return null;
}

/** Original `ToOpenAIError` default branch (errorType new_api_error). */
export function toOpenAIPerformanceError(err: SystemPerformanceError): {
  message: string;
  type: string;
  param: string;
  code: string;
} {
  return { message: err.message, type: NEW_API_ERROR_TYPE, param: "", code: err.code };
}

/** Original `ToClaudeError` default branch (errorType new_api_error). */
export function toClaudePerformanceError(err: SystemPerformanceError): { type: string; message: string } {
  return { type: NEW_API_ERROR_TYPE, message: err.message };
}

/** Original `c.JSON(err.StatusCode, gin.H{"error": err.ToClaudeError/ToOpenAIError})`. */
export function writeSystemPerformanceError(path: string, err: SystemPerformanceError): Response {
  if (systemPerformanceUsesClaudeError(path)) {
    return json(err.statusCode, { error: toClaudePerformanceError(err) });
  }
  return json(err.statusCode, { error: toOpenAIPerformanceError(err) });
}

export async function systemPerformanceCheck(store: Store, path: string, db?: object | null): Promise<Response | null> {
  const err = await checkSystemPerformance(store, db);
  if (!err) return null;
  return writeSystemPerformanceError(path, err);
}
