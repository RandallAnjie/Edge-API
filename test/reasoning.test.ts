import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER } from "../src/constants.js";
import { applyReasoningModelSuffix } from "../src/reasoning.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
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

async function boot() {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test" };
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
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "cli", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, sk };
}

test("original ApplyReasoningModelSuffix trims GPT effort tails and leaves unknown OpenRouter thinking models", () => {
  const gpt = applyReasoningModelSuffix({ model: "gpt-5.1-high" }, "gpt-5.1-high", "gpt-5.1-high");
  assert.equal(gpt.upstreamModelName, "gpt-5.1");
  assert.equal(gpt.reasoningEffort, "high");

  const unknown = applyReasoningModelSuffix({ model: "some-model-thinking" }, "some-model-thinking", "some-model-thinking");
  assert.equal(unknown.upstreamModelName, "some-model-thinking");
  assert.equal(unknown.reasoningEffort, "");

  const claude = applyReasoningModelSuffix({ model: "claude-3-7-sonnet-thinking" }, "claude-3-7-sonnet-thinking", "claude-3-7-sonnet-thinking");
  assert.equal(claude.upstreamModelName, "claude-3-7-sonnet");
  assert.equal(claude.reasoningEffort, "high");
});

test("original OpenRouter ConvertOpenAIRequest JSON is sent upstream with usage.include and nested reasoning", async () => {
  const { e, auth, sk } = await boot();
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openrouter",
        type: CHANNEL_TYPE_OPENROUTER,
        key: "sk-or",
        models: "gpt-5.2-high,gpt-5.2",
        group: "default",
        base_url: "https://openrouter.example.test/api",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers };
    return new Response(
      JSON.stringify({
        id: "chatcmpl-or",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const relay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.2-high", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(relay.res.status, 200, relay.text);
    if (!captured) throw new Error("missing upstream request");
    assert.match(captured.url, /openrouter\.example\.test/);
    assert.equal(captured.body.model, "gpt-5.2");
    assert.equal("reasoning_effort" in captured.body, false);
    assert.deepEqual(captured.body.usage, { include: true });
    assert.deepEqual(captured.body.reasoning, { enabled: true, effort: "high" });
    assert.equal(captured.headers.get("HTTP-Referer") || captured.headers.get("http-referer"), "https://www.newapi.ai");
    assert.equal(captured.headers.get("X-OpenRouter-Title") || captured.headers.get("x-openrouter-title"), "New API");
  } finally {
    globalThis.fetch = origFetch;
  }

  const openai = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-mod",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-oa",
        models: "gpt-5.2,m@thinkin:on",
        group: "default",
        base_url: "https://openai.example.test",
      }),
    }),
    e,
  );
  assert.equal(openai.body.success, true, String(openai.body.message));

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url: String(_input), body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: new Headers(init?.headers) };
    return new Response("bad modifier", { status: 500 });
  }) as typeof fetch;
  try {
    const bad = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "m@thinkin:on", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(bad.res.status, 400);
    const err = bad.body.error as { code?: string; message?: string };
    assert.equal(err.code, "convert_request_failed");
    assert.match(String(err.message), /unsupported model modifier "thinkin"/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Claude ConvertOpenAIRequest JSON is sent upstream with system blocks, tools, and default max_tokens", async () => {
  const { e, auth, sk } = await boot();
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "claude",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-3-5-sonnet,claude-3-7-sonnet-thinking",
        group: "default",
        base_url: "https://anthropic.example.test",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url: String(input), body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const relay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-5-sonnet",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hi" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get weather by city",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
              },
            },
          ],
          tool_choice: "auto",
        }),
      }),
      e,
    );
    assert.equal(relay.res.status, 200, relay.text);
    if (!captured) throw new Error("missing upstream request");
    assert.match(captured.url, /anthropic\.example\.test\/v1\/messages/);
    assert.equal(captured.body.model, "claude-3-5-sonnet");
    assert.equal(captured.body.max_tokens, 8192);
    assert.deepEqual(captured.body.system, [{ type: "text", text: "You are a helpful assistant." }]);
    assert.deepEqual(captured.body.messages, [{ role: "user", content: "hi" }]);
    assert.deepEqual(captured.body.tool_choice, { type: "auto" });
    const tools = captured.body.tools as { name: string; input_schema: { type: string } }[];
    assert.equal(tools[0].name, "get_weather");
    assert.equal(tools[0].input_schema.type, "object");

    const thinkingRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet-thinking",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 4096,
        }),
      }),
      e,
    );
    assert.equal(thinkingRelay.res.status, 200, thinkingRelay.text);
    assert.equal(captured.body.model, "claude-3-7-sonnet");
    const thinking = captured.body.thinking as { type: string; budget_tokens: number };
    assert.equal(thinking.type, "enabled");
    assert.equal(thinking.budget_tokens, Math.max(Math.trunc((4096 * 80) / 100), 1024));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Claude DoResponse JSON is returned to OpenAI clients with usage and tool_calls", async () => {
  const { e, auth, sk } = await boot();
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "claude-resp",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-test",
        group: "default",
        base_url: "https://anthropic.example.test",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "msg_fixed",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [
          { type: "text", text: "The answer is 42." },
          { type: "tool_use", id: "toolu_abc", name: "get_weather", input: { city: "Paris" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const relay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(relay.res.status, 200, relay.text);
    assert.equal(relay.body.id, "msg_fixed");
    assert.equal(relay.body.model, "claude-test");
    const choice = (relay.body.choices as { message: Record<string, unknown>; finish_reason: string }[])[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, "The answer is 42.");
    const tools = choice.message.tool_calls as { function: { arguments: string } }[];
    assert.equal(tools[0].function.arguments, '{"city":"Paris"}');
    const usage = relay.body.usage as Record<string, unknown>;
    assert.equal(usage.prompt_tokens, 15);
    assert.equal(usage.completion_tokens, 5);
    assert.equal(usage.total_tokens, 20);
    assert.equal(usage.usage_semantic, "openai");
    assert.equal(usage.usage_source, "anthropic");
    assert.equal((usage.billing_usage as { source: string }).source, "claude_messages");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Gemini DoResponse JSON is returned to OpenAI clients with usage and tool_calls", async () => {
  const { e, auth, sk } = await boot();
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-resp",
        type: CHANNEL_TYPE_GEMINI,
        key: "gem-key",
        models: "gemini-2.0-flash",
        group: "default",
        base_url: "https://generativelanguage.googleapis.com",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ text: "The answer is 42." }, { functionCall: { name: "get_weather", args: { city: "Paris" } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 15 },
      }),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const relay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(relay.res.status, 200, relay.text);
    assert.equal(relay.body.model, "gemini-2.0-flash");
    assert.match(String(relay.body.id), /^chatcmpl-/);
    const choice = (relay.body.choices as { message: Record<string, unknown>; finish_reason: string }[])[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, "The answer is 42.");
    const usage = relay.body.usage as Record<string, unknown>;
    assert.equal(usage.prompt_tokens, 10);
    assert.equal(usage.completion_tokens, 7);
    assert.equal(usage.total_tokens, 15);
    const billing = usage.billing_usage as { source: string; gemini_usage_metadata: { thoughtsTokenCount: number } };
    assert.equal(billing.source, "gemini_chat");
    assert.equal(billing.gemini_usage_metadata.thoughtsTokenCount, 2);
    assert.equal((usage.completion_tokens_details as { reasoning_tokens: number }).reasoning_tokens, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});
