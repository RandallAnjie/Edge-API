import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
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

function headerMap(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
  return out;
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

test("original via-responses ApplyParamOverride on OpenAI chat JSON fields", async () => {
  const { e, auth, sk } = await boot();
  const policy = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        key: "global.chat_completions_to_responses_policy",
        value: JSON.stringify({ enabled: true, all_channels: true, model_patterns: [".*"] }),
      }),
    }),
    e,
  );
  assert.equal(policy.body.success, true, String(policy.body.message));

  const openai = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-via-chat-override",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-via-chat",
        models: "gpt-4o-via",
        group: "default",
        base_url: "https://api.openai-via.example",
        header_override: JSON.stringify({ "X-Via-Chat": "applied" }),
        param_override: JSON.stringify({
          operations: [
            { path: "messages.0.content", mode: "set", value: "overridden-chat" },
            { path: "max_tokens", mode: "set", value: 32 },
            {
              path: "temperature",
              mode: "set",
              value: 0.1,
              conditions: [{ path: "request_path", mode: "contains", value: "/v1/chat/completions" }],
            },
          ],
        }),
      }),
    }),
    e,
  );
  assert.equal(openai.body.success, true, String(openai.body.message));

  const claude = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-via-claude-override",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-via-claude",
        models: "gpt-4o-claude-via",
        group: "default",
        base_url: "https://api.openai-via-claude.example",
        param_override: JSON.stringify({
          operations: [
            { path: "messages.0.content", mode: "set", value: "should-not-apply-on-claude-via" },
            { path: "max_output_tokens", mode: "set", value: 99 },
          ],
        }),
      }),
    }),
    e,
  );
  assert.equal(claude.body.success, true, String(claude.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    calls.push({ url, body: parsed, headers: headerMap(init) });
    return new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-4o-via",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
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
          model: "gpt-4o-via",
          max_tokens: 16,
          temperature: 0.9,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 200, chat.text);
    const chatHit = calls.find((c) => c.url === "https://api.openai-via.example/v1/responses");
    if (!chatHit) throw new Error("missing openai via-responses upstream: " + JSON.stringify(calls.map((c) => c.url)));
    assert.equal("messages" in chatHit.body, false);
    assert.equal((chatHit.body.input as { content?: string }[])[0].content, "overridden-chat");
    assert.equal(chatHit.body.max_output_tokens, 32);
    assert.equal("max_tokens" in chatHit.body, false);
    assert.equal(chatHit.body.temperature, 0.1);
    assert.equal(chatHit.headers["x-via-chat"], "applied");

    const messages = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "gpt-4o-claude-via",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      e,
    );
    assert.equal(messages.res.status, 200, messages.text);
    const claudeHit = calls.find((c) => c.url === "https://api.openai-via-claude.example/v1/responses");
    if (!claudeHit) throw new Error("missing claude via-responses upstream: " + JSON.stringify(calls.map((c) => c.url)));
    assert.equal((claudeHit.body.input as { content?: string }[])[0].content, "hello");
    assert.equal(
      ((claudeHit.body.messages as { content?: string }[] | undefined) || [])[0]?.content,
      "should-not-apply-on-claude-via",
    );
    assert.equal(claudeHit.body.max_output_tokens, 99);
  } finally {
    globalThis.fetch = origFetch;
  }
});
