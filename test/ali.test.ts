import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ALI } from "../src/constants.js";
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

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>) {
  const res = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
  return res;
}

test("original Ali image rerank Claude URL ConvertImageRequest DoResponse JSON fields", async () => {
  const { e, auth, sk } = await boot();
  await addChannel(e, auth, {
    name: "ali",
    type: CHANNEL_TYPE_ALI,
    key: "sk-ali",
    models: "qwen-plus,qwen-image-3.0-pro,gte-rerank-v2,deepseek-r1",
    group: "default",
  });

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.includes("/api/v1/services/aigc/multimodal-generation/generation")) {
      return new Response(
        JSON.stringify({ output: { results: [{ url: "https://example.com/ali.png" }] }, usage: { image_count: 1 } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/api/v1/services/rerank/text-rerank/text-rerank")) {
      return new Response(
        JSON.stringify({
          output: { results: [{ index: 1, relevance_score: 0.88, document: { text: "doc" } }] },
          usage: { total_tokens: 9 },
          request_id: "req-ali",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/apps/anthropic/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_ali",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "hello qwen" }],
          model: "qwen-plus",
          stop_reason: "end_turn",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/compatible-mode/v1/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-ali",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello mapped" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const image = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen-image-3.0-pro",
          prompt: "poster",
          size: "1024x1024",
          n: 1,
        }),
      }),
      e,
    );
    assert.equal(image.res.status, 200, image.text);
    const imageCall = calls.find((c) => c.url.includes("/multimodal-generation/generation"));
    if (!imageCall) throw new Error("missing ali image upstream");
    assert.equal(imageCall.url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    assert.equal(imageCall.headers.get("authorization"), "Bearer sk-ali");
    assert.equal(imageCall.headers.get("x-dashscope-async"), null);
    assert.deepEqual(imageCall.body.input, { messages: [{ role: "user", content: [{ text: "poster" }] }] });
    assert.equal((imageCall.body.parameters as { n: number; size: string }).n, 1);
    assert.equal((imageCall.body.parameters as { size: string }).size, "1024*1024");
    assert.deepEqual(image.body.data, [{ url: "https://example.com/ali.png", b64_json: "", revised_prompt: "" }]);
    assert.equal(typeof image.body.created, "number");
    assert.equal((image.body.metadata as { output?: { results?: unknown[] } })?.output?.results?.[0] != null, true);

    const rerank = await json(
      new Request("http://local/v1/rerank", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gte-rerank-v2", query: "q", documents: ["a", "b"] }),
      }),
      e,
    );
    assert.equal(rerank.res.status, 200, rerank.text);
    const rerankCall = calls.find((c) => c.url.includes("/text-rerank/text-rerank"));
    if (!rerankCall) throw new Error("missing ali rerank upstream");
    assert.deepEqual(rerankCall.body.input, { query: "q", documents: ["a", "b"] });
    assert.equal((rerankCall.body.parameters as { return_documents: boolean }).return_documents, true);
    assert.deepEqual((rerank.body.results as { index: number }[])[0], { index: 1, relevance_score: 0.88, document: { text: "doc" } });
    assert.deepEqual(rerank.body.usage, { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9 });

    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "qwen-plus",
          messages: [{ role: "user", content: "hi claude" }],
          max_tokens: 32,
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    const claudeCall = calls.find((c) => c.url.includes("/apps/anthropic/v1/messages"));
    if (!claudeCall) throw new Error("missing ali claude upstream");
    assert.equal(claudeCall.url, "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages");
    assert.deepEqual(claudeCall.body.messages, [{ role: "user", content: "hi claude" }]);
    assert.equal(claude.body.type, "message");
    assert.equal((claude.body.content as { text: string }[])[0].text, "hello qwen");

    const mappedClaude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "deepseek-r1",
          messages: [{ role: "user", content: "hi mapped" }],
          max_tokens: 16,
        }),
      }),
      e,
    );
    assert.equal(mappedClaude.res.status, 200, mappedClaude.text);
    const mappedCall = calls.find((c) => c.url.includes("/compatible-mode/v1/chat/completions"));
    if (!mappedCall) throw new Error("missing ali mapped claude upstream");
    assert.equal(mappedCall.body.model, "deepseek-r1");
    assert.equal(Array.isArray(mappedCall.body.messages), true);
    assert.equal((mappedClaude.body.choices as { message: { content: string } }[])[0].message.content, "hello mapped");

    const chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen-plus",
          messages: [{ role: "user", content: "hi" }],
          top_p: 1,
          enable_thinking: true,
          thinking_budget: 128,
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    const chatCall = calls.filter((c) => c.url.includes("/compatible-mode/v1/chat/completions")).at(-1);
    if (!chatCall) throw new Error("missing ali chat upstream");
    assert.equal(chatCall.body.top_p, 0.99);
    assert.equal(chatCall.body.thinking_budget, 128);
    assert.equal(chatCall.headers.get("authorization"), "Bearer sk-ali");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Ali multipart image edits ConvertImageRequest JSON is not rawBody passthrough", async () => {
  const { e, auth, sk } = await boot();
  await addChannel(e, auth, {
    name: "ali-edit",
    type: CHANNEL_TYPE_ALI,
    key: "sk-ali-edit",
    models: "qwen-image-3.0-pro,wanx-v1",
    group: "default",
  });

  const fixture = "fixture image";
  const expectedImage = `data:text/plain; charset=utf-8;base64,${Buffer.from(fixture).toString("base64")}`;
  const boundary = "----AliEditBoundary";
  const form =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nqwen-image-3.0-pro\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nedit poster\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n2\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="parameters"\r\n\r\n{"n":3,"prompt_extend":false}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: application/octet-stream\r\n\r\n${fixture}\r\n` +
    `--${boundary}--\r\n`;

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; contentType: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({
      url,
      body,
      contentType: new Headers(init?.headers).get("content-type") || "",
    });
    if (url.includes("/api/v1/services/aigc/multimodal-generation/generation")) {
      return new Response(
        JSON.stringify({ output: { results: [{ url: "https://example.com/ali-edit.png" }] }, usage: { image_count: 3 } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const image = await json(
      new Request("http://local/v1/images/edits", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
        body: form,
      }),
      e,
    );
    assert.equal(image.res.status, 200, image.text);
    const imageCall = calls.find((c) => c.url.includes("/multimodal-generation/generation"));
    if (!imageCall) throw new Error("missing ali image edit upstream");
    assert.equal(imageCall.url, "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    assert.equal(imageCall.contentType, "application/json");
    assert.doesNotMatch(imageCall.contentType, /multipart/);
    assert.equal((imageCall.body.parameters as { n: number; prompt_extend: boolean }).n, 3);
    assert.equal((imageCall.body.parameters as { prompt_extend: boolean }).prompt_extend, false);
    assert.deepEqual(imageCall.body.input, {
      messages: [{ role: "user", content: [{ image: expectedImage }, { text: "edit poster" }] }],
    });
    assert.deepEqual(image.body.data, [{ url: "https://example.com/ali-edit.png", b64_json: "", revised_prompt: "" }]);
  } finally {
    globalThis.fetch = origFetch;
  }
});
