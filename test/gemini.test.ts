import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_GEMINI } from "../src/constants.js";
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

test("original GetGeminiVersionSetting uses v1 for gemini-1.0-pro GetRequestURL", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-version",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-1.0-pro,gemini-2.0-flash",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const origFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const pro = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-1.0-pro",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(pro.res.status, 200, pro.text);
    assert.equal(urls[0], "https://generativelanguage.googleapis.com/v1/models/gemini-1.0-pro:generateContent?key=gkey");

    const flash = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(flash.res.status, 200, flash.text);
    assert.equal(urls[1], "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gkey");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Gemini ConvertClaudeRequest and Claude ConvertGeminiRequest HTTP JSON fields", async () => {
  const { e, auth, sk } = await boot();
  const gemini = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-claude",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-2.0-flash",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(gemini.body.success, true, String(gemini.body.message));
  const anthropic = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "anthropic-gemini",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-3-7-sonnet",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(anthropic.body.success, true, String(anthropic.body.message));

  const origFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body: parsed });
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                role: "model",
                parts: [
                  { text: "hello from gemini" },
                  { functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_claude",
        type: "message",
        role: "assistant",
        model: "claude-3-7-sonnet",
        content: [
          { type: "text", text: "hello from claude" },
          { type: "tool_use", id: "toolu_9", name: "lookup", input: { q: "y" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claudeClient = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          max_tokens: 1024,
          system: "You are a helpful assistant.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              input_schema: { type: "object", properties: { q: { type: "string" } } },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What is in this image?" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
              ],
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(claudeClient.res.status, 200, claudeClient.text);
    assert.equal(
      calls[0].url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gkey",
    );
    const geminiBody = calls[0].body;
    assert.equal((geminiBody.systemInstruction as { parts: { text: string }[] }).parts[0].text, "You are a helpful assistant.");
    assert.equal((geminiBody.generationConfig as { maxOutputTokens: number }).maxOutputTokens, 1024);
    assert.equal(
      (geminiBody.tools as { functionDeclarations: { name: string }[] }[])[0].functionDeclarations[0].name,
      "lookup",
    );
    const userParts = (geminiBody.contents as { parts: Record<string, unknown>[] }[])[0].parts;
    assert.equal(userParts[0].text, "What is in this image?");
    assert.deepEqual(userParts[1].inlineData, { mimeType: "image/png", data: "aGVsbG8=" });
    assert.equal(claudeClient.body.type, "message");
    assert.equal(claudeClient.body.role, "assistant");
    const claudeBlocks = claudeClient.body.content as { type: string; text?: string; name?: string }[];
    assert.ok(claudeBlocks.some((block) => block.type === "text" && block.text === "hello from gemini"));
    assert.ok(claudeBlocks.some((block) => block.type === "tool_use" && block.name === "lookup"));

    const geminiClient = await json(
      new Request("http://local/v1beta/models/claude-3-7-sonnet:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "What is in this image?" },
                { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
              ],
            },
          ],
          systemInstruction: { parts: [{ text: "You are a helpful assistant." }] },
          tools: [
            {
              functionDeclarations: [
                {
                  name: "lookup",
                  description: "Lookup data",
                  parameters: { type: "object", properties: { q: { type: "string" } } },
                },
              ],
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(geminiClient.res.status, 200, geminiClient.text);
    assert.equal(calls[1].url, "https://api.anthropic.com/v1/messages");
    const claudeBody = calls[1].body;
    const system = claudeBody.system as { text: string }[];
    assert.ok(system[0].text.includes("You are a helpful assistant."));
    assert.ok(JSON.stringify(claudeBody.tools).includes("lookup"));
    assert.ok(Number(claudeBody.max_tokens) > 0);
    const blocks = (claudeBody.messages as { content: { type: string; source?: { type: string } }[] }[])[0].content;
    assert.ok(blocks.some((block) => block.type === "image" || block.source?.type === "base64"));
    const candidates = geminiClient.body.candidates as { content: { parts: Record<string, unknown>[] } }[];
    assert.ok(candidates[0].content.parts.some((part) => part.text === "hello from claude"));
    assert.ok(candidates[0].content.parts.some((part) => (part.functionCall as { name?: string } | undefined)?.name === "lookup"));
  } finally {
    globalThis.fetch = origFetch;
  }
});
