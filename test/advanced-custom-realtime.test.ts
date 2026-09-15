import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from "../src/constants.js";
import {
  advancedCustomRealtimeSetupHeaders,
  advancedCustomRealtimeWsURL,
  buildAdvancedCustomRealtimeRequestURL,
} from "../src/channel-validate.js";
import {
  OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS,
  advancedCustomRealtimeUpstream,
} from "../src/openai-realtime.js";
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

function realtimeSettings(route: Record<string, unknown>): string {
  return JSON.stringify({
    advanced_custom: {
      advanced_routes: [
        {
          incoming_path: "/v1/realtime",
          upstream_path: "/v1/realtime",
          converter: "none",
          models: ["gpt-realtime"],
          ...route,
        },
      ],
    },
  });
}

function channel(partial: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 1,
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "sk-adv",
    status: 1,
    name: "adv-rt",
    weight: 1,
    created_time: 1,
    test_time: 0,
    response_time: 0,
    base_url: "https://rt.example.com",
    other: "",
    models: "gpt-realtime",
    group: "default",
    used_quota: 0,
    model_mapping: "",
    status_code_mapping: "",
    priority: 0,
    auto_ban: 0,
    tag: null,
    header_override: "",
    param_override: "",
    remark: "",
    settings: realtimeSettings({}),
    openai_organization: "",
    test_model: "",
    ...partial,
  };
}

test("original Advanced Custom realtime GetRequestURL JSON fields", () => {
  assert.equal(advancedCustomRealtimeWsURL("https://rt.example.com/v1/realtime"), "wss://rt.example.com/v1/realtime");
  assert.equal(advancedCustomRealtimeWsURL("http://localhost:8080/v1/realtime"), "ws://localhost:8080/v1/realtime");
  assert.equal(
    buildAdvancedCustomRealtimeRequestURL(channel(), "/v1/realtime", "gpt-realtime", "gpt-realtime"),
    "wss://rt.example.com/v1/realtime",
  );
  assert.equal(
    buildAdvancedCustomRealtimeRequestURL(
      channel({
        settings: realtimeSettings({ upstream_path: "https://other.example/ws/{model}" }),
      }),
      "/v1/realtime?model=gpt-realtime",
      "gpt-realtime",
      "mapped-rt",
    ),
    "wss://other.example/ws/mapped-rt",
  );
  assert.equal(
    buildAdvancedCustomRealtimeRequestURL(
      channel({
        settings: realtimeSettings({ auth: { type: "query", name: "key", value: "{api_key}" } }),
      }),
      "/v1/realtime",
      "gpt-realtime",
      "gpt-realtime",
    ),
    "wss://rt.example.com/v1/realtime?key=sk-adv",
  );
  assert.throws(
    () => buildAdvancedCustomRealtimeRequestURL(channel({ settings: "{}" }), "/v1/realtime", "gpt-realtime", "gpt-realtime"),
    /advanced_custom is required/,
  );
  assert.throws(
    () => buildAdvancedCustomRealtimeRequestURL(channel(), "/v1/realtime", "other-model", "other-model"),
    /advanced custom channel does not support request path \/v1\/realtime for model other-model/,
  );
});

test("original Advanced Custom realtime SetupRequestHeader JSON fields", () => {
  const bearer = advancedCustomRealtimeSetupHeaders(channel(), "/v1/realtime", "gpt-realtime", "sk-adv");
  assert.equal(bearer.Authorization, "Bearer sk-adv");
  assert.equal("openai-beta" in bearer, false);

  const headerAuth = advancedCustomRealtimeSetupHeaders(
    channel({
      settings: realtimeSettings({ auth: { type: "header", name: "X-Api-Key", value: "{api_key}" } }),
    }),
    "/v1/realtime",
    "gpt-realtime",
    "sk-adv",
  );
  assert.equal(headerAuth["X-Api-Key"], "sk-adv");
  assert.equal("Authorization" in headerAuth, false);

  const queryAuth = advancedCustomRealtimeSetupHeaders(
    channel({
      settings: realtimeSettings({ auth: { type: "query", name: "key", value: "{api_key}" } }),
    }),
    "/v1/realtime",
    "gpt-realtime",
    "sk-adv",
  );
  assert.equal("Authorization" in queryAuth, false);
  assert.equal("key" in queryAuth, false);

  const noneAuth = advancedCustomRealtimeSetupHeaders(
    channel({ settings: realtimeSettings({ auth: { type: "none" } }) }),
    "/v1/realtime",
    "gpt-realtime",
    "sk-adv",
  );
  assert.equal("Authorization" in noneAuth, false);

  const nativeBearer = advancedCustomRealtimeSetupHeaders(
    channel({
      settings: realtimeSettings({ auth: { type: "header", name: "Authorization", value: "Bearer {api_key}" } }),
    }),
    "/v1/realtime",
    "gpt-realtime",
    "sk-adv",
  );
  assert.equal(nativeBearer.Authorization, "Bearer sk-adv");

  const req = new Request("http://local/v1/realtime?model=gpt-realtime", {
    headers: { "content-type": "application/json", upgrade: "websocket" },
  });
  const target = advancedCustomRealtimeUpstream(channel(), req, "gpt-realtime");
  assert.equal(target.url, "wss://rt.example.com/v1/realtime");
  assert.equal(target.headers.Authorization, "Bearer sk-adv");
  assert.equal(target.headers["Content-Type"], "application/json");
  assert.equal("openai-beta" in target.headers, false);
});

