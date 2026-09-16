import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_JIMENG,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_REPLICATE,
  CHANNEL_TYPE_SUB2API,
  CHANNEL_TYPE_SUBMODEL,
  CHANNEL_TYPE_XUNFEI,
} from "../src/constants.js";
import { XUNFEI_WS_BAD_HANDSHAKE, XUNFEI_WS_HANDSHAKE_TIMEOUT_MS } from "../src/xunfei-convert.js";
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
    "SparkDesk-invalid": 1,
    "sub-1": 1,
    "gpt-5.6-sol": 1,
    "sub2-alpha": 1,
    "jimeng_high_aes_general_v21_L": 1,
  });
  return { e, auth, sk };
}

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>) {
  const res = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
  return res;
}

type WsListener = (ev: { data?: unknown }) => void;

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static sent: { url: string; data: string }[] = [];
  url: string;
  readyState = 0;
  listeners: Record<string, WsListener[]> = { open: [], message: [], error: [], close: [] };
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      for (const fn of this.listeners.open) fn({});
    });
  }
  addEventListener(type: string, fn: WsListener) {
    (this.listeners[type] ||= []).push(fn);
  }
  accept() {}
  send(data: string) {
    MockWebSocket.sent.push({ url: this.url, data });
    queueMicrotask(() => {
      const payload = {
        header: { code: 0, message: "success", status: 2 },
        payload: {
          choices: { status: 2, seq: 0, text: [{ content: "hello spark", role: "assistant" }] },
          usage: { text: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
        },
      };
      for (const fn of this.listeners.message) fn({ data: JSON.stringify(payload) });
    });
  }
  close() {
    this.readyState = 3;
  }
}

