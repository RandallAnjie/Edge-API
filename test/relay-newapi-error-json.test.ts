import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ERROR_CODE_BAD_RESPONSE_BODY,
  ERROR_CODE_BAD_RESPONSE_STATUS_CODE,
  ERROR_CODE_CHANNEL_INVALID_KEY,
  ERROR_CODE_CONVERT_REQUEST_FAILED,
  ERROR_CODE_DO_REQUEST_FAILED,
  ERROR_CODE_EMPTY_RESPONSE,
  ERROR_CODE_GET_CHANNEL_FAILED,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_MODEL_PRICE_ERROR,
  ERROR_CODE_PROMPT_BLOCKED,
  ERROR_TYPE_NEW_API_ERROR,
  messageWithRequestId,
  noAvailableChannelRetryMessage,
  relayErrorHandler,
  relayUsesClaudeError,
  resetNewAPIErrorStatusCode,
  toClaudeRelayError,
  writeGeminiChatEmptyCandidatesError,
  writeGeminiChatUnmarshalError,
  writeRelayNewAPIError,
} from "../src/http.js";
import { geminiChatEmptyCandidatesError, geminiChatResponseUnmarshalError } from "../src/gemini-response.js";
import { CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_XUNFEI } from "../src/constants.js";
import { MAX_TOKENS_LIMIT } from "../src/valid-request.js";
import { Store } from "../src/store.js";
import { mergeModelRatio } from "./merge-model-ratio.js";
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

test("original Relay leftover convert/price/do_request/bad_response_body Claude vs OpenAI gin.H", async () => {
  async function assertClaudeEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/messages", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    assert.equal(res.status, status);
    const body = (await res.json()) as { type: string; error: Record<string, unknown> };
    assert.equal(body.type, "error");
    assert.deepEqual(Object.keys(body), ["type", "error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["message", "type"]);
    assert.equal("param" in body.error, false);
    assert.equal("code" in body.error, false);
    assert.deepEqual(body.error, { type: ERROR_TYPE_NEW_API_ERROR, message });
  }

  async function assertOpenAIEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/chat/completions", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    const body = (await res.json()) as { error: Record<string, unknown> };
    assert.equal("type" in body, false);
    assert.deepEqual(body.error, {
      message,
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code,
    });
  }

  await assertClaudeEnvelope(400, "Model hop350-unpriced price not configured", ERROR_CODE_MODEL_PRICE_ERROR);
  await assertOpenAIEnvelope(400, "Model hop350-unpriced price not configured", ERROR_CODE_MODEL_PRICE_ERROR);
  await assertClaudeEnvelope(500, "not implemented", ERROR_CODE_CONVERT_REQUEST_FAILED);
  await assertOpenAIEnvelope(500, "not implemented", ERROR_CODE_CONVERT_REQUEST_FAILED);
  await assertClaudeEnvelope(500, "dial failed", ERROR_CODE_DO_REQUEST_FAILED);
  await assertOpenAIEnvelope(500, "dial failed", ERROR_CODE_DO_REQUEST_FAILED);
  await assertClaudeEnvelope(500, "bad_response_body", ERROR_CODE_BAD_RESPONSE_BODY);
  await assertOpenAIEnvelope(500, "bad_response_body", ERROR_CODE_BAD_RESPONSE_BODY);
});

