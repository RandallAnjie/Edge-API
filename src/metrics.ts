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
    active_connections: 0,
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
    cache_stats: {
      active_disk_files: 0,
      current_disk_usage_bytes: 0,
      active_memory_buffers: 0,
      current_memory_usage_bytes: mem?.usedJSHeapSize || 0,
      disk_cache_hits: 0,
      memory_cache_hits: 0,
      disk_cache_max_bytes: 0,
      disk_cache_threshold_bytes: 0,
    },
    memory_stats: {
      alloc: mem?.usedJSHeapSize || 0,
      total_alloc: mem?.totalJSHeapSize || 0,
      sys: mem?.totalJSHeapSize || 0,
      num_gc: 0,
      num_goroutine: 1,
    },
    disk_cache_info: { path: "", exists: false, file_count: 0, total_size: 0 },
    disk_space_info: { total: 0, free: 0, used: 0, used_percent: 0 },
    config: {
      disk_cache_enabled: false,
      disk_cache_threshold_mb: 10,
      disk_cache_max_size_mb: 1024,
      disk_cache_path: "",
      is_running_in_container: true,
      monitor_enabled: true,
      monitor_cpu_threshold: 90,
      monitor_memory_threshold: 90,
      monitor_disk_threshold: 95,
    },
  };
}
