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