test("original Xunfei, Submodel, Replicate, Sub2API, NewAPI, and Jimeng ConvertOpenAIRequest JSON is sent upstream with original URLs and DoResponse fields", async () => {
  const { e, auth, sk } = await boot();
  await addChannel(e, auth, {
    name: "xunfei",
    type: CHANNEL_TYPE_XUNFEI,
    key: "appid|apiSecret|apiKey",
    models: "SparkDesk-v3.1",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "submodel",
    type: CHANNEL_TYPE_SUBMODEL,
    key: "sk-sub",
    models: "sub-1",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "replicate",
    type: CHANNEL_TYPE_REPLICATE,
    key: "r8_key",
    models: "black-forest-labs/flux-1.1-pro",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "newapi",
    type: CHANNEL_TYPE_NEW_API,
    key: "sk-new",
    models: "gpt-4o-mini",
    group: "default",
    base_url: "https://newapi.example",
  });
  await addChannel(e, auth, {
    name: "sub2api",
    type: CHANNEL_TYPE_SUB2API,
    key: "sk-sub2",
    models: "gpt-5.6-sol,sub2-alpha",
    group: "default",
    base_url: "https://sub2api.example",
  });
  await addChannel(e, auth, {
    name: "xunfei-bad",
    type: CHANNEL_TYPE_XUNFEI,
    key: "invalid",
    models: "SparkDesk-invalid",
    group: "default",
  });
  await addChannel(e, auth, {
    name: "jimeng",
    type: CHANNEL_TYPE_JIMENG,
    key: "ak|sk",
    models: "jimeng_high_aes_general_v21_L",
    group: "default",
  });

  const origFetch = globalThis.fetch;
  const OrigWebSocket = globalThis.WebSocket;
  MockWebSocket.instances = [];
  MockWebSocket.sent = [];
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
  const calls: { url: string; body: Record<string, unknown>; headers: Headers; raw: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ url, body, headers: new Headers(init?.headers), raw });
    if (url.includes("llm.submodel.ai/v1/chat/completions") || url.includes("newapi.example") || url.includes("sub2api.example")) {
      return new Response(
        JSON.stringify({
          id: "oa-1",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("api.replicate.com/v1/models/")) {
      return new Response(
        JSON.stringify({ status: "succeeded", output: ["https://img.example/cat.png"] }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("visual.volcengineapi.com")) {
      return new Response(
        JSON.stringify({
          code: 10000,
          message: "success",
          data: { image_urls: ["https://img.example/jimeng.png"], binary_data_base64: [] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const xfChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-v3.1",
          messages: [
            { role: "system", content: "be helpful" },
            { role: "user", content: "hi spark" },
          ],
          temperature: 0.4,
          n: 2,
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(xfChat.res.status, 200, xfChat.text);
    assert.equal(MockWebSocket.sent.length, 1);
    const xfSent = JSON.parse(MockWebSocket.sent[0].data) as Record<string, unknown>;
    assert.equal(MockWebSocket.sent[0].url.startsWith("wss://spark-api.xf-yun.com/v3.1/chat?"), true);
    assert.deepEqual(xfSent.header, { app_id: "appid" });
    assert.equal((xfSent.parameter as { chat: { domain: string; top_k: number } }).chat.domain, "generalv3");
    assert.equal((xfSent.parameter as { chat: { top_k: number } }).chat.top_k, 2);
    assert.deepEqual((xfSent.payload as { message: { text: unknown } }).message.text, [
      { role: "user", content: "be helpful" },
      { role: "assistant", content: "Okay" },
      { role: "user", content: "hi spark" },
    ]);
    assert.equal("stream_options" in xfSent, false);
    assert.equal((xfChat.body.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello spark");
    assert.equal((xfChat.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");
    assert.equal(xfChat.body.object, "chat.completion");
    assert.equal((xfChat.body.usage as { total_tokens: number }).total_tokens, 5);

    const xfStream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-v3.1",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(xfStream.res.status, 200, xfStream.text);
    assert.match(xfStream.text, /"model":"SparkDesk"/);
    assert.match(xfStream.text, /hello spark/);
    assert.match(xfStream.text, /data: \[DONE\]/);

    const xfBad = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-invalid",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(xfBad.res.status, 500, xfBad.text);
    assert.equal((xfBad.body.error as { message?: string; code?: string }).message, "invalid auth");
    assert.equal((xfBad.body.error as { code?: string }).code, "channel:invalid_key");

    const subChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "sub-1",
          messages: [{ role: "user", content: "hi sub" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(subChat.res.status, 200, subChat.text);
    const subCall = calls.find((c) => c.url === "https://llm.submodel.ai/v1/chat/completions");
    if (!subCall) throw new Error("missing submodel upstream");
    assert.equal("stream_options" in subCall.body, false);
    assert.equal(subCall.headers.get("authorization"), "Bearer sk-sub");

    const subEmbed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "sub-1", input: "hi" }),
      }),
      e,
    );
    assert.equal(subEmbed.res.status, 500, subEmbed.text);
    assert.match(String((subEmbed.body.error as { message?: string } | undefined)?.message || subEmbed.text), /submodel channel: endpoint not supported/);

    const repChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "black-forest-labs/flux-1.1-pro",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(repChat.res.status, 500, repChat.text);
    assert.match(String((repChat.body.error as { message?: string } | undefined)?.message || repChat.text), /ConvertOpenAIRequest is not implemented/);

    const repImage = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "black-forest-labs/flux-1.1-pro",
          prompt: "a cat",
          size: "1024x1024",
          n: 2,
          quality: "hd",
        }),
      }),
      e,
    );
    assert.equal(repImage.res.status, 200, repImage.text);
    const repCall = calls.find((c) => c.url === "https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions");
    if (!repCall) throw new Error("missing replicate upstream");
    assert.deepEqual(repCall.body, { input: { prompt: "a cat", aspect_ratio: "1:1", num_outputs: 2, prompt_upsampling: true } });
    assert.equal(repCall.headers.get("authorization"), "Bearer r8_key");
    assert.equal(repCall.headers.get("Prefer"), "wait");
    assert.equal((repImage.body.data as { url: string }[])[0].url, "https://img.example/cat.png");

    const newChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hi new" }],
          stream_options: { include_usage: true },
        }),
      }),
      e,
    );
    assert.equal(newChat.res.status, 200, newChat.text);
    const newCall = calls.find((c) => c.url === "https://newapi.example/v1/chat/completions");
    if (!newCall) throw new Error("missing newapi upstream");
    assert.equal("stream_options" in newCall.body, false);
    assert.equal(newCall.headers.get("authorization"), "Bearer sk-new");
    assert.equal(newCall.headers.get("x-api-key"), null);

    const claudeChat = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          max_tokens: 8192,
          temperature: 0.2,
          top_p: 0.99,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: "xhigh", provider_option: true },
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      e,
    );
    assert.equal(claudeChat.res.status, 200, claudeChat.text);
    const claudeCall = calls.find((c) => c.url === "https://sub2api.example/v1/messages");
    if (!claudeCall) throw new Error("missing sub2api claude upstream");
    assert.equal((claudeCall.body.thinking as { type: string }).type, "adaptive");
    assert.deepEqual(claudeCall.body.output_config, { effort: "xhigh", provider_option: true });
    assert.equal(claudeCall.headers.get("authorization")?.startsWith("Bearer "), true);
    assert.equal(claudeCall.headers.get("x-api-key"), claudeCall.headers.get("authorization")?.slice("Bearer ".length));
    assert.equal(claudeCall.headers.get("anthropic-version"), "2023-06-01");

    const alpha = await json(
      new Request("http://local/v1/alpha/search", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "sub2-alpha", query: "q" }),
      }),
      e,
    );
    assert.equal(alpha.res.status, 200, alpha.text);
    const alphaCall = calls.find((c) => c.url === "https://sub2api.example/v1/alpha/search");
    if (!alphaCall) throw new Error("missing alpha search upstream");

    const jimengImage = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "jimeng_high_aes_general_v21_L",
          prompt: "a mountain",
          extra_fields: { seed: 42 },
        }),
      }),
      e,
    );
    assert.equal(jimengImage.res.status, 200, jimengImage.text);
    const jimengCall = calls.find((c) => c.url === "https://visual.volcengineapi.com/?Action=CVProcess&Version=2022-08-31");
    if (!jimengCall) throw new Error("missing jimeng upstream");
    assert.equal(jimengCall.body.req_key, "jimeng_high_aes_general_v21_L");
    assert.equal(jimengCall.body.prompt, "a mountain");
    assert.equal(jimengCall.body.return_url, true);
    assert.equal(jimengCall.body.seed, 42);
    assert.equal(jimengCall.headers.get("authorization")?.startsWith("HMAC-SHA256 Credential=ak/"), true);
    assert.ok(jimengCall.headers.get("X-Date"));
    assert.ok(jimengCall.headers.get("X-Content-Sha256"));
    assert.equal((jimengImage.body.data as { url: string }[])[0].url, "https://img.example/jimeng.png");

    const jimengClaude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "jimeng_high_aes_general_v21_L",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(jimengClaude.res.status, 500, jimengClaude.text);
    assert.equal((jimengClaude.body.error as { message: string }).message, "not implemented");
    assert.equal((jimengClaude.body.error as { code: string }).code, "convert_request_failed");

    const replicateClaude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "black-forest-labs/flux-1.1-pro",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(replicateClaude.res.status, 500, replicateClaude.text);
    assert.equal(
      (replicateClaude.body.error as { message: string }).message,
      "replicate adaptor: ConvertClaudeRequest is not implemented",
    );

    const submodelClaude = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "sub-1",
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(submodelClaude.res.status, 500, submodelClaude.text);
    assert.equal((submodelClaude.body.error as { message: string }).message, "submodel channel: endpoint not supported");

    const jimengGemini = await json(
      new Request("http://local/v1beta/models/jimeng_high_aes_general_v21_L:generateContent", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      e,
    );
    assert.equal(jimengGemini.res.status, 500, jimengGemini.text);
    assert.equal((jimengGemini.body.error as { message: string }).message, "not implemented");
  } finally {
    globalThis.fetch = origFetch;
    (globalThis as unknown as { WebSocket: typeof OrigWebSocket }).WebSocket = OrigWebSocket;
  }
});

