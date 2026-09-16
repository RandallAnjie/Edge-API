import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ERROR_CODE_INVALID_REQUEST,
  ERROR_TYPE_NEW_API_ERROR,
  messageWithRequestId,
  relayUsesClaudeError,
  toClaudeRelayError,
  writeRelayNewAPIError,
} from "../src/http.js";
import { MAX_TOKENS_LIMIT } from "../src/valid-request.js";
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
      body: JSON.stringify({ name: "relay-newapi", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { auth, sk };
}

test("original Relay leftover GetAndValidateRequest Claude vs OpenAI gin.H", async () => {
  assert.equal(relayUsesClaudeError("/v1/messages"), true);
  assert.equal(relayUsesClaudeError("/v1/messages/"), true);
  assert.equal(relayUsesClaudeError("/v1/messages/count_tokens"), false);
  assert.equal(relayUsesClaudeError("/v1/chat/completions"), false);
  assert.deepEqual(toClaudeRelayError("field messages is required"), {
    type: ERROR_TYPE_NEW_API_ERROR,
    message: "field messages is required",
  });

  const claudeReq = new Request("http://local/v1/messages", { method: "POST" });
  const claudeRes = writeRelayNewAPIError(claudeReq, 400, "field messages is required", ERROR_CODE_INVALID_REQUEST);
  assert.equal(claudeRes.status, 400);
  const claudeBody = (await claudeRes.json()) as { type: string; error: Record<string, unknown> };
  assert.equal(claudeBody.type, "error");
  assert.deepEqual(Object.keys(claudeBody), ["type", "error"]);
  assert.deepEqual(Object.keys(claudeBody.error).sort(), ["message", "type"]);
  assert.equal("param" in claudeBody.error, false);
  assert.equal("code" in claudeBody.error, false);
  assert.deepEqual(claudeBody.error, {
    type: ERROR_TYPE_NEW_API_ERROR,
    message: "field messages is required",
  });

  const chatReq = new Request("http://local/v1/chat/completions", { method: "POST" });
  const chatRes = writeRelayNewAPIError(chatReq, 400, "field messages is required", ERROR_CODE_INVALID_REQUEST);
  const chatBody = (await chatRes.json()) as { error: Record<string, unknown> };
  assert.equal("type" in chatBody, false);
  assert.deepEqual(chatBody.error, {
    message: "field messages is required",
    type: ERROR_TYPE_NEW_API_ERROR,
    param: "",
    code: ERROR_CODE_INVALID_REQUEST,
  });
});

test("original Relay leftover GetAndValidateRequest Claude envelope JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { sk } = await boot(e, { "cf-connecting-ip": "192.0.2.120" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };

  const missing = await send(
    new Request("http://local/v1/messages", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.121", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 32 }),
    }),
    e,
  );
  assert.equal(missing.res.status, 400, missing.text);
  assert.equal(missing.body.type, "error");
  const err = missing.body.error as { type: string; message: string; code?: string; param?: string };
  assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(err.message, "field messages is required");
  assert.equal(err.code, undefined);
  assert.equal(err.param, undefined);
  assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);

  const numbered = await send(
    new Request("http://local/v1/messages", {
      method: "POST",
      headers: {
        ...skAuth,
        "cf-connecting-ip": "192.0.2.122",
        "x-oneapi-request-id": "relay-claude-max-tokens",
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: MAX_TOKENS_LIMIT + 1,
      }),
    }),
    e,
  );
  assert.equal(numbered.res.status, 400, numbered.text);
  assert.equal(numbered.body.type, "error");
  const numberedErr = numbered.body.error as { type: string; message: string };
  assert.equal(numberedErr.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(numberedErr.message, messageWithRequestId("max_tokens is invalid", "relay-claude-max-tokens"));

  const chat = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.123" },
      body: JSON.stringify({ model: "gpt-4o-mini" }),
    }),
    e,
  );
  assert.equal(chat.res.status, 400, chat.text);
  assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
  const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
  assert.equal(chatErr.message, "field messages is required");
  assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(chatErr.param, "");
  assert.equal(chatErr.code, ERROR_CODE_INVALID_REQUEST);
});

test("original Relay leftover GetAndValidateRequest does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.124" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.125", "x-oneapi-request-id": "hop349-vendor-create" },
      body: JSON.stringify({ name: "relay-newapi-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop349-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});
