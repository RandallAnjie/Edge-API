import { START_TIME, VERSION } from "./constants.js";

const state = {
  requests: 0,
  relay: 0,
  errors: 0,
  lastReset: Date.now(),
};

export function hit(kind: "http" | "relay" | "error" = "http"): void {
  state.requests += 1;
  if (kind === "relay") state.relay += 1;
  if (kind === "error") state.errors += 1;
}

export function resetMetrics(): void {
  state.requests = 0;
  state.relay = 0;
  state.errors = 0;
  state.lastReset = Date.now();
}

export function httpStats(): Record<string, unknown> {
  return {
    requests: state.requests,
    relay: state.relay,
    errors: state.errors,
    uptime_ms: Date.now() - START_TIME,
    version: VERSION,
  };
}

export function performanceStats(): Record<string, unknown> {
  const mem =
    typeof performance !== "undefined" && "memory" in performance
      ? (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory
      : undefined;
  return {
    runtime: "workerd",
    version: VERSION,
    start_time: START_TIME,
    last_reset: state.lastReset,
    http_stats: httpStats(),
    cache_stats: { enabled: false, entries: 0, hits: 0, misses: 0, size_bytes: 0 },
    memory_stats: {
      alloc: mem?.usedJSHeapSize || 0,
      total_alloc: mem?.totalJSHeapSize || 0,
      sys: mem?.totalJSHeapSize || 0,
      num_gc: 0,
      num_goroutine: 1,
    },
    disk_cache_info: { path: "", files: 0, size_bytes: 0 },
    disk_space_info: { used_percent: 0 },
    config: {
      disk_cache_enabled: false,
      disk_cache_threshold_mb: 0,
      disk_cache_max_size_mb: 0,
      disk_cache_path: "",
      is_running_in_container: true,
      monitor_enabled: true,
      monitor_cpu_threshold: 90,
      monitor_memory_threshold: 90,
      monitor_disk_threshold: 90,
    },
  };
}
