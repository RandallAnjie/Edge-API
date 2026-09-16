import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from "../src/constants.js";
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
    "gpt-test": 1,
    "claude-test": 1,
    "gpt-responses": 1,
    "gpt-from-responses": 1,
    "gemini-test": 1,
  });
  return { e, auth, sk };
}

function openaiCompletion() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-adv",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function claudeMessage() {
  return new Response(
    JSON.stringify({
      id: "msg_adv",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function geminiCandidates(text = "hello") {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function responsesUpstream() {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      object: "response",
      created_at: 123,
      status: "completed",
      model: "gpt-responses",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function upstreamFor(url: string) {
  if (url.includes("/v1/messages")) return claudeMessage();
  if (url.includes(":generateContent") || url.includes("generativelanguage")) return geminiCandidates();
  if (url.includes("/v1/responses")) return responsesUpstream();
  return openaiCompletion();
}

test("original AdvancedCustom ConvertOpenAIRequest converter JSON", async () => {
  const { e, auth, sk } = await boot();
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "adv-convert",
        type: CHANNEL_TYPE_ADVANCED_CUSTOM,
        key: "sk-adv",
        models: "gpt-test,claude-test,gemini-2.5-flash,gpt-responses,gpt-from-responses",
        group: "default",
        base_url: "https://upstream.example",
        settings: JSON.stringify({
          advanced_custom: {
            advanced_routes: [
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "/v1/chat/completions",
                converter: "none",
                models: ["gpt-test"],
              },
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "/v1/messages",
                converter: "openai_chat_completions_to_anthropic_messages",
                models: ["claude-test"],
              },
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                converter: "openai_chat_completions_to_gemini_generate_content",
                models: ["gemini-2.5-flash"],
              },
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "/v1/responses",
                converter: "openai_chat_completions_to_openai_responses",
                models: ["gpt-responses"],
              },
              {
                incoming_path: "/v1/responses",
                upstream_path: "/v1/chat/completions",
                converter: "openai_responses_to_openai_chat_completions",
                models: ["gpt-from-responses"],
              },
            ],
          },
        }),
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));

  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    calls.push({ url, body, headers });
    return upstreamFor(url);
  }) as typeof fetch;

  try {
    const none = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(none.res.status, 200, none.text);
    assert.equal(none.body.object, "chat.completion");
    assert.equal((none.body.choices as { message: { content: string } }[])[0].message.content, "ok");
    const noneHit = calls.find((c) => c.url === "https://upstream.example/v1/chat/completions" && c.body.model === "gpt-test");
    if (!noneHit) throw new Error("missing none converter upstream");
    assert.equal("stream_options" in noneHit.body, false);
    assert.equal(noneHit.headers.get("authorization"), "Bearer sk-adv");

    const claude = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-test",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    assert.equal(claude.body.object, "chat.completion");
    assert.equal((claude.body.choices as { message: { content: string } }[])[0].message.content, "ok");
    const claudeHit = calls.find((c) => c.url === "https://upstream.example/v1/messages");
    if (!claudeHit) throw new Error("missing chat→claude upstream");
    assert.equal(claudeHit.body.model, "claude-test");
    assert.equal((claudeHit.body.messages as { role: string }[])[0].role, "user");
    assert.equal(claudeHit.headers.get("anthropic-version"), "2023-06-01");

    const gemini = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-flash",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      e,
    );
    assert.equal(gemini.res.status, 200, gemini.text);
    assert.equal(gemini.body.object, "chat.completion");
    assert.equal((gemini.body.choices as { message: { content: string } }[])[0].message.content, "hello");
    const geminiHit = calls.find((c) => c.url.includes(":generateContent"));
    if (!geminiHit) throw new Error("missing chat→gemini upstream");
    assert.equal((geminiHit.body.contents as { role: string }[])[0].role, "user");

    const responses = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-responses",
          messages: [
            { role: "system", content: "system rules" },
            { role: "user", content: "hello" },
          ],
        }),
      }),
      e,
    );
    assert.equal(responses.res.status, 200, responses.text);
    assert.equal(responses.body.object, "chat.completion");
    assert.equal((responses.body.choices as { message: { content: string } }[])[0].message.content, "hello");
    const responsesHit = calls.find((c) => c.url === "https://upstream.example/v1/responses");
    if (!responsesHit) throw new Error("missing chat→responses upstream");
    assert.equal(responsesHit.body.model, "gpt-responses");
    assert.equal(responsesHit.body.instructions, "system rules");
    assert.ok(Array.isArray(responsesHit.body.input) && (responsesHit.body.input as unknown[]).length > 0);

    const fromResponses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-from-responses",
          instructions: "system rules",
          input: "hello",
        }),
      }),
      e,
    );
    assert.equal(fromResponses.res.status, 200, fromResponses.text);
    assert.equal(fromResponses.body.object, "response");
    assert.equal(fromResponses.text.includes('"type":"output_text"'), true);
    assert.equal(fromResponses.text.includes('"text":"ok"'), true);
    const chatHit = calls.find(
      (c) => c.url === "https://upstream.example/v1/chat/completions" && Array.isArray(c.body.messages) && (c.body.messages as { role: string }[])[0]?.role === "system",
    );
    if (!chatHit) throw new Error("missing responses→chat upstream");
    const msgs = chatHit.body.messages as { role: string; content: string }[];
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "system");
    assert.equal(msgs[0].content, "system rules");
    assert.equal(msgs[1].role, "user");
    assert.equal(msgs[1].content, "hello");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original AdvancedCustom responses→gemini DoResponse uses Responses bridge", async () => {
  const { e, auth, sk } = await boot();
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "adv-responses-gemini",
        type: CHANNEL_TYPE_ADVANCED_CUSTOM,
        key: "sk-adv",
        models: "gemini-test",
        group: "default",
        base_url: "https://upstream.example",
        settings: JSON.stringify({
          advanced_custom: {
            advanced_routes: [
              {
                incoming_path: "/v1/responses",
                upstream_path: "/v1beta/models/{model}:generateContent",
                converter: "openai_responses_to_gemini_generate_content",
                models: ["gemini-test"],
              },
            ],
          },
        }),
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (!url.includes(":generateContent")) throw new Error("unexpected upstream " + url);
    return geminiCandidates("hello");
  }) as typeof fetch;

  try {
    const got = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-test", input: "hello" }),
      }),
      e,
    );
    assert.equal(got.res.status, 200, got.text);
    assert.equal(got.body.object, "response");
    assert.equal(got.text.includes('"type":"output_text"'), true);
    assert.equal(got.text.includes('"text":"hello"'), true);
    assert.equal(got.text.includes('"candidates"'), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original AdvancedCustom Responses↔Chat stream DoResponse SSE JSON", async () => {
  const { e, auth, sk } = await boot();
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "adv-stream",
        type: CHANNEL_TYPE_ADVANCED_CUSTOM,
        key: "sk-adv",
        models: "gpt-responses,gpt-from-responses",
        group: "default",
        base_url: "https://upstream.example",
        settings: JSON.stringify({
          advanced_custom: {
            advanced_routes: [
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "/v1/responses",
                converter: "openai_chat_completions_to_openai_responses",
                models: ["gpt-responses"],
              },
              {
                incoming_path: "/v1/responses",
                upstream_path: "/v1/chat/completions",
                converter: "openai_responses_to_openai_chat_completions",
                models: ["gpt-from-responses"],
              },
            ],
          },
        }),
      }),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/responses")) {
      return new Response(
        [
          `data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-responses","created_at":1710000000}}`,
          `data: {"type":"response.output_text.delta","delta":"hello"}`,
          `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}`,
          `data: [DONE]`,
          ``,
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    if (url.includes("/v1/chat/completions")) {
      return new Response(
        [
          `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
          `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: { content: "ok" } }] })}`,
          `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", created: 123, model: "gpt-from-responses", choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}`,
          `data: [DONE]`,
          ``,
        ].join("\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error("unexpected upstream " + url);
  }) as typeof fetch;

  try {
    const chat = await handleFetch(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-responses",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      }),
      e,
      ctx(),
    );
    const chatText = await chat.text();
    assert.equal(chat.status, 200, chatText);
    assert.equal(chat.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.match(chatText, /"role":"assistant"/);
    assert.match(chatText, /"content":"hello"/);
    assert.match(chatText, /"finish_reason":"stop"/);
    assert.match(chatText, /"usage":\{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3/);
    assert.match(chatText, /data: \[DONE\]/);

    const responses = await handleFetch(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-from-responses", input: "hello", stream: true }),
      }),
      e,
      ctx(),
    );
    const responsesText = await responses.text();
    assert.equal(responses.status, 200, responsesText);
    assert.equal(responses.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.match(responsesText, /event: response\.created/);
    assert.match(responsesText, /"sequence_number":0/);
    assert.match(responsesText, /"delta":"ok"/);
    assert.match(responsesText, /event: response\.completed/);
    assert.match(responsesText, /"text":"ok"/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
