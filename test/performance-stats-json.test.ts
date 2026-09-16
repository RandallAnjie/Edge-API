import assert from "node:assert/strict";
import { test } from "node:test";
import { diskCacheSizeBytes } from "../src/metrics.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot(e: Env) {
  await json(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  return { token, auth, login };
}

test("original GetPerformanceStats cache_stats bytes follow performance_setting JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const perf = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  assert.equal(perf.body.success, true, String(perf.body.message));
  const data = perf.body.data as {
    cache_stats: { disk_cache_max_bytes: number; disk_cache_threshold_bytes: number };
    config: {
      disk_cache_enabled: boolean;
      disk_cache_threshold_mb: number;
      disk_cache_max_size_mb: number;
      monitor_enabled: boolean;
    };
  };
  assert.equal(data.config.disk_cache_enabled, false);
  assert.equal(data.config.disk_cache_threshold_mb, 10);
  assert.equal(data.config.disk_cache_max_size_mb, 1024);
  assert.equal(data.config.monitor_enabled, true);
  assert.equal(data.cache_stats.disk_cache_threshold_bytes, diskCacheSizeBytes(10));
  assert.equal(data.cache_stats.disk_cache_max_bytes, diskCacheSizeBytes(1024));
  assert.equal(data.cache_stats.disk_cache_threshold_bytes, 10 * 1024 * 1024);
  assert.equal(data.cache_stats.disk_cache_max_bytes, 1024 * 1024 * 1024);

  const updated = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "performance_setting.disk_cache_threshold_mb", value: "25" }),
    }),
    e,
  );
  assert.equal(updated.body.success, true, String(updated.body.message));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "performance_setting.disk_cache_max_size_mb", value: "512" }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "performance_setting.disk_cache_enabled", value: "true" }),
    }),
    e,
  );

  const after = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  const afterData = after.body.data as {
    cache_stats: { disk_cache_max_bytes: number; disk_cache_threshold_bytes: number };
    config: { disk_cache_enabled: boolean; disk_cache_threshold_mb: number; disk_cache_max_size_mb: number };
  };
  assert.equal(afterData.config.disk_cache_enabled, true);
  assert.equal(afterData.config.disk_cache_threshold_mb, 25);
  assert.equal(afterData.config.disk_cache_max_size_mb, 512);
  assert.equal(afterData.cache_stats.disk_cache_threshold_bytes, 25 * 1024 * 1024);
  assert.equal(afterData.cache_stats.disk_cache_max_bytes, 512 * 1024 * 1024);
});

test("original GetPerformanceStats data keys match PerformanceStats JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const perf = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  assert.equal(perf.body.success, true, String(perf.body.message));
  const data = perf.body.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), ["cache_stats", "config", "disk_cache_info", "disk_space_info", "memory_stats"]);
  for (const extra of ["runtime", "version", "start_time", "last_reset", "http_stats", "counts"]) {
    assert.equal(extra in data, false, "extra GetPerformanceStats key " + extra);
  }
  const cache = data.cache_stats as { current_memory_usage_bytes: number };
  assert.equal(cache.current_memory_usage_bytes, 0);
});

test("original GetPerformanceStats gin.H omits message; clear/reset/gc omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const stats = await json(new Request("http://local/api/performance/stats", { headers: auth }), e);
  assert.equal(stats.res.status, 200);
  assert.equal(stats.body.success, true);
  assert.equal("message" in stats.body, false);
  assert.deepEqual(Object.keys(stats.body).sort(), ["data", "success"]);

  const clear = await json(new Request("http://local/api/performance/disk_cache", { method: "DELETE", headers: auth }), e);
  assert.equal(clear.body.success, true);
  assert.equal(clear.body.message, "不活跃的磁盘缓存已清理");
  assert.equal("data" in clear.body, false);
  assert.deepEqual(Object.keys(clear.body).sort(), ["message", "success"]);

  const reset = await json(new Request("http://local/api/performance/reset_stats", { method: "POST", headers: auth }), e);
  assert.equal(reset.body.success, true);
  assert.equal(reset.body.message, "统计信息已重置");
  assert.equal("data" in reset.body, false);

  const gc = await json(new Request("http://local/api/performance/gc", { method: "POST", headers: auth }), e);
  assert.equal(gc.body.success, true);
  assert.equal(gc.body.message, "GC 已执行");
  assert.equal("data" in gc.body, false);

  const logs = await json(new Request("http://local/api/performance/logs", { headers: auth }), e);
  assert.equal(logs.body.success, true);
  assert.equal(logs.body.message, "");
  const logData = logs.body.data as { enabled: boolean; files: unknown };
  assert.equal(logData.enabled, false);
  assert.equal(logData.files, null);

  const badMode = await json(new Request("http://local/api/performance/logs?mode=nope&value=1", { method: "DELETE", headers: auth }), e);
  assert.equal(badMode.res.status, 200);
  assert.equal(badMode.body.message, "invalid mode, must be by_count or by_days");
  assert.equal("data" in badMode.body, false);

  const badValue = await json(new Request("http://local/api/performance/logs?mode=by_count&value=1.5", { method: "DELETE", headers: auth }), e);
  assert.equal(badValue.body.message, "invalid value, must be a positive integer");
  assert.equal("data" in badValue.body, false);

  const noDir = await json(new Request("http://local/api/performance/logs?mode=by_days&value=7", { method: "DELETE", headers: auth }), e);
  assert.equal(noDir.body.message, "log directory not configured");
  assert.equal("data" in noDir.body, false);
});

test("original TestStatus envelope JSON has StatsInfo only", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const st = await json(new Request("http://local/api/status/test", { headers: auth }), e);
  assert.equal(st.res.status, 200);
  assert.equal(st.body.success, true);
  assert.equal(st.body.message, "Server is running");
  assert.equal("data" in st.body, false);
  assert.deepEqual(Object.keys(st.body).sort(), ["http_stats", "message", "success"]);
  const stats = st.body.http_stats as Record<string, unknown>;
  assert.deepEqual(Object.keys(stats), ["active_connections"]);
  assert.equal(stats.active_connections, 0);
});
