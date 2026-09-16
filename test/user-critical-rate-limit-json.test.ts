import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  USER_CRITICAL_RATE_LIMIT_MARK_PREFIX,
  memoryUserRateLimitKey,
  redisUserRateLimitKey,
  userCriticalRateLimit,
  userCriticalRateLimitApplies,
  userCriticalRateLimitMark,
  userCriticalRateLimitScope,
} from "../src/user-critical-rate-limit.js";
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

async function login(e: Env, username = "root", ip = "192.0.2.200") {
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

function setupReq(token: string, ip: string) {
  return new Request("http://local/api/user/2fa/setup", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "cf-connecting-ip": ip },
  });
}

test("original UserCriticalRateLimit applies to original UC routes only", () => {
  assert.equal(USER_CRITICAL_RATE_LIMIT_MARK_PREFIX, "UC:");
  assert.equal(userCriticalRateLimitMark("security-verification"), "UC:security-verification");
  assert.equal(redisUserRateLimitKey("UC:security-verification", 42), "rateLimit:v2:user:UC:security-verification:42");
  assert.equal(memoryUserRateLimitKey("UC:account-security", 7), "UC:account-security:user:7");

  assert.equal(userCriticalRateLimitScope("POST", "/api/oauth/email/bind/start"), "account-security");
  assert.equal(userCriticalRateLimitScope("POST", "/api/oauth/email/bind/resend"), "account-security");
  assert.equal(userCriticalRateLimitScope("POST", "/api/oauth/email/bind"), "account-security");
  assert.equal(userCriticalRateLimitScope("POST", "/api/verify"), "security-verification");
  assert.equal(userCriticalRateLimitScope("GET", "/api/user/token"), "access-token");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/token"), "access-token");
  assert.equal(userCriticalRateLimitScope("DELETE", "/api/user/token"), "access-token");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/passkey/register/begin"), "security-verification");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/passkey/register/finish"), "security-verification");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/passkey/verify/begin"), "security-verification");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/passkey/verify/finish"), "security-verification");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/aff_transfer"), "aff-transfer");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/2fa/setup"), "security-verification");
  assert.equal(userCriticalRateLimitScope("POST", "/api/user/2fa/enable"), "security-verification");
  assert.equal(userCriticalRateLimitApplies("POST", "/api/user/2fa/setup/"), true);

  assert.equal(userCriticalRateLimitApplies("GET", "/api/user/2fa/status"), false);
  assert.equal(userCriticalRateLimitApplies("POST", "/api/user/2fa/disable"), false);
  assert.equal(userCriticalRateLimitApplies("GET", "/api/user/token/status"), false);
  assert.equal(userCriticalRateLimitApplies("POST", "/api/user/login"), false);
  assert.equal(userCriticalRateLimitApplies("POST", "/api/user/checkin"), false);
  assert.equal(userCriticalRateLimitApplies("GET", "/api/verify/methods"), false);
});

test("original UserCriticalRateLimit leftover empty HTTP 401 when userID is 0", async () => {
  const denied = await userCriticalRateLimit(env(), 0, "security-verification");
  assert.ok(denied);
  assert.equal(denied.status, 401);
  assert.equal(await denied.text(), "");
  assert.equal(denied.headers.get("content-type"), null);
  assert.equal(denied.headers.get("retry-after"), null);
});

test("original UserCriticalRateLimit memory leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT: "2", CRITICAL_RATE_LIMIT_DURATION: "30" });
  await setup(e);
  const token = await login(e, "root", "192.0.2.201");

  const first = await send(setupReq(token, "192.0.2.201"), e);
  assert.notEqual(first.res.status, 429, first.text);
  assert.notEqual(first.text, "");
  const second = await send(setupReq(token, "192.0.2.202"), e);
  assert.notEqual(second.res.status, 429, second.text);
  const third = await send(setupReq(token, "192.0.2.203"), e);
  assert.equal(third.res.status, 429);
  assert.equal(third.text, "");
  assert.equal(third.res.headers.get("retry-after"), "30");
  assert.equal(third.res.headers.get("content-type"), null);

  const anon = await send(
    new Request("http://local/api/user/2fa/setup", {
      method: "POST",
      headers: { "cf-connecting-ip": "192.0.2.204" },
    }),
    e,
  );
  assert.notEqual(anon.res.status, 429, anon.text);
  assert.notEqual(anon.text, "");
  assert.match(anon.text, /"success":false/);
});

test("original UserCriticalRateLimit is per-user not per-IP", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT: "2", CRITICAL_RATE_LIMIT_DURATION: "30" });
  await setup(e);
  const rootToken = await login(e, "root", "192.0.2.210");
  const created = await send(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: { authorization: "Bearer " + rootToken, "content-type": "application/json", "cf-connecting-ip": "192.0.2.210" },
      body: JSON.stringify({ username: "alice", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.res.status, 200, created.text);
  const aliceToken = await login(e, "alice", "192.0.2.211");

  assert.notEqual((await send(setupReq(rootToken, "192.0.2.210"), e)).res.status, 429);
  assert.notEqual((await send(setupReq(rootToken, "192.0.2.210"), e)).res.status, 429);
  const rootLimited = await send(setupReq(rootToken, "192.0.2.210"), e);
  assert.equal(rootLimited.res.status, 429);
  assert.equal(rootLimited.text, "");

  const aliceFirst = await send(setupReq(aliceToken, "192.0.2.210"), e);
  assert.notEqual(aliceFirst.res.status, 429, aliceFirst.text);
  assert.notEqual(aliceFirst.text, "");
});

test("original UserCriticalRateLimit Redis/KV leftover empty HTTP 429 Retry-After", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), {
    KV: memoryKv(),
    CRITICAL_RATE_LIMIT: "2",
    CRITICAL_RATE_LIMIT_DURATION: "30",
  });
  await setup(e);
  const token = await login(e, "root", "192.0.2.220");
  assert.notEqual((await send(setupReq(token, "192.0.2.220"), e)).res.status, 429);
  assert.notEqual((await send(setupReq(token, "192.0.2.220"), e)).res.status, 429);
  const limited = await send(setupReq(token, "192.0.2.220"), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.text, "");
  assert.match(String(limited.res.headers.get("retry-after")), /^\d+$/);
  assert.ok(Number(limited.res.headers.get("retry-after")) > 0);
  assert.ok(Number(limited.res.headers.get("retry-after")) <= 30);
});

test("original UserCriticalRateLimit Redis/KV failure is empty HTTP 500", async () => {
  const m = new Map<string, string>();
  const boom: KVNamespace = {
    async get(key) {
      if (key.includes(":user:UC:")) throw new Error("Redis client is not initialized");
      return m.get(key) ?? null;
    },
    async put(key, value) {
      if (key.includes(":user:UC:")) throw new Error("Redis client is not initialized");
      m.set(key, value);
    },
  };
  resetSchemaFlag();
  const e = env(createMemoryD1(), { KV: boom });
  await setup(e);
  const token = await login(e, "root", "192.0.2.230");
  const hit = await send(setupReq(token, "192.0.2.230"), e);
  assert.equal(hit.res.status, 500);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("retry-after"), null);
});

test("original UserCriticalRateLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { CRITICAL_RATE_LIMIT_ENABLE: "false", CRITICAL_RATE_LIMIT: "1" });
  await setup(e);
  const token = await login(e, "root", "192.0.2.240");
  for (let i = 0; i < 5; i++) {
    const hit = await send(setupReq(token, "192.0.2.240"), e);
    assert.notEqual(hit.res.status, 429, hit.text);
    assert.notEqual(hit.text, "");
  }
});
