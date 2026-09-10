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
