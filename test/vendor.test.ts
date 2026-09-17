import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_DEEPSEEK, CHANNEL_TYPE_MINIMAX, CHANNEL_TYPE_MOONSHOT, CHANNEL_TYPE_VOLC, CHANNEL_TYPE_XAI, CHANNEL_TYPE_ZHIPU_V4 } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";
import { mergeModelRatio } from "./merge-model-ratio.js";

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
  await mergeModelRatio(new Store(e.DB), {
    "deepseek-v3-thinking": 1,
    "deepseek-v3": 1,
    "doubao-pro": 1,
    "doubao-pro-plan": 1,
    "grok-2-search": 1,
    "grok-3-mini-high": 1,
    "grok-3-mini": 1,
    "grok-3": 1,
    "grok-2-image": 1,
    "deepseek-v4-pro-max": 1,
    "deepseek-v4-flash-none": 1,
    "kimi-k2.5": 1,
    "abab6.5s-chat": 1,
  });
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
    assert.equal("stream_options" in captured.body, false);

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

    const xaiResponses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-3-mini-high",
          input: "hi",
        }),
      }),
      e,
    );
    assert.equal(xaiResponses.res.status, 200, xaiResponses.text);
    if (!captured) throw new Error("missing grok-3-mini responses upstream");
    assert.equal(captured.url, "https://api.x.ai/v1/responses");
    assert.equal(captured.body.model, "grok-3-mini-high");
    assert.equal("reasoning" in captured.body, false);
    assert.equal("reasoning_effort" in captured.body, false);

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

    const responses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-flash-none",
          input: "hi",
        }),
      }),
      e,
    );
    assert.equal(responses.res.status, 200, responses.text);
    if (!captured) throw new Error("missing deepseek responses upstream");
    assert.equal(captured.url, "https://api.deepseek.com/responses");
    assert.equal(captured.body.model, "deepseek-v4-flash");
    assert.deepEqual(captured.body.reasoning, { effort: "none" });
    assert.equal("thinking" in captured.body, false);
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

