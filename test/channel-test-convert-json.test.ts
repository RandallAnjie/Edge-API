import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_COZE,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_OPENAI,
} from "../src/constants.js";
import { buildTestRequest } from "../src/channel-test.js";
import { convertOpenAIAdaptorClaudeRequest, convertOpenAIAdaptorGeminiRequest, convertOpenAIRequest } from "../src/convert.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
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
  return { token, auth };
}

function openaiChatResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function claudeResponse() {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function geminiResponse() {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("original TestChannel adaptor ConvertClaudeRequest / ConvertGeminiRequest / ConvertOpenAIRequest JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const openaiCreated = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "convert-openai",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://api.example.test",
      }),
    }),
    e,
  );
  assert.equal(openaiCreated.body.success, true, String(openaiCreated.body.message));
  const claudeCreated = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "convert-claude",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-3-5-sonnet-20241022",
        group: "default",
        base_url: "https://api.anthropic.example",
      }),
    }),
    e,
  );
  assert.equal(claudeCreated.body.success, true, String(claudeCreated.body.message));
  const geminiCreated = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "convert-gemini",
        type: CHANNEL_TYPE_GEMINI,
        key: "gem-key",
        models: "gemini-2.5-flash",
        group: "default",
        base_url: "https://generativelanguage.example",
      }),
    }),
    e,
  );
  assert.equal(geminiCreated.body.success, true, String(geminiCreated.body.message));
  const cozeCreated = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "convert-coze",
        type: CHANNEL_TYPE_COZE,
        key: "coze-key",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://api.coze.example",
      }),
    }),
    e,
  );
  assert.equal(cozeCreated.body.success, true, String(cozeCreated.body.message));

  const channels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  const items = ((channels.body.data as { items: { id: number; name: string }[] }).items || []);
  const openaiRow = items.find((c) => c.name === "convert-openai");
  const claudeRow = items.find((c) => c.name === "convert-claude");
  const geminiRow = items.find((c) => c.name === "convert-gemini");
  const cozeRow = items.find((c) => c.name === "convert-coze");
  assert.ok(openaiRow && claudeRow && geminiRow && cozeRow);

  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = { raw };
    }
    seen.push({ url, body });
    if (url.includes("/v1/chat/completions")) return openaiChatResponse();
    if (url.includes("/v1/messages")) return claudeResponse();
    if (url.includes(":generateContent")) return geminiResponse();
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const anthropicOnOpenAI = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=gpt-4o-mini&endpoint_type=anthropic", { headers: auth }),
      e,
    );
    assert.equal(anthropicOnOpenAI.body.success, true, String(anthropicOnOpenAI.body.message));
    const claudeHit = seen.find((s) => s.url === "https://api.example.test/v1/chat/completions");
    assert.ok(claudeHit, JSON.stringify(seen.map((s) => s.url)));
    const claudeBuilt = buildTestRequest("gpt-4o-mini", "anthropic", false);
    const expectedClaude = convertOpenAIAdaptorClaudeRequest(claudeBuilt.body, {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o-mini",
      upstreamModelName: "gpt-4o-mini",
      isStream: false,
      relayMode: "messages",
    });
    assert.deepEqual(claudeHit.body, expectedClaude);
    assert.deepEqual(claudeHit.body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(claudeHit.body.max_tokens, 16);
    assert.equal("contents" in claudeHit.body, false);

    seen.length = 0;
    const geminiOnOpenAI = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=gpt-4o-mini&endpoint_type=gemini", { headers: auth }),
      e,
    );
    assert.equal(geminiOnOpenAI.body.success, true, String(geminiOnOpenAI.body.message));
    const geminiHit = seen.find((s) => s.url === "https://api.example.test/v1/chat/completions");
    assert.ok(geminiHit, JSON.stringify(seen.map((s) => s.url)));
    const geminiBuilt = buildTestRequest("gpt-4o-mini", "gemini", false);
    const expectedGemini = convertOpenAIAdaptorGeminiRequest(geminiBuilt.body, {
      channelType: CHANNEL_TYPE_OPENAI,
      originModelName: "gpt-4o-mini",
      upstreamModelName: "gpt-4o-mini",
      isStream: false,
      relayMode: "gemini",
    });
    assert.deepEqual(geminiHit.body, expectedGemini);
    assert.deepEqual(geminiHit.body.messages, [{ role: "user", content: "hi" }]);
    assert.equal(geminiHit.body.max_tokens, 3000);

    seen.length = 0;
    const openaiOnClaude = await json(
      new Request("http://local/api/channel/test/" + claudeRow.id + "?model=claude-3-5-sonnet-20241022&endpoint_type=openai", { headers: auth }),
      e,
    );
    assert.equal(openaiOnClaude.body.success, true, String(openaiOnClaude.body.message));
    const openaiClaudeHit = seen.find((s) => s.url === "https://api.anthropic.example/v1/messages");
    assert.ok(openaiClaudeHit, JSON.stringify(seen.map((s) => s.url)));
    const openaiBuilt = buildTestRequest("claude-3-5-sonnet-20241022", "openai", false);
    const expectedOpenAIClaude = convertOpenAIRequest(openaiBuilt.body, {
      channelType: CHANNEL_TYPE_ANTHROPIC,
      originModelName: "claude-3-5-sonnet-20241022",
      upstreamModelName: "claude-3-5-sonnet-20241022",
      relayMode: "chat",
    });
    assert.deepEqual(openaiClaudeHit.body, expectedOpenAIClaude);
    assert.equal(openaiClaudeHit.body.max_tokens, 16);

    seen.length = 0;
    const nativeClaude = await json(
      new Request("http://local/api/channel/test/" + claudeRow.id + "?model=claude-3-5-sonnet-20241022&endpoint_type=anthropic", { headers: auth }),
      e,
    );
    assert.equal(nativeClaude.body.success, true, String(nativeClaude.body.message));
    const nativeClaudeHit = seen.find((s) => s.url === "https://api.anthropic.example/v1/messages");
    assert.ok(nativeClaudeHit, JSON.stringify(seen.map((s) => s.url)));
    assert.equal(nativeClaudeHit.body.model, "claude-3-5-sonnet-20241022");
    assert.equal(nativeClaudeHit.body.max_tokens, 16);
    assert.deepEqual(nativeClaudeHit.body.messages, [{ role: "user", content: "hi" }]);

    seen.length = 0;
    const nativeGemini = await json(
      new Request("http://local/api/channel/test/" + geminiRow.id + "?model=gemini-2.5-flash&endpoint_type=gemini", { headers: auth }),
      e,
    );
    assert.equal(nativeGemini.body.success, true, String(nativeGemini.body.message));
    const nativeGeminiHit = seen.find((s) => s.url.includes(":generateContent"));
    assert.ok(nativeGeminiHit, JSON.stringify(seen.map((s) => s.url)));
    assert.deepEqual((nativeGeminiHit.body.contents as unknown[])[0], { role: "user", parts: [{ text: "hi" }] });

    const cozeImage = await json(
      new Request("http://local/api/channel/test/" + cozeRow.id + "?model=gpt-4o-mini&endpoint_type=image-generation", { headers: auth }),
      e,
    );
    assert.equal(cozeImage.body.success, false);
    assert.equal(cozeImage.body.message, "not implemented");
    assert.equal(cozeImage.body.error_code, "convert_request_failed");
    assert.equal(cozeImage.body.time, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
