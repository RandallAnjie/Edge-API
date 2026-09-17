import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OLLAMA } from "../src/constants.js";
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
  await mergeModelRatio(new Store(e.DB), { llama3: 1 });
  return { e, auth, sk };
}

test("original Ollama ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "ollama",
        type: CHANNEL_TYPE_OLLAMA,
        key: "ollama-key",
        models: "llama3",
        group: "default",
        base_url: "http://localhost:11434",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: new Headers(init?.headers) };
    if (url.includes("/v1/messages")) {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "llama3",
          content: [{ type: "text", text: "hello claude" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/api/embed")) {
      return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]], prompt_eval_count: 4, model: "nomic" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/generate")) {
      return new Response(
        JSON.stringify({
          model: "llama3",
          created_at: "2026-05-27T12:00:00Z",
          response: "ok generate",
          done: true,
          done_reason: "stop",
          prompt_eval_count: 2,
          eval_count: 3,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (init?.body && String(init.body).includes('"stream":true')) {
      const ndjson = [
        JSON.stringify({
          model: "llama3",
          created_at: "2026-05-27T12:00:00Z",
          message: { role: "assistant", content: "ok " },
          done: false,
        }),
        JSON.stringify({
          model: "llama3",
          created_at: "2026-05-27T12:00:00Z",
          message: { role: "assistant", content: "stream" },
          done: false,
        }),
        JSON.stringify({
          model: "llama3",
          created_at: "2026-05-27T12:00:00Z",
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 2,
          eval_count: 2,
        }),
      ].join("\n");
      return new Response(ndjson, { headers: { "content-type": "application/x-ndjson" } });
    }
    return new Response(
      JSON.stringify({
        model: "llama3",
        created_at: "2026-05-27T12:00:00Z",
        message: { role: "assistant", content: "hello ollama" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 4,
        eval_count: 6,
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
          model: "llama3",
          messages: [{ role: "user", content: "hi ollama" }],
          max_tokens: 32,
          temperature: 0,
          reasoning: { effort: "medium" },
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    if (!captured) throw new Error("missing ollama chat upstream");
    assert.equal(captured.url, "http://localhost:11434/api/chat");
    assert.equal(captured.headers.get("authorization"), "Bearer ollama-key");
    assert.equal(captured.body.model, "llama3");
    assert.equal(captured.body.stream, false);
    assert.equal("max_tokens" in captured.body, false);
    assert.deepEqual(captured.body.messages, [{ role: "user", content: "hi ollama" }]);
    assert.deepEqual(captured.body.options, { temperature: 0, num_predict: 32 });
    assert.equal(captured.body.think, "medium");
    assert.equal((chat.body.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello ollama");
    assert.equal((chat.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");
    assert.equal((chat.body.usage as { prompt_tokens: number }).prompt_tokens, 4);
    assert.equal((chat.body.usage as { completion_tokens: number }).completion_tokens, 6);
    assert.equal((chat.body.usage as { total_tokens: number }).total_tokens, 10);

    const generate = await json(
      new Request("http://local/v1/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "llama3", prompt: "complete this", max_tokens: 8 }),
      }),
      e,
    );
    assert.equal(generate.res.status, 200, generate.text);
    if (!captured) throw new Error("missing ollama generate upstream");
    assert.equal(captured.url, "http://localhost:11434/api/generate");
    assert.equal(captured.body.prompt, "complete this");
    assert.equal(captured.body.stream, false);
    assert.equal("messages" in captured.body, false);
    assert.deepEqual(captured.body.options, { num_predict: 8 });
    assert.equal((generate.body.choices as { message: { content: string } }[])[0].message.content, "ok generate");
    assert.equal((generate.body.usage as { total_tokens: number }).total_tokens, 5);

    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "llama3", input: "hello" }),
      }),
      e,
    );
    assert.equal(embed.res.status, 200, embed.text);
    if (!captured) throw new Error("missing ollama embed upstream");
    assert.equal(captured.url, "http://localhost:11434/api/embed");
    assert.equal(captured.body.input, "hello");
    assert.equal("options" in captured.body, false);
    assert.equal(embed.body.object, "list");
    assert.equal(embed.body.model, "llama3");
    assert.deepEqual(embed.body.data, [{ index: 0, object: "embedding", embedding: [0.1, 0.2] }]);
    assert.equal((embed.body.usage as { prompt_tokens: number }).prompt_tokens, 4);
    assert.equal((embed.body.usage as { completion_tokens: number }).completion_tokens, 0);
    assert.equal((embed.body.usage as { total_tokens: number }).total_tokens, 4);

    const stream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "llama3",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(stream.res.status, 200, stream.text);
    if (!captured) throw new Error("missing ollama stream upstream");
    assert.equal(captured.url, "http://localhost:11434/api/chat");
    assert.equal(captured.body.stream, true);
    const sse = String(stream.body.raw || stream.text);
    assert.equal(sse.includes("data: [DONE]"), true);
    const frames = sse
      .split("\n\n")
      .map((block) => block.replace(/^data: /, ""))
      .filter((line) => line && line !== "[DONE]");
    const first = JSON.parse(frames[0]) as { choices: { delta: { role: string; content: string } }[] };
    assert.equal(first.choices[0].delta.role, "assistant");
    assert.equal(first.choices[0].delta.content, "");
    assert.equal(sse.includes('"content":"ok "'), true);
    assert.equal(sse.includes('"content":"stream"'), true);
    const last = JSON.parse(frames[frames.length - 1]) as { usage?: { total_tokens: number }; choices: unknown[] };
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage?.total_tokens, 4);

    const claude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "messages-2023-12-15",
        },
        body: JSON.stringify({
          model: "llama3",
          messages: [{ role: "user", content: "hi claude" }],
          max_tokens: 0,
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    if (!captured) throw new Error("missing ollama claude upstream");
    assert.equal(captured.url, "http://localhost:11434/v1/messages");
    assert.equal(captured.headers.get("authorization"), "Bearer ollama-key");
    assert.equal(captured.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(captured.headers.get("anthropic-beta"), "messages-2023-12-15");
    assert.equal(captured.body.max_tokens, 8192);
    assert.deepEqual(captured.body.messages, [{ role: "user", content: "hi claude" }]);
    assert.equal(claude.body.type, "message");
    assert.equal(claude.body.role, "assistant");
    assert.deepEqual(claude.body.content, [{ type: "text", text: "hello claude" }]);
    assert.equal(claude.body.object, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});
