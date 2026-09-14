import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_GEMINI } from "../src/constants.js";
import { VERTEX_IMAGE_TOKENS } from "../src/vertex-convert.js";
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

test("original Gemini type-24 ConvertImageRequest :predict GeminiImageHandler JSON fields", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "customer-imagen,imagen-3.0-generate-001,gemini-2.0-flash",
        group: "default",
        model_mapping: JSON.stringify({ "customer-imagen": "imagen-3.0-generate-001" }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected gemini imagen body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed, headers: new Headers(init?.headers) });
    if (url.includes(":predict") && parsed.instances && (parsed.instances as { prompt: string }[])[0]?.prompt === "empty") {
      return new Response(JSON.stringify({ predictions: [] }), { headers: { "content-type": "application/json" } });
    }
    return new Response(
      JSON.stringify({
        predictions: [
          { bytesBase64Encoded: "YWE=" },
          { bytesBase64Encoded: "YmI=", raiFilteredReason: "blocked" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const imagen = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "customer-imagen",
          prompt: "a cat",
          n: 2,
          size: "1792x1024",
          quality: "hd",
        }),
      }),
      e,
    );
    assert.equal(imagen.res.status, 200, imagen.text);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=gkey",
    );
    assert.equal(calls[0].headers.get("x-goog-api-key"), "gkey");
    assert.deepEqual(calls[0].body.instances, [{ prompt: "a cat" }]);
    assert.deepEqual(calls[0].body.parameters, {
      sampleCount: 2,
      aspectRatio: "16:9",
      personGeneration: "allow_adult",
      imageSize: "2K",
    });
    assert.deepEqual(imagen.body.data, [{ url: "", b64_json: "YWE=", revised_prompt: "" }]);
    assert.equal(VERTEX_IMAGE_TOKENS, 258);

    const unsupported = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gemini-2.0-flash", prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(unsupported.res.status, 500);
    assert.equal(
      (unsupported.body.error as { message: string }).message,
      "not supported model for image generation, only imagen models are supported",
    );
    assert.equal((unsupported.body.error as { code: string }).code, "convert_request_failed");

    const empty = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "imagen-3.0-generate-001", prompt: "empty" }),
      }),
      e,
    );
    assert.equal(empty.res.status, 500, empty.text);
    assert.equal((empty.body.error as { message: string }).message, "no images generated");
    assert.equal((empty.body.error as { code: string }).code, "bad_response_body");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Gemini type-24 ConvertEmbeddingRequest batchEmbedContents GeminiEmbeddingHandler JSON fields", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-embed",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "customer-embed,text-embedding-004,gemini-embedding-001",
        group: "default",
        model_mapping: JSON.stringify({ "customer-embed": "text-embedding-004" }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    if (raw instanceof FormData || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
      throw new Error("unexpected gemini embedding body");
    }
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed, headers: new Headers(init?.headers) });
    return new Response(
      JSON.stringify({ embeddings: [{ values: [0.11, 0.22] }, { values: [0.33, 0.44] }] }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "customer-embed",
          input: ["hello", "world"],
          dimensions: 768,
        }),
      }),
      e,
    );
    assert.equal(embed.res.status, 200, embed.text);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=gkey",
    );
    assert.equal(calls[0].headers.get("x-goog-api-key"), "gkey");
    assert.deepEqual(calls[0].body.requests, [
      {
        model: "models/text-embedding-004",
        content: { parts: [{ text: "hello" }] },
        outputDimensionality: 768,
      },
      {
        model: "models/text-embedding-004",
        content: { parts: [{ text: "world" }] },
        outputDimensionality: 768,
      },
    ]);
    assert.equal(embed.body.object, "list");
    assert.equal(embed.body.model, "text-embedding-004");
    assert.deepEqual(embed.body.data, [
      { object: "embedding", embedding: [0.11, 0.22], index: 0 },
      { object: "embedding", embedding: [0.33, 0.44], index: 1 },
    ]);
    assert.equal((embed.body.usage as { completion_tokens: number }).completion_tokens, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
