import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import {
  applyGetAndValidateRequest,
  embeddingCombineText,
  exceedsMaxTokensLimit,
  getAndValidateClaudeRequest,
  getAndValidateEmbeddingRequest,
  getAndValidateGeminiRequest,
  getAndValidateRerankRequest,
  getAndValidateResponsesRequest,
  getAndValidateTextRequest,
  MAX_TOKENS_LIMIT,
  parseEmbeddingInput,
} from "../src/valid-request.js";
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("valid-request.ts must not import store / relay / convert / query / submit", () => {
  const src = readFileSync(join(root, "src/valid-request.ts"), "utf8");
  assert.doesNotMatch(src, /from ["']\.\/(store|relay|convert|query|submit)/);
});

test("original GetAndValidateEmbeddingRequest JSON DTO fields", () => {
  assert.deepEqual(parseEmbeddingInput(null), []);
  assert.deepEqual(parseEmbeddingInput("hello"), ["hello"]);
  assert.deepEqual(parseEmbeddingInput(["a", 1, "b"]), ["a", "b"]);
  assert.equal(embeddingCombineText({ input: ["hello", "world"] }), "hello\nworld");

  assert.throws(() => getAndValidateEmbeddingRequest("embeddings", {}), /input is empty/);
  assert.throws(() => getAndValidateEmbeddingRequest("embeddings", { model: "m", input: null }), /input is empty/);
  const emptyString = getAndValidateEmbeddingRequest("embeddings", { model: "m", input: "", extra: 1 });
  assert.equal(emptyString.input, "");
  assert.equal("extra" in emptyString, false);
  const emptyArr = getAndValidateEmbeddingRequest("embeddings", { model: "m", input: [] });
  assert.deepEqual(emptyArr.input, []);

  const engines = getAndValidateEmbeddingRequest(
    "engines_embeddings",
    { input: "hi" },
    "/v1/engines/text-embedding-ada-002/embeddings",
  );
  assert.equal(engines.model, "text-embedding-ada-002");
  assert.equal(engines.input, "hi");

  const moderation = getAndValidateEmbeddingRequest("moderations", { input: "hi" });
  assert.equal(moderation.model, "omni-moderation-latest");
});

test("original GetAndValidateRerankRequest JSON fields", () => {
  assert.throws(() => getAndValidateRerankRequest({ model: "r", documents: ["a"] }), /query is empty/);
  assert.throws(() => getAndValidateRerankRequest({ model: "r", query: "q" }), /documents is empty/);
  assert.throws(() => getAndValidateRerankRequest({ model: "r", query: "q", documents: [] }), /documents is empty/);
  const ok = getAndValidateRerankRequest({
    model: "r",
    query: "q",
    documents: ["a"],
    extra: true,
    top_n: 3,
  });
  assert.deepEqual(ok, { documents: ["a"], query: "q", model: "r", top_n: 3 });
});

test("original GetAndValidateGeminiRequest JSON fields", () => {
  assert.throws(() => getAndValidateGeminiRequest({}), /contents is required/);
  assert.throws(() => getAndValidateGeminiRequest({ contents: [] }), /contents is required/);
  const ok = getAndValidateGeminiRequest({ contents: [{ parts: [{ text: "hi" }] }] });
  assert.equal((ok.contents as unknown[]).length, 1);
  const batch = getAndValidateGeminiRequest({ requests: [{ contents: [{ parts: [{ text: "hi" }] }] }] });
  assert.equal((batch.requests as unknown[]).length, 1);
  assert.equal(exceedsMaxTokensLimit(MAX_TOKENS_LIMIT), false);
  assert.equal(exceedsMaxTokensLimit(MAX_TOKENS_LIMIT + 1), true);
  assert.throws(
    () => getAndValidateGeminiRequest({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: MAX_TOKENS_LIMIT + 1 } }),
    /maxOutputTokens is invalid/,
  );
});

test("original GetAndValidateTextRequest / Claude / Responses JSON fields", () => {
  assert.throws(() => getAndValidateTextRequest("chat", { model: "gpt-4o-mini" }), /field messages is required/);
  const fim = getAndValidateTextRequest("chat", { model: "qwen", prefix: "def ", suffix: ":" });
  assert.equal(fim.prefix, "def ");
  const search = getAndValidateTextRequest("chat", {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    web_search_options: {},
  });
  assert.deepEqual(search.web_search_options, { search_context_size: "medium" });
  assert.throws(
    () =>
      getAndValidateTextRequest("chat", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        web_search_options: { search_context_size: "huge" },
      }),
    /invalid search_context_size/,
  );
  assert.throws(
    () =>
      getAndValidateTextRequest("chat", {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: MAX_TOKENS_LIMIT + 1,
      }),
    /max_tokens is invalid/,
  );
  assert.throws(() => getAndValidateTextRequest("completions", { model: "davinci", prompt: "" }), /field prompt is required/);
  const missingPrompt = getAndValidateTextRequest("completions", { model: "davinci" });
  assert.equal("prompt" in missingPrompt, false);
  assert.throws(() => getAndValidateTextRequest("moderations", { model: "omni-moderation-latest" }), /field input is required/);

  assert.throws(() => getAndValidateClaudeRequest({ model: "claude-3", max_tokens: 32 }), /field messages is required/);
  assert.throws(() => getAndValidateResponsesRequest({ model: "gpt-4o" }), /input is required/);
  const compact = applyGetAndValidateRequest("responses", "/v1/responses/compact", { model: "gpt-4o" });
  assert.equal((compact as { model: string }).model, "gpt-4o");
});

