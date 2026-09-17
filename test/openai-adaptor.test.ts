import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_AZURE, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_PERPLEXITY, CHANNEL_TYPE_SILICONFLOW } from "../src/constants.js";
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
    "customer-claude": 1,
    "customer-gemini": 1,
    "Qwen/Qwen2-7B-Instruct": 1,
    sonar: 1,
  });
  return { e, auth, sk };
}

test("original openai.Adaptor ConvertClaudeRequest / ConvertGeminiRequest / ConvertResponse HTTP JSON", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-upstream",
        models: "customer-claude,gpt-4o-mini,customer-gemini",
        group: "default",
        base_url: "https://api.openai.example",
        model_mapping: JSON.stringify({
          "customer-claude": "gpt-4o-mini",
          "customer-gemini": "gpt-4o-mini",
        }),
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
      throw new Error("unexpected openai adaptor body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    if (parsed.tools) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_tool",
          model: "gpt-4o-mini",
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
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_text",
        model: "gpt-4o-mini",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hello from openai" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "customer-claude",
          max_tokens: 32,
          stop_sequences: ["END"],
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
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.example/v1/chat/completions");
    assert.equal(calls[0].body.model, "gpt-4o-mini");
    assert.equal(calls[0].body.stop, "END");
    assert.deepEqual((calls[0].body.messages as Record<string, unknown>[])[0].content, [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
    ]);
    assert.equal(claude.body.type, "message");
    assert.equal(claude.body.role, "assistant");
    assert.equal(claude.body.stop_reason, "tool_use");
    assert.deepEqual(claude.body.content, [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }]);
    assert.equal((claude.body.usage as { input_tokens: number }).input_tokens, 4);
    assert.equal((claude.body.usage as { output_tokens: number }).output_tokens, 6);

    const gemini = await json(
      new Request("http://local/v1beta/models/customer-gemini:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello gemini" }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 64 },
        }),
      }),
      e,
    );
    assert.equal(gemini.res.status, 200, gemini.text);
    assert.equal(calls[1].url, "https://api.openai.example/v1/chat/completions");
    assert.equal(calls[1].body.model, "gpt-4o-mini");
    assert.deepEqual(calls[1].body.messages, [{ role: "user", content: "hello gemini" }]);
    const candidates = gemini.body.candidates as Record<string, unknown>[];
    assert.equal(candidates[0].finishReason, "STOP");
    assert.deepEqual(candidates[0].safetyRatings, []);
    assert.deepEqual(candidates[0].content, { role: "model", parts: [{ text: "hello from openai" }] });
    assert.equal((gemini.body.usageMetadata as { promptTokenCount: number }).promptTokenCount, 2);
    assert.equal((gemini.body.usageMetadata as { candidatesTokenCount: number }).candidatesTokenCount, 3);
    assert.equal((gemini.body.usageMetadata as { totalTokenCount: number }).totalTokenCount, 5);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Azure openai.Adaptor GetRequestURL rewrites /v1/messages to chat/completions", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "azure",
        type: CHANNEL_TYPE_AZURE,
        key: "ak",
        models: "gpt-4o",
        group: "default",
        base_url: "https://demo.openai.azure.com",
        other: "2025-04-01-preview",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected azure adaptor body");
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_az",
        model: "gpt-4o",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "azure hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.equal(
      calls[0],
      "https://demo.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-04-01-preview",
    );
    assert.equal(claude.body.type, "message");
    assert.equal(claude.body.stop_reason, "end_turn");
    assert.deepEqual(claude.body.content, [{ type: "text", text: "azure hi" }]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original openai.Adaptor stream ConvertResponse Claude/Gemini SSE JSON", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-stream",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-upstream",
        models: "customer-claude,customer-gemini",
        group: "default",
        base_url: "https://api.openai.example",
        model_mapping: JSON.stringify({
          "customer-claude": "gpt-4o-mini",
          "customer-gemini": "gpt-4o-mini",
        }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const openaiSse = [
    'data: {"id":"chatcmpl_stream","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello from stream"},"finish_reason":null}]}',
    "",
    'data: {"id":"chatcmpl_stream","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
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
      throw new Error("unexpected openai adaptor stream body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    return new Response(openaiSse, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "customer-claude",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.equal(claude.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(calls[0].url, "https://api.openai.example/v1/chat/completions");
    assert.equal(calls[0].body.stream, true);
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
    assert.match(claude.text, /event: message_start/);
    assert.match(claude.text, /"type":"content_block_start"/);
    assert.match(claude.text, /"type":"text_delta"/);
    assert.match(claude.text, /hello from stream/);
    assert.match(claude.text, /"stop_reason":"end_turn"/);
    assert.match(claude.text, /event: message_stop/);
    assert.match(claude.text, /"input_tokens":5/);
    assert.match(claude.text, /"output_tokens":2/);

    const gemini = await json(
      new Request("http://local/v1beta/models/customer-gemini:streamGenerateContent", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hello gemini stream" }] }],
        }),
      }),
      e,
    );
    assert.equal(gemini.res.status, 200, gemini.text);
    assert.equal(calls[1].url, "https://api.openai.example/v1/chat/completions");
    assert.equal(calls[1].body.stream, true);
    assert.match(gemini.text, /"text":"hello from stream"/);
    assert.match(gemini.text, /"finishReason":"STOP"/);
    assert.match(gemini.text, /"promptTokenCount":5/);
    assert.match(gemini.text, /"candidatesTokenCount":2/);
    assert.match(gemini.text, /"role":"model"/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original SiliconFlow/Perplexity ConvertClaudeRequest HTTP JSON and URLs", async () => {
  const { e, auth, sk } = await boot();
  const sfAdd = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "siliconflow",
        type: CHANNEL_TYPE_SILICONFLOW,
        key: "sfk",
        models: "Qwen/Qwen2-7B-Instruct",
        group: "default",
        base_url: "https://api.siliconflow.cn",
      }),
    }),
    e,
  );
  assert.equal(sfAdd.body.success, true, String(sfAdd.body.message));
  const pplxAdd = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "perplexity",
        type: CHANNEL_TYPE_PERPLEXITY,
        key: "pplx",
        models: "sonar",
        group: "default",
        base_url: "https://api.perplexity.ai",
      }),
    }),
    e,
  );
  assert.equal(pplxAdd.body.success, true, String(pplxAdd.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected delegated claude body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_sf",
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
      model: "Qwen/Qwen2-7B-Instruct",
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
    const sf = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify(claudeBody),
      }),
      e,
    );
    assert.equal(sf.res.status, 200, sf.text);
    assert.equal(calls[0].url, "https://api.siliconflow.cn/v1/messages");
    assert.equal(calls[0].body.model, "Qwen/Qwen2-7B-Instruct");
    assert.deepEqual((calls[0].body.messages as Record<string, unknown>[])[0].content, [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
    ]);
    assert.equal(sf.body.type, "message");
    assert.equal(sf.body.stop_reason, "tool_use");
    assert.deepEqual(sf.body.content, [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }]);

    const pplx = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ ...claudeBody, model: "sonar" }),
      }),
      e,
    );
    assert.equal(pplx.res.status, 200, pplx.text);
    assert.equal(calls[1].url, "https://api.perplexity.ai/chat/completions");
    assert.equal(pplx.body.type, "message");
    assert.equal(pplx.body.stop_reason, "tool_use");

    const gemini = await json(
      new Request("http://local/v1beta/models/sonar:generateContent", {
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

test("original openai.Adaptor OpenAI→Claude citations and citations_delta JSON", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-cite",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-upstream",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://api.openai.example",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (parsed.stream === true) {
      const sse = [
        'data: {"id":"chatcmpl_cite","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"see this","annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com/a","title":"Example","cited_text":"see"}}]},"finish_reason":null}]}',
        "",
        'data: {"id":"chatcmpl_cite","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_cite",
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "see this",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: "https://example.com/a", title: "Example", start_index: 0, end_index: 3 },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.deepEqual(claude.body.content, [
      {
        type: "text",
        text: "see this",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com/a",
            title: "Example",
            cited_text: "see",
          },
        ],
      },
    ]);

    const stream = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(stream.res.status, 200, stream.text);
    assert.match(stream.text, /"type":"citations_delta"/);
    assert.match(stream.text, /"type":"web_search_result_location"/);
    assert.match(stream.text, /https:\/\/example.com\/a/);
    assert.match(stream.text, /"cited_text":"see"/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
