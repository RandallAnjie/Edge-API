import type { Store } from "./store.js";

const state = {
  requests: 0,
  relay: 0,
  errors: 0,
  lastReset: Date.now(),
};

/** Original `performance_setting.PerformanceSetting` defaults. */
export type PerformanceSettingView = {
  disk_cache_enabled: boolean;
  disk_cache_threshold_mb: number;
  disk_cache_max_size_mb: number;
  disk_cache_path: string;
  monitor_enabled: boolean;
  monitor_cpu_threshold: number;
  monitor_memory_threshold: number;
  monitor_disk_threshold: number;
};

export const DEFAULT_PERFORMANCE_SETTING: PerformanceSettingView = {
  disk_cache_enabled: false,
  disk_cache_threshold_mb: 10,
  disk_cache_max_size_mb: 1024,
  disk_cache_path: "",
  monitor_enabled: true,
  monitor_cpu_threshold: 90,
  monitor_memory_threshold: 90,
  monitor_disk_threshold: 95,
};

/** Original `common.GetDiskCacheThresholdBytes` / `GetDiskCacheMaxSizeBytes` (`mb << 20`). */
export function diskCacheSizeBytes(mb: number): number {
  return Math.trunc(Number(mb) || 0) * 1024 * 1024;
}

export async function loadPerformanceSetting(store: Store): Promise<PerformanceSettingView> {
  return {
    disk_cache_enabled: await store.optionBool("performance_setting.disk_cache_enabled", DEFAULT_PERFORMANCE_SETTING.disk_cache_enabled),
    disk_cache_threshold_mb: await store.optionNum("performance_setting.disk_cache_threshold_mb", DEFAULT_PERFORMANCE_SETTING.disk_cache_threshold_mb),
    disk_cache_max_size_mb: await store.optionNum("performance_setting.disk_cache_max_size_mb", DEFAULT_PERFORMANCE_SETTING.disk_cache_max_size_mb),
    disk_cache_path: (await store.option("performance_setting.disk_cache_path")) || "",
    monitor_enabled: await store.optionBool("performance_setting.monitor_enabled", DEFAULT_PERFORMANCE_SETTING.monitor_enabled),
    monitor_cpu_threshold: await store.optionNum("performance_setting.monitor_cpu_threshold", DEFAULT_PERFORMANCE_SETTING.monitor_cpu_threshold),
    monitor_memory_threshold: await store.optionNum("performance_setting.monitor_memory_threshold", DEFAULT_PERFORMANCE_SETTING.monitor_memory_threshold),
    monitor_disk_threshold: await store.optionNum("performance_setting.monitor_disk_threshold", DEFAULT_PERFORMANCE_SETTING.monitor_disk_threshold),
  };
}

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

/** Original `middleware.GetStats` / `StatsInfo`. Internal `hit()` counters stay process-local. */
export function httpStats(): Record<string, unknown> {
  return { active_connections: 0 };
}

export function performanceStats(setting: PerformanceSettingView = DEFAULT_PERFORMANCE_SETTING): Record<string, unknown> {
  const mem =
    typeof performance !== "undefined" && "memory" in performance
      ? (performance as unknown as { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } }).memory
      : undefined;
  return {
    cache_stats: {
      active_disk_files: 0,
      current_disk_usage_bytes: 0,
      active_memory_buffers: 0,
      current_memory_usage_bytes: 0,
      disk_cache_hits: 0,
      memory_cache_hits: 0,
      disk_cache_max_bytes: diskCacheSizeBytes(setting.disk_cache_max_size_mb),
      disk_cache_threshold_bytes: diskCacheSizeBytes(setting.disk_cache_threshold_mb),
    },
    memory_stats: {
      alloc: mem?.usedJSHeapSize || 0,
      total_alloc: mem?.totalJSHeapSize || 0,
      sys: mem?.totalJSHeapSize || 0,
      num_gc: 0,
      num_goroutine: 1,
    },
    disk_cache_info: { path: setting.disk_cache_path, exists: false, file_count: 0, total_size: 0 },
    disk_space_info: { total: 0, free: 0, used: 0, used_percent: 0 },
    config: {
      disk_cache_enabled: setting.disk_cache_enabled,
      disk_cache_threshold_mb: setting.disk_cache_threshold_mb,
      disk_cache_max_size_mb: setting.disk_cache_max_size_mb,
      disk_cache_path: setting.disk_cache_path,
      is_running_in_container: true,
      monitor_enabled: setting.monitor_enabled,
      monitor_cpu_threshold: setting.monitor_cpu_threshold,
      monitor_memory_threshold: setting.monitor_memory_threshold,
      monitor_disk_threshold: setting.monitor_disk_threshold,
    },
  };
}
