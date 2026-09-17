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
  leftoverWithOpenAIError,
  messageWithRequestId,
  getOpenAIError,
  writeOpenaiHandlerOpenAIError,
  writeOpenaiHandlerUnmarshalError,
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
import { aliSiliconflowRerankResponseUnmarshalError, baiduResponseUnmarshalError, cloudflareResponseUnmarshalError, cohereChatResponseUnmarshalError, cohereRerankResponseUnmarshalError, cozeResponseUnmarshalError, difyResponseUnmarshalError, jimengResponseUnmarshalError, mokaResponseUnmarshalError, ollamaResponseUnmarshalError, openaiDoResponseUnmarshalMode, openaiHandlerResponseUnmarshalError, openRouterEnterpriseResponseUnmarshalError, OPENROUTER_ENTERPRISE_SUCCESS_FALSE, palmTencentZhipuResponseUnmarshalError, rerankHandlerResponseUnmarshalError, unwrapOpenRouterEnterpriseResponse, usesAliSiliconflowRerankUnmarshal, usesBaiduUnmarshal, usesCloudflareUnmarshal, usesCohereChatUnmarshal, usesCohereRerankUnmarshal, usesCozeUnmarshal, usesDifyUnmarshal, usesJimengUnmarshal, usesMokaUnmarshal, usesOllamaUnmarshal, usesOpenRouterEnterpriseUnwrap, usesPalmTencentZhipuUnmarshal, usesRerankHandlerUnmarshal, usesReplicateUnmarshal, usesXaiUnmarshal, usesZhipuV4ImageUnmarshal, replicateResponseUnmarshalError, xaiResponseUnmarshalError, zhipuV4ImageResponseUnmarshalError } from "../src/openai-adaptor.js";
import {
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_BAIDU,
  CHANNEL_TYPE_CLOUDFLARE,
  CHANNEL_TYPE_COHERE,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_DIFY,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_JIMENG,
  CHANNEL_TYPE_JINA,
  CHANNEL_TYPE_MINIMAX,
  CHANNEL_TYPE_MOKA,
  CHANNEL_TYPE_OLLAMA,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_OPENROUTER,
  CHANNEL_TYPE_PALM,
  CHANNEL_TYPE_REPLICATE,
  CHANNEL_TYPE_SILICONFLOW,
  CHANNEL_TYPE_TENCENT,
  CHANNEL_TYPE_XAI,
  CHANNEL_TYPE_XINFERENCE,
  CHANNEL_TYPE_XUNFEI,
  CHANNEL_TYPE_ZHIPU,
  CHANNEL_TYPE_ZHIPU_V4,
} from "../src/constants.js";
import { MAX_TOKENS_LIMIT } from "../src/valid-request.js";
import { Store } from "../src/store.js";
import { clearBaiduAccessTokenCache } from "../src/baidu-convert.js";
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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.226", "x-oneapi-request-id": "hop360-vendor-create" },
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

