import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_CODEX } from "../src/constants.js";
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

test("original Codex ConvertOpenAIRequest throw and ConvertOpenAIResponsesRequest JSON", async () => {
  const { e, auth, sk } = await boot();
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "codex-convert",
        type: CHANNEL_TYPE_CODEX,
        key: JSON.stringify({ access_token: "codex-at", account_id: "acct-1", refresh_token: "rt", type: "codex" }),
        models: "gpt-5.1-codex",
        group: "default",
        setting: JSON.stringify({ system_prompt: "Answer in English.", system_prompt_override: true }),
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
    return new Response(
      JSON.stringify({
        id: "resp_codex",
        object: "response",
        output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const chat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.1-codex",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(chat.res.status, 500, chat.text);
    assert.match(
      String((chat.body.error as { message?: string } | undefined)?.message || chat.text),
      /codex channel: \/v1\/chat\/completions endpoint not supported/,
    );

    const responses = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.1-codex",
          input: "hello",
          instructions: "be brief",
          max_output_tokens: 128,
          temperature: 1,
          frequency_penalty: 1.5,
          presence_penalty: 1.5,
        }),
      }),
      e,
    );
    assert.equal(responses.res.status, 200, responses.text);
    const hit = calls.find((c) => c.url === "https://chatgpt.com/backend-api/codex/responses");
    if (!hit) throw new Error("missing codex responses upstream");
    assert.equal(hit.headers.get("authorization"), `Bearer ${"codex-at"}`);
    assert.equal(hit.headers.get("chatgpt-account-id"), "acct-1");
    assert.equal(hit.headers.get("openai-beta"), "responses=experimental");
    assert.equal(hit.headers.get("originator"), "codex_cli_rs");
    assert.equal(hit.body.store, false);
    assert.equal(hit.body.instructions, "Answer in English.\nbe brief");
    assert.equal(hit.body.model, "gpt-5.1-codex");
    assert.equal("max_output_tokens" in hit.body, false);
    assert.equal("temperature" in hit.body, false);
    assert.equal("frequency_penalty" in hit.body, false);
    assert.equal("presence_penalty" in hit.body, false);

    const compact = await json(
      new Request("http://local/v1/responses/compact", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.1-codex",
          input: "hello",
          max_output_tokens: 64,
          temperature: 0.4,
          store: true,
        }),
      }),
      e,
    );
    assert.equal(compact.res.status, 200, compact.text);
    const compactHit = calls.find((c) => c.url === "https://chatgpt.com/backend-api/codex/responses/compact");
    if (!compactHit) throw new Error("missing codex compact upstream");
    assert.equal(compactHit.body.store, true);
    assert.equal(compactHit.body.max_output_tokens, 64);
    assert.equal(compactHit.body.temperature, 0.4);
    assert.equal(compactHit.body.instructions, "Answer in English.");
  } finally {
    globalThis.fetch = origFetch;
  }
});