test("original Xunfei gorilla Dial is HTTP 101 Upgrade websocket and bad handshake is do_request_failed", async () => {
  const { e, auth, sk } = await boot();
  await addChannel(e, auth, {
    name: "xunfei-dial",
    type: CHANNEL_TYPE_XUNFEI,
    key: "appid|apiSecret|apiKey",
    models: "SparkDesk-v3.1",
    group: "default",
  });

  const origFetch = globalThis.fetch;
  const OrigWebSocket = globalThis.WebSocket;
  const origTimeout = AbortSignal.timeout;
  let handshakeMs: number | undefined;
  let denyHandshake = false;
  const handshake: { url: string; upgrade: string | null; authorization: string | null; method: string }[] = [];
  MockWebSocket.instances = [];
  MockWebSocket.sent = [];
  AbortSignal.timeout = ((ms: number) => {
    handshakeMs = ms;
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
  } catch {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: undefined });
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.startsWith("wss://spark-api.xf-yun.com/")) {
      handshake.push({
        url,
        upgrade: headers.get("Upgrade"),
        authorization: headers.get("Authorization"),
        method: String(init?.method || "GET"),
      });
      if (denyHandshake) return new Response("upgrade rejected", { status: 400 });
      const ws = new MockWebSocket(url);
      ws.readyState = MockWebSocket.OPEN;
      return { status: 101, ok: false, headers: new Headers(), webSocket: ws, text: async () => "" } as unknown as Response;
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const xfChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-v3.1",
          messages: [{ role: "user", content: "hi spark" }],
        }),
      }),
      e,
    );
    assert.equal(xfChat.res.status, 200, xfChat.text);
    assert.equal(handshake.length, 1);
    assert.equal(handshake[0].upgrade, "websocket");
    assert.equal(handshake[0].authorization, null);
    assert.equal(handshake[0].method, "GET");
    assert.equal(handshake[0].url.startsWith("wss://spark-api.xf-yun.com/v3.1/chat?"), true);
    assert.equal(handshakeMs, XUNFEI_WS_HANDSHAKE_TIMEOUT_MS);
    assert.equal(MockWebSocket.sent.length, 1);
    const xfSent = JSON.parse(MockWebSocket.sent[0].data) as Record<string, unknown>;
    assert.deepEqual(xfSent.header, { app_id: "appid" });
    assert.equal((xfChat.body.choices as { message: { content: string }; finish_reason: string }[])[0].message.content, "hello spark");
    assert.equal((xfChat.body.choices as { finish_reason: string }[])[0].finish_reason, "stop");
    assert.equal(xfChat.body.object, "chat.completion");
    assert.equal((xfChat.body.usage as { total_tokens: number }).total_tokens, 5);

    const xfStream = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-v3.1",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(xfStream.res.status, 200, xfStream.text);
    assert.match(xfStream.text, /"model":"SparkDesk"/);
    assert.match(xfStream.text, /hello spark/);
    assert.match(xfStream.text, /data: \[DONE\]/);

    denyHandshake = true;
    const xfBad = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "SparkDesk-v3.1",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(xfBad.res.status, 500, xfBad.text);
    assert.equal((xfBad.body.error as { message?: string }).message, XUNFEI_WS_BAD_HANDSHAKE);
    assert.equal((xfBad.body.error as { code?: string }).code, "do_request_failed");
    assert.equal((xfBad.body.error as { type?: string }).type, "new_api_error");
    assert.equal((xfBad.body.error as { param?: string }).param, "");
  } finally {
    globalThis.fetch = origFetch;
    AbortSignal.timeout = origTimeout;
    if (OrigWebSocket) (globalThis as unknown as { WebSocket: typeof OrigWebSocket }).WebSocket = OrigWebSocket;
  }
});