test("original Moonshot/MiniMax/DeepSeek ConvertClaudeRequest HTTP JSON and Gemini not implemented", async () => {
  const { e, auth, sk } = await boot();
  const adds = await Promise.all([
    json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "moonshot",
          type: CHANNEL_TYPE_MOONSHOT,
          key: "mk",
          models: "kimi-k2.5",
          group: "default",
        }),
      }),
      e,
    ),
    json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "minimax",
          type: CHANNEL_TYPE_MINIMAX,
          key: "mmk",
          models: "abab6.5s-chat",
          group: "default",
        }),
      }),
      e,
    ),
    json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "deepseek-claude",
          type: CHANNEL_TYPE_DEEPSEEK,
          key: "dk",
          models: "deepseek-v4-pro-max",
          group: "default",
        }),
      }),
      e,
    ),
    json(
      new Request("http://local/api/channel/", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          name: "zhipu-v4",
          type: CHANNEL_TYPE_ZHIPU_V4,
          key: "zk",
          models: "glm-4",
          group: "default",
        }),
      }),
      e,
    ),
  ]);
  for (const add of adds) assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected native claude body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    return new Response(
      JSON.stringify({
        id: "msg_native",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claudeBody = {
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
    const moonshot = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ...claudeBody, model: "kimi-k2.5" }),
      }),
      e,
    );
    assert.equal(moonshot.res.status, 200, moonshot.text);
    assert.equal(calls[0].url, "https://api.moonshot.cn/anthropic/v1/messages");
    assert.equal(((calls[0].body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
    assert.equal((calls[0].body.tools as { name: string }[])[0].name, "lookup");
    assert.equal("function" in (calls[0].body.tools as Record<string, unknown>[])[0], false);
    assert.equal(moonshot.body.type, "message");
    assert.deepEqual(moonshot.body.content, [{ type: "text", text: "ok" }]);

    const minimax = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ...claudeBody, model: "abab6.5s-chat" }),
      }),
      e,
    );
    assert.equal(minimax.res.status, 200, minimax.text);
    assert.equal(calls[1].url, "https://api.minimax.chat/anthropic/v1/messages");
    assert.equal(((calls[1].body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
    assert.equal(minimax.body.type, "message");

    const deepseek = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4-pro-max",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(deepseek.res.status, 200, deepseek.text);
    assert.equal(calls[2].url, "https://api.deepseek.com/anthropic/v1/messages");
    assert.equal(calls[2].body.model, "deepseek-v4-pro");
    assert.deepEqual(calls[2].body.thinking, { type: "enabled" });
    assert.deepEqual(calls[2].body.output_config, { effort: "max" });

    const zhipu = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ...claudeBody, model: "glm-4" }),
      }),
      e,
    );
    assert.equal(zhipu.res.status, 200, zhipu.text);
    assert.equal(calls[3].url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(((calls[3].body.messages as Record<string, unknown>[])[0].content as Record<string, unknown>[])[1].type, "image");
    assert.equal(zhipu.body.type, "message");

    const gemini = await json(
      new Request("http://local/v1beta/models/kimi-k2.5:generateContent", {
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

test("original xAI ConvertImageRequest JSON, ConvertClaudeRequest not available, and embeddings not available", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "xai-image",
        type: CHANNEL_TYPE_XAI,
        key: "xk",
        models: "grok-2-image,grok-3-mini-high",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected xai body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://img.example/xai.png", b64_json: null, revised_prompt: null }] }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const image = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-2-image",
          prompt: "a cat",
          n: 2,
          size: "1024x1024",
          quality: "hd",
          style: "vivid",
          user: "alice",
          response_format: "url",
        }),
      }),
      e,
    );
    assert.equal(image.res.status, 200, image.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.x.ai/v1/images/generations");
    assert.deepEqual(calls[0].body, { model: "grok-2-image", prompt: "a cat", n: 2, response_format: "url" });
    assert.equal((image.body.data as { url: string }[])[0].url, "https://img.example/xai.png");

    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-3-mini-high",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 500, claude.text);
    assert.equal(claude.body.type, "error");
    assert.equal((claude.body.error as { message: string }).message, "not available");
    assert.equal((claude.body.error as { type: string }).type, "new_api_error");
    assert.equal("code" in (claude.body.error as object), false);
    assert.equal(calls.length, 1);

    const gemini = await json(
      new Request("http://local/v1beta/models/grok-3-mini-high:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      e,
    );
    assert.equal(gemini.res.status, 500, gemini.text);
    assert.equal((gemini.body.error as { message: string }).message, "not implemented");
    assert.equal((gemini.body.error as { code: string }).code, "convert_request_failed");

    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-3-mini-high", input: "hi" }),
      }),
      e,
    );
    assert.equal(embed.res.status, 500, embed.text);
    assert.equal((embed.body.error as { message: string }).message, "not available");
    assert.equal((embed.body.error as { code: string }).code, "convert_request_failed");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original xAIHandler HTTP JSON rewrites completion_tokens and text_tokens", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "xai-usage",
        type: CHANNEL_TYPE_XAI,
        key: "xk",
        models: "grok-3",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-xai",
        object: "chat.completion",
        created: 1,
        model: "grok-3",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 25,
          completion_tokens_details: {
            reasoning_tokens: 5,
            audio_tokens: 0,
            accepted_prediction_tokens: 0,
            rejected_prediction_tokens: 0,
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-3",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    const usage = chat.body.usage as Record<string, unknown>;
    assert.equal(usage.prompt_tokens, 10);
    assert.equal(usage.completion_tokens, 15);
    assert.equal(usage.total_tokens, 25);
    assert.equal((usage.completion_tokens_details as Record<string, unknown>).text_tokens, 10);
    assert.equal((usage.completion_tokens_details as Record<string, unknown>).reasoning_tokens, 5);
    assert.equal(chat.body.system_fingerprint, "");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original xAIStreamHandler HTTP SSE rewrites completion_tokens without text_tokens", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "xai-stream",
        type: CHANNEL_TYPE_XAI,
        key: "xk",
        models: "grok-3",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const sse = [
    'data: {"id":"chatcmpl-xai","object":"chat.completion.chunk","created":1,"model":"grok-3","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl-xai","object":"chat.completion.chunk","created":1,"model":"grok-3","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":25,"completion_tokens_details":{"reasoning_tokens":5,"text_tokens":1,"audio_tokens":0,"image_tokens":0}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const stream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "grok-3",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
      e,
    );
    assert.equal(stream.res.status, 200, stream.text);
    assert.match(stream.text, /data: \[DONE\]/);
    assert.match(stream.text, /"completion_tokens":15/);
    assert.match(stream.text, /"text_tokens":1/);
    assert.equal(stream.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Moonshot ConvertAudioRequest and ConvertOpenAIResponsesRequest HTTP JSON errors", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "moonshot-endpoint",
        type: CHANNEL_TYPE_MOONSHOT,
        key: "mk",
        models: "kimi-k2.5",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("upstream must not be called");
  }) as typeof fetch;
  try {
    const speech = await json(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k2.5", input: "hi" }),
      }),
      e,
    );
    assert.equal(speech.res.status, 500, speech.text);
    assert.equal((speech.body.error as { message: string }).message, "not supported");
    assert.equal((speech.body.error as { code: string }).code, "convert_request_failed");
    assert.equal((speech.body.error as { type: string }).type, "new_api_error");

    const boundary = "----MoonshotAudio";
    const raw =
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nkimi-k2.5\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n` +
      `--${boundary}--\r\n`;
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const transcription = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
        body: bytes.buffer,
      }),
      e,
    );
    assert.equal(transcription.res.status, 500, transcription.text);
    assert.equal((transcription.body.error as { message: string }).message, "not supported");
    assert.equal((transcription.body.error as { code: string }).code, "convert_request_failed");

    const responses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-k2.5", input: "hi" }),
      }),
      e,
    );
    assert.equal(responses.res.status, 500, responses.text);
    assert.equal((responses.body.error as { message: string }).message, "not implemented");
    assert.equal((responses.body.error as { code: string }).code, "convert_request_failed");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original DeepSeek ConvertImage/Audio/Embedding HTTP JSON errors", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "deepseek-endpoint",
        type: CHANNEL_TYPE_DEEPSEEK,
        key: "dk",
        models: "deepseek-chat",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("upstream must not be called");
  }) as typeof fetch;
  try {
    const image = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(image.res.status, 500, image.text);
    assert.equal((image.body.error as { message: string }).message, "not implemented");
    assert.equal((image.body.error as { code: string }).code, "convert_request_failed");

    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", input: "hi" }),
      }),
      e,
    );
    assert.equal(embed.res.status, 500, embed.text);
    assert.equal((embed.body.error as { message: string }).message, "not implemented");

    const speech = await json(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", input: "hi" }),
      }),
      e,
    );
    assert.equal(speech.res.status, 500, speech.text);
    assert.equal((speech.body.error as { message: string }).message, "not implemented");
  } finally {
    globalThis.fetch = origFetch;
  }
});