test("original leftover ImageHelper quantity NewError gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.222" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.223" },
      body: JSON.stringify({
        name: "hop361-image",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop361",
        models: "dall-e-3",
        group: "default",
        param_override: JSON.stringify({ n: 129 }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("should-not-fetch");
  }) as typeof fetch;
  try {
    const hit = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.224", "x-oneapi-request-id": "hop361-image-n" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
      }),
      e,
    );
    assert.equal(hit.res.status, 400, hit.text);
    assert.equal(fetched, false);
    assert.equal("type" in hit.body && hit.body.type === "error", false, hit.text);
    const err = hit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(err.message, messageWithRequestId("n must be an integer between 1 and 128", "hop361-image-n"));
    assert.equal(err.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(err.param, "");
    assert.equal(err.code, ERROR_CODE_INVALID_REQUEST);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover ImageHelper quantity gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.225" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.226", "x-oneapi-request-id": "hop361-vendor-create" },
      body: JSON.stringify({ name: "hop361-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop361-vendor-create", { headers: auth }),
    e,
  );
  const vendorItems = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItems.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover image WithOpenAIError gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.227" });
  await mergeModelRatio(new Store(e.DB), {
    "image-01": 1,
    "jimeng_high_aes_general_v21_L": 1,
    "cogview-3": 1,
  });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const minimax = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.228" },
      body: JSON.stringify({
        name: "hop362-minimax",
        type: CHANNEL_TYPE_MINIMAX,
        key: "mk-hop362",
        models: "image-01",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(minimax.body.success, true, minimax.text);
  const jimeng = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.229" },
      body: JSON.stringify({
        name: "hop362-jimeng",
        type: CHANNEL_TYPE_JIMENG,
        key: "ak|sk",
        models: "jimeng_high_aes_general_v21_L",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(jimeng.body.success, true, jimeng.text);
  const zhipu = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.230" },
      body: JSON.stringify({
        name: "hop362-zhipu",
        type: CHANNEL_TYPE_ZHIPU_V4,
        key: "sk-z-hop362",
        models: "cogview-3",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(zhipu.body.success, true, zhipu.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/image_generation")) {
      return new Response(
        JSON.stringify({ base_resp: { status_code: 1002, status_msg: "sensitive content" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("visual.volcengineapi.com")) {
      return new Response(JSON.stringify({ code: 50429, message: "quota exceeded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/paas/v4/images/generations")) {
      return new Response(JSON.stringify({ error: { code: "1234", message: "sensitive content" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input);
  }) as typeof fetch;
  try {
    const mm = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.231", "x-oneapi-request-id": "hop362-minimax-image" },
        body: JSON.stringify({ model: "image-01", prompt: "a cat", n: 1 }),
      }),
      e,
    );
    assert.equal(mm.res.status, 200, mm.text);
    assert.equal("type" in mm.body && mm.body.type === "error", false, mm.text);
    const mmErr = mm.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(mmErr.message, "sensitive content");
    assert.equal(mmErr.message.includes("hop362-minimax-image"), false);
    assert.equal(mmErr.type, "minimax_image_error");
    assert.equal(mmErr.param, "");
    assert.equal(mmErr.code, "1002");

    const jm = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.232", "x-oneapi-request-id": "hop362-jimeng-image" },
        body: JSON.stringify({ model: "jimeng_high_aes_general_v21_L", prompt: "a mountain" }),
      }),
      e,
    );
    assert.equal(jm.res.status, 200, jm.text);
    assert.equal("type" in jm.body && jm.body.type === "error", false, jm.text);
    const jmErr = jm.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(jmErr.message, "quota exceeded");
    assert.equal(jmErr.message.includes("hop362-jimeng-image"), false);
    assert.equal(jmErr.type, "jimeng_error");
    assert.equal(jmErr.param, "");
    assert.equal(jmErr.code, "50429");

    const zp = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.233", "x-oneapi-request-id": "hop362-zhipu-image" },
        body: JSON.stringify({ model: "cogview-3", prompt: "blocked" }),
      }),
      e,
    );
    assert.equal(zp.res.status, 200, zp.text);
    assert.equal("type" in zp.body && zp.body.type === "error", false, zp.text);
    const zpErr = zp.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(zpErr.message, "sensitive content");
    assert.equal(zpErr.message.includes("hop362-zhipu-image"), false);
    assert.equal(zpErr.type, "zhipu_image_error");
    assert.equal(zpErr.param, "");
    assert.equal(zpErr.code, "1234");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover image WithOpenAIError gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.234" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.235", "x-oneapi-request-id": "hop362-vendor-create" },
      body: JSON.stringify({ name: "hop362-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop362-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop362 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop362.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover chat WithOpenAIError gin.H", async () => {
  const empty = leftoverWithOpenAIError(200, "", 0);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {
    error: { message: "openai_error", type: "upstream_error", param: "", code: 0 },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.236" });
  await mergeModelRatio(new Store(e.DB), { "PaLM-2": 1, "hunyuan-lite": 1, chatglm_std: 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const palm = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.237" },
      body: JSON.stringify({
        name: "hop363-palm",
        type: CHANNEL_TYPE_PALM,
        key: "palm-key",
        models: "PaLM-2",
        group: "default",
        base_url: "https://generativelanguage.googleapis.com",
      }),
    }),
    e,
  );
  assert.equal(palm.body.success, true, palm.text);
  const tencent = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.238" },
      body: JSON.stringify({
        name: "hop363-tencent",
        type: CHANNEL_TYPE_TENCENT,
        key: "1300000000|AKIDxxxxxxxx|secretxxxxxxxx",
        models: "hunyuan-lite",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(tencent.body.success, true, tencent.text);
  const zhipu = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.239" },
      body: JSON.stringify({
        name: "hop363-zhipu",
        type: CHANNEL_TYPE_ZHIPU,
        key: "id.secret",
        models: "chatglm_std",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(zhipu.body.success, true, zhipu.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("chat-bison-001:generateMessage")) {
      return new Response(
        JSON.stringify({
          error: { code: 3, message: "blocked", status: "PERMISSION_DENIED" },
          candidates: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://hunyuan.tencentcloudapi.com/") {
      return new Response(
        JSON.stringify({ Response: { Error: { Code: 4000, Message: "invalid hunyuan" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/paas/v3/model-api/")) {
      return new Response(JSON.stringify({ success: false, msg: "quota", code: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input);
  }) as typeof fetch;
  try {
    const palmHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.240", "x-oneapi-request-id": "hop363-palm-chat" },
        body: JSON.stringify({ model: "PaLM-2", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(palmHit.res.status, 200, palmHit.text);
    assert.equal("type" in palmHit.body && palmHit.body.type === "error", false, palmHit.text);
    const palmErr = palmHit.body.error as { message: string; type: string; param: string; code: number };
    assert.equal(palmErr.message, "blocked");
    assert.equal(palmErr.message.includes("hop363-palm-chat"), false);
    assert.equal(palmErr.type, "PERMISSION_DENIED");
    assert.equal(palmErr.param, "");
    assert.equal(palmErr.code, 3);
    assert.equal(typeof palmErr.code, "number");

    const tencentHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.241", "x-oneapi-request-id": "hop363-tencent-chat" },
        body: JSON.stringify({ model: "hunyuan-lite", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(tencentHit.res.status, 200, tencentHit.text);
    const tencentErr = tencentHit.body.error as { message: string; type: string; param: string; code: number };
    assert.equal(tencentErr.message, "invalid hunyuan");
    assert.equal(tencentErr.message.includes("hop363-tencent-chat"), false);
    assert.equal(tencentErr.type, "upstream_error");
    assert.equal(tencentErr.param, "");
    assert.equal(tencentErr.code, 4000);
    assert.equal(typeof tencentErr.code, "number");

    const zhipuHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.242", "x-oneapi-request-id": "hop363-zhipu-chat" },
        body: JSON.stringify({ model: "chatglm_std", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(zhipuHit.res.status, 200, zhipuHit.text);
    const zhipuErr = zhipuHit.body.error as { message: string; type: string; param: string; code: number };
    assert.equal(zhipuErr.message, "quota");
    assert.equal(zhipuErr.message.includes("hop363-zhipu-chat"), false);
    assert.equal(zhipuErr.type, "upstream_error");
    assert.equal(zhipuErr.param, "");
    assert.equal(zhipuErr.code, 1);
    assert.equal(typeof zhipuErr.code, "number");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover chat WithOpenAIError gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.243" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.244", "x-oneapi-request-id": "hop363-vendor-create" },
      body: JSON.stringify({ name: "hop363-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop363-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop363 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop363.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover OpenaiHandler GetOpenAIError gin.H", async () => {
  assert.equal(getOpenAIError(null), null);
  assert.deepEqual(getOpenAIError("oops"), { type: "error", message: "oops", param: "", code: undefined });
  const mapped = getOpenAIError({
    message: "content filter",
    type: "invalid_request_error",
    code: "content_filter",
    param: "prompt",
  });
  assert.deepEqual(mapped, {
    message: "content filter",
    type: "invalid_request_error",
    param: "prompt",
    code: "content_filter",
  });
  const emptyType = getOpenAIError({ message: "fail", type: "" });
  assert.equal(emptyType?.type, "");

  const chatHelper = writeOpenaiHandlerOpenAIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop364-helper" } }),
    200,
    { message: "content filter", type: "invalid_request_error", param: "prompt", code: "content_filter" },
  );
  assert.equal(chatHelper.status, 200);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "content filter",
      type: "invalid_request_error",
      param: "prompt",
      code: "content_filter",
    },
  });
  const claudeHelper = writeOpenaiHandlerOpenAIError(
    new Request("http://local/v1/messages", { headers: { "x-oneapi-request-id": "hop364-helper-claude" } }),
    200,
    { message: "content filter", type: "invalid_request_error", param: "prompt", code: "content_filter" },
  );
  assert.equal(claudeHelper.status, 200);
  assert.deepEqual(await claudeHelper.json(), {
    type: "error",
    error: { type: "content_filter", message: messageWithRequestId("content filter", "hop364-helper-claude") },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.245" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.246" },
      body: JSON.stringify({
        name: "hop364-openai",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop364",
        models: "gpt-4o,dall-e-3",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          message: "content filter",
          type: "invalid_request_error",
          code: "content_filter",
          param: "prompt",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.247", "x-oneapi-request-id": "hop364-chat-oai" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "content filter");
    assert.equal(chatErr.message.includes("hop364-chat-oai"), false);
    assert.equal(chatErr.type, "invalid_request_error");
    assert.equal(chatErr.param, "prompt");
    assert.equal(chatErr.code, "content_filter");

    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.248",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop364-claude-oai",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.equal(claude.body.type, "error");
    const claudeErr = claude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(claudeErr.type, "content_filter");
    assert.equal(claudeErr.message, messageWithRequestId("content filter", "hop364-claude-oai"));
    assert.equal(claudeErr.code, undefined);
    assert.equal(claudeErr.param, undefined);
    assert.deepEqual(Object.keys(claudeErr).sort(), ["message", "type"]);

    const images = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.249", "x-oneapi-request-id": "hop364-image-oai" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(images.res.status, 200, images.text);
    const imagesErr = images.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(imagesErr.message, "content filter");
    assert.equal(imagesErr.message.includes("hop364-image-oai"), false);
    assert.equal(imagesErr.type, "invalid_request_error");
    assert.equal(imagesErr.param, "prompt");
    assert.equal(imagesErr.code, "content_filter");

    const responses = await send(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.250", "x-oneapi-request-id": "hop364-responses-oai" },
        body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
      }),
      e,
    );
    assert.equal(responses.res.status, 200, responses.text);
    const responsesErr = responses.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(responsesErr.message, "content filter");
    assert.equal(responsesErr.message.includes("hop364-responses-oai"), false);
    assert.equal(responsesErr.type, "invalid_request_error");
    assert.equal(responsesErr.param, "prompt");
    assert.equal(responsesErr.code, "content_filter");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover OpenaiHandler GetOpenAIError gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.251" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.252", "x-oneapi-request-id": "hop364-vendor-create" },
      body: JSON.stringify({ name: "hop364-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop364-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop364 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop364.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover OpenaiHandler Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(openaiHandlerResponseUnmarshalError("not-json", "chat"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", "chat"),
    "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse",
  );
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", "images"),
    "json: cannot unmarshal array into Go value of type dto.SimpleResponse",
  );
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", "responses"),
    "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesResponse",
  );
  assert.equal(openaiHandlerResponseUnmarshalError("null", "chat"), null);
  assert.equal(openaiHandlerResponseUnmarshalError("{}", "chat"), null);

  const chatHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop365-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });
  const claudeHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/messages", { headers: { "x-oneapi-request-id": "hop365-helper-claude" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(claudeHelper.status, 500);
  assert.deepEqual(await claudeHelper.json(), {
    type: "error",
    error: {
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      message: messageWithRequestId("invalid character 'o' looking for beginning of value", "hop365-helper-claude"),
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.10" });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.11" },
      body: JSON.stringify({
        name: "hop365-openai",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop365",
        models: "gpt-4o,dall-e-3",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.12", "x-oneapi-request-id": "hop365-chat-unmarshal" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chat.res.status, 500, chat.text);
    assert.equal("type" in chat.body && chat.body.type === "error", false, chat.text);
    const chatErr = chat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(chatErr.message.includes("hop365-chat-unmarshal"), false);
    assert.equal(chatErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const asArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.13", "x-oneapi-request-id": "hop365-chat-array" },
        body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(asArray.res.status, 500, asArray.text);
    const arrayErr = asArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(arrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse");
    assert.equal(arrayErr.message.includes("hop365-chat-array"), false);
    assert.equal(arrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(arrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const claude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.14",
          "anthropic-version": "2023-06-01",
          "x-oneapi-request-id": "hop365-claude-unmarshal",
        },
        body: JSON.stringify({
          model: "gpt-4o",
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
      messageWithRequestId("invalid character 'o' looking for beginning of value", "hop365-claude-unmarshal"),
    );
    assert.equal(claudeErr.code, undefined);
    assert.equal(claudeErr.param, undefined);

    const images = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.15", "x-oneapi-request-id": "hop365-image-array" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "as-array" }),
      }),
      e,
    );
    assert.equal(images.res.status, 500, images.text);
    const imagesErr = images.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(imagesErr.message, "json: cannot unmarshal array into Go value of type dto.SimpleResponse");
    assert.equal(imagesErr.message.includes("hop365-image-array"), false);
    assert.equal(imagesErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(imagesErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const responses = await send(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.16", "x-oneapi-request-id": "hop365-responses-unmarshal" },
        body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
      }),
      e,
    );
    assert.equal(responses.res.status, 500, responses.text);
    const responsesErr = responses.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(responsesErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(responsesErr.message.includes("hop365-responses-unmarshal"), false);
    assert.equal(responsesErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(responsesErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover OpenaiHandler Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.17" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.18", "x-oneapi-request-id": "hop365-vendor-create" },
      body: JSON.stringify({ name: "hop365-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop365-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop365 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop365.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover RerankHandler Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_OPENAI, "rerank"), true);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_XINFERENCE, "rerank"), true);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_JINA, "rerank"), true);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_ALI, "rerank"), false);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_SILICONFLOW, "rerank"), false);
  assert.equal(usesRerankHandlerUnmarshal(CHANNEL_TYPE_COHERE, "rerank"), false);
  assert.equal(rerankHandlerResponseUnmarshalError("not-json", CHANNEL_TYPE_OPENAI), "invalid character 'o' looking for beginning of value");
  assert.equal(
    rerankHandlerResponseUnmarshalError("[]", CHANNEL_TYPE_OPENAI),
    "json: cannot unmarshal array into Go value of type dto.RerankResponse",
  );
  assert.equal(
    rerankHandlerResponseUnmarshalError("[]", CHANNEL_TYPE_JINA),
    "json: cannot unmarshal array into Go value of type dto.RerankResponse",
  );
  assert.equal(
    rerankHandlerResponseUnmarshalError("[]", CHANNEL_TYPE_XINFERENCE),
    "json: cannot unmarshal array into Go value of type xinference.XinRerankResponse",
  );
  assert.equal(rerankHandlerResponseUnmarshalError("null", CHANNEL_TYPE_OPENAI), null);
  assert.equal(rerankHandlerResponseUnmarshalError("{}", CHANNEL_TYPE_OPENAI), null);

  const rerankHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/rerank", { headers: { "x-oneapi-request-id": "hop366-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(rerankHelper.status, 500);
  assert.deepEqual(await rerankHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.30" });
  await mergeModelRatio(new Store(e.DB), {
    "jina-reranker-v2-base-multilingual": 1,
    "hop366-xin-rerank": 1,
  });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const openaiCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.31" },
      body: JSON.stringify({
        name: "hop366-openai-rerank",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop366",
        models: "gpt-4o",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(openaiCh.body.success, true, openaiCh.text);
  const jinaCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.32" },
      body: JSON.stringify({
        name: "hop366-jina-rerank",
        type: CHANNEL_TYPE_JINA,
        key: "jina-hop366",
        models: "jina-reranker-v2-base-multilingual",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(jinaCh.body.success, true, jinaCh.text);
  const xinCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.33" },
      body: JSON.stringify({
        name: "hop366-xinference-rerank",
        type: CHANNEL_TYPE_XINFERENCE,
        key: "xin-hop366",
        models: "hop366-xin-rerank",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(xinCh.body.success, true, xinCh.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const openaiRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.34", "x-oneapi-request-id": "hop366-openai-unmarshal" },
        body: JSON.stringify({ model: "gpt-4o", query: "hi", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(openaiRerank.res.status, 500, openaiRerank.text);
    assert.equal("type" in openaiRerank.body && openaiRerank.body.type === "error", false, openaiRerank.text);
    const openaiErr = openaiRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(openaiErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(openaiErr.message.includes("hop366-openai-unmarshal"), false);
    assert.equal(openaiErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(openaiErr.param, "");
    assert.equal(openaiErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const asArray = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.35", "x-oneapi-request-id": "hop366-openai-array" },
        body: JSON.stringify({ model: "gpt-4o", query: "as-array", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(asArray.res.status, 500, asArray.text);
    const arrayErr = asArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(arrayErr.message, "json: cannot unmarshal array into Go value of type dto.RerankResponse");
    assert.equal(arrayErr.message.includes("hop366-openai-array"), false);
    assert.equal(arrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(arrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const jinaRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.36", "x-oneapi-request-id": "hop366-jina-unmarshal" },
        body: JSON.stringify({ model: "jina-reranker-v2-base-multilingual", query: "hi", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(jinaRerank.res.status, 500, jinaRerank.text);
    const jinaErr = jinaRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(jinaErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(jinaErr.message.includes("hop366-jina-unmarshal"), false);
    assert.equal(jinaErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(jinaErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const xinRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.37", "x-oneapi-request-id": "hop366-xin-array" },
        body: JSON.stringify({ model: "hop366-xin-rerank", query: "as-array", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(xinRerank.res.status, 500, xinRerank.text);
    const xinErr = xinRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(xinErr.message, "json: cannot unmarshal array into Go value of type xinference.XinRerankResponse");
    assert.equal(xinErr.message.includes("hop366-xin-array"), false);
    assert.equal(xinErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(xinErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover RerankHandler Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.38" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.39", "x-oneapi-request-id": "hop366-vendor-create" },
      body: JSON.stringify({ name: "hop366-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop366-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop366 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop366.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Ali/Siliconflow rerank Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesAliSiliconflowRerankUnmarshal(CHANNEL_TYPE_ALI, "rerank"), true);
  assert.equal(usesAliSiliconflowRerankUnmarshal(CHANNEL_TYPE_SILICONFLOW, "rerank"), true);
  assert.equal(usesAliSiliconflowRerankUnmarshal(CHANNEL_TYPE_OPENAI, "rerank"), false);
  assert.equal(usesAliSiliconflowRerankUnmarshal(CHANNEL_TYPE_COHERE, "rerank"), false);
  assert.equal(usesAliSiliconflowRerankUnmarshal(CHANNEL_TYPE_ALI, "chat"), false);
  assert.equal(aliSiliconflowRerankResponseUnmarshalError("not-json", CHANNEL_TYPE_ALI), "invalid character 'o' looking for beginning of value");
  assert.equal(
    aliSiliconflowRerankResponseUnmarshalError("[]", CHANNEL_TYPE_ALI),
    "json: cannot unmarshal array into Go value of type ali.AliRerankResponse",
  );
  assert.equal(
    aliSiliconflowRerankResponseUnmarshalError("[]", CHANNEL_TYPE_SILICONFLOW),
    "json: cannot unmarshal array into Go value of type siliconflow.SFRerankResponse",
  );
  assert.equal(aliSiliconflowRerankResponseUnmarshalError("null", CHANNEL_TYPE_ALI), null);
  assert.equal(aliSiliconflowRerankResponseUnmarshalError("{}", CHANNEL_TYPE_ALI), null);

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.40" });
  await mergeModelRatio(new Store(e.DB), {
    "gte-rerank-v2": 1,
    "BAAI/bge-reranker-v2-m3": 1,
  });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const aliCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.41" },
      body: JSON.stringify({
        name: "hop367-ali-rerank",
        type: CHANNEL_TYPE_ALI,
        key: "sk-hop367-ali",
        models: "gte-rerank-v2",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(aliCh.body.success, true, aliCh.text);
  const sfCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.42" },
      body: JSON.stringify({
        name: "hop367-sf-rerank",
        type: CHANNEL_TYPE_SILICONFLOW,
        key: "sf-hop367",
        models: "BAAI/bge-reranker-v2-m3",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(sfCh.body.success, true, sfCh.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const aliRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.43", "x-oneapi-request-id": "hop367-ali-unmarshal" },
        body: JSON.stringify({ model: "gte-rerank-v2", query: "hi", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(aliRerank.res.status, 500, aliRerank.text);
    assert.equal("type" in aliRerank.body && aliRerank.body.type === "error", false, aliRerank.text);
    const aliErr = aliRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(aliErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(aliErr.message.includes("hop367-ali-unmarshal"), false);
    assert.equal(aliErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(aliErr.param, "");
    assert.equal(aliErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const aliArray = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.44", "x-oneapi-request-id": "hop367-ali-array" },
        body: JSON.stringify({ model: "gte-rerank-v2", query: "as-array", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(aliArray.res.status, 500, aliArray.text);
    const aliArrayErr = aliArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(aliArrayErr.message, "json: cannot unmarshal array into Go value of type ali.AliRerankResponse");
    assert.equal(aliArrayErr.message.includes("hop367-ali-array"), false);
    assert.equal(aliArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(aliArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const sfRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.45", "x-oneapi-request-id": "hop367-sf-unmarshal" },
        body: JSON.stringify({ model: "BAAI/bge-reranker-v2-m3", query: "hi", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(sfRerank.res.status, 500, sfRerank.text);
    const sfErr = sfRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(sfErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(sfErr.message.includes("hop367-sf-unmarshal"), false);
    assert.equal(sfErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(sfErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const sfArray = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.46", "x-oneapi-request-id": "hop367-sf-array" },
        body: JSON.stringify({ model: "BAAI/bge-reranker-v2-m3", query: "as-array", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(sfArray.res.status, 500, sfArray.text);
    const sfArrayErr = sfArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(sfArrayErr.message, "json: cannot unmarshal array into Go value of type siliconflow.SFRerankResponse");
    assert.equal(sfArrayErr.message.includes("hop367-sf-array"), false);
    assert.equal(sfArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(sfArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Ali/Siliconflow rerank Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.47" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.48", "x-oneapi-request-id": "hop367-vendor-create" },
      body: JSON.stringify({ name: "hop367-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop367-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop367 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop367.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Cohere rerank Unmarshal NewError gin.H", async () => {
  assert.equal(usesCohereRerankUnmarshal(CHANNEL_TYPE_COHERE, "rerank"), true);
  assert.equal(usesCohereRerankUnmarshal(CHANNEL_TYPE_OPENAI, "rerank"), false);
  assert.equal(usesCohereRerankUnmarshal(CHANNEL_TYPE_ALI, "rerank"), false);
  assert.equal(usesCohereRerankUnmarshal(CHANNEL_TYPE_COHERE, "chat"), false);
  assert.equal(cohereRerankResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    cohereRerankResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type cohere.CohereRerankResponseResult",
  );
  assert.equal(cohereRerankResponseUnmarshalError("null"), null);
  assert.equal(cohereRerankResponseUnmarshalError("{}"), null);

  const rerankHelper = writeRelayNewAPIError(
    new Request("http://local/v1/rerank", { headers: { "x-oneapi-request-id": "hop368-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(rerankHelper.status, 500);
  assert.deepEqual(await rerankHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop368-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });
  const rerankHelperNoRid = writeRelayNewAPIError(
    new Request("http://local/v1/rerank"),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.deepEqual(await rerankHelperNoRid.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.60" });
  await mergeModelRatio(new Store(e.DB), { "hop368-cohere-rerank": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const cohereCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.61" },
      body: JSON.stringify({
        name: "hop368-cohere-rerank",
        type: CHANNEL_TYPE_COHERE,
        key: "ck-hop368",
        models: "hop368-cohere-rerank",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(cohereCh.body.success, true, cohereCh.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cohereRerank = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.62", "x-oneapi-request-id": "hop368-cohere-unmarshal" },
        body: JSON.stringify({ model: "hop368-cohere-rerank", query: "hi", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(cohereRerank.res.status, 500, cohereRerank.text);
    assert.equal("type" in cohereRerank.body && cohereRerank.body.type === "error", false, cohereRerank.text);
    const cohereErr = cohereRerank.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(cohereErr.message, "invalid character 'o' looking for beginning of value (request id: hop368-cohere-unmarshal)");
    assert.equal(cohereErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(cohereErr.param, "");
    assert.equal(cohereErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const cohereArray = await send(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.63", "x-oneapi-request-id": "hop368-cohere-array" },
        body: JSON.stringify({ model: "hop368-cohere-rerank", query: "as-array", documents: ["a"] }),
      }),
      e,
    );
    assert.equal(cohereArray.res.status, 500, cohereArray.text);
    const cohereArrayErr = cohereArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(
      cohereArrayErr.message,
      "json: cannot unmarshal array into Go value of type cohere.CohereRerankResponseResult (request id: hop368-cohere-array)",
    );
    assert.equal(cohereArrayErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(cohereArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Cohere rerank Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.64" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.65", "x-oneapi-request-id": "hop368-vendor-create" },
      body: JSON.stringify({ name: "hop368-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop368-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop368 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop368.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Cohere chat Unmarshal NewError gin.H", async () => {
  assert.equal(usesCohereChatUnmarshal(CHANNEL_TYPE_COHERE, "chat"), true);
  assert.equal(usesCohereChatUnmarshal(CHANNEL_TYPE_COHERE, "rerank"), false);
  assert.equal(usesCohereChatUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(usesCohereChatUnmarshal(CHANNEL_TYPE_ALI, "chat"), false);
  assert.equal(cohereChatResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    cohereChatResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type cohere.CohereResponseResult",
  );
  assert.equal(cohereChatResponseUnmarshalError("null"), null);
  assert.equal(cohereChatResponseUnmarshalError("{}"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop369-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop369-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });
  const chatHelperNoRid = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions"),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.deepEqual(await chatHelperNoRid.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.70" });
  await mergeModelRatio(new Store(e.DB), { "hop369-cohere-chat": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const cohereCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.71" },
      body: JSON.stringify({
        name: "hop369-cohere-chat",
        type: CHANNEL_TYPE_COHERE,
        key: "ck-hop369",
        models: "hop369-cohere-chat",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(cohereCh.body.success, true, cohereCh.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const cohereChat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.72", "x-oneapi-request-id": "hop369-cohere-unmarshal" },
        body: JSON.stringify({ model: "hop369-cohere-chat", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(cohereChat.res.status, 500, cohereChat.text);
    assert.equal("type" in cohereChat.body && cohereChat.body.type === "error", false, cohereChat.text);
    const cohereErr = cohereChat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(cohereErr.message, "invalid character 'o' looking for beginning of value (request id: hop369-cohere-unmarshal)");
    assert.equal(cohereErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(cohereErr.param, "");
    assert.equal(cohereErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const cohereArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.73", "x-oneapi-request-id": "hop369-cohere-array" },
        body: JSON.stringify({ model: "hop369-cohere-chat", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(cohereArray.res.status, 500, cohereArray.text);
    const cohereArrayErr = cohereArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(
      cohereArrayErr.message,
      "json: cannot unmarshal array into Go value of type cohere.CohereResponseResult (request id: hop369-cohere-array)",
    );
    assert.equal(cohereArrayErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(cohereArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Cohere chat Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.74" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.75", "x-oneapi-request-id": "hop369-vendor-create" },
      body: JSON.stringify({ name: "hop369-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop369-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop369 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop369.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover OpenRouter enterprise unwrap NewOpenAIError gin.H", async () => {
  const enterpriseSettings = JSON.stringify({ openrouter_enterprise: true });
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, enterpriseSettings, "chat"), true);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, enterpriseSettings, "completions"), true);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, JSON.stringify({ openrouter_enterprise: false }), "chat"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, "{}", "chat"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, "", "chat"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENAI, enterpriseSettings, "chat"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, enterpriseSettings, "images"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, enterpriseSettings, "responses"), false);
  assert.equal(usesOpenRouterEnterpriseUnwrap(CHANNEL_TYPE_OPENROUTER, enterpriseSettings, "rerank"), false);
  assert.equal(openRouterEnterpriseResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    openRouterEnterpriseResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type openrouter.OpenRouterEnterpriseResponse",
  );
  assert.equal(openRouterEnterpriseResponseUnmarshalError("null"), null);
  assert.equal(openRouterEnterpriseResponseUnmarshalError("{}"), null);
  assert.deepEqual(unwrapOpenRouterEnterpriseResponse("null"), { ok: false, message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE });
  assert.deepEqual(unwrapOpenRouterEnterpriseResponse("{}"), { ok: false, message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE });
  assert.deepEqual(unwrapOpenRouterEnterpriseResponse('{"success":false}'), { ok: false, message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE });
  assert.deepEqual(unwrapOpenRouterEnterpriseResponse('{"success":true}'), { ok: true, body: "" });
  assert.deepEqual(unwrapOpenRouterEnterpriseResponse('{"success":true,"data":null}'), { ok: true, body: "null" });
  const notJsonUnwrap = unwrapOpenRouterEnterpriseResponse("not-json");
  assert.equal(notJsonUnwrap.ok, false);
  const arrayUnwrap = unwrapOpenRouterEnterpriseResponse("[]");
  assert.equal(arrayUnwrap.ok, false);
  if (!arrayUnwrap.ok) {
    assert.equal(
      arrayUnwrap.message,
      "json: cannot unmarshal array into Go value of type openrouter.OpenRouterEnterpriseResponse",
    );
  }

  const chatHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop370-helper" } }),
    OPENROUTER_ENTERPRISE_SUCCESS_FALSE,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: OPENROUTER_ENTERPRISE_SUCCESS_FALSE,
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });
  const claudeHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/messages", { headers: { "x-oneapi-request-id": "hop370-helper-claude" } }),
    OPENROUTER_ENTERPRISE_SUCCESS_FALSE,
  );
  assert.equal(claudeHelper.status, 500);
  assert.deepEqual(await claudeHelper.json(), {
    type: "error",
    error: {
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      message: messageWithRequestId(OPENROUTER_ENTERPRISE_SUCCESS_FALSE, "hop370-helper-claude"),
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.80" });
  await mergeModelRatio(new Store(e.DB), { "hop370-or-chat": 1, "hop370-or-plain": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const enterpriseCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.81" },
      body: JSON.stringify({
        name: "hop370-or-enterprise",
        type: CHANNEL_TYPE_OPENROUTER,
        key: "or-hop370-ent",
        models: "hop370-or-chat",
        group: "default",
        settings: enterpriseSettings,
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(enterpriseCh.body.success, true, enterpriseCh.text);
  const plainCh = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.82" },
      body: JSON.stringify({
        name: "hop370-or-plain",
        type: CHANNEL_TYPE_OPENROUTER,
        key: "or-hop370-plain",
        models: "hop370-or-plain",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(plainCh.body.success, true, plainCh.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("unwrap-ok")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "chatcmpl-hop370",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "unwrapped" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (raw.includes("fail-enterprise")) {
      return new Response(JSON.stringify({ success: false, data: { error: "nope" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (raw.includes("inner-array")) {
      return new Response(JSON.stringify({ success: true, data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const notJson = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.83", "x-oneapi-request-id": "hop370-or-unmarshal" },
        body: JSON.stringify({ model: "hop370-or-chat", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(notJson.res.status, 500, notJson.text);
    assert.equal("type" in notJson.body && notJson.body.type === "error", false, notJson.text);
    const notJsonErr = notJson.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(notJsonErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(notJsonErr.message.includes("hop370-or-unmarshal"), false);
    assert.equal(notJsonErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(notJsonErr.param, "");
    assert.equal(notJsonErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const asArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.84", "x-oneapi-request-id": "hop370-or-array" },
        body: JSON.stringify({ model: "hop370-or-chat", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(asArray.res.status, 500, asArray.text);
    const asArrayErr = asArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(
      asArrayErr.message,
      "json: cannot unmarshal array into Go value of type openrouter.OpenRouterEnterpriseResponse",
    );
    assert.equal(asArrayErr.message.includes("hop370-or-array"), false);
    assert.equal(asArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(asArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const failEnt = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.85", "x-oneapi-request-id": "hop370-or-false" },
        body: JSON.stringify({ model: "hop370-or-chat", messages: [{ role: "user", content: "fail-enterprise" }] }),
      }),
      e,
    );
    assert.equal(failEnt.res.status, 500, failEnt.text);
    const failErr = failEnt.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(failErr.message, OPENROUTER_ENTERPRISE_SUCCESS_FALSE);
    assert.equal(failErr.message.includes("hop370-or-false"), false);
    assert.equal(failErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(failErr.param, "");
    assert.equal(failErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const innerArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.86", "x-oneapi-request-id": "hop370-or-inner-array" },
        body: JSON.stringify({ model: "hop370-or-chat", messages: [{ role: "user", content: "inner-array" }] }),
      }),
      e,
    );
    assert.equal(innerArray.res.status, 500, innerArray.text);
    const innerArrayErr = innerArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(innerArrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse");
    assert.equal(innerArrayErr.message.includes("hop370-or-inner-array"), false);
    assert.equal(innerArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(innerArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const unwrapped = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.87", "x-oneapi-request-id": "hop370-or-ok" },
        body: JSON.stringify({ model: "hop370-or-chat", messages: [{ role: "user", content: "unwrap-ok" }] }),
      }),
      e,
    );
    assert.equal(unwrapped.res.status, 200, unwrapped.text);
    const choices = (unwrapped.body as { choices?: { message?: { content?: string } }[] }).choices || [];
    assert.equal(choices[0]?.message?.content, "unwrapped");

    const plainArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.88", "x-oneapi-request-id": "hop370-or-plain-array" },
        body: JSON.stringify({ model: "hop370-or-plain", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(plainArray.res.status, 500, plainArray.text);
    const plainArrayErr = plainArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(plainArrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse");
    assert.equal(plainArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(plainArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover OpenRouter enterprise unwrap gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.89" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.90", "x-oneapi-request-id": "hop370-vendor-create" },
      body: JSON.stringify({ name: "hop370-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop370-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop370 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop370.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover OaiResponsesToChatHandler Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(openaiDoResponseUnmarshalMode("chat"), "chat");
  assert.equal(openaiDoResponseUnmarshalMode("chat", true), "responses");
  assert.equal(openaiDoResponseUnmarshalMode("images", true), "responses");
  assert.equal(openaiDoResponseUnmarshalMode("responses", false), "responses");
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", openaiDoResponseUnmarshalMode("chat", true)),
    "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesResponse",
  );
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", openaiDoResponseUnmarshalMode("chat", false)),
    "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse",
  );
  assert.equal(openaiHandlerResponseUnmarshalError("null", openaiDoResponseUnmarshalMode("chat", true)), null);

  const chatHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop371-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });
  const claudeHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/messages", { headers: { "x-oneapi-request-id": "hop371-helper-claude" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(claudeHelper.status, 500);
  assert.deepEqual(await claudeHelper.json(), {
    type: "error",
    error: {
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      message: messageWithRequestId("invalid character 'o' looking for beginning of value", "hop371-helper-claude"),
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.91" });
  await mergeModelRatio(new Store(e.DB), { "hop371-via-chat": 1, "hop371-plain": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const policy = await send(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.92" },
      body: JSON.stringify({
        key: "global.chat_completions_to_responses_policy",
        value: JSON.stringify({ enabled: true, all_channels: true, model_patterns: ["^hop371-via-chat$"] }),
      }),
    }),
    e,
  );
  assert.equal(policy.body.success, true, policy.text);
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.93" },
      body: JSON.stringify({
        name: "hop371-via",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop371",
        models: "hop371-via-chat,hop371-plain",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const viaChat = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.94", "x-oneapi-request-id": "hop371-via-unmarshal" },
        body: JSON.stringify({ model: "hop371-via-chat", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(viaChat.res.status, 500, viaChat.text);
    assert.equal("type" in viaChat.body && viaChat.body.type === "error", false, viaChat.text);
    const viaErr = viaChat.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(viaErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(viaErr.message.includes("hop371-via-unmarshal"), false);
    assert.equal(viaErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(viaErr.param, "");
    assert.equal(viaErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const viaArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.95", "x-oneapi-request-id": "hop371-via-array" },
        body: JSON.stringify({ model: "hop371-via-chat", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(viaArray.res.status, 500, viaArray.text);
    const viaArrayErr = viaArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(viaArrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesResponse");
    assert.equal(viaArrayErr.message.includes("hop371-via-array"), false);
    assert.equal(viaArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(viaArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const viaClaude = await send(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          ...skAuth,
          "cf-connecting-ip": "192.0.2.96",
          "x-oneapi-request-id": "hop371-via-claude",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "hop371-via-chat",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 32,
        }),
      }),
      e,
    );
    assert.equal(viaClaude.res.status, 500, viaClaude.text);
    assert.equal(viaClaude.body.type, "error");
    const viaClaudeErr = viaClaude.body.error as { type: string; message: string; code?: string; param?: string };
    assert.equal(viaClaudeErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(viaClaudeErr.message, messageWithRequestId("invalid character 'o' looking for beginning of value", "hop371-via-claude"));
    assert.equal(viaClaudeErr.code, undefined);
    assert.equal(viaClaudeErr.param, undefined);

    const plainArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.97", "x-oneapi-request-id": "hop371-plain-array" },
        body: JSON.stringify({ model: "hop371-plain", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(plainArray.res.status, 500, plainArray.text);
    const plainArrayErr = plainArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(plainArrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAITextResponse");
    assert.equal(plainArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(plainArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover OaiResponsesToChatHandler Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.98" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.99", "x-oneapi-request-id": "hop371-vendor-create" },
      body: JSON.stringify({ name: "hop371-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop371-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop371 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop371.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover OaiResponsesCompactionHandler Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(openaiDoResponseUnmarshalMode("responses"), "responses");
  assert.equal(openaiDoResponseUnmarshalMode("responses", false, "/v1/responses"), "responses");
  assert.equal(openaiDoResponseUnmarshalMode("responses", false, "/v1/responses/compact"), "responses_compact");
  assert.equal(openaiDoResponseUnmarshalMode("chat", true, "/v1/responses/compact"), "responses");
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", openaiDoResponseUnmarshalMode("responses", false, "/v1/responses/compact")),
    "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesCompactionResponse",
  );
  assert.equal(
    openaiHandlerResponseUnmarshalError("[]", openaiDoResponseUnmarshalMode("responses", false, "/v1/responses")),
    "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesResponse",
  );
  assert.equal(openaiHandlerResponseUnmarshalError("null", openaiDoResponseUnmarshalMode("responses", false, "/v1/responses/compact")), null);

  const compactHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/responses/compact", { headers: { "x-oneapi-request-id": "hop372-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(compactHelper.status, 500);
  assert.deepEqual(await compactHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.100" });
  await mergeModelRatio(new Store(e.DB), { "hop372-compact": 1, "hop372-plain": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ch = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.101" },
      body: JSON.stringify({
        name: "hop372-compact",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-hop372",
        models: "hop372-compact,hop372-plain",
        group: "default",
        status_code_mapping: JSON.stringify({ "500": "503" }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, ch.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const compact = await send(
      new Request("http://local/v1/responses/compact", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.102", "x-oneapi-request-id": "hop372-compact-unmarshal" },
        body: JSON.stringify({ model: "hop372-compact" }),
      }),
      e,
    );
    assert.equal(compact.res.status, 500, compact.text);
    assert.equal("type" in compact.body && compact.body.type === "error", false, compact.text);
    const compactErr = compact.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(compactErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(compactErr.message.includes("hop372-compact-unmarshal"), false);
    assert.equal(compactErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(compactErr.param, "");
    assert.equal(compactErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const compactArray = await send(
      new Request("http://local/v1/responses/compact", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.103", "x-oneapi-request-id": "hop372-compact-array" },
        body: JSON.stringify({ model: "hop372-compact", input: "as-array" }),
      }),
      e,
    );
    assert.equal(compactArray.res.status, 500, compactArray.text);
    const compactArrayErr = compactArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(
      compactArrayErr.message,
      "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesCompactionResponse",
    );
    assert.equal(compactArrayErr.message.includes("hop372-compact-array"), false);
    assert.equal(compactArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(compactArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const plainArray = await send(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.104", "x-oneapi-request-id": "hop372-plain-array" },
        body: JSON.stringify({ model: "hop372-plain", input: "as-array" }),
      }),
      e,
    );
    assert.equal(plainArray.res.status, 500, plainArray.text);
    const plainArrayErr = plainArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(plainArrayErr.message, "json: cannot unmarshal array into Go value of type dto.OpenAIResponsesResponse");
    assert.equal(plainArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(plainArrayErr.code, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover OaiResponsesCompactionHandler Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.105" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.106", "x-oneapi-request-id": "hop372-vendor-create" },
      body: JSON.stringify({ name: "hop372-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop372-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop372 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop372.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Palm/Tencent/Zhipu Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_PALM, "chat"), true);
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_ZHIPU, "chat"), true);
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_TENCENT, "chat", true), true);
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_TENCENT, "chat", false), false);
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(usesPalmTencentZhipuUnmarshal(CHANNEL_TYPE_PALM, "images"), false);
  assert.equal(
    palmTencentZhipuResponseUnmarshalError("[]", CHANNEL_TYPE_PALM),
    "json: cannot unmarshal array into Go value of type palm.PaLMChatResponse",
  );
  assert.equal(
    palmTencentZhipuResponseUnmarshalError("[]", CHANNEL_TYPE_TENCENT),
    "json: cannot unmarshal array into Go value of type tencent.TencentChatResponseSB",
  );
  assert.equal(
    palmTencentZhipuResponseUnmarshalError("[]", CHANNEL_TYPE_ZHIPU),
    "json: cannot unmarshal array into Go value of type zhipu.ZhipuResponse",
  );
  assert.equal(palmTencentZhipuResponseUnmarshalError("not-json", CHANNEL_TYPE_PALM), "invalid character 'o' looking for beginning of value");
  assert.equal(palmTencentZhipuResponseUnmarshalError("null", CHANNEL_TYPE_PALM), null);

  const palmHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop373-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(palmHelper.status, 500);
  assert.deepEqual(await palmHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.107" });
  await mergeModelRatio(new Store(e.DB), { "hop373-palm": 1, "hop373-hunyuan": 1, "hop373-glm": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const palm = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.108" },
      body: JSON.stringify({
        name: "hop373-palm",
        type: CHANNEL_TYPE_PALM,
        key: "palm-key",
        models: "hop373-palm",
        group: "default",
        base_url: "https://generativelanguage.googleapis.com",
      }),
    }),
    e,
  );
  assert.equal(palm.body.success, true, palm.text);
  const tencent = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.109" },
      body: JSON.stringify({
        name: "hop373-tencent",
        type: CHANNEL_TYPE_TENCENT,
        key: "1300000000|AKIDxxxxxxxx|secretxxxxxxxx",
        models: "hop373-hunyuan",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(tencent.body.success, true, tencent.text);
  const zhipu = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.110" },
      body: JSON.stringify({
        name: "hop373-zhipu",
        type: CHANNEL_TYPE_ZHIPU,
        key: "id.secret",
        models: "hop373-glm",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(zhipu.body.success, true, zhipu.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const palmHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.111", "x-oneapi-request-id": "hop373-palm-unmarshal" },
        body: JSON.stringify({ model: "hop373-palm", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(palmHit.res.status, 500, palmHit.text);
    assert.equal("type" in palmHit.body && palmHit.body.type === "error", false, palmHit.text);
    const palmErr = palmHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(palmErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(palmErr.message.includes("hop373-palm-unmarshal"), false);
    assert.equal(palmErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(palmErr.param, "");
    assert.equal(palmErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const palmArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.112", "x-oneapi-request-id": "hop373-palm-array" },
        body: JSON.stringify({ model: "hop373-palm", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(palmArray.res.status, 500, palmArray.text);
    const palmArrayErr = palmArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(palmArrayErr.message, "json: cannot unmarshal array into Go value of type palm.PaLMChatResponse");
    assert.equal(palmArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);

    const tencentHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.113", "x-oneapi-request-id": "hop373-tencent-unmarshal" },
        body: JSON.stringify({ model: "hop373-hunyuan", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(tencentHit.res.status, 500, tencentHit.text);
    const tencentErr = tencentHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(tencentErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(tencentErr.message.includes("hop373-tencent-unmarshal"), false);
    assert.equal(tencentErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(tencentErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const tencentArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.114", "x-oneapi-request-id": "hop373-tencent-array" },
        body: JSON.stringify({ model: "hop373-hunyuan", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(tencentArray.res.status, 500, tencentArray.text);
    const tencentArrayErr = tencentArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(tencentArrayErr.message, "json: cannot unmarshal array into Go value of type tencent.TencentChatResponseSB");
    assert.equal(tencentArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);

    const zhipuHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.115", "x-oneapi-request-id": "hop373-zhipu-unmarshal" },
        body: JSON.stringify({ model: "hop373-glm", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(zhipuHit.res.status, 500, zhipuHit.text);
    const zhipuErr = zhipuHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(zhipuErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(zhipuErr.message.includes("hop373-zhipu-unmarshal"), false);
    assert.equal(zhipuErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(zhipuErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const zhipuArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.116", "x-oneapi-request-id": "hop373-zhipu-array" },
        body: JSON.stringify({ model: "hop373-glm", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(zhipuArray.res.status, 500, zhipuArray.text);
    const zhipuArrayErr = zhipuArray.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(zhipuArrayErr.message, "json: cannot unmarshal array into Go value of type zhipu.ZhipuResponse");
    assert.equal(zhipuArrayErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Palm/Tencent/Zhipu Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.117" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.118", "x-oneapi-request-id": "hop373-vendor-create" },
      body: JSON.stringify({ name: "hop373-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop373-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop373 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop373.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Baidu Unmarshal NewError gin.H", async () => {
  assert.equal(usesBaiduUnmarshal(CHANNEL_TYPE_BAIDU, "chat"), true);
  assert.equal(usesBaiduUnmarshal(CHANNEL_TYPE_BAIDU, "embeddings"), true);
  assert.equal(usesBaiduUnmarshal(CHANNEL_TYPE_BAIDU, "images"), false);
  assert.equal(usesBaiduUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(baiduResponseUnmarshalError("not-json", "chat"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    baiduResponseUnmarshalError("[]", "chat"),
    "json: cannot unmarshal array into Go value of type baidu.BaiduChatResponse",
  );
  assert.equal(
    baiduResponseUnmarshalError("[]", "embeddings"),
    "json: cannot unmarshal array into Go value of type baidu.BaiduEmbeddingResponse",
  );
  assert.equal(baiduResponseUnmarshalError("null", "chat"), null);
  assert.equal(baiduResponseUnmarshalError("{}", "chat"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop374-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop374-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  clearBaiduAccessTokenCache();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.119" });
  await mergeModelRatio(new Store(e.DB), { "hop374-ernie": 1, "Embedding-hop374": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const baidu = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.120" },
      body: JSON.stringify({
        name: "hop374-baidu",
        type: CHANNEL_TYPE_BAIDU,
        key: "ak|sk-hop374",
        models: "hop374-ernie,Embedding-hop374",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(baidu.body.success, true, baidu.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/2.0/token")) {
      return new Response(JSON.stringify({ access_token: "bd-token", expires_in: 2592000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.121", "x-oneapi-request-id": "hop374-baidu-unmarshal" },
        body: JSON.stringify({ model: "hop374-ernie", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value (request id: hop374-baidu-unmarshal)");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.122", "x-oneapi-request-id": "hop374-baidu-array" },
        body: JSON.stringify({ model: "hop374-ernie", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type baidu.BaiduChatResponse (request id: hop374-baidu-array)",
    );

    const embedHit = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.123", "x-oneapi-request-id": "hop374-baidu-embed" },
        body: JSON.stringify({ model: "Embedding-hop374", input: "hi" }),
      }),
      e,
    );
    assert.equal(embedHit.res.status, 500, embedHit.text);
    const embedErr = embedHit.body.error as { message: string; type: string; code: string };
    assert.equal(embedErr.message, "invalid character 'o' looking for beginning of value (request id: hop374-baidu-embed)");
    assert.equal(embedErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(embedErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const embedArray = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.124", "x-oneapi-request-id": "hop374-baidu-embed-array" },
        body: JSON.stringify({ model: "Embedding-hop374", input: "as-array" }),
      }),
      e,
    );
    assert.equal(embedArray.res.status, 500, embedArray.text);
    const embedArrayErr = embedArray.body.error as { message: string };
    assert.equal(
      embedArrayErr.message,
      "json: cannot unmarshal array into Go value of type baidu.BaiduEmbeddingResponse (request id: hop374-baidu-embed-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Baidu Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.125" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.126", "x-oneapi-request-id": "hop374-vendor-create" },
      body: JSON.stringify({ name: "hop374-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop374-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop374 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop374.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Coze Unmarshal NewError gin.H", async () => {
  assert.equal(usesCozeUnmarshal(CHANNEL_TYPE_COZE, "chat"), true);
  assert.equal(usesCozeUnmarshal(CHANNEL_TYPE_COZE, "embeddings"), false);
  assert.equal(usesCozeUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(cozeResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    cozeResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type coze.CozeChatDetailResponse",
  );
  assert.equal(cozeResponseUnmarshalError("null"), null);
  assert.equal(cozeResponseUnmarshalError("{}"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop375-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop375-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.127" });
  await mergeModelRatio(new Store(e.DB), { "hop375-coze": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const coze = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.128" },
      body: JSON.stringify({
        name: "hop375-coze",
        type: CHANNEL_TYPE_COZE,
        key: "ck-hop375",
        models: "hop375-coze",
        group: "default",
        other: "bot-hop375",
      }),
    }),
    e,
  );
  assert.equal(coze.body.success, true, coze.text);

  let nextList = "not-json";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    if (url.includes("/v3/chat/retrieve")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { status: "completed", usage: { token_count: 9, output_count: 4, input_count: 5 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v3/chat/message/list")) {
      return new Response(nextList, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v3/chat")) {
      nextList = raw.includes("as-array") ? "[]" : "not-json";
      return new Response(JSON.stringify({ code: 0, data: { id: "chat1", conversation_id: "conv1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.129", "x-oneapi-request-id": "hop375-coze-unmarshal" },
        body: JSON.stringify({ model: "hop375-coze", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value (request id: hop375-coze-unmarshal)");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.130", "x-oneapi-request-id": "hop375-coze-array" },
        body: JSON.stringify({ model: "hop375-coze", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type coze.CozeChatDetailResponse (request id: hop375-coze-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Coze Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.131" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.132", "x-oneapi-request-id": "hop375-vendor-create" },
      body: JSON.stringify({ name: "hop375-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop375-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop375 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop375.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Dify Unmarshal NewError gin.H", async () => {
  assert.equal(usesDifyUnmarshal(CHANNEL_TYPE_DIFY, "chat"), true);
  assert.equal(usesDifyUnmarshal(CHANNEL_TYPE_DIFY, "embeddings"), false);
  assert.equal(usesDifyUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(difyResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    difyResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type dify.DifyChatCompletionResponse",
  );
  assert.equal(difyResponseUnmarshalError("null"), null);
  assert.equal(difyResponseUnmarshalError("{}"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop376-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop376-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.133" });
  await mergeModelRatio(new Store(e.DB), { "hop376-dify": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const dify = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.134" },
      body: JSON.stringify({
        name: "hop376-dify",
        type: CHANNEL_TYPE_DIFY,
        key: "dk-hop376",
        models: "hop376-dify",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(dify.body.success, true, dify.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.135", "x-oneapi-request-id": "hop376-dify-unmarshal" },
        body: JSON.stringify({ model: "hop376-dify", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value (request id: hop376-dify-unmarshal)");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.136", "x-oneapi-request-id": "hop376-dify-array" },
        body: JSON.stringify({ model: "hop376-dify", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type dify.DifyChatCompletionResponse (request id: hop376-dify-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Dify Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.137" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.138", "x-oneapi-request-id": "hop376-vendor-create" },
      body: JSON.stringify({ name: "hop376-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop376-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop376 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop376.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Moka Unmarshal NewError gin.H", async () => {
  assert.equal(usesMokaUnmarshal(CHANNEL_TYPE_MOKA, "embeddings"), true);
  assert.equal(usesMokaUnmarshal(CHANNEL_TYPE_MOKA, "chat"), false);
  assert.equal(usesMokaUnmarshal(CHANNEL_TYPE_OPENAI, "embeddings"), false);
  assert.equal(mokaResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    mokaResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type dto.EmbeddingResponse",
  );
  assert.equal(mokaResponseUnmarshalError("null"), null);
  assert.equal(mokaResponseUnmarshalError("{}"), null);

  const embedHelper = writeRelayNewAPIError(
    new Request("http://local/v1/embeddings", { headers: { "x-oneapi-request-id": "hop377-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(embedHelper.status, 500);
  assert.deepEqual(await embedHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop377-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.139" });
  await mergeModelRatio(new Store(e.DB), { "hop377-m3e": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const moka = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.140" },
      body: JSON.stringify({
        name: "hop377-moka",
        type: CHANNEL_TYPE_MOKA,
        key: "mk-hop377",
        models: "hop377-m3e",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(moka.body.success, true, moka.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const embedHit = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.141", "x-oneapi-request-id": "hop377-moka-unmarshal" },
        body: JSON.stringify({ model: "hop377-m3e", input: "hi" }),
      }),
      e,
    );
    assert.equal(embedHit.res.status, 500, embedHit.text);
    assert.equal("type" in embedHit.body && embedHit.body.type === "error", false, embedHit.text);
    const embedErr = embedHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(embedErr.message, "invalid character 'o' looking for beginning of value (request id: hop377-moka-unmarshal)");
    assert.equal(embedErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(embedErr.param, "");
    assert.equal(embedErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const embedArray = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.142", "x-oneapi-request-id": "hop377-moka-array" },
        body: JSON.stringify({ model: "hop377-m3e", input: "as-array" }),
      }),
      e,
    );
    assert.equal(embedArray.res.status, 500, embedArray.text);
    const embedArrayErr = embedArray.body.error as { message: string };
    assert.equal(
      embedArrayErr.message,
      "json: cannot unmarshal array into Go value of type dto.EmbeddingResponse (request id: hop377-moka-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Moka Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.143" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.144", "x-oneapi-request-id": "hop377-vendor-create" },
      body: JSON.stringify({ name: "hop377-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop377-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop377 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop377.some((item) => item.action === "vendor.create"), listed.text);
});

function hop378AudioForm(model: string): { buf: ArrayBuffer; ct: string } {
  const boundary = "----Hop378CfAudio";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFWAV\r\n` +
    `--${boundary}--\r\n`;
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return { buf: out.buffer, ct: `multipart/form-data; boundary=${boundary}` };
}

test("original leftover Cloudflare Unmarshal NewError gin.H", async () => {
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "chat"), true);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "embeddings"), true);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "audio_transcription"), true);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "audio_translation"), true);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "completions"), false);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "responses"), false);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_CLOUDFLARE, "images"), false);
  assert.equal(usesCloudflareUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(cloudflareResponseUnmarshalError("not-json", "chat"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    cloudflareResponseUnmarshalError("[]", "chat"),
    "json: cannot unmarshal array into Go value of type dto.TextResponse",
  );
  assert.equal(
    cloudflareResponseUnmarshalError("[]", "embeddings"),
    "json: cannot unmarshal array into Go value of type dto.TextResponse",
  );
  assert.equal(
    cloudflareResponseUnmarshalError("[]", "audio_transcription"),
    "json: cannot unmarshal array into Go value of type cloudflare.CfAudioResponse",
  );
  assert.equal(
    cloudflareResponseUnmarshalError("[]", "audio_translation"),
    "json: cannot unmarshal array into Go value of type cloudflare.CfAudioResponse",
  );
  assert.equal(cloudflareResponseUnmarshalError("null", "chat"), null);
  assert.equal(cloudflareResponseUnmarshalError("{}", "chat"), null);
  assert.equal(cloudflareResponseUnmarshalError("null", "audio_transcription"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop378-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop378-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.145" });
  await mergeModelRatio(new Store(e.DB), { "hop378-cf": 1, "hop378-array": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const cloudflare = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.146" },
      body: JSON.stringify({
        name: "hop378-cloudflare",
        type: CHANNEL_TYPE_CLOUDFLARE,
        key: "cf-hop378",
        other: "acct-1",
        models: "hop378-cf,hop378-array",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(cloudflare.body.success, true, cloudflare.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/ai/run/hop378-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/ai/run/")) {
      return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.147", "x-oneapi-request-id": "hop378-cf-unmarshal" },
        body: JSON.stringify({ model: "hop378-cf", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value (request id: hop378-cf-unmarshal)");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.148", "x-oneapi-request-id": "hop378-cf-array" },
        body: JSON.stringify({ model: "hop378-cf", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type dto.TextResponse (request id: hop378-cf-array)",
    );

    const embedHit = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.149", "x-oneapi-request-id": "hop378-cf-embed" },
        body: JSON.stringify({ model: "hop378-cf", input: "hi" }),
      }),
      e,
    );
    assert.equal(embedHit.res.status, 500, embedHit.text);
    const embedErr = embedHit.body.error as { message: string; type: string; code: string };
    assert.equal(embedErr.message, "invalid character 'o' looking for beginning of value (request id: hop378-cf-embed)");
    assert.equal(embedErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(embedErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const embedArray = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.150", "x-oneapi-request-id": "hop378-cf-embed-array" },
        body: JSON.stringify({ model: "hop378-cf", input: "as-array" }),
      }),
      e,
    );
    assert.equal(embedArray.res.status, 500, embedArray.text);
    const embedArrayErr = embedArray.body.error as { message: string };
    assert.equal(
      embedArrayErr.message,
      "json: cannot unmarshal array into Go value of type dto.TextResponse (request id: hop378-cf-embed-array)",
    );

    const sttForm = hop378AudioForm("hop378-cf");
    const sttHit = await send(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": sttForm.ct,
          "cf-connecting-ip": "192.0.2.151",
          "x-oneapi-request-id": "hop378-cf-stt",
        },
        body: sttForm.buf,
      }),
      e,
    );
    assert.equal(sttHit.res.status, 500, sttHit.text);
    const sttErr = sttHit.body.error as { message: string; type: string; code: string };
    assert.equal(sttErr.message, "invalid character 'o' looking for beginning of value (request id: hop378-cf-stt)");
    assert.equal(sttErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(sttErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const sttArrayForm = hop378AudioForm("hop378-array");
    const sttArray = await send(
      new Request("http://local/v1/audio/translations", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": sttArrayForm.ct,
          "cf-connecting-ip": "192.0.2.152",
          "x-oneapi-request-id": "hop378-cf-stt-array",
        },
        body: sttArrayForm.buf,
      }),
      e,
    );
    assert.equal(sttArray.res.status, 500, sttArray.text);
    const sttArrayErr = sttArray.body.error as { message: string };
    assert.equal(
      sttArrayErr.message,
      "json: cannot unmarshal array into Go value of type cloudflare.CfAudioResponse (request id: hop378-cf-stt-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Cloudflare Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.153" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.154", "x-oneapi-request-id": "hop378-vendor-create" },
      body: JSON.stringify({ name: "hop378-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop378-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop378 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop378.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover xAI Unmarshal NewError gin.H", async () => {
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "chat"), true);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "completions"), true);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "embeddings"), false);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "images"), false);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "responses"), false);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_XAI, "audio_speech"), false);
  assert.equal(usesXaiUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(xaiResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    xaiResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type xai.ChatCompletionResponse",
  );
  assert.equal(xaiResponseUnmarshalError("null"), null);
  assert.equal(xaiResponseUnmarshalError("{}"), null);

  const chatHelper = writeRelayNewAPIError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop379-helper" } }),
    500,
    "invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value (request id: hop379-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.155" });
  await mergeModelRatio(new Store(e.DB), { "hop379-grok": 1, "hop379-array": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const xai = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.156" },
      body: JSON.stringify({
        name: "hop379-xai",
        type: CHANNEL_TYPE_XAI,
        key: "xk-hop379",
        models: "hop379-grok,hop379-array",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(xai.body.success, true, xai.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.157", "x-oneapi-request-id": "hop379-xai-unmarshal" },
        body: JSON.stringify({ model: "hop379-grok", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value (request id: hop379-xai-unmarshal)");
    assert.equal(chatErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.158", "x-oneapi-request-id": "hop379-xai-array" },
        body: JSON.stringify({ model: "hop379-grok", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type xai.ChatCompletionResponse (request id: hop379-xai-array)",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover xAI Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.159" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.160", "x-oneapi-request-id": "hop379-vendor-create" },
      body: JSON.stringify({ name: "hop379-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop379-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop379 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop379.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Jimeng Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesJimengUnmarshal(CHANNEL_TYPE_JIMENG, "images"), true);
  assert.equal(usesJimengUnmarshal(CHANNEL_TYPE_JIMENG, "chat"), false);
  assert.equal(usesJimengUnmarshal(CHANNEL_TYPE_JIMENG, "completions"), false);
  assert.equal(usesJimengUnmarshal(CHANNEL_TYPE_JIMENG, "embeddings"), false);
  assert.equal(usesJimengUnmarshal(CHANNEL_TYPE_OPENAI, "images"), false);
  assert.equal(jimengResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    jimengResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type jimeng.ImageResponse",
  );
  assert.equal(jimengResponseUnmarshalError("null"), null);
  assert.equal(jimengResponseUnmarshalError("{}"), null);

  const imageHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/images/generations", { headers: { "x-oneapi-request-id": "hop380-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(imageHelper.status, 500);
  assert.deepEqual(await imageHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.161" });
  await mergeModelRatio(new Store(e.DB), { "hop380-jimeng": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const jimeng = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.162" },
      body: JSON.stringify({
        name: "hop380-jimeng",
        type: CHANNEL_TYPE_JIMENG,
        key: "ak|sk-hop380",
        models: "hop380-jimeng",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(jimeng.body.success, true, jimeng.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const imageHit = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.163", "x-oneapi-request-id": "hop380-jimeng-unmarshal" },
        body: JSON.stringify({ model: "hop380-jimeng", prompt: "a mountain" }),
      }),
      e,
    );
    assert.equal(imageHit.res.status, 500, imageHit.text);
    assert.equal("type" in imageHit.body && imageHit.body.type === "error", false, imageHit.text);
    const imageErr = imageHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(imageErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(imageErr.message.includes("hop380-jimeng-unmarshal"), false);
    assert.equal(imageErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(imageErr.param, "");
    assert.equal(imageErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const imageArray = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.164", "x-oneapi-request-id": "hop380-jimeng-array" },
        body: JSON.stringify({ model: "hop380-jimeng", prompt: "as-array" }),
      }),
      e,
    );
    assert.equal(imageArray.res.status, 500, imageArray.text);
    const imageArrayErr = imageArray.body.error as { message: string };
    assert.equal(
      imageArrayErr.message,
      "json: cannot unmarshal array into Go value of type jimeng.ImageResponse",
    );
    assert.equal(imageArrayErr.message.includes("hop380-jimeng-array"), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Jimeng Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.165" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.166", "x-oneapi-request-id": "hop380-vendor-create" },
      body: JSON.stringify({ name: "hop380-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop380-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop380 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop380.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Ollama Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "chat"), true);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "completions"), true);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "embeddings"), true);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "images"), false);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "responses"), false);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OLLAMA, "audio_speech"), false);
  assert.equal(usesOllamaUnmarshal(CHANNEL_TYPE_OPENAI, "chat"), false);
  assert.equal(ollamaResponseUnmarshalError("not-json", "chat"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    ollamaResponseUnmarshalError("[]", "chat"),
    "json: cannot unmarshal array into Go value of type ollama.ollamaChatStreamChunk",
  );
  assert.equal(
    ollamaResponseUnmarshalError("[]", "embeddings"),
    "json: cannot unmarshal array into Go value of type ollama.OllamaEmbeddingResponse",
  );
  assert.equal(ollamaResponseUnmarshalError("null", "chat"), null);
  assert.equal(ollamaResponseUnmarshalError("null", "embeddings"), null);
  assert.equal(ollamaResponseUnmarshalError("{}", "chat"), null);
  assert.equal(
    ollamaResponseUnmarshalError('{"message":{"content":"a"}}\n{"done":true}', "chat"),
    null,
  );

  const chatHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/chat/completions", { headers: { "x-oneapi-request-id": "hop381-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(chatHelper.status, 500);
  assert.deepEqual(await chatHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.167" });
  await mergeModelRatio(new Store(e.DB), { "hop381-llama": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const ollama = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.168" },
      body: JSON.stringify({
        name: "hop381-ollama",
        type: CHANNEL_TYPE_OLLAMA,
        key: "ollama-hop381",
        models: "hop381-llama",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ollama.body.success, true, ollama.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const chatHit = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.169", "x-oneapi-request-id": "hop381-ollama-unmarshal" },
        body: JSON.stringify({ model: "hop381-llama", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(chatHit.res.status, 500, chatHit.text);
    assert.equal("type" in chatHit.body && chatHit.body.type === "error", false, chatHit.text);
    const chatErr = chatHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(chatErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(chatErr.message.includes("hop381-ollama-unmarshal"), false);
    assert.equal(chatErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(chatErr.param, "");
    assert.equal(chatErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const chatArray = await send(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.170", "x-oneapi-request-id": "hop381-ollama-array" },
        body: JSON.stringify({ model: "hop381-llama", messages: [{ role: "user", content: "as-array" }] }),
      }),
      e,
    );
    assert.equal(chatArray.res.status, 500, chatArray.text);
    const chatArrayErr = chatArray.body.error as { message: string };
    assert.equal(
      chatArrayErr.message,
      "json: cannot unmarshal array into Go value of type ollama.ollamaChatStreamChunk",
    );
    assert.equal(chatArrayErr.message.includes("hop381-ollama-array"), false);

    const embedHit = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.171", "x-oneapi-request-id": "hop381-ollama-embed" },
        body: JSON.stringify({ model: "hop381-llama", input: "hi" }),
      }),
      e,
    );
    assert.equal(embedHit.res.status, 500, embedHit.text);
    const embedErr = embedHit.body.error as { message: string; type: string; code: string };
    assert.equal(embedErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(embedErr.message.includes("hop381-ollama-embed"), false);
    assert.equal(embedErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(embedErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const embedArray = await send(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.172", "x-oneapi-request-id": "hop381-ollama-embed-array" },
        body: JSON.stringify({ model: "hop381-llama", input: "as-array" }),
      }),
      e,
    );
    assert.equal(embedArray.res.status, 500, embedArray.text);
    const embedArrayErr = embedArray.body.error as { message: string };
    assert.equal(
      embedArrayErr.message,
      "json: cannot unmarshal array into Go value of type ollama.OllamaEmbeddingResponse",
    );
    assert.equal(embedArrayErr.message.includes("hop381-ollama-embed-array"), false);

    const completionsHit = await send(
      new Request("http://local/v1/completions", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.173", "x-oneapi-request-id": "hop381-ollama-completions" },
        body: JSON.stringify({ model: "hop381-llama", prompt: "hi" }),
      }),
      e,
    );
    assert.equal(completionsHit.res.status, 500, completionsHit.text);
    const completionsErr = completionsHit.body.error as { message: string; type: string };
    assert.equal(completionsErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(completionsErr.message.includes("hop381-ollama-completions"), false);
    assert.equal(completionsErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Ollama Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.174" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.175", "x-oneapi-request-id": "hop381-vendor-create" },
      body: JSON.stringify({ name: "hop381-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop381-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop381 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop381.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Zhipu v4 image Unmarshal NewOpenAIError gin.H", async () => {
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_ZHIPU_V4, "images"), true);
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_ZHIPU_V4, "chat"), false);
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_ZHIPU_V4, "embeddings"), false);
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_ZHIPU_V4, "responses"), false);
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_ZHIPU, "images"), false);
  assert.equal(usesZhipuV4ImageUnmarshal(CHANNEL_TYPE_OPENAI, "images"), false);
  assert.equal(zhipuV4ImageResponseUnmarshalError("not-json"), "invalid character 'o' looking for beginning of value");
  assert.equal(
    zhipuV4ImageResponseUnmarshalError("[]"),
    "json: cannot unmarshal array into Go value of type zhipu_4v.zhipuImageResponse",
  );
  assert.equal(zhipuV4ImageResponseUnmarshalError("null"), null);
  assert.equal(zhipuV4ImageResponseUnmarshalError("{}"), null);

  const imageHelper = writeOpenaiHandlerUnmarshalError(
    new Request("http://local/v1/images/generations", { headers: { "x-oneapi-request-id": "hop382-helper" } }),
    "invalid character 'o' looking for beginning of value",
  );
  assert.equal(imageHelper.status, 500);
  assert.deepEqual(await imageHelper.json(), {
    error: {
      message: "invalid character 'o' looking for beginning of value",
      type: ERROR_CODE_BAD_RESPONSE_BODY,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.176" });
  await mergeModelRatio(new Store(e.DB), { "hop382-cogview": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const zhipu = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.177" },
      body: JSON.stringify({
        name: "hop382-zhipu",
        type: CHANNEL_TYPE_ZHIPU_V4,
        key: "sk-z-hop382",
        models: "hop382-cogview",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(zhipu.body.success, true, zhipu.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const imageHit = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.178", "x-oneapi-request-id": "hop382-zhipu-unmarshal" },
        body: JSON.stringify({ model: "hop382-cogview", prompt: "a mountain" }),
      }),
      e,
    );
    assert.equal(imageHit.res.status, 500, imageHit.text);
    assert.equal("type" in imageHit.body && imageHit.body.type === "error", false, imageHit.text);
    const imageErr = imageHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(imageErr.message, "invalid character 'o' looking for beginning of value");
    assert.equal(imageErr.message.includes("hop382-zhipu-unmarshal"), false);
    assert.equal(imageErr.type, ERROR_CODE_BAD_RESPONSE_BODY);
    assert.equal(imageErr.param, "");
    assert.equal(imageErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const imageArray = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.179", "x-oneapi-request-id": "hop382-zhipu-array" },
        body: JSON.stringify({ model: "hop382-cogview", prompt: "as-array" }),
      }),
      e,
    );
    assert.equal(imageArray.res.status, 500, imageArray.text);
    const imageArrayErr = imageArray.body.error as { message: string };
    assert.equal(
      imageArrayErr.message,
      "json: cannot unmarshal array into Go value of type zhipu_4v.zhipuImageResponse",
    );
    assert.equal(imageArrayErr.message.includes("hop382-zhipu-array"), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Zhipu v4 image Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.180" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.181", "x-oneapi-request-id": "hop382-vendor-create" },
      body: JSON.stringify({ name: "hop382-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop382-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop382 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop382.some((item) => item.action === "vendor.create"), listed.text);
});

test("original leftover Replicate Unmarshal NewError gin.H", async () => {
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_REPLICATE, "images"), true);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_REPLICATE, "chat"), false);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_REPLICATE, "embeddings"), false);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_REPLICATE, "responses"), false);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_REPLICATE, "audio_speech"), false);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_OPENAI, "images"), false);
  assert.equal(usesReplicateUnmarshal(CHANNEL_TYPE_JIMENG, "images"), false);
  assert.equal(
    replicateResponseUnmarshalError("not-json"),
    "replicate adaptor: failed to decode response: invalid character 'o' looking for beginning of value",
  );
  assert.equal(
    replicateResponseUnmarshalError("[]"),
    "replicate adaptor: failed to decode response: json: cannot unmarshal array into Go value of type replicate.PredictionResponse",
  );
  assert.equal(replicateResponseUnmarshalError("null"), null);
  assert.equal(replicateResponseUnmarshalError("{}"), null);

  const imageHelper = writeRelayNewAPIError(
    new Request("http://local/v1/images/generations", { headers: { "x-oneapi-request-id": "hop383-helper" } }),
    500,
    "replicate adaptor: failed to decode response: invalid character 'o' looking for beginning of value",
    ERROR_CODE_BAD_RESPONSE_BODY,
  );
  assert.equal(imageHelper.status, 500);
  assert.deepEqual(await imageHelper.json(), {
    error: {
      message:
        "replicate adaptor: failed to decode response: invalid character 'o' looking for beginning of value (request id: hop383-helper)",
      type: ERROR_TYPE_NEW_API_ERROR,
      param: "",
      code: ERROR_CODE_BAD_RESPONSE_BODY,
    },
  });

  resetSchemaFlag();
  const e = env();
  const { auth, sk } = await boot(e, { "cf-connecting-ip": "192.0.2.182" });
  await mergeModelRatio(new Store(e.DB), { "hop383-flux": 1 });
  const skAuth = { authorization: "Bearer " + sk, "content-type": "application/json" };
  const replicate = await send(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: { ...auth, "cf-connecting-ip": "192.0.2.183" },
      body: JSON.stringify({
        name: "hop383-replicate",
        type: CHANNEL_TYPE_REPLICATE,
        key: "r8-hop383",
        models: "hop383-flux",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(replicate.body.success, true, replicate.text);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    if (raw.includes("as-array")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const imageHit = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.184", "x-oneapi-request-id": "hop383-replicate-unmarshal" },
        body: JSON.stringify({ model: "hop383-flux", prompt: "a mountain" }),
      }),
      e,
    );
    assert.equal(imageHit.res.status, 500, imageHit.text);
    assert.equal("type" in imageHit.body && imageHit.body.type === "error", false, imageHit.text);
    const imageErr = imageHit.body.error as { message: string; type: string; param: string; code: string };
    assert.equal(
      imageErr.message,
      "replicate adaptor: failed to decode response: invalid character 'o' looking for beginning of value (request id: hop383-replicate-unmarshal)",
    );
    assert.equal(imageErr.type, ERROR_TYPE_NEW_API_ERROR);
    assert.equal(imageErr.param, "");
    assert.equal(imageErr.code, ERROR_CODE_BAD_RESPONSE_BODY);

    const imageArray = await send(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { ...skAuth, "cf-connecting-ip": "192.0.2.185", "x-oneapi-request-id": "hop383-replicate-array" },
        body: JSON.stringify({ model: "hop383-flux", prompt: "as-array" }),
      }),
      e,
    );
    assert.equal(imageArray.res.status, 500, imageArray.text);
    const imageArrayErr = imageArray.body.error as { message: string; type: string };
    assert.equal(
      imageArrayErr.message,
      "replicate adaptor: failed to decode response: json: cannot unmarshal array into Go value of type replicate.PredictionResponse (request id: hop383-replicate-array)",
    );
    assert.equal(imageArrayErr.type, ERROR_TYPE_NEW_API_ERROR);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original leftover Replicate Unmarshal gin.H does not change AUTH StatusText or hop 323 vendor.create", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e, { "cf-connecting-ip": "192.0.2.186" });

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
      headers: { ...auth, "cf-connecting-ip": "192.0.2.187", "x-oneapi-request-id": "hop383-vendor-create" },
      body: JSON.stringify({ name: "hop383-vendor-create", description: "d", icon: "" }),
    }),
    e,
  );
  assert.equal(created.body.success, true, created.text);
  const listed = await send(
    new Request("http://local/api/audit?page_size=100&request_id=hop383-vendor-create", { headers: auth }),
    e,
  );
  const vendorItemsHop383 = ((listed.body.data as { items: { action: string }[] }).items || []);
  assert.ok(vendorItemsHop383.some((item) => item.action === "vendor.create"), listed.text);
});


