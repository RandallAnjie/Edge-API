import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_AWS } from "../src/constants.js";
import {
  AWS_BEDROCK_ANTHROPIC_VERSION,
  awsInvokeUrl,
  awsPassThroughInvokeBody,
  formatAwsClaudeRequest,
  parseAwsAkskKey,
  resolveAwsInvokeModelId,
} from "../src/aws-convert.js";
import {
  applyAwsAkskAuth,
  AWS_SIGV4_ALGORITHM,
  AWS_SIGV4_SERVICE,
  signAwsSigV4,
} from "../src/aws-auth.js";
import {
  decodeAwsEventStreamResponse,
  encodeAwsBedrockChunk,
  eventStreamToClaudeSse,
} from "../src/aws-eventstream.js";
import { bytesToHex, sha256Bytes } from "../src/crypto.js";
import { buildUpstream } from "../src/upstream.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { ChannelRow, Env, ExecutionContextLike } from "../src/types.js";

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

function testChannel(partial: Partial<ChannelRow>): ChannelRow {
  return {
    id: 1,
    type: CHANNEL_TYPE_AWS,
    key: "AKID|secret|us-east-1",
    status: 1,
    name: "aws",
    weight: 1,
    created_time: 0,
    test_time: 0,
    response_time: 0,
    base_url: "",
    other: "",
    models: "claude-3-haiku-20240307",
    group: "default",
    used_quota: 0,
    model_mapping: "",
    status_code_mapping: "",
    priority: 0,
    auto_ban: 1,
    tag: "",
    header_override: "",
    param_override: "",
    remark: "",
    settings: JSON.stringify({ aws_key_type: "ak_sk" }),
    openai_organization: "",
    test_model: "",
    ...partial,
  };
}

test("original newAwsClient 2-part bearer vs 3-part AKSK JSON", () => {
  assert.deepEqual(parseAwsAkskKey("token|us-east-1"), { mode: "bearer", token: "token", region: "us-east-1" });
  assert.deepEqual(parseAwsAkskKey("AKID|secret|us-west-2"), {
    mode: "aksk",
    accessKey: "AKID",
    secretKey: "secret",
    region: "us-west-2",
  });
  assert.throws(() => parseAwsAkskKey("onlyone"), /invalid aws secret key/);
  assert.throws(() => parseAwsAkskKey("a|b|c|d"), /invalid aws secret key/);
});

test("original doAwsClientRequest cross-region InvokeModel URL JSON fields", () => {
  assert.equal(resolveAwsInvokeModelId("claude-3-haiku-20240307", "us-east-1"), "us.anthropic.claude-3-haiku-20240307-v1:0");
  assert.equal(resolveAwsInvokeModelId("nova-lite-v1:0", "us-east-1"), "us.amazon.nova-lite-v1:0");
  assert.equal(resolveAwsInvokeModelId("nova-lite-v1:0", "ap-northeast-1"), "amazon.nova-lite-v1:0");
  assert.equal(
    awsInvokeUrl("us-east-1", "us.anthropic.claude-3-haiku-20240307-v1:0", false),
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-haiku-20240307-v1%3A0/invoke",
  );
  assert.equal(
    awsInvokeUrl("us-east-1", "us.anthropic.claude-3-haiku-20240307-v1:0", true),
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
  );
});

