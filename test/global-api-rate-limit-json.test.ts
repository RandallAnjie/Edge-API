import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  GLOBAL_API_RATE_LIMIT_DURATION,
  GLOBAL_API_RATE_LIMIT_MARK,
  GLOBAL_API_RATE_LIMIT_NUM,
  globalApiRateLimitApplies,
} from "../src/global-api-rate-limit.js";
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

function statusReq(ip: string) {
  return new Request("http://local/api/status", { headers: { "cf-connecting-ip": ip } });
}

test("original GlobalAPIRateLimit applies to /api and dashboard billing only", () => {
  assert.equal(GLOBAL_API_RATE_LIMIT_MARK, "GA");
  assert.equal(GLOBAL_API_RATE_LIMIT_NUM, 360);
  assert.equal(GLOBAL_API_RATE_LIMIT_DURATION, 180);
  assert.equal(redisIPRateLimitKey(GLOBAL_API_RATE_LIMIT_MARK, "192.0.2.10"), "rateLimit:v2:ip:GA:192.0.2.10");

  assert.equal(globalApiRateLimitApplies("/api"), true);
  assert.equal(globalApiRateLimitApplies("/api/status"), true);
  assert.equal(globalApiRateLimitApplies("/api/user/login"), true);
  assert.equal(globalApiRateLimitApplies("/api/verification"), true);
  assert.equal(globalApiRateLimitApplies("/dashboard/billing/subscription"), true);
  assert.equal(globalApiRateLimitApplies("/dashboard/billing/usage"), true);
  assert.equal(globalApiRateLimitApplies("/v1/dashboard/billing/subscription"), true);
  assert.equal(globalApiRateLimitApplies("/v1/dashboard/billing/usage/"), true);

  assert.equal(globalApiRateLimitApplies("/v1/chat/completions"), false);
  assert.equal(globalApiRateLimitApplies("/v1/models"), false);
  assert.equal(globalApiRateLimitApplies("/pg/chat/completions"), false);
  assert.equal(globalApiRateLimitApplies("/mj/submit/imagine"), false);
});

test("original GlobalAPIRateLimit memory leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_API_RATE_LIMIT: "2", GLOBAL_API_RATE_LIMIT_DURATION: "30" });
  const ip = "192.0.2.120";

  const first = await send(statusReq(ip), e);
  assert.equal(first.res.status, 200, first.text);
  assert.match(first.text, /"success":true/);
  const second = await send(statusReq(ip), e);
  assert.equal(second.res.status, 200, second.text);
  const third = await send(statusReq(ip), e);
  assert.equal(third.res.status, 429);
  assert.equal(third.text, "");
  assert.equal(third.res.headers.get("retry-after"), "30");
  assert.equal(third.res.headers.get("content-type"), null);

  const other = await send(statusReq("192.0.2.121"), e);
  assert.equal(other.res.status, 200, other.text);

  const relay = await send(
    new Request("http://local/v1/models", { headers: { "cf-connecting-ip": ip, authorization: "Bearer sk-missing" } }),
    e,
  );
  assert.notEqual(relay.res.status, 429, relay.text);
});

test("original GlobalAPIRateLimit Redis/KV leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    KV: memoryKv(),
    GLOBAL_API_RATE_LIMIT: "2",
    GLOBAL_API_RATE_LIMIT_DURATION: "30",
  });
  const ip = "192.0.2.130";
  assert.equal((await send(statusReq(ip), e)).res.status, 200);
  assert.equal((await send(statusReq(ip), e)).res.status, 200);
  const limited = await send(statusReq(ip), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(String(limited.res.headers.get("retry-after")), /^\d+$/);
  assert.ok(Number(limited.res.headers.get("retry-after")) > 0);
  assert.ok(Number(limited.res.headers.get("retry-after")) <= 30);
});

test("original GlobalAPIRateLimit Redis/KV failure is empty HTTP 500", async () => {
  const boom: KVNamespace = {
    async get() {
      throw new Error("Redis client is not initialized");
    },
    async put() {
      throw new Error("Redis client is not initialized");
    },
  };
  resetSchemaFlag();
  const e = env(createMemoryD1(), { KV: boom });
  const hit = await send(statusReq("192.0.2.140"), e);
  assert.equal(hit.res.status, 500);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("retry-after"), null);
});

test("original GlobalAPIRateLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_API_RATE_LIMIT_ENABLE: "false", GLOBAL_API_RATE_LIMIT: "1" });
  const ip = "192.0.2.150";
  for (let i = 0; i < 5; i++) {
    const hit = await send(statusReq(ip), e);
    assert.equal(hit.res.status, 200, hit.text);
    assert.notEqual(hit.text, "");
  }
});
