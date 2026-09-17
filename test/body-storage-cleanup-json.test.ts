import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ERR_REQUEST_BODY_TOO_LARGE,
  ERR_STORAGE_CLOSED,
  ERROR_CODE_READ_REQUEST_BODY_FAILED,
  GET_REQUEST_BODY_MAX_MB_FALLBACK,
  cleanupBodyStorage,
  createBodyStorage,
  emitBodyStorageCleanup,
  getDiskCacheStats,
  getRequestBody,
  getRequestBodyMaxMB,
  isRequestBodyTooLargeError,
  registerSourceForCleanup,
  rememberBodyCleanupContext,
  resetDiskCacheStats,
  WrappedRequestBodyTooLargeError,
} from "../src/body-storage.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(extra: Partial<Env> = {}): Env {
  return { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
}

async function send(req: Request, e: Env) {
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

async function boot(e: Env, ipHeaders: Record<string, string> = {}) {
  await send(
    new Request("http://local/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12", confirmPassword: "password12" }),
    }),
    e,
  );
  const login = await send(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", ...ipHeaders },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  const token = (login.body.data as { access_token: string }).access_token;
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };
  const tk = await send(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: { ...auth, ...ipHeaders },
      body: JSON.stringify({ name: "body-storage", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { auth, sk };
}

test("original BodyStorage Close / GetRequestBody wrap / FileSource cleanup", async () => {
  assert.equal(ERR_REQUEST_BODY_TOO_LARGE, "request body too large");
  assert.equal(ERR_STORAGE_CLOSED, "body storage is closed");
  assert.equal(ERROR_CODE_READ_REQUEST_BODY_FAILED, "read_request_body_failed");
  assert.equal(GET_REQUEST_BODY_MAX_MB_FALLBACK, 128);
  assert.equal(getRequestBodyMaxMB({}), 128);
  assert.equal(getRequestBodyMaxMB({ MAX_REQUEST_BODY_MB: "1" }), 1);
  assert.equal(getRequestBodyMaxMB({ MAX_REQUEST_BODY_MB: "0" }), 128);
  assert.equal(getRequestBodyMaxMB({ MAX_REQUEST_BODY_MB: "-1" }), 128);

  const wrapped = new WrappedRequestBodyTooLargeError(1);
  assert.equal(wrapped.message, "request body exceeds 1 MB: request body too large");
  assert.equal(isRequestBodyTooLargeError(wrapped), true);

  const payload = new TextEncoder().encode("hello-body");
  const storage = createBodyStorage(payload);
  assert.equal(storage.isDisk(), false);
  assert.equal(storage.size(), payload.byteLength);
  assert.equal(new TextDecoder().decode(storage.bytes()), "hello-body");
  storage.close();
  assert.throws(() => storage.bytes(), { message: ERR_STORAGE_CLOSED });
  storage.close();

  const req = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4" }),
  });
  rememberBodyCleanupContext(req, { MAX_REQUEST_BODY_MB: "1" });
  const first = await getRequestBody(req, { MAX_REQUEST_BODY_MB: "1" });
  const again = await getRequestBody(req, { MAX_REQUEST_BODY_MB: "1" });
  assert.equal(first, again);
  const beforeCleanup = getDiskCacheStats();
  assert.equal(beforeCleanup.activeMemoryBuffers >= 1, true);

  let closed = 0;
  registerSourceForCleanup(req, {
    getCache() {
      return {
        close() {
          closed += 1;
        },
      };
    },
  });
  emitBodyStorageCleanup(req);
  assert.equal(closed, 1);
  assert.throws(() => first.bytes(), { message: ERR_STORAGE_CLOSED });
  assert.equal(getDiskCacheStats().activeMemoryBuffers, beforeCleanup.activeMemoryBuffers - 1);

  cleanupBodyStorage(req);
  resetDiskCacheStats();
});

test("original BodyStorageCleanup leftover 413 read_request_body_failed JSON", async () => {
  resetSchemaFlag();
  const e = env({ MAX_REQUEST_BODY_MB: "1" });
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.90" });
  const over = "x".repeat((1 << 20) + 1);
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };

  const missing = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.91" },
      body: over,
    }),
    e,
  );
  assert.equal(missing.res.status, 401, missing.text);
  assert.notEqual(missing.res.status, 413);

  const chat = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.92" },
      body: over,
    }),
    e,
  );
  assert.equal(chat.res.status, 413, chat.text);
  const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
  assert.equal(chatErr.message, "request body exceeds 1 MB: request body too large");
  assert.equal(chatErr.type, "new_api_error");
  assert.equal(chatErr.param, "");
  assert.equal(chatErr.code, ERROR_CODE_READ_REQUEST_BODY_FAILED);
  assert.equal("type" in chat.body && chat.body.type === "error", false);

  const claude = await send(
    new Request("http://local/v1/messages", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.93", "anthropic-version": "2023-06-01" },
      body: over,
    }),
    e,
  );
  assert.equal(claude.res.status, 413, claude.text);
  assert.equal(claude.body.type, "error");
  const claudeErr = claude.body.error as { type: string; message: string; code?: string; param?: string };
  assert.equal(claudeErr.type, "new_api_error");
  assert.equal(claudeErr.message, "request body exceeds 1 MB: request body too large");
  assert.equal(claudeErr.code, undefined);
  assert.equal(claudeErr.param, undefined);

  const under = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.94" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.notEqual(under.res.status, 413, under.text);

  const perf = await send(new Request("http://local/api/performance/stats", { headers: auth }), e);
  assert.equal(perf.body.success, true, String(perf.body.message));
  const cache = (perf.body.data as { cache_stats: { current_memory_usage_bytes: number } }).cache_stats;
  assert.equal(cache.current_memory_usage_bytes, 0);
});

test("original BodyStorageCleanup leftover does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.95" });

  const unauth = await send(
    new Request("http://local/api/oauth/email/bind/start", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ email: "new@example.com" }),
    }),
    e,
  );
  assert.equal(unauth.res.status, 401);
  assert.equal(unauth.body.code, "AUTH_UNAUTHORIZED");
  assert.equal(unauth.body.message, "Unauthorized");

  const created = await send(
    new Request("http://local/api/vendors/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.96", "x-oneapi-request-id": "hop347-vendor-create" },
      body: JSON.stringify({ name: "body-cleanup-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop347-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