test("original aws.formatRequest Claude JSON fields", () => {
  const formatted = formatAwsClaudeRequest(
    {
      model: "claude-3-haiku-20240307",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 128,
    },
    { "anthropic-beta": "computer-use-2025-01-24,max-tokens-3-5-sonnet-2024-07-15" },
  );
  assert.equal(formatted.anthropic_version, AWS_BEDROCK_ANTHROPIC_VERSION);
  assert.deepEqual(formatted.anthropic_beta, ["computer-use-2025-01-24", "max-tokens-3-5-sonnet-2024-07-15"]);
  assert.equal("model" in formatted, false);
  assert.equal("stream" in formatted, false);
  assert.equal(formatted.max_tokens, 128);
  assert.deepEqual(formatted.messages, [{ role: "user", content: "hello" }]);
  const kept = formatAwsClaudeRequest({ anthropic_beta: ["from-body"], messages: [] });
  assert.deepEqual(kept.anthropic_beta, ["from-body"]);
  const pass = awsPassThroughInvokeBody({ model: "x", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal("model" in pass, false);
  assert.equal("stream" in pass, false);
  assert.deepEqual(pass.messages, [{ role: "user", content: "hi" }]);
});

test("original AWS AKSK SigV4 header JSON fields", async () => {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  const url = awsInvokeUrl("us-east-1", "us.anthropic.claude-3-haiku-20240307-v1:0", false);
  const body = { anthropic_version: AWS_BEDROCK_ANTHROPIC_VERSION, messages: [] };
  const payload = await signAwsSigV4(
    headers,
    url,
    "POST",
    body,
    "AKID",
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "us-east-1",
    new Date("2026-09-15T12:00:00Z"),
  );
  assert.equal(payload, JSON.stringify(body));
  assert.equal(headers["x-amz-date"], "20260915T120000Z");
  assert.equal(headers["x-amz-content-sha256"], bytesToHex(await sha256Bytes(payload)));
  assert.match(headers.authorization, new RegExp(`^${AWS_SIGV4_ALGORITHM} Credential=AKID/20260915/us-east-1/${AWS_SIGV4_SERVICE}/aws4_request, SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`));

  const apiKeyHeaders = { authorization: "Bearer keep" };
  const apiKeyBody = await applyAwsAkskAuth(
    { type: CHANNEL_TYPE_AWS, settings: JSON.stringify({ aws_key_type: "api_key" }) },
    apiKeyHeaders,
    url,
    "POST",
    { keep: true },
    "ak|us-east-1",
  );
  assert.deepEqual(apiKeyBody, { keep: true });
  assert.equal(apiKeyHeaders.authorization, "Bearer keep");

  const bearerHeaders: Record<string, string> = {};
  await applyAwsAkskAuth(
    { type: CHANNEL_TYPE_AWS, settings: JSON.stringify({ aws_key_type: "ak_sk" }) },
    bearerHeaders,
    url,
    "POST",
    {},
    "bedrock-token|us-east-1",
  );
  assert.equal(bearerHeaders.authorization, "Bearer bedrock-token");
});

test("original Bedrock eventstream chunk bytes JSON becomes Claude SSE", async () => {
  const events = [
    `{"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":100,"output_tokens":1}}}`,
    `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}`,
  ];
  const encoded = new Uint8Array(events.reduce((n, event) => n + encodeAwsBedrockChunk(event).length, 0));
  let off = 0;
  for (const event of events) {
    const chunk = encodeAwsBedrockChunk(event);
    encoded.set(chunk, off);
    off += chunk.length;
  }
  const sse = eventStreamToClaudeSse(encoded);
  assert.equal(sse, events.map((event) => `data: ${event}\n\n`).join(""));
  const res = await decodeAwsEventStreamResponse(
    new Response(encoded as unknown as BodyInit, { headers: { "content-type": "application/vnd.amazon.eventstream" } }),
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), sse);
});

test("original AWS AKSK chat JSON uses InvokeModel URL and SigV4", async () => {
  const { e, auth, sk } = await boot();
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "aws-aksk",
        type: CHANNEL_TYPE_AWS,
        key: "AKID|secret|us-east-1",
        models: "claude-3-haiku-20240307,nova-lite-v1:0",
        group: "default",
        settings: { aws_key_type: "ak_sk" },
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));

  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown>; headers: Headers; raw: string } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, headers: new Headers(init?.headers), raw };
    if (url.includes("nova-")) {
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: "hello nova" }] } },
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("invoke-with-response-stream")) {
      const events = [
        `{"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-test","content":[],"usage":{"input_tokens":2,"output_tokens":1}}}`,
        `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok claude"}}`,
        `{"type":"content_block_stop","index":0}`,
        `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}`,
        `{"type":"message_stop"}`,
      ];
      const parts = events.map((event) => encodeAwsBedrockChunk(event));
      let n = 0;
      for (const part of parts) n += part.length;
      const bytes = new Uint8Array(n);
      let off = 0;
      for (const part of parts) {
        bytes.set(part, off);
        off += part.length;
      }
      return new Response(bytes as unknown as BodyInit, {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    }
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
  }) as typeof fetch;
  try {
    const claudeRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-beta": "computer-use-2025-01-24",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 128,
        }),
      }),
      e,
    );
    assert.equal(claudeRelay.res.status, 200, claudeRelay.text);
    if (!captured) throw new Error("missing aws aksk upstream");
    assert.equal(
      captured.url,
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-haiku-20240307-v1%3A0/invoke",
    );
    assert.equal(captured.body.anthropic_version, "bedrock-2023-05-31");
    assert.deepEqual(captured.body.anthropic_beta, ["computer-use-2025-01-24"]);
    assert.equal("model" in captured.body, false);
    assert.equal("stream" in captured.body, false);
    assert.equal(captured.headers.get("accept"), "application/json");
    assert.match(String(captured.headers.get("authorization")), /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/bedrock\/aws4_request,/);
    assert.match(String(captured.headers.get("x-amz-date")), /^\d{8}T\d{6}Z$/);
    assert.equal(captured.headers.get("x-amz-content-sha256"), bytesToHex(await sha256Bytes(captured.raw)));
    assert.equal((claudeRelay.body.choices as { message: { content: string } }[])[0].message.content, "ok claude");

    const novaRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "nova-lite-v1:0",
          messages: [{ role: "user", content: "hi nova" }],
          max_tokens: 32,
          stream: true,
        }),
      }),
      e,
    );
    assert.equal(novaRelay.res.status, 200, novaRelay.text);
    if (!captured) throw new Error("missing nova aksk upstream");
    assert.equal(captured.url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.amazon.nova-lite-v1%3A0/invoke");
    assert.equal(captured.body.schemaVersion, "messages-v1");
    assert.equal("anthropic_version" in captured.body, false);

    const streamRelay = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
      e,
    );
    assert.equal(streamRelay.res.status, 200, streamRelay.text);
    if (!captured) throw new Error("missing aws stream upstream");
    assert.equal(
      captured.url,
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream",
    );
    assert.match(streamRelay.text, /ok claude/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original AWS api_key Converse URL is unchanged next to AKSK InvokeModel", () => {
  const apiKey = testChannel({
    key: "ak|us-east-1",
    settings: JSON.stringify({ aws_key_type: "api_key" }),
  });
  const target = buildUpstream(apiKey, "chat", "/v1/chat/completions", "claude-3-haiku-20240307", {
    model: "claude-3-haiku-20240307",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(
    target.url,
    "https://bedrock-runtime.anthropic.claude-3-haiku-20240307-v1:0.amazonaws.com/model/us-east-1/converse",
  );
  assert.equal(target.headers.authorization, "Bearer ak|us-east-1");
  assert.equal("anthropic_version" in (target.body as object), false);
});