test("original Advanced Custom realtime DoWssRequest is HTTP 101 Upgrade websocket", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "adv-rt",
        type: CHANNEL_TYPE_ADVANCED_CUSTOM,
        key: "sk-upstream",
        models: "gpt-realtime",
        group: "default",
        base_url: "https://rt.example.com",
        settings: realtimeSettings({
          auth: { type: "header", name: "Authorization", value: "Bearer {api_key}" },
        }),
      }),
    }),
    e,
  );

  type WsListener = (ev: { data?: unknown }) => void;
  class MockSocket {
    listeners: Record<string, WsListener[]> = { open: [], message: [], error: [], close: [] };
    accept() {}
    addEventListener(type: string, fn: WsListener) {
      (this.listeners[type] ||= []).push(fn);
    }
    send() {}
    close() {}
  }
  class MockPair {
    0: MockSocket;
    1: MockSocket;
    constructor() {
      this[0] = new MockSocket();
      this[1] = new MockSocket();
    }
  }

  const origFetch = globalThis.fetch;
  const OrigPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  const origTimeout = AbortSignal.timeout;
  let handshakeMs: number | undefined;
  const handshake: { url: string; upgrade: string | null; authorization: string | null; beta: string | null }[] = [];
  AbortSignal.timeout = ((ms: number) => {
    handshakeMs = ms;
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = MockPair;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    handshake.push({
      url: String(input),
      upgrade: headers.get("Upgrade"),
      authorization: headers.get("Authorization"),
      beta: headers.get("openai-beta"),
    });
    return { status: 101, ok: false, headers: new Headers(), webSocket: new MockSocket(), text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  try {
    const ok = await handleFetch(
      new Request("http://local/v1/realtime?model=gpt-realtime", {
        headers: { authorization: "Bearer " + sk, upgrade: "websocket", "content-type": "application/json" },
      }),
      e,
      ctx(),
    );
    assert.equal(ok.status, 101, await ok.text().catch(() => ""));
    assert.equal(handshake.length, 1);
    assert.equal(handshake[0].url, "wss://rt.example.com/v1/realtime");
    assert.equal(handshake[0].upgrade, "websocket");
    assert.equal(handshake[0].authorization, "Bearer sk-upstream");
    assert.equal(handshake[0].beta, null);
    assert.equal(handshakeMs, OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS);
  } finally {
    globalThis.fetch = origFetch;
    AbortSignal.timeout = origTimeout;
    if (OrigPair) (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = OrigPair;
    else delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  }
});

test("original Advanced Custom realtime unmatched route is distributor no available channel", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "adv-chat-only",
        type: CHANNEL_TYPE_ADVANCED_CUSTOM,
        key: "sk-chat",
        models: "gpt-realtime",
        group: "default",
        base_url: "https://chat.example.com",
        settings: JSON.stringify({
          advanced_custom: {
            advanced_routes: [
              {
                incoming_path: "/v1/chat/completions",
                upstream_path: "/v1/chat/completions",
                converter: "none",
                models: ["gpt-realtime"],
              },
            ],
          },
        }),
      }),
    }),
    e,
  );
  const missing = await json(
    new Request("http://local/v1/realtime?model=gpt-realtime", {
      headers: { authorization: "Bearer " + sk, upgrade: "websocket" },
    }),
    e,
  );
  assert.equal(missing.res.status, 503, missing.text);
  assert.equal((missing.body.error as { code?: string }).code, "model_not_found");
  assert.equal((missing.body.error as { type?: string }).type, "new_api_error");
  assert.equal((missing.body.error as { param?: string }).param, "");
  assert.match(
    String((missing.body.error as { message?: string }).message),
    /No available channel for model gpt-realtime under group default \(distributor\)/,
  );
});
