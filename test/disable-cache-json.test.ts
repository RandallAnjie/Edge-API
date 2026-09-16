import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { DISABLE_CACHE_CONTROL, disableCacheApplies } from "../src/disable-cache.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, text };
}

function assertDisableCache(res: Response, label: string) {
  assert.equal(res.headers.get("cache-control"), DISABLE_CACHE_CONTROL, label);
  assert.equal(res.headers.get("pragma"), "no-cache", label);
  assert.equal(res.headers.get("expires"), "0", label);
}

test("original DisableCache applies to original security routes only", () => {
  assert.equal(DISABLE_CACHE_CONTROL, "no-store, no-cache, must-revalidate, private, max-age=0");
  assert.equal(disableCacheApplies("GET", "/api/user/token/status"), true);
  assert.equal(disableCacheApplies("GET", "/api/user/token"), true);
  assert.equal(disableCacheApplies("GET", "/api/audit/self"), true);
  assert.equal(disableCacheApplies("GET", "/api/audit"), true);
  assert.equal(disableCacheApplies("POST", "/api/user/login"), true);
  assert.equal(disableCacheApplies("GET", "/api/oauth/github"), true);
  assert.equal(disableCacheApplies("POST", "/api/channel/3/key"), true);
  assert.equal(disableCacheApplies("POST", "/api/token/9/key"), true);
  assert.equal(disableCacheApplies("GET", "/api/user/self"), true);
  assert.equal(disableCacheApplies("GET", "/api/user/self/groups"), true);

  assert.equal(disableCacheApplies("GET", "/api/status"), false);
  assert.equal(disableCacheApplies("GET", "/api/notice"), false);
  assert.equal(disableCacheApplies("POST", "/api/user/register"), false);
  assert.equal(disableCacheApplies("POST", "/api/oauth/wechat/bind"), false);
  assert.equal(disableCacheApplies("GET", "/api/user/groups"), false);
  assert.equal(disableCacheApplies("GET", "/api/user/1"), false);
  assert.equal(disableCacheApplies("POST", "/api/setup"), false);
});

test("original DisableCache leftover headers before authentication", async () => {
  resetSchemaFlag();
  const e = env();
  for (const path of ["/api/user/token/status", "/api/user/token", "/api/audit/self", "/api/audit"]) {
    const hit = await send(new Request(`http://local${path}`), e);
    assert.notEqual(hit.res.status, 200, `${path} ${hit.text}`);
    assertDisableCache(hit.res, path);
  }
});

test("original DisableCache leftover headers on login and not on register/status/notice", async () => {
  resetSchemaFlag();
  const e = env();
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.match(login.text, /"success":false/);
  assertDisableCache(login.res, "login");

  const register = await send(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "n", password: "password12" }),
    }),
    e,
  );
  assert.equal(register.res.headers.get("pragma"), null, register.text);
  assert.notEqual(register.res.headers.get("cache-control"), DISABLE_CACHE_CONTROL);

  const status = await send(new Request("http://local/api/status"), e);
  assert.equal(status.res.status, 200, status.text);
  assert.equal(status.res.headers.get("pragma"), null);
  assert.notEqual(status.res.headers.get("cache-control"), DISABLE_CACHE_CONTROL);

  const notice = await send(new Request("http://local/api/notice"), e);
  assert.equal(notice.res.status, 200, notice.text);
  assert.equal(notice.res.headers.get("cache-control"), "no-cache");
  assert.equal(notice.res.headers.get("pragma"), null);
});

test("original DisableCache is skipped when CriticalRateLimit aborts first", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT: "1", CRITICAL_RATE_LIMIT_DURATION: "30" });
  const ip = "192.0.2.70";
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  const first = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.notEqual(first.res.status, 429, first.text);
  assertDisableCache(first.res, "login-before-ct");

  const limited = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.equal(limited.res.headers.get("pragma"), null);
  assert.equal(limited.res.headers.get("cache-control"), null);
});
