import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  SEARCH_RATE_LIMIT_DURATION,
  SEARCH_RATE_LIMIT_MARK,
  SEARCH_RATE_LIMIT_NUM,
  searchRateLimit,
  searchRateLimitApplies,
} from "../src/search-rate-limit.js";
import { memoryUserRateLimitKey, redisUserRateLimitKey } from "../src/user-critical-rate-limit.js";
import type { Env, ExecutionContextLike, KVNamespace } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function memoryKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    async get(key) {
      return m.get(key) ?? null;
    },
    async put(key, value) {
      m.set(key, value);
    },
  };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const text = await res.text();
  return { res, text };
}

async function setup(e: Env) {
  const { res, text } = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  assert.equal(res.status, 200, text);
}

async function login(e: Env, username = "root", ip = "192.0.2.250") {
  const { res, text } = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ username, password: "password12" }),
    }),
    e,
  );
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text) as { data: { access_token: string } };
  return body.data.access_token;
}

function tokenSearchReq(token: string, ip: string) {
  return new Request("http://local/api/token/search?keyword=none", {
    headers: { authorization: "Bearer " + token, "cf-connecting-ip": ip },
  });
}

function logSearchReq(token: string, ip: string) {
  return new Request("http://local/api/log/self/search", {
    headers: { authorization: "Bearer " + token, "cf-connecting-ip": ip },
  });
}

test("original SearchRateLimit applies to original SR routes only", () => {
  assert.equal(SEARCH_RATE_LIMIT_MARK, "SR");
  assert.equal(SEARCH_RATE_LIMIT_NUM, 10);
  assert.equal(SEARCH_RATE_LIMIT_DURATION, 60);
  assert.equal(redisUserRateLimitKey(SEARCH_RATE_LIMIT_MARK, 42), "rateLimit:v2:user:SR:42");
  assert.equal(memoryUserRateLimitKey(SEARCH_RATE_LIMIT_MARK, 7), "SR:user:7");

  assert.equal(searchRateLimitApplies("GET", "/api/token/search"), true);
  assert.equal(searchRateLimitApplies("GET", "/api/token/search/"), true);
  assert.equal(searchRateLimitApplies("GET", "/api/log/self/search"), true);
  assert.equal(searchRateLimitApplies("GET", "/api/log/self/search/"), true);

  assert.equal(searchRateLimitApplies("POST", "/api/token/search"), false);
  assert.equal(searchRateLimitApplies("GET", "/api/log/search"), false);
  assert.equal(searchRateLimitApplies("GET", "/api/redemption/search"), false);
  assert.equal(searchRateLimitApplies("GET", "/api/user/search"), false);
  assert.equal(searchRateLimitApplies("GET", "/api/token/"), false);
  assert.equal(searchRateLimitApplies("GET", "/api/log/self"), false);
});

test("original SearchRateLimit leftover empty HTTP 401 when userID is 0", async () => {
  const denied = await searchRateLimit(env(), 0);
  assert.ok(denied);
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), "");
  assert.equal(denied.headers.get("content-type"), null);
  assert.equal(denied.headers.get("retry-after"), null);
});

test("original SearchRateLimit memory leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { SEARCH_RATE_LIMIT: "2", SEARCH_RATE_LIMIT_DURATION: "30" });
  await setup(e);
  const token = await login(e, "root", "192.0.2.251");

  const first = await send(tokenSearchReq(token, "192.0.2.251"), e);
  assert.equal(first.res.status, 200, first.text);
  assert.match(first.text, /"success":true/);
  const second = await send(logSearchReq(token, "192.0.2.252"), e);
  assert.equal(second.res.status, 200, second.text);
  assert.match(second.text, /该接口已废弃/);
  const third = await send(tokenSearchReq(token, "192.0.2.253"), e);
  assert.equal(third.res.status, 429);
  assert.equal(third.text, "");
  assert.equal(third.res.headers.get("retry-after"), "30");
  assert.equal(third.res.headers.get("content-type"), null);

  const anon = await send(
    new Request("http://local/api/token/search", { headers: { "cf-connecting-ip": "192.0.2.254" } }),
    e,
  );
  assert.notEqual(anon.res.status, 429, anon.text);
  assert.notEqual(anon.text, "");
  assert.match(anon.text, /"success":false/);
});

test("original SearchRateLimit is per-user not per-IP", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { SEARCH_RATE_LIMIT: "2", SEARCH_RATE_LIMIT_DURATION: "30" });
  await setup(e);
  const rootToken = await login(e, "root", "192.0.2.260");
  const created = await send(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: { authorization: "Bearer " + rootToken, "content-type": "application/json", "cf-connecting-ip": "192.0.2.260" },
      body: JSON.stringify({ username: "searcher", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.res.status, 200, created.text);
  const otherToken = await login(e, "searcher", "192.0.2.261");

  assert.equal((await send(tokenSearchReq(rootToken, "192.0.2.260"), e)).res.status, 200);
  assert.equal((await send(tokenSearchReq(rootToken, "192.0.2.260"), e)).res.status, 200);
  const rootLimited = await send(tokenSearchReq(rootToken, "192.0.2.260"), e);
  assert.equal(rootLimited.res.status, 429);
  assert.equal(rootLimited.text, "");

  const otherFirst = await send(tokenSearchReq(otherToken, "192.0.2.260"), e);
  assert.equal(otherFirst.res.status, 200, otherFirst.text);
  assert.notEqual(otherFirst.text, "");
});

test("original SearchRateLimit Redis/KV leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    KV: memoryKv(),
    SEARCH_RATE_LIMIT: "2",
    SEARCH_RATE_LIMIT_DURATION: "30",
  });
  await setup(e);
  const token = await login(e, "root", "192.0.2.270");
  assert.equal((await send(tokenSearchReq(token, "192.0.2.270"), e)).res.status, 200);
  assert.equal((await send(tokenSearchReq(token, "192.0.2.270"), e)).res.status, 200);
  const limited = await send(tokenSearchReq(token, "192.0.2.270"), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(String(limited.res.headers.get("retry-after")), /^\d+$/);
  assert.ok(Number(limited.res.headers.get("retry-after")) > 0);
  assert.ok(Number(limited.res.headers.get("retry-after")) <= 30);
});

test("original SearchRateLimit Redis/KV failure is empty HTTP 500", async () => {
  const m = new Map<string, string>();
  const boom: KVNamespace = {
    async get(key) {
      if (key.includes(":user:SR:")) throw new Error("Redis client is not initialized");
      return m.get(key) ?? null;
    },
    async put(key, value) {
      if (key.includes(":user:SR:")) throw new Error("Redis client is not initialized");
      m.set(key, value);
    },
  };
  resetSchemaFlag();
  const e = env(createMemoryD1(), { KV: boom });
  await setup(e);
  const token = await login(e, "root", "192.0.2.280");
  const hit = await send(tokenSearchReq(token, "192.0.2.280"), e);
  assert.equal(hit.res.status, 500);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("retry-after"), null);
});

test("original SearchRateLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { SEARCH_RATE_LIMIT_ENABLE: "false", SEARCH_RATE_LIMIT: "1" });
  await setup(e);
  const token = await login(e, "root", "192.0.2.290");
  for (let i = 0; i < 5; i++) {
    const hit = await send(tokenSearchReq(token, "192.0.2.290"), e);
    assert.equal(hit.res.status, 200, hit.text);
    assert.notEqual(hit.text, "");
  }
});