test("original Relay leftover ModelPriceHelper Claude envelope JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.130" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.131" },
      body: JSON.stringify({
        name: "hop350-unpriced",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop350",
        models: "hop350-unpriced",
        group: "default",
        base_url: "https://hop350.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  let fetchHits = 0;
  globalThis.fetch = (async () => {
    fetchHits += 1;
    return new Response("should-not-fetch");
  }) as typeof fetch;
  try {
    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.132",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop350-claude-price",
        },
        body: JSON.stringify({
          model: "hop350-unpriced",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 400, claude.text);
    assert.equal(claude.body.type, "error");
    const err = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
    assert.match(err.message, /Model hop350-unpriced price not configured/);
    assert.ok(err.message.endsWith("(request id: hop350-claude-price)"), err.message);
    assert.equal(err.code, undefined);
    assert.equal(err.param, undefined);
    assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);
    assert.equal(fetchHits, 0);

    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.133" },
        body: JSON.stringify({
          model: "hop350-unpriced",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 400, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.match(chatErr.message, /Model hop350-unpriced price not configured/);
    assert.equal(chatErr.message.includes("(request id:"), false, chatErr.message);
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_MODEL_PRICE_ERROR);
    assert.equal(fetchHits, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Relay leftover convert/price does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.134" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.135", "x-oneapi-request-id": "hop350-vendor-create" },
      body: JSON.stringify({ name: "relay-newapi-convert-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop350-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});

test("original Relay leftover RelayErrorHandler Claude vs OpenAI gin.H", async () => {
  const claudeReq = new Request("http://local/v1/messages", { method: "POST" });
  const claudeRes = relayErrorHandler(502, "not-json", "", claudeReq);
  assert.equal(claudeRes.status, 502);
  const claudeBody = (await claudeRes.json()) as { type: string; error: Record<string, unknown> };
  assert.equal(claudeBody.type, "error");
  assert.deepEqual(Object.keys(claudeBody), ["type", "error"]);
  assert.deepEqual(Object.keys(claudeBody.error).sort(), ["message", "type"]);
  assert.equal("param" in claudeBody.error, false);
  assert.equal("code" in claudeBody.error, false);
  assert.deepEqual(claudeBody.error, {
    type: ERROR_CODE_BAD_RESPONSE_STATUS_CODE,
    message: "bad response status code 502",
  });

  const numberedReq = new Request("http://local/v1/messages", {
    method: "POST",
    headers: { "x-oneapi-request-id": "hop351-claude-status" },
  });
  const numberedRes = relayErrorHandler(502, "not-json", "", numberedReq);
  const numberedBody = (await numberedRes.json()) as { error: { message: string } };
  assert.equal(numberedBody.error.message, messageWithRequestId("bad response status code 502", "hop351-claude-status"));

  const deniedReq = new Request("http://local/v1/messages", { method: "POST" });
  const deniedRes = relayErrorHandler(
    403,
    JSON.stringify({ error: { message: "nope", type: "auth", code: "denied" } }),
    JSON.stringify({ "403": 404 }),
    deniedReq,
  );
  assert.equal(deniedRes.status, 404);
  const deniedBody = (await deniedRes.json()) as { type: string; error: Record<string, unknown> };
  assert.equal(deniedBody.type, "error");
  assert.deepEqual(deniedBody.error, { type: "denied", message: "nope" });

  const chatRes = relayErrorHandler(502, "not-json");
  const chatBody = (await chatRes.json()) as { error: Record<string, unknown> };
  assert.equal("type" in chatBody, false);
  assert.deepEqual(chatBody.error, {
    message: "bad response status code 502",
    type: ERROR_CODE_BAD_RESPONSE_STATUS_CODE,
    param: "",
    code: ERROR_CODE_BAD_RESPONSE_STATUS_CODE,
  });
});

test("original Relay leftover RelayErrorHandler Claude envelope JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.140" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.141" },
      body: JSON.stringify({
        name: "hop351-status",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop351",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://hop351.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not-json", { status: 502 })) as typeof fetch;
  try {
    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.142",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop351-claude-upstream",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 502, claude.text);
    assert.equal(claude.body.type, "error");
    const err = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(err.type, ERROR_CODE_BAD_RESPONSE_STATUS_CODE);
    assert.equal(err.message, messageWithRequestId("bad response status code 502", "hop351-claude-upstream"));
    assert.equal(err.code, undefined);
    assert.equal(err.param, undefined);
    assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);

    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.143" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 502, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "bad response status code 502");
    assert.equal(chatErr.type, ERROR_CODE_BAD_RESPONSE_STATUS_CODE);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_STATUS_CODE);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Relay leftover RelayErrorHandler does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.144" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.145", "x-oneapi-request-id": "hop351-vendor-create" },
      body: JSON.stringify({ name: "relay-error-handler-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop351-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});

test("original Relay leftover last-loop do_request_failed Claude vs OpenAI gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.160" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.161" },
      body: JSON.stringify({
        name: "hop353-fetch-throw",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop353",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://hop353-throw.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("upstream down");
  }) as typeof fetch;
  try {
    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.162",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop353-claude-do-request",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 500, claude.text);
    assert.equal(claude.body.type, "error");
    const err = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(err.message, messageWithRequestId("upstream down", "hop353-claude-do-request"));
    assert.equal(err.code, undefined);
    assert.equal(err.param, undefined);
    assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);

    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.163" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 500, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "upstream down");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_DO_REQUEST_FAILED);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Relay leftover last-loop get_channel_failed Claude vs OpenAI gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.164" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const retryOpt = await send(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.165" },
      body: JSON.stringify({ key: "RetryTimes", value: "1" }),
    }),
    e,
  );
  assert.equal(retryOpt.body.success, true, retryOpt.text);
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.166" },
      body: JSON.stringify({
        name: "hop353-retry-channel",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop353-retry",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://hop353-retry.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);
  const channelId = Number((ch.body.data as { id?: number })?.id || 0);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).startsWith("https://hop353-retry.example.test")) {
      await e.DB.prepare(`UPDATE abilities SET enabled = 0 WHERE channel_id = ?`).bind(channelId).run();
      return new Response("upstream boom", { status: 502 });
    }
    return origFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.167",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop353-claude-get-channel",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 500, claude.text);
    assert.equal(claude.body.type, "error");
    const err = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(
      err.message,
      messageWithRequestId(noAvailableChannelRetryMessage("default", "gpt-4o-mini"), "hop353-claude-get-channel"),
    );
    assert.equal(err.code, undefined);
    assert.equal(err.param, undefined);

    await e.DB.prepare(`UPDATE abilities SET enabled = 1 WHERE channel_id = ?`).bind(channelId).run();

    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.168" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 500, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, noAvailableChannelRetryMessage("default", "gpt-4o-mini"));
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_GET_CHANNEL_FAILED);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Relay leftover last-loop gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.169" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.170", "x-oneapi-request-id": "hop353-vendor-create" },
      body: JSON.stringify({ name: "relay-last-loop-vendor", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop353-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});

test("original Relay leftover DoResponse NewError Claude vs OpenAI gin.H", async () => {
  async function assertClaudeEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/messages", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    assert.equal(res.status, status);
    const body = (await res.json()) as { type: string; error: Record<string, unknown> };
    assert.equal(body.type, "error");
    assert.deepEqual(Object.keys(body), ["type", "error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["message", "type"]);
    assert.equal("param" in body.error, false);
    assert.equal("code" in body.error, false);
    assert.deepEqual(body.error, { type: ERROR_TYPE_NEW_API_ERROR, message });
  }

  async function assertOpenAIEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/chat/completions", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    const body = (await res.json()) as { error: Record<string, unknown> };
    assert.equal("type" in body, false);
    assert.deepEqual(body.error, {
      message,
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code,
    });
  }

  await assertClaudeEnvelope(500, "invalid auth", ERROR_CODE_CHANNEL_INVALID_KEY);
  await assertOpenAIEnvelope(500, "invalid auth", ERROR_CODE_CHANNEL_INVALID_KEY);
  await assertClaudeEnvelope(400, "unsupported advanced custom converter: not-a-converter", ERROR_CODE_INVALID_REQUEST);
  await assertOpenAIEnvelope(400, "unsupported advanced custom converter: not-a-converter", ERROR_CODE_INVALID_REQUEST);
  await assertClaudeEnvelope(400, "no audio data in minimax TTS response", "bad_response");
  await assertOpenAIEnvelope(400, "no audio data in minimax TTS response", "bad_response");

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.193" });
  await mergeModelRatio(new Store(e.DB), { "SparkDesk-invalid": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.194" },
      body: JSON.stringify({
        name: "hop356-xunfei-bad",
        type: CHANNEL_TYPE_XUNFEI,
        key: "invalid",
        models: "SparkDesk-invalid",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  // Extra-OK: original Xunfei ConvertClaudeRequest panics "implement me" before DoResponse invalid auth.
  const claude = await send(
    new Request("http://local/v1/messages", {
      method: "POST",
      headers: {
        ...skAuth,
        "cf-connecting-ip": "192.0.2.195",
        "anthropic-version": "2023-06-01",
        "x-oneapi-request-id": "hop356-claude-invalid-auth",
      },
      body: JSON.stringify({
        model: "SparkDesk-invalid",
        max_tokens: 32,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    e,
  );
  assert.equal(claude.res.status, 500, claude.text);
  assert.equal(claude.body.type, "error");
  const err = claude.body.error as { type: string; message: string; code?: string; param?: string };
  assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(err.message, messageWithRequestId("implement me", "hop356-claude-invalid-auth"));
  assert.equal(err.code, undefined);
  assert.equal(err.param, undefined);
  assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);

  const chat = await send(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { ...skAuth, "cf-connecting-ip": "192.0.2.196" },
      body: JSON.stringify({
        model: "SparkDesk-invalid",
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    e,
  );
  assert.equal(chat.res.status, 500, chat.text);
  assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
  const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
  assert.equal(chatErr.message, "invalid auth");
  assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(chatErr.param, "");
  assert.equal(chatErr.code, ERROR_CODE_CHANNEL_INVALID_KEY);
});

test("original leftover Relay DoResponse NewError does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.197" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.198", "x-oneapi-request-id": "hop356-vendor-create" },
      body: JSON.stringify({ name: "hop356-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop356-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});

test("original Relay leftover handleRelay GetAndValidate image/audio NewError Claude vs OpenAI gin.H", async () => {
  async function assertClaudeEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/messages", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    assert.equal(res.status, status);
    const body = (await res.json()) as { type: string; error: Record<string, unknown> };
    assert.equal(body.type, "error");
    assert.deepEqual(Object.keys(body), ["type", "error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["message", "type"]);
    assert.equal("param" in body.error, false);
    assert.equal("code" in body.error, false);
    assert.deepEqual(body.error, { type: ERROR_TYPE_NEW_API_ERROR, message });
  }

  async function assertOpenAIEnvelope(status: number, message: string, code: string) {
    const req = new Request("http://local/v1/chat/completions", { method: "POST" });
    const res = writeRelayNewAPIError(req, status, message, code);
    const body = (await res.json()) as { error: Record<string, unknown> };
    assert.equal("type" in body, false);
    assert.deepEqual(body.error, {
      message,
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code,
    });
  }

  await assertClaudeEnvelope(400, "model is required", ERROR_CODE_INVALID_REQUEST);
  await assertOpenAIEnvelope(400, "model is required", ERROR_CODE_INVALID_REQUEST);
  await assertClaudeEnvelope(400, "invalid stream value: strconv.ParseBool: parsing \"notabool\": invalid syntax", ERROR_CODE_INVALID_REQUEST);
  await assertOpenAIEnvelope(400, "invalid stream value: strconv.ParseBool: parsing \"notabool\": invalid syntax", ERROR_CODE_INVALID_REQUEST);

  resetSchemaFlag();
  const e = env();
  const { sk } = await boot(e, { "cf-connecting-ip": "192.0.2.199" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };

  const audio = await send(
    new Request("http://local/v1/audio/speech", {
      method: "POST",
      headers: {
        ...skAuth,
        "cf-connecting-ip": "192.0.2.200",
        "x-oneapi-request-id": "hop357-audio-missing-model",
      },
      body: JSON.stringify({ input: "hello", voice: "alloy" }),
    }),
    e,
  );
  assert.equal(audio.res.status, 400, audio.text);
  assert.equal("type" in audio.body && audio.body.type === "error", false, audio.text);
  const audioErr = audio.body.error as { message: string; type: string; param: string; code: string };
  assert.equal(audioErr.message, messageWithRequestId("model is required", "hop357-audio-missing-model"));
  assert.equal(audioErr.type, ERROR_TYPE_NEW_API_ERROR);
  assert.equal(audioErr.param, "");
  assert.equal(audioErr.code, ERROR_CODE_INVALID_REQUEST);
});

test("original leftover handleRelay GetAndValidate NewError does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.201" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.202", "x-oneapi-request-id": "hop357-vendor-create" },
      body: JSON.stringify({ name: "hop357-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop357-vendor-create", { headers: auth }),
    e,
  );
  const items = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(items.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover GeminiChatHandler empty-candidates gin.H", async () => {
  const chatReq = new Request("http://local/v1/chat/completions", { method: "POST" });
  const chatEmpty = writeGeminiChatEmptyCandidatesError(chatReq, 500, "empty response from Gemini API", ERROR_CODE_EMPTY_RESPONSE);
  assert.equal(chatEmpty.status, 500);
  const chatEmptyBody = (await chatEmpty.json()) as { error: Record<string, unknown> };
  assert.equal("type" in chatEmptyBody, false);
  assert.deepEqual(chatEmptyBody.error, {
    message: "empty response from Gemini API",
    type: ERROR_CODE_EMPTY_RESPONSE,
    param: "",
    code: ERROR_CODE_EMPTY_RESPONSE,
  });

  const claudeReq = new Request("http://local/v1/messages", { method: "POST" });
  const claudeBlocked = writeGeminiChatEmptyCandidatesError(
    claudeReq,
    400,
    "request blocked by Gemini API: SAFETY",
    ERROR_CODE_PROMPT_BLOCKED,
  );
  assert.equal(claudeBlocked.status, 400);
  const claudeBody = (await claudeBlocked.json()) as { type: string; error: Record<string, unknown> };
  assert.equal(claudeBody.type, "error");
  assert.deepEqual(Object.keys(claudeBody), ["type", "error"]);
  assert.deepEqual(Object.keys(claudeBody.error).sort(), ["message", "type"]);
  assert.equal("param" in claudeBody.error, false);
  assert.equal("code" in claudeBody.error, false);
  assert.deepEqual(claudeBody.error, {
    type: ERROR_CODE_PROMPT_BLOCKED,
    message: "request blocked by Gemini API: SAFETY",
  });

  assert.equal(resetNewAPIErrorStatusCode(500, '{"500":"503"}'), 503);
  assert.equal(resetNewAPIErrorStatusCode(500, '{"500":503}'), 503);
  assert.equal(resetNewAPIErrorStatusCode(400, '{"500":"503"}'), 400);
  assert.deepEqual(geminiChatEmptyCandidatesError({ candidates: [] })?.code, ERROR_CODE_EMPTY_RESPONSE);
  assert.deepEqual(geminiChatEmptyCandidatesError({})?.code, ERROR_CODE_EMPTY_RESPONSE);
  assert.equal(geminiChatEmptyCandidatesError({ candidates: [{ content: {} }] }), null);
  assert.equal(
    geminiChatEmptyCandidatesError({ candidates: [], promptFeedback: { blockReason: "SAFETY" } })?.code,
    ERROR_CODE_PROMPT_BLOCKED,
  );

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.204" });
  await mergeModelRatio(new Store(e.DB), { "gemini-1.0-pro": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.205" },
      body: JSON.stringify({
        name: "hop359-gemini",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-1.0-pro",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return origFetch(input, init);
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("block-me")) {
      return new Response(JSON.stringify({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ candidates: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const empty = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.206", "x-oneapi-request-id": "hop359-chat-empty" },
        body: JSON.stringify({ model: "gemini-1.0-pro", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(empty.res.status, 503, empty.text);
    assert.equal("type" in empty.body && empty.body.type === "error", false, empty.text);
    const emptyErr = empty.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(emptyErr.message, "empty response from Gemini API");
    assert.equal(emptyErr.type, ERROR_CODE_EMPTY_RESPONSE);
    assert.equal(emptyErr.param, "");
    assert.equal(emptyErr.code, ERROR_CODE_EMPTY_RESPONSE);

    const blocked = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.207" },
        body: JSON.stringify({ model: "gemini-1.0-pro", messages: [{ role: "user", content: "block-me" }] }),
      }),
      e,
    );
    assert.equal(blocked.res.status, 400, blocked.text);
    const blockedErr = blocked.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(blockedErr.message, "request blocked by Gemini API: SAFETY");
    assert.equal(blockedErr.type, ERROR_CODE_PROMPT_BLOCKED);
    assert.equal(blockedErr.param, "");
    assert.equal(blockedErr.code, ERROR_CODE_PROMPT_BLOCKED);

    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.208",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop359-claude-empty",
        },
        body: JSON.stringify({
          model: "gemini-1.0-pro",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 503, claude.text);
    assert.equal(claude.body.type, "error");
    const claudeErr = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(claudeErr.type, ERROR_CODE_EMPTY_RESPONSE);
    assert.equal(claudeErr.message, "empty response from Gemini API");
    assert.equal(claudeErr.code, undefined);
    assert.equal(claudeErr.param, undefined);
    assert.deepEqual(Object.keys(claudeErr).sort(), ["message", "type"]);

    const responses = await send(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.209", "x-oneapi-request-id": "hop359-responses-empty" },
        body: JSON.stringify({ model: "gemini-1.0-pro", input: "hi" }),
      }),
      e,
    );
    assert.equal(responses.res.status, 503, responses.text);
    const responsesErr = responses.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(responsesErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(responsesErr.code, ERROR_CODE_EMPTY_RESPONSE);
    assert.equal(responsesErr.param, "");
    assert.equal(responsesErr.message, messageWithRequestId("empty response from Gemini API", "hop359-responses-empty"));

    const native = await send(
      new Request("http://local/v1beta/models/gemini-1.0-pro:generateContent", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.210" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      e,
    );
    assert.equal(native.res.status, 200, native.text);
    assert.deepEqual(native.body.candidates, []);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover GeminiChatHandler gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.211" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.212", "x-oneapi-request-id": "hop359-vendor-create" },
      body: JSON.stringify({ name: "hop359-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop359-vendor-create", { headers: auth }),
    e,
  );
  const vendorItems = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItems.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover GeminiChatHandler Unmarshal BadResponseBody gin.H", async () => {
  const syntax = geminiChatResponseUnmarshalError("not-json");
  assert.equal(syntax, "invalid character 'o' looking for beginning of value");
  assert.equal(
    geminiChatResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type dto.GeminiChatResponse",
  );
  assert.equal(geminiChatResponseUnmarshalError("null"), null);
  assert.equal(geminiChatResponseUnmarshalError("{}"), null);
  assert.equal(geminiChatResponseUnmarshalError('{"candidates":[]}'), null);

  const chatReq = new Request("http://local/v1/chat/completions", {
    method: "POST",
    headers: { "x-oneapi-request-id": "hop360-helper" },
  });
  const chatRes = writeGeminiChatUnmarshalError(chatReq, "invalid character 'o' looking for beginning of value");
  assert.equal(chatRes.status, 500);
  const chatBody = (await chatRes.json()) as { error: Record<string, unknown> };
  assert.equal("type" in chatBody, false);
  assert.deepEqual(chatBody.error, {
    message: messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-helper"),
    type: ERROR_CODE_BAD_RESPONSE_BODY,
    param: "",
    code: ERROR_CODE_BAD_RESPONSE_BODY,
  });

  const claudeReq = new Request("http://local/v1/messages", {
    method: "POST",
    headers: { "x-oneapi-request-id": "hop360-helper-claude" },
  });
  const claudeRes = writeGeminiChatUnmarshalError(claudeReq, "invalid character 'o' looking for beginning of value");
  assert.equal(claudeRes.status, 500);
  const claudeBody = (await claudeRes.json()) as { type: string; error: Record<string, unknown> };
  assert.equal(claudeBody.type, "error");
  assert.deepEqual(Object.keys(claudeBody), ["type", "error"]);
  assert.deepEqual(Object.keys(claudeBody.error).sort(), ["message", "type"]);
  assert.equal("param" in claudeBody.error, false);
  assert.equal("code" in claudeBody.error, false);
  assert.deepEqual(claudeBody.error, {
    type: ERROR_CODE_BAD_RESPONSE_BODY,
    message: messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-helper-claude"),
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.213" });
  await mergeModelRatio(new Store(e.DB), { "gemini-1.0-pro": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.214" },
      body: JSON.stringify({
        name: "hop360-gemini",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-1.0-pro",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("generativelanguage.googleapis.com")) return origFetch(input, init);
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { headers: { "content-type": "application/json" } });
    return new Response("not-json", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.215", "x-oneapi-request-id": "hop360-chat-unmarshal" },
        body: JSON.stringify({ model: "gemini-1.0-pro", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chat.res.status, 500, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-chat-unmarshal"));
    assert.equal(chatErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const arr = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.216", "x-oneapi-request-id": "hop360-chat-array" },
        body: JSON.stringify({ model: "gemini-1.0-pro", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(arr.res.status, 500, arr.text);
    const arrErr = arr.body.error as { message: string; type: string; code: string };
    assert.equal(
      arrErr.message,
      messageWithRequestId("json: cannot unmarshal array into Go value of type dto.GeminiChatResponse", "hop360-chat-array"),
    );
    assert.equal(arrErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(arrErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.217",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop360-claude-unmarshal",
        },
        body: JSON.stringify({
          model: "gemini-1.0-pro",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 500, claude.text);
    assert.equal(claude.body.type, "error");
    const claudeErr = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(claudeErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(
      claudeErr.message,
      messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-claude-unmarshal"),
    );
    assert.equal(claudeErr.code, undefined);
    assert.equal(claudeErr.param, undefined);
    assert.deepEqual(Object.keys(claudeErr).sort(), ["message", "type"]);

    const responses = await send(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.218", "x-oneapi-request-id": "hop360-responses-unmarshal" },
        body: JSON.stringify({ model: "gemini-1.0-pro", input: "hi" }),
      }),
      e,
    );
    assert.equal(responses.res.status, 500, responses.text);
    const responsesErr = responses.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(responsesErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(responsesErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(responsesErr.param, "");
    assert.equal(
      responsesErr.message,
      messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-responses-unmarshal"),
    );

    const native = await send(
      new Request("http://local/v1beta/models/gemini-1.0-pro:generateContent", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.219", "x-oneapi-request-id": "hop360-native-unmarshal" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      e,
    );
    assert.equal(native.res.status, 500, native.text);
    const nativeErr = native.body.error as { message: string; type: string; code: string };
    assert.equal(nativeErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(nativeErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(
      nativeErr.message,
      messageWithRequestId("invalid character 'o' looking for beginning of value", "hop360-native-unmarshal"),
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover GeminiChatHandler Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.220" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.221", "x-oneapi-request-id": "hop360-vendor-create" },
      body: JSON.stringify({ name: "hop360-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop360-vendor-create", { headers: auth }),
    e,
  );
  const vendorItems = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItems.some((item) => item.action === "vendor.create"), listed.text);
});

