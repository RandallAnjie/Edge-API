import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  DEFAULT_ANONYMOUS_REQUEST_BODY_LIMIT_KB,
  anonymousRequestBodyLimitApplies,
  getAnonymousRequestBodyLimitBytes,
  readAnonymousRequestBody,
} from "../src/anonymous-request-body-limit.js";
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

function paddedJson(bytes: number): string {
  const pad = "x".repeat(Math.max(0, bytes));
  return JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12", pad });
}

test("original AnonymousRequestBodyLimit applies to original anonymous-body routes only", () => {
  assert.equal(DEFAULT_ANONYMOUS_REQUEST_BODY_LIMIT_KB, 512);
  assert.equal(getAnonymousRequestBodyLimitBytes(env()), 512 << 10);
  assert.equal(getAnonymousRequestBodyLimitBytes(env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "1" })), 1024);
  assert.equal(getAnonymousRequestBodyLimitBytes(env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "0" })), 0);
  assert.equal(getAnonymousRequestBodyLimitBytes(env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "-1" })), 512 << 10);

  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/setup"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/setup/"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/reset"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/oauth/state"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/register"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/login"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/login/2fa"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/login/verify"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/login/passkey/begin"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/login/passkey/finish"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/passkey/login/begin"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/passkey/login/finish"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/stripe/webhook"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/creem/webhook"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/waffo/webhook"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/waffo-pancake/webhook/test"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/waffo-pancake/webhook/prod"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/epay/notify"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/subscription/epay/notify"), true);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/subscription/epay/return"), true);

  assert.equal(anonymousRequestBodyLimitApplies("GET", "/api/setup"), false);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/verify"), false);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/user/checkin"), false);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/oauth/email/bind"), false);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/api/waffo-pancake/webhook/test/extra"), false);
  assert.equal(anonymousRequestBodyLimitApplies("GET", "/api/user/epay/notify"), false);
  assert.equal(anonymousRequestBodyLimitApplies("GET", "/api/subscription/epay/return"), false);
  assert.equal(anonymousRequestBodyLimitApplies("POST", "/v1/chat/completions"), false);
});

test("original AnonymousRequestBodyLimit leftover empty HTTP 413", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "1" });
  const over = paddedJson(1200);
  assert.ok(Buffer.byteLength(over) > 1024);

  const setup = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.160" },
      body: over,
    }),
    e,
  );
  assert.equal(setup.res.status, 413);
  assert.equal(setup.text, "");
  assert.equal(setup.res.headers.get("content-type"), null);

  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.161" },
      body: over,
    }),
    e,
  );
  assert.equal(login.res.status, 413);
  assert.equal(login.text, "");

  const webhook = await send(
    new Request("http://local/api/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.162" },
      body: over,
    }),
    e,
  );
  assert.equal(webhook.res.status, 413);
  assert.equal(webhook.text, "");

  const pancake = await send(
    new Request("http://local/api/waffo-pancake/webhook/prod", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.163" },
      body: over,
    }),
    e,
  );
  assert.equal(pancake.res.status, 413);
  assert.equal(pancake.text, "");

  const under = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.164" },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  assert.notEqual(under.res.status, 413, under.text);
  assert.notEqual(under.text, "");
});

test("original AnonymousRequestBodyLimit does not apply off original routes", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "1" });
  const over = paddedJson(1200);
  const hit = await send(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.165" },
      body: over,
    }),
    e,
  );
  assert.notEqual(hit.res.status, 413, hit.text);
  assert.notEqual(hit.text, "");
});

test("original AnonymousRequestBodyLimit can be disabled", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "0" });
  const over = paddedJson(1200);
  const hit = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.166" },
      body: over,
    }),
    e,
  );
  assert.notEqual(hit.res.status, 413, hit.text);
  assert.notEqual(hit.text, "");
});

test("original AnonymousRequestBodyLimit read error is empty HTTP 400", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  await assert.rejects(() => readAnonymousRequestBody(stream, 1024), /connection reset/);

  resetSchemaFlag();
  const exploding = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  const e = env(createMemoryD1(), { ANONYMOUS_REQUEST_BODY_LIMIT_KB: "1" });
  const hit = await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.167" },
      body: exploding,
      duplex: "half",
    } as RequestInit),
    e,
  );
  assert.equal(hit.res.status, 400);
  assert.equal(hit.text, "");
  assert.equal(hit.res.headers.get("content-type"), null);
});
