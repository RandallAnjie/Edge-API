import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { removeDisabledFields, usesRemoveDisabledFields } from "../src/relay-disabled-fields.js";
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

test("original RemoveDisabledFields JSON fields", () => {
  const passthroughInput = {
    service_tier: "flex",
    safety_identifier: "user-123",
    store: true,
    stream_options: { include_obfuscation: false },
  };
  assert.equal(removeDisabledFields(passthroughInput, {}, true), passthroughInput);
  assert.equal(removeDisabledFields(passthroughInput, {}, false, true), passthroughInput);

  const defaultInput = {
    service_tier: "flex",
    inference_geo: "eu",
    speed: "fast",
    cache_control: { type: "ephemeral" },
    safety_identifier: "user-123",
    store: true,
    stream_options: { include_obfuscation: false },
  };
  assert.deepEqual(removeDisabledFields(defaultInput, {}, false), {
    cache_control: { type: "ephemeral" },
    store: true,
  });

  const identity = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
  assert.equal(removeDisabledFields(identity, {}, false), identity);

  assert.deepEqual(removeDisabledFields({ inference_geo: "eu", store: true }, { allow_inference_geo: true }, false), {
    inference_geo: "eu",
    store: true,
  });
  assert.deepEqual(removeDisabledFields({ speed: "fast", store: true }, { allow_speed: true }, false), {
    speed: "fast",
    store: true,
  });
  assert.deepEqual(removeDisabledFields({ service_tier: "flex", store: true }, { allow_service_tier: true }, false), {
    service_tier: "flex",
    store: true,
  });
  const noStore = removeDisabledFields({ store: true, model: "gpt-4o" }, { disable_store: true }, false) as Record<string, unknown>;
  assert.equal("store" in noStore, false);
  assert.equal(noStore.model, "gpt-4o");

  const keptUsage = removeDisabledFields(
    { stream_options: { include_obfuscation: false, include_usage: true } },
    {},
    false,
  ) as Record<string, unknown>;
  assert.deepEqual(keptUsage.stream_options, { include_usage: true });

  const allowedObfuscation = {
    stream_options: { include_obfuscation: false },
    store: true,
  };
  assert.deepEqual(removeDisabledFields(allowedObfuscation, { allow_include_obfuscation: true }, false), allowedObfuscation);

  assert.equal(usesRemoveDisabledFields("openai", "chat"), true);
  assert.equal(usesRemoveDisabledFields("openai", "completions"), true);
  assert.equal(usesRemoveDisabledFields("openai", "responses"), true);
  assert.equal(usesRemoveDisabledFields("anthropic", "messages"), true);
  assert.equal(usesRemoveDisabledFields("gemini", "gemini"), false);
  assert.equal(usesRemoveDisabledFields("openai", "embeddings"), false);
  assert.equal(usesRemoveDisabledFields("openai", "images"), false);
  assert.equal(usesRemoveDisabledFields("gemini", "chat", true), true);
});

test("original RemoveDisabledFields TextHelper ClaudeHelper ResponsesHelper GeminiHelper HTTP JSON", async () => {
  const { e, auth, sk } = await boot();
  const openai = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-disabled-fields",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://api.openai.example",
      }),
    }),
    e,
  );
  assert.equal(openai.body.success, true, String(openai.body.message));

  const openaiAllow = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-allow-tier",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-allow",
        models: "gpt-4o-allow",
        group: "default",
        base_url: "https://api.openai-allow.example",
        settings: { allow_service_tier: true, disable_store: true },
      }),
    }),
    e,
  );
  assert.equal(openaiAllow.body.success, true, String(openaiAllow.body.message));

  const claude = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "claude-disabled-fields",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "ak-test",
        models: "claude-3-7-sonnet",
        group: "default",
        base_url: "https://api.anthropic.example",
      }),
    }),
    e,
  );
  assert.equal(claude.body.success, true, String(claude.body.message));

  const gemini = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-disabled-fields",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-2.0-flash",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(gemini.body.success, true, String(gemini.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    calls.push({ url, body: parsed });
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("api.anthropic.example")) {
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-3-7-sonnet",
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/responses")) {
      return new Response(
        JSON.stringify({
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "gpt-4o-mini",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        model: "gpt-4o-mini",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
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
          model: "gpt-4o-mini",
          service_tier: "flex",
          inference_geo: "eu",
          speed: "fast",
          safety_identifier: "user-123",
          store: true,
          stream_options: { include_obfuscation: false, include_usage: true },
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    const chatHit = calls.find((c) => c.url === "https://api.openai.example/v1/chat/completions");
    if (!chatHit) throw new Error("missing openai chat upstream");
    assert.equal("service_tier" in chatHit.body, false);
    assert.equal("inference_geo" in chatHit.body, false);
    assert.equal("speed" in chatHit.body, false);
    assert.equal("safety_identifier" in chatHit.body, false);
    assert.equal(chatHit.body.store, true);
    assert.deepEqual(chatHit.body.stream_options, { include_usage: true });

    const allowed = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-allow",
          service_tier: "priority",
          store: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(allowed.res.status, 200, allowed.text);
    const allowHit = calls.find((c) => c.url === "https://api.openai-allow.example/v1/chat/completions");
    if (!allowHit) throw new Error("missing allow-tier openai upstream");
    assert.equal(allowHit.body.service_tier, "priority");
    assert.equal("store" in allowHit.body, false);

    const messages = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-7-sonnet",
          max_tokens: 32,
          service_tier: "flex",
          inference_geo: "eu",
          speed: "fast",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(messages.res.status, 200, messages.text);
    const claudeHit = calls.find((c) => c.url.includes("api.anthropic.example"));
    if (!claudeHit) throw new Error("missing claude upstream");
    assert.equal("service_tier" in claudeHit.body, false);
    assert.equal("inference_geo" in claudeHit.body, false);
    assert.equal("speed" in claudeHit.body, false);
    assert.equal(claudeHit.body.max_tokens, 32);

    const responses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          service_tier: "flex",
          store: true,
          stream_options: { include_obfuscation: false },
          input: "hi",
        }),
      }),
      e,
    );
    assert.equal(responses.res.status, 200, responses.text);
    const responsesHit = calls.find((c) => c.url === "https://api.openai.example/v1/responses");
    if (!responsesHit) throw new Error("missing openai responses upstream");
    assert.equal("service_tier" in responsesHit.body, false);
    assert.equal(responsesHit.body.store, true);
    assert.equal("stream_options" in responsesHit.body, false);

    const geminiClient = await json(
      new Request("http://local/v1beta/models/gemini-2.0-flash:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          service_tier: "flex",
        }),
      }),
      e,
    );
    assert.equal(geminiClient.res.status, 200, geminiClient.text);
    const geminiHit = calls.find((c) => c.url.includes("generativelanguage.googleapis.com"));
    if (!geminiHit) throw new Error("missing gemini upstream");
    assert.equal(geminiHit.body.service_tier, "flex");
  } finally {
    globalThis.fetch = origFetch;
  }
});
