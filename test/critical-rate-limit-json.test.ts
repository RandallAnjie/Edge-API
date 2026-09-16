import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  CRITICAL_RATE_LIMIT_DURATION,
  CRITICAL_RATE_LIMIT_MARK,
  CRITICAL_RATE_LIMIT_NUM,
  criticalRateLimitApplies,
  memoryCriticalRateLimitKey,
} from "../src/critical-rate-limit.js";
import { redisIPRateLimitKey } from "../src/email-verification-rate-limit.js";
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

function loginReq(ip: string, username = "root") {
  return new Request("http://local/api/user/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ username, password: "password12" }),
  });
}

test("original CriticalRateLimit applies to original CT routes only", () => {
  assert.equal(CRITICAL_RATE_LIMIT_MARK, "CT");
  assert.equal(CRITICAL_RATE_LIMIT_NUM, 20);
  assert.equal(CRITICAL_RATE_LIMIT_DURATION, 1200);
  assert.equal(memoryCriticalRateLimitKey("192.0.2.10"), "CT192.0.2.10");
  assert.equal(redisIPRateLimitKey(CRITICAL_RATE_LIMIT_MARK, "192.0.2.10"), "rateLimit:v2:ip:CT:192.0.2.10");

  assert.equal(criticalRateLimitApplies("POST", "/api/user/login"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/user/register"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/reset_password"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/user/reset"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/oauth/state"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/oauth/github"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/oauth/wechat"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/oauth/telegram/login"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/oauth/telegram/bind/flow_missing"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/ratio_config"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/verify"), true);
  assert.equal(criticalRateLimitApplies("PUT", "/api/user/self"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/user/token"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/user/pay"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/token/12/key"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/token/batch/keys"), true);
  assert.equal(criticalRateLimitApplies("POST", "/api/channel/3/key"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/usage/token"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/usage/token/"), true);
  assert.equal(criticalRateLimitApplies("GET", "/api/log/token"), true);

  assert.equal(criticalRateLimitApplies("GET", "/api/status"), false);
  assert.equal(criticalRateLimitApplies("GET", "/api/verification"), false);
  assert.equal(criticalRateLimitApplies("POST", "/api/setup"), false);
  assert.equal(criticalRateLimitApplies("GET", "/api/user/self"), false);
  assert.equal(criticalRateLimitApplies("GET", "/api/user/token/status"), false);
  assert.equal(criticalRateLimitApplies("POST", "/api/token/batch"), false);
  assert.equal(criticalRateLimitApplies("GET", "/api/channel/3"), false);
  assert.equal(criticalRateLimitApplies("POST", "/api/user/checkin"), false);
});

test("original CriticalRateLimit memory leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT: "2", CRITICAL_RATE_LIMIT_DURATION: "30" });
  await setup(e);
  const ip = "192.0.2.80";

  const first = await send(loginReq(ip), e);
  assert.equal(first.res.status, 200, first.text);
  assert.match(first.text, /"success":true/);
  const second = await send(loginReq(ip), e);
  assert.equal(second.res.status, 200, second.text);
  const third = await send(loginReq(ip), e);
  assert.equal(third.res.status, 429);
  assert.equal(third.text, "");
  assert.equal(third.res.headers.get("retry-after"), "30");
  assert.equal(third.res.headers.get("content-type"), null);

  const other = await send(loginReq("192.0.2.81"), e);
  assert.equal(other.res.status, 200, other.text);

  const status = await send(new Request("http://local/api/status", { headers: { "cf-connecting-ip": ip } }), e);
  assert.equal(status.res.status, 200, status.text);
  assert.match(status.text, /"success":true/);

  const verify = await send(new Request("http://local/api/verification?email=not-an-email", { headers: { "cf-connecting-ip": ip } }), e);
  assert.equal(verify.res.status, 200, verify.text);
  assert.notEqual(verify.text, "");

  const reset = await send(new Request("http://local/api/reset_password?email=not-an-email", { headers: { "cf-connecting-ip": ip } }), e);
  assert.equal(reset.res.status, 429);
  assert.equal(reset.text, "");
  assert.equal(reset.res.headers.get("retry-after"), "30");
});

test("original CriticalRateLimit Redis/KV leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    KV: memoryKv(),
    CRITICAL_RATE_LIMIT: "2",
    CRITICAL_RATE_LIMIT_DURATION: "30",
  });
  await setup(e);
  const ip = "192.0.2.90";
  assert.equal((await send(loginReq(ip), e)).res.status, 200);
  assert.equal((await send(loginReq(ip), e)).res.status, 200);
  const limited = await send(loginReq(ip), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(String(limited.res.headers.get("retry-after")), /^\d+$/);
  assert.ok(Number(limited.res.headers.get("retry-after")) > 0);
  assert.ok(Number(limited.res.headers.get("retry-after")) <= 30);
});

test("original CriticalRateLimit Redis/KV failure is empty HTTP 500", async () => {
  const m = new Map<string, string>();
  const boom: KVNamespace = {
    async get(key) {
      if (key.includes(":ip:CT:")) throw new Error("Redis client is not initialized");
      return m.get(key) ?? null;
    },
    async put(key, value) {
      if (key.includes(":ip:CT:")) throw new Error("Redis client is not initialized");
      m.set(key, value);
    },
  };
  resetSchemaFlag();
  const e = env(createMemoryD1(), { KV: boom });
  await setup(e);
  const hit = await send(loginReq("192.0.2.100"), e);
  assert.equal(hit.res.status, 500);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("retry-after"), null);
});

test("original CriticalRateLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT_ENABLE: "false", CRITICAL_RATE_LIMIT: "1" });
  await setup(e);
  const ip = "192.0.2.110";
  for (let i = 0; i < 5; i++) {
    const hit = await send(loginReq(ip), e);
    assert.equal(hit.res.status, 200, hit.text);
    assert.notEqual(hit.text, "");
  }
});
