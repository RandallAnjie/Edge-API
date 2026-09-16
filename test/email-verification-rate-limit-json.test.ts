import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  EMAIL_VERIFICATION_DURATION,
  EMAIL_VERIFICATION_MAX_REQUESTS,
  EMAIL_VERIFICATION_RATE_LIMIT_MARK,
  MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY,
  emailVerificationRateLimitWaitMessage,
  memoryEmailVerificationKey,
  redisFixedWindowTake,
  redisIPRateLimitKey,
} from "../src/email-verification-rate-limit.js";
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

function env(db = createMemoryD1(), kv?: KVNamespace): Env {
  return kv ? { DB: db, KV: kv, SYSTEM_NAME: "Edge API Test" } : { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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
  return { auth };
}

function verifyReq(email: string, ip: string, extra: Record<string, string> = {}) {
  return new Request(`http://local/api/verification?email=${encodeURIComponent(email)}`, {
    headers: { "cf-connecting-ip": ip, ...extra },
  });
}

test("original EmailVerificationRateLimit memory leftover gin.H HTTP 429 omit data", async () => {
  assert.equal(memoryEmailVerificationKey("192.0.2.30"), "EV:192.0.2.30");
  assert.equal(EMAIL_VERIFICATION_MAX_REQUESTS, 2);
  assert.equal(EMAIL_VERIFICATION_DURATION, 30);

  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const ip = "192.0.2.30";

  const first = await json(verifyReq("not-an-email", ip), e);
  assert.equal(first.res.status, 200);
  assert.equal(first.body.code, "EMAIL_ADDRESS_REJECTED");
  const second = await json(verifyReq("also-bad", ip), e);
  assert.equal(second.res.status, 200);
  assert.equal(second.body.code, "EMAIL_ADDRESS_REJECTED");
  const third = await json(verifyReq("still-bad", ip), e);
  assert.equal(third.res.status, 429);
  omitData(third.body, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);

  const otherIp = await json(verifyReq("not-an-email", "192.0.2.31"), e);
  assert.equal(otherIp.res.status, 200);
  assert.equal(otherIp.body.code, "EMAIL_ADDRESS_REJECTED");

  for (let i = 0; i < 3; i++) {
    const reset = await json(new Request("http://local/api/reset_password?email=not-an-email", { headers: { "cf-connecting-ip": ip } }), e);
    assert.equal(reset.res.status, 200);
    assert.notEqual(reset.body.message, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);
  }

  const unauth = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.40" },
      body: JSON.stringify({ email: "a@example.com" }),
    }),
    e,
  );
  assert.equal(unauth.res.status, 401);
  const bindIp = "198.51.100.40";
  const b1 = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": bindIp },
      body: JSON.stringify({ email: "not-an-email" }),
    }),
    e,
  );
  assert.equal(b1.res.status, 200);
  assert.equal(b1.body.code, "EMAIL_ADDRESS_REJECTED");
  const b2 = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": bindIp },
      body: JSON.stringify({ email: "also-bad" }),
    }),
    e,
  );
  assert.equal(b2.body.code, "EMAIL_ADDRESS_REJECTED");
  const b3 = await json(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": bindIp },
      body: JSON.stringify({ email: "still-bad" }),
    }),
    e,
  );
  assert.equal(b3.res.status, 429);
  omitData(b3.body, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);

  const resend = await json(
    new Request("http://local/api/oauth/email/bind/resend", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": bindIp },
      body: JSON.stringify({ flow_token: "missing" }),
    }),
    e,
  );
  assert.equal(resend.res.status, 429);
  omitData(resend.body, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);
});

test("original EmailVerificationRateLimit Redis/KV leftover gin.H HTTP 429 omit data", async () => {
  assert.equal(redisIPRateLimitKey(EMAIL_VERIFICATION_RATE_LIMIT_MARK, "192.0.2.30"), "rateLimit:v2:ip:EV:192.0.2.30");
  assert.equal(emailVerificationRateLimitWaitMessage(30), "发送过于频繁，请等待 30 秒后再试");

  const kv = memoryKv();
  const now = 1_700_000_000;
  const key = redisIPRateLimitKey("EV", "192.0.2.30");
  const a = await redisFixedWindowTake(kv, key, 2, 30, now);
  assert.equal(a.allowed, true);
  assert.equal(a.count, 1);
  const b = await redisFixedWindowTake(kv, key, 2, 30, now);
  assert.equal(b.allowed, true);
  assert.equal(b.count, 2);
  const c = await redisFixedWindowTake(kv, key, 2, 30, now);
  assert.equal(c.allowed, false);
  assert.equal(c.count, 3);
  assert.equal(c.ttlSeconds, 30);
  await assert.rejects(() => redisFixedWindowTake(kv, "", 2, 30, now), /rate limit key is empty/);

  resetSchemaFlag();
  const e = env(createMemoryD1(), memoryKv());
  await boot(e);
  const ip = "192.0.2.50";
  assert.equal((await json(verifyReq("not-an-email", ip), e)).res.status, 200);
  assert.equal((await json(verifyReq("also-bad", ip), e)).res.status, 200);
  const limited = await json(verifyReq("still-bad", ip), e);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.body.success, false);
  assert.equal("data" in limited.body, false);
  assert.match(String(limited.body.message), /^发送过于频繁，请等待 \d+ 秒后再试$/);

  const boom: KVNamespace = {
    async get(key) {
      if (key.includes(":ip:EV:")) throw new Error("Redis client is not initialized");
      return null;
    },
    async put(key) {
      if (key.includes(":ip:EV:")) throw new Error("Redis client is not initialized");
    },
  };
  resetSchemaFlag();
  const fallback = env(createMemoryD1(), boom);
  await boot(fallback);
  const fip = "192.0.2.60";
  assert.equal((await json(verifyReq("not-an-email", fip), fallback)).res.status, 200);
  assert.equal((await json(verifyReq("also-bad", fip), fallback)).res.status, 200);
  const fell = await json(verifyReq("still-bad", fip), fallback);
  assert.equal(fell.res.status, 429);
  omitData(fell.body, MSG_EMAIL_VERIFICATION_RATE_LIMIT_MEMORY);
});