test("original GetAndValidateEmbeddingRequest HTTP JSON rejects empty input after model", async () => {
  const { e, sk } = await boot();
  const missingInput = await json(
    new Request("http://local/v1/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small" }),
    }),
    e,
  );
  assert.equal(missingInput.res.status, 400, missingInput.text);
  assert.equal((missingInput.body.error as { message?: string }).message, "input is empty");
  assert.equal((missingInput.body.error as { code?: string }).code, "invalid_request");
  assert.equal((missingInput.body.error as { type?: string }).type, "new_api_error");
  assert.equal((missingInput.body.error as { param?: string }).param, "");

  const missingModel = await json(
    new Request("http://local/v1/embeddings", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(missingModel.res.status, 400, missingModel.text);
  assert.equal((missingModel.body.error as { message?: string }).message, "Model name not specified, model name cannot be empty");
});

test("original GetAndValidateRerankRequest HTTP JSON rejects empty query/documents", async () => {
  const { e, sk } = await boot();
  const query = await json(
    new Request("http://local/v1/rerank", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "rerank-english-v3.0", documents: ["a"] }),
    }),
    e,
  );
  assert.equal(query.res.status, 400, query.text);
  assert.equal((query.body.error as { message?: string }).message, "query is empty");
  assert.equal((query.body.error as { code?: string }).code, "invalid_request");

  const documents = await json(
    new Request("http://local/v1/rerank", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "rerank-english-v3.0", query: "q" }),
    }),
    e,
  );
  assert.equal(documents.res.status, 400, documents.text);
  assert.equal((documents.body.error as { message?: string }).message, "documents is empty");
});

test("original GetAndValidateGeminiRequest HTTP JSON rejects empty contents", async () => {
  const { e, sk } = await boot();
  const missing = await json(
    new Request("http://local/v1beta/models/gemini-2.0-flash:generateContent", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(missing.res.status, 400, missing.text);
  assert.equal((missing.body.error as { message?: string }).message, "contents is required");
  assert.equal((missing.body.error as { code?: string }).code, "invalid_request");
});

test("original GetAndValidateTextRequest HTTP JSON rejects empty chat messages", async () => {
  const { e, sk } = await boot();
  const missing = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini" }),
    }),
    e,
  );
  assert.equal(missing.res.status, 400, missing.text);
  assert.equal((missing.body.error as { message?: string }).message, "field messages is required");
  assert.equal((missing.body.error as { code?: string }).code, "invalid_request");
});

test("original GetAndValidateResponsesRequest HTTP JSON rejects missing input", async () => {
  const { e, sk } = await boot();
  const missing = await json(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    }),
    e,
  );
  assert.equal(missing.res.status, 400, missing.text);
  assert.equal((missing.body.error as { message?: string }).message, "input is required");
  assert.equal((missing.body.error as { code?: string }).code, "invalid_request");
});

test("original GetAndValidateEmbeddingRequest still relays DTO input JSON", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-embed",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-up",
        models: "text-embedding-3-small",
        group: "default",
        base_url: "https://api.openai.com",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  let captured: { body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = { body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> };
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1] }],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hello",
          extra_dropped: true,
          dimensions: 8,
        }),
      }),
      e,
    );
    assert.equal(embed.res.status, 200, embed.text);
    if (!captured) throw new Error("missing embedding upstream");
    assert.equal(captured.body.input, "hello");
    assert.equal(captured.body.dimensions, 8);
    assert.equal("extra_dropped" in captured.body, false);
    assert.equal(embed.body.object, "list");
  } finally {
    globalThis.fetch = origFetch;
  }
});
