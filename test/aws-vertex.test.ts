import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_AWS, CHANNEL_TYPE_VERTEX } from "../src/constants.js";
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

test("original AWS Nova and Vertex ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  const aws = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "aws",
        type: CHANNEL_TYPE_AWS,
        key: "ak|us-east-1",
        models: "nova-lite-v1:0,claude-3-haiku-20240307",
        group: "default",
        settings: { aws_key_type: "api_key" },
      }),
    }),
    e,
  );
  assert.equal(aws.body.success, true, String(aws.body.message));
  const vertex = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "vertex",
        type: CHANNEL_TYPE_VERTEX,
        key: "vkey",
        models: "claude-3-5-sonnet-20241022,gemini-2.0-flash,imagen-3.0-generate-001",
        group: "default",
        other: JSON.stringify({ default: "us-central1" }),
        settings: { vertex_key_type: "api_key" },
      }),
    }),
    e,
  );
  assert.equal(vertex.body.success, true, String(vertex.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown>; headers: Headers } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: new Headers(init?.headers) };
    if (url.includes("nova-")) {
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: "hello nova" }] } },
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("publishers/anthropic") || url.includes("anthropic.claude")) {
      return new Response(
        JSON.stringify({
          id: "msg_aws",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok claude" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(":predict")) {
      return new Response(
        JSON.stringify({ predictions: [{ bytesBase64Encoded: "YWE=" }, { bytesBase64Encoded: "YmI=", raiFilteredReason: "blocked" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "ok gemini" }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const novaRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "nova-lite-v1:0",
          messages: [{ role: "user", content: "hi nova" }],
          max_tokens: 32,
        }),
      }),
      e,
    );
    assert.equal(novaRelay.res.status, 200, novaRelay.text);
    if (!captured) throw new Error("missing nova upstream");
    assert.equal(captured.url, "https://bedrock-runtime.amazon.nova-lite-v1:0.amazonaws.com/model/us-east-1/converse");
    assert.equal(captured.headers.get("authorization"), "Bearer ak|us-east-1");
    assert.equal(captured.body.schemaVersion, "messages-v1");
    assert.deepEqual(captured.body.messages, [{ role: "user", content: [{ text: "hi nova" }] }]);
    assert.deepEqual(captured.body.inferenceConfig, { maxTokens: 32 });
    assert.equal("model" in captured.body, false);
    assert.equal((novaRelay.body.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello nova");
    assert.equal((novaRelay.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");
    assert.equal((novaRelay.body.usage as { prompt_tokens: number }).prompt_tokens, 4);
    assert.equal((novaRelay.body.usage as { completion_tokens: number }).completion_tokens, 6);
    assert.equal((novaRelay.body.usage as { total_tokens: number }).total_tokens, 10);

    const awsClaude = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
          ],
        }),
      }),
      e,
    );
    assert.equal(awsClaude.res.status, 200, awsClaude.text);
    if (!captured) throw new Error("missing aws claude upstream");
    assert.equal(
      captured.url,
      "https://bedrock-runtime.anthropic.claude-3-haiku-20240307-v1:0.amazonaws.com/model/us-east-1/converse",
    );
    assert.equal("schemaVersion" in captured.body, false);
    assert.equal(captured.body.model, "claude-3-haiku-20240307");
    assert.deepEqual(captured.body.system, [{ type: "text", text: "sys" }]);
    assert.equal(captured.body.max_tokens, 8192);
    assert.equal("anthropic_version" in captured.body, false);
    assert.equal((awsClaude.body.choices as { message: { content: string } }[])[0].message.content, "ok claude");

    const vertexClaude = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "hi" },
          ],
          max_tokens: 1024,
        }),
      }),
      e,
    );
    assert.equal(vertexClaude.res.status, 200, vertexClaude.text);
    if (!captured) throw new Error("missing vertex claude upstream");
    assert.equal(
      captured.url,
      "https://us-central1-aiplatform.googleapis.com/v1/publishers/anthropic/models/claude-3-5-sonnet-v2@20241022:rawPredict?key=vkey",
    );
    assert.equal(captured.body.anthropic_version, "vertex-2023-10-16");
    assert.equal("model" in captured.body, false);
    assert.deepEqual(captured.body.system, [{ type: "text", text: "sys" }]);
    assert.equal(captured.body.max_tokens, 1024);

    const vertexGemini = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
            },
            { role: "tool", tool_call_id: "call_1", content: "15 degrees" },
          ],
        }),
      }),
      e,
    );
    assert.equal(vertexGemini.res.status, 200, vertexGemini.text);
    if (!captured) throw new Error("missing vertex gemini upstream");
    assert.equal(
      captured.url,
      "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.0-flash:generateContent?key=vkey",
    );
    const contents = captured.body.contents as { role: string; parts: Record<string, unknown>[] }[];
    const call = contents.find((c) => c.role === "model")?.parts.find((p) => p.functionCall) as { functionCall: { id?: string; name: string } };
    assert.equal(call.functionCall.name, "get_weather");
    assert.equal("id" in call.functionCall, false);
    const resp = contents.find((c) => c.parts.some((p) => p.functionResponse))?.parts.find((p) => p.functionResponse) as {
      functionResponse: { id?: string };
    };
    assert.equal("id" in resp.functionResponse, false);
    assert.equal("model" in captured.body, false);

    const imagen = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "imagen-3.0-generate-001",
          messages: [{ role: "user", content: "a cat" }],
          n: 1,
          size: "1024x1024",
        }),
      }),
      e,
    );
    assert.equal(imagen.res.status, 200, imagen.text);
    if (!captured) throw new Error("missing imagen upstream");
    assert.equal(
      captured.url,
      "https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/imagen-3.0-generate-001:predict?key=vkey",
    );
    assert.deepEqual(captured.body.instances, [{ prompt: "a cat" }]);
    assert.deepEqual(captured.body.parameters, { sampleCount: 1, aspectRatio: "1:1", personGeneration: "allow_adult" });
    assert.deepEqual(imagen.body.data, [{ url: "", b64_json: "YWE=", revised_prompt: "" }]);
    assert.equal(VERTEX_IMAGE_TOKENS, 258);
  } finally {
    globalThis.fetch = origFetch;
  }
});
