import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  GLOBAL_WEB_RATE_LIMIT_DURATION,
  GLOBAL_WEB_RATE_LIMIT_MARK,
  GLOBAL_WEB_RATE_LIMIT_NUM,
} from "../src/global-web-rate-limit.js";
import { redisIPRateLimitKey } from "../src/email-verification-rate-limit.js";
import type { AssetsBinding, Env, ExecutionContextLike, KVNamespace } from "../src/types.js";

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

function spaReq(ip: string, path = "/console") {
  return new Request(`http://local${path}`, { headers: { "cf-connecting-ip": ip } });
}

test("original GlobalWebRateLimit uses mark GW 120/180s IP key", () => {
  assert.equal(GLOBAL_WEB_RATE_LIMIT_MARK, "GW");
  assert.equal(GLOBAL_WEB_RATE_LIMIT_NUM, 120);
  assert.equal(GLOBAL_WEB_RATE_LIMIT_DURATION, 180);
  assert.equal(redisIPRateLimitKey(GLOBAL_WEB_RATE_LIMIT_MARK, "192.0.2.10"), "rateLimit:v2:ip:GW:192.0.2.10");
});

test("original GlobalWebRateLimit memory leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_WEB_RATE_LIMIT: "2", GLOBAL_WEB_RATE_LIMIT_DURATION: "30" });
  const ip = "192.0.2.220";

  const first = await send(spaReq(ip), e);
  assert.equal(first.res.status, 404, first.text);
  const second = await send(spaReq(ip), e);
  assert.equal(second.res.status, 404, second.text);
  const third = await send(spaReq(ip), e);
  assert.equal(third.res.status, 429);
  assert.equal(third.text, "");
  assert.equal(third.res.headers.get("retry-after"), "30");
  assert.equal(third.res.headers.get("content-type"), null);

  const other = await send(spaReq("192.0.2.221"), e);
  assert.equal(other.res.status, 404, other.text);

  const status = await send(new Request("http://local/api/status", { headers: { "cf-connecting-ip": ip } }), e);
  assert.equal(status.res.status, 200, status.text);
  assert.match(status.text, /"success":true/);
});

test("original GlobalWebRateLimit Redis/KV leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    KV: memoryKv(),
    GLOBAL_WEB_RATE_LIMIT: "2",
    GLOBAL_WEB_RATE_LIMIT_DURATION: "30",
  });
  const ip = "192.0.2.230";
  assert.equal((await send(spaReq(ip), e)).res.status, 404);
  assert.equal((await send(spaReq(ip), e)).res.status, 404);
  const limited = await send(spaReq(ip), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(String(limited.res.headers.get("retry-after")), /^\d+$/);
  assert.ok(Number(limited.res.headers.get("retry-after")) > 0);
  assert.ok(Number(limited.res.headers.get("retry-after")) <= 30);
});

test("original GlobalWebRateLimit Redis/KV failure is empty HTTP 500", async () => {
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
  const hit = await send(spaReq("192.0.2.240"), e);
  assert.equal(hit.res.status, 500);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("retry-after"), null);
});

test("original GlobalWebRateLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_WEB_RATE_LIMIT_ENABLE: "false", GLOBAL_WEB_RATE_LIMIT: "1" });
  const ip = "192.0.2.250";
  for (let i = 0; i < 5; i++) {
    const hit = await send(spaReq(ip), e);
    assert.equal(hit.res.status, 404, hit.text);
    assert.notEqual(hit.text, "");
  }
});

test("original GlobalWebRateLimit does not apply to registered /api or relay /v1", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_WEB_RATE_LIMIT: "1", GLOBAL_WEB_RATE_LIMIT_DURATION: "30" });
  const ip = "192.0.2.251";
  for (let i = 0; i < 2; i++) {
    const status = await send(new Request("http://local/api/status", { headers: { "cf-connecting-ip": ip } }), e);
    assert.equal(status.res.status, 200, status.text);
    assert.match(status.text, /"success":true/);
  }
  for (let i = 0; i < 2; i++) {
    const relay = await send(
      new Request("http://local/v1/models", { headers: { "cf-connecting-ip": ip, authorization: "Bearer sk-missing" } }),
      e,
    );
    assert.notEqual(relay.res.status, 429, relay.text);
  }
});

test("original GlobalWebRateLimit leftover empty HTTP 429 on unmatched /api and /v1 NoRoute", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { GLOBAL_WEB_RATE_LIMIT: "2", GLOBAL_WEB_RATE_LIMIT_DURATION: "30" });
  const apiIp = "192.0.2.252";
  assert.notEqual((await send(spaReq(apiIp, "/api/no-such-gw"), e)).res.status, 429);
  assert.notEqual((await send(spaReq(apiIp, "/api/no-such-gw"), e)).res.status, 429);
  const apiLimited = await send(spaReq(apiIp, "/api/no-such-gw"), e);
  assert.equal(apiLimited.res.status, 429);
  assert.equal(apiLimited.text, "");
  assert.equal(apiLimited.res.headers.get("retry-after"), "30");

  const v1Ip = "192.0.2.253";
  assert.notEqual((await send(spaReq(v1Ip, "/v1/no-such-gw"), e)).res.status, 429);
  assert.notEqual((await send(spaReq(v1Ip, "/v1/no-such-gw"), e)).res.status, 429);
  const v1Limited = await send(spaReq(v1Ip, "/v1/no-such-gw"), e);
  assert.equal(v1Limited.res.status, 429);
  assert.equal(v1Limited.text, "");
  assert.equal(v1Limited.res.headers.get("retry-after"), "30");
});

test("original GlobalWebRateLimit leftover empty HTTP 429 before ASSETS SPA serve", async () => {
  const assets: AssetsBinding = {
    async fetch() {
      return new Response("<html>spa</html>", { status: 200, headers: { "content-type": "text/html" } });
    },
  };
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    ASSETS: assets,
    GLOBAL_WEB_RATE_LIMIT: "2",
    GLOBAL_WEB_RATE_LIMIT_DURATION: "30",
  });
  const ip = "192.0.2.254";
  assert.equal((await send(spaReq(ip, "/sign-in"), e)).res.status, 200);
  assert.equal((await send(spaReq(ip, "/sign-in"), e)).res.status, 200);
  const limited = await send(spaReq(ip, "/sign-in"), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.equal(limited.res.headers.get("retry-after"), "30");
});
