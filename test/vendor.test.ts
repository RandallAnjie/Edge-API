import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI } from "../src/constants.js";
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

test("original Volc, xAI, and DeepSeek ConvertOpenAIRequest JSON is sent upstream", async () => {
  const { e, auth, sk } = await boot();
  const volc = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc",
        type: CHANNEL_TYPE_VOLC,
        key: "vk",
        models: "deepseek-v3-thinking,doubao-pro",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(volc.body.success, true, String(volc.body.message));
  const xai = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "xai",
        type: CHANNEL_TYPE_XAI,
        key: "xk",
        models: "grok-2-search,grok-3-mini-high",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(xai.body.success, true, String(xai.body.message));
  const deepseek = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "deepseek",
        type: CHANNEL_TYPE_DEEPSEEK,
        key: "dk",
        models: "deepseek-v4-flash-none,deepseek-v4-pro-max",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(deepseek.body.success, true, String(deepseek.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
    return new Response(
      JSON.stringify({
        id: "chatcmpl-vendor",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const thinking = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v3-thinking",
          messages: [{ role: "user", content: "hi" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(thinking.res.status, 200, thinking.text);
    if (!captured) throw new Error("missing volc upstream");
    assert.equal(captured.url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(captured.body.model, "deepseek-v3");
    assert.deepEqual(captured.body.thinking, { type: "enabled" });
    assert.deepEqual(captured.body.stream_options, { include_usage: true });

    const search = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-2-search",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(search.res.status, 200, search.text);
    if (!captured) throw new Error("missing xai search upstream");
    assert.equal(captured.url, "https://api.x.ai/v1/chat/completions");
    assert.equal(captured.body.model, "grok-2");
    assert.deepEqual(captured.body.search_parameters, { mode: "on" });

    const mini = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-3-mini-high",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 16,
        }),
      }),
      e,
    );
    assert.equal(mini.res.status, 200, mini.text);
    if (!captured) throw new Error("missing grok-3-mini upstream");
    assert.equal(captured.body.model, "grok-3-mini");
    assert.equal(captured.body.reasoning_effort, "high");
    assert.equal(captured.body.max_completion_tokens, 16);
    assert.equal("max_tokens" in captured.body, false);

    const v4 = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro-max",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(v4.res.status, 200, v4.text);
    if (!captured) throw new Error("missing deepseek upstream");
    assert.equal(captured.url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(captured.body.model, "deepseek-v4-pro");
    assert.deepEqual(captured.body.thinking, { type: "enabled" });
    assert.equal(captured.body.reasoning_effort, "max");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original VolcEngine ConvertClaudeRequest HTTP JSON, URLs, and Gemini not implemented", async () => {
  const { e, auth, sk } = await boot();
  const volcAdd = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-claude",
        type: CHANNEL_TYPE_VOLC,
        key: "vk",
        models: "doubao-pro,deepseek-v3-thinking",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(volcAdd.body.success, true, String(volcAdd.body.message));
  const planAdd = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-plan",
        type: CHANNEL_TYPE_VOLC,
        key: "vk-plan",
        models: "doubao-pro-plan",
        group: "default",
        base_url: "doubao-coding-plan",
      }),
    }),
    e,
  );
  assert.equal(planAdd.body.success, true, String(planAdd.body.message));

  const openaiSse = [
    'data: {"id":"chatcmpl_volc","model":"doubao-pro","choices":[{"index":0,"delta":{"content":"hello volc"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl_volc","model":"doubao-pro","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected volc claude body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    if (parsed.stream === true) {
      return new Response(openaiSse, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.includes("/api/coding/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_plan",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "plan ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_volc",
        model: parsed.model,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claudeBody = {
      model: "doubao-pro",
      max_tokens: 32,
      tools: [{ name: "lookup", description: "find", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "YWE=" } },
          ],
        },
      ],
    };
    const volc = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify(claudeBody),
      }),
      e,
    );
    assert.equal(volc.res.status, 200, volc.text);
    assert.equal(calls[0].url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(calls[0].body.model, "doubao-pro");
    assert.deepEqual((calls[0].body.messages as Record<string, unknown>[])[0].content, [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
    ]);
    assert.equal(volc.body.type, "message");
    assert.equal(volc.body.stop_reason, "tool_use");
    assert.deepEqual(volc.body.content, [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }]);

    const thinking = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v3-thinking",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(thinking.res.status, 200, thinking.text);
    assert.equal(calls[1].url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(calls[1].body.model, "deepseek-v3");
    assert.deepEqual(calls[1].body.thinking, { type: "enabled" });

    const plan = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ...claudeBody, model: "doubao-pro-plan" }),
      }),
      e,
    );
    assert.equal(plan.res.status, 200, plan.text);
    assert.equal(calls[2].url, "https://ark.cn-beijing.volces.com/api/coding/v1/messages");
    assert.equal(((calls[2].body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
    assert.equal((calls[2].body.tools as { name: string }[])[0].name, "lookup");
    assert.equal("function" in (calls[2].body.tools as Record<string, unknown>[])[0], false);
    assert.equal(plan.body.type, "message");
    assert.equal(plan.body.stop_reason, "end_turn");
    assert.deepEqual(plan.body.content, [{ type: "text", text: "plan ok" }]);

    const stream = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "doubao-pro",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(stream.res.status, 200, stream.text);
    assert.equal(stream.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(calls[3].url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(calls[3].body.stream, true);
    assert.equal("stream_options" in calls[3].body, false);
    assert.match(stream.text, /event: message_start/);
    assert.match(stream.text, /hello volc/);
    assert.match(stream.text, /event: message_stop/);

    const gemini = await json(
      new Request("http://local/v1beta/models/doubao-pro:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      e,
    );
    assert.equal(gemini.res.status, 500, gemini.text);
    assert.match(gemini.text, /not implemented/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
