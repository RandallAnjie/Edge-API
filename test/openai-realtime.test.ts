import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AZURE_NO_REMOVE_DOT_TIME,
  CHANNEL_TYPE_AZURE,
  CHANNEL_TYPE_CUSTOM,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_OPENROUTER,
} from "../src/constants.js";
import {
  OPENAI_REALTIME_BAD_HANDSHAKE,
  OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS,
  openaiRealtimeRequestURL,
  openaiRealtimeSetupHeaders,
  openaiRealtimeUpstream,
  sanitizeURLForLog,
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

function channel(partial: Partial<ChannelRow> & Pick<ChannelRow, "type" | "key">): ChannelRow {
  return {
    id: 1,
    status: 1,
    name: "rt",
    weight: 1,
    created_time: AZURE_NO_REMOVE_DOT_TIME,
    test_time: 0,
    response_time: 0,
    base_url: "",
    other: "",
    models: "gpt-4o-realtime-preview",
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
    settings: "",
    openai_organization: "",
    test_model: "",
    ...partial,
  };
}

test("original OpenAI Realtime GetRequestURL JSON fields", () => {
  assert.equal(
    openaiRealtimeRequestURL(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk", base_url: "https://api.openai.com" }), {
      requestUrlPath: "/v1/realtime?model=gpt-4o-realtime-preview",
      upstreamModel: "gpt-4o-realtime-preview",
    }),
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
  );
  assert.equal(
    openaiRealtimeRequestURL(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk", base_url: "http://localhost:8080" }), {
      requestUrlPath: "/v1/realtime",
      upstreamModel: "gpt-realtime",
    }),
    "ws://localhost:8080/v1/realtime",
  );
  assert.equal(
    openaiRealtimeRequestURL(
      channel({
        type: CHANNEL_TYPE_AZURE,
        key: "az",
        base_url: "https://east.openai.azure.com",
        other: "2025-04-01-preview",
        created_time: AZURE_NO_REMOVE_DOT_TIME,
      }),
      { requestUrlPath: "/v1/realtime?model=gpt-4o-realtime-preview", upstreamModel: "gpt-4o-realtime-preview" },
    ),
    "wss://east.openai.azure.com/openai/realtime?deployment=gpt-4o-realtime-preview&api-version=2025-04-01-preview",
  );
  assert.equal(
    openaiRealtimeRequestURL(
      channel({
        type: CHANNEL_TYPE_AZURE,
        key: "az",
        base_url: "https://east.openai.azure.com",
        created_time: AZURE_NO_REMOVE_DOT_TIME - 1,
      }),
      { requestUrlPath: "/v1/realtime", upstreamModel: "gpt-4o-realtime-preview" },
    ),
    "wss://east.openai.azure.com/openai/realtime?deployment=gpt-4orealtimpreview&api-version=2025-04-01-preview",
  );
  assert.equal(
    openaiRealtimeRequestURL(
      channel({ type: CHANNEL_TYPE_CUSTOM, key: "sk", base_url: "https://rt.example/{model}/ws" }),
      { requestUrlPath: "/v1/realtime?model=ignored", upstreamModel: "gpt-realtime" },
    ),
    "wss://rt.example/gpt-realtime/ws",
  );
});

test("original OpenAI Realtime SetupRequestHeader JSON fields", () => {
  const preview = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk", openai_organization: "org-1" }), {
    apiKey: "sk-live",
    upstreamModel: "gpt-4o-realtime-preview",
    clientSecWebSocketProtocol: "",
  });
  assert.equal(preview.Authorization, "Bearer sk-live");
  assert.equal(preview["openai-beta"], "realtime=v1");
  assert.equal(preview["OpenAI-Organization"], "org-1");
  assert.equal("Sec-WebSocket-Protocol" in preview, false);

  const ga = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk" }), {
    apiKey: "sk-live",
    upstreamModel: "gpt-realtime",
    clientSecWebSocketProtocol: "",
  });
  assert.equal(ga.Authorization, "Bearer sk-live");
  assert.equal("openai-beta" in ga, false);

  const swpPreview = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk" }), {
    apiKey: "sk-live",
    upstreamModel: "gpt-4o-mini-realtime-preview",
    clientSecWebSocketProtocol: "realtime",
  });
  assert.equal(swpPreview["Sec-WebSocket-Protocol"], "realtime,openai-insecure-api-key.sk-live,openai-beta.realtime-v1");
  assert.equal("Authorization" in swpPreview, false);
  assert.equal("openai-beta" in swpPreview, false);

  const swpGa = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_OPENAI, key: "sk" }), {
    apiKey: "sk-live",
    upstreamModel: "gpt-realtime",
    clientSecWebSocketProtocol: "realtime",
  });
  assert.equal(swpGa["Sec-WebSocket-Protocol"], "realtime,openai-insecure-api-key.sk-live");
  assert.equal("Authorization" in swpGa, false);

  const azure = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_AZURE, key: "az" }), {
    apiKey: "azure-key",
    upstreamModel: "gpt-4o-realtime-preview",
    clientSecWebSocketProtocol: "realtime",
  });
  assert.deepEqual(azure, { "api-key": "azure-key" });

  const skipAuth = openaiRealtimeSetupHeaders(
    channel({ type: CHANNEL_TYPE_OPENAI, key: "sk", header_override: JSON.stringify({ Authorization: "Bearer override" }) }),
    { apiKey: "sk-live", upstreamModel: "gpt-realtime", clientSecWebSocketProtocol: "" },
  );
  assert.equal("Authorization" in skipAuth, false);

  const openrouter = openaiRealtimeSetupHeaders(channel({ type: CHANNEL_TYPE_OPENROUTER, key: "or" }), {
    apiKey: "or-key",
    upstreamModel: "gpt-realtime",
    clientSecWebSocketProtocol: "",
  });
  assert.equal(openrouter.Authorization, "Bearer or-key");
  assert.equal(openrouter["HTTP-Referer"], "https://www.newapi.ai");
  assert.equal(openrouter["X-OpenRouter-Title"], "New API");
  assert.equal("openai-beta" in openrouter, false);

  assert.equal(sanitizeURLForLog("wss://api.openai.com/v1/realtime?model=x&api_key=secret"), "wss://api.openai.com/v1/realtime?model=x&api_key=***masked***");
});

test("original OpenAI Realtime DoWssRequest is HTTP 101 Upgrade websocket and bad handshake is do_request_failed", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-rt",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-upstream",
        models: "gpt-4o-realtime-preview,gpt-realtime",
        group: "default",
        openai_organization: "org-9",
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
  let deny = false;
  const handshake: { url: string; upgrade: string | null; authorization: string | null; beta: string | null; org: string | null; swp: string | null; contentType: string | null }[] = [];
  AbortSignal.timeout = ((ms: number) => {
    handshakeMs = ms;
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  (globalThis as { WebSocketPair: unknown }).WebSocketPair = MockPair;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    handshake.push({
      url,
      upgrade: headers.get("Upgrade"),
      authorization: headers.get("Authorization"),
      beta: headers.get("openai-beta"),
      org: headers.get("OpenAI-Organization"),
      swp: headers.get("Sec-WebSocket-Protocol"),
      contentType: headers.get("Content-Type"),
    });
    if (deny) return new Response("upgrade rejected", { status: 400 });
    return { status: 101, ok: false, headers: new Headers(), webSocket: new MockSocket(), text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  try {
    const preview = await handleFetch(
      new Request("http://local/v1/realtime?model=gpt-4o-realtime-preview", {
        headers: {
          authorization: "Bearer " + sk,
          upgrade: "websocket",
          "content-type": "application/json",
        },
      }),
      e,
      ctx(),
    );
    assert.equal(preview.status, 101, await preview.text().catch(() => ""));
    assert.equal(handshake.length, 1);
    assert.equal(handshake[0].url, "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview");
    assert.equal(handshake[0].upgrade, "websocket");
    assert.equal(handshake[0].authorization, "Bearer sk-upstream");
    assert.equal(handshake[0].beta, "realtime=v1");
    assert.equal(handshake[0].org, "org-9");
    assert.equal(handshake[0].swp, null);
    assert.equal(handshake[0].contentType, "application/json");
    assert.equal(handshakeMs, OPENAI_REALTIME_HANDSHAKE_TIMEOUT_MS);

    handshake.length = 0;
    const ga = await handleFetch(
      new Request("http://local/v1/realtime?model=gpt-realtime", {
        headers: { authorization: "Bearer " + sk, upgrade: "websocket", "sec-websocket-protocol": "realtime" },
      }),
      e,
      ctx(),
    );
    assert.equal(ga.status, 101);
    assert.equal(handshake[0].url, "wss://api.openai.com/v1/realtime?model=gpt-realtime");
    assert.equal(handshake[0].authorization, null);
    assert.equal(handshake[0].beta, null);
    assert.equal(handshake[0].swp, "realtime,openai-insecure-api-key.sk-upstream");

    deny = true;
    const bad = await json(
      new Request("http://local/v1/realtime?model=gpt-realtime", {
        headers: { authorization: "Bearer " + sk, upgrade: "websocket" },
      }),
      e,
    );
    assert.equal(bad.res.status, 500, bad.text);
    assert.equal((bad.body.error as { code?: string }).code, "do_request_failed");
    assert.equal((bad.body.error as { type?: string }).type, "new_api_error");
    assert.equal((bad.body.error as { param?: string }).param, "");
    assert.match(String((bad.body.error as { message?: string }).message), new RegExp(OPENAI_REALTIME_BAD_HANDSHAKE));
    assert.match(String((bad.body.error as { message?: string }).message), /^dial failed to /);
  } finally {
    globalThis.fetch = origFetch;
    AbortSignal.timeout = origTimeout;
    if (OrigPair) (globalThis as { WebSocketPair: unknown }).WebSocketPair = OrigPair;
    else delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  }
});

test("original OpenAI Realtime Azure api-key Dial URL", () => {
  const req = new Request("http://local/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { "content-type": "application/json", upgrade: "websocket" },
  });
  const target = openaiRealtimeUpstream(
    channel({
      type: CHANNEL_TYPE_AZURE,
      key: "azure-secret",
      base_url: "https://west.openai.azure.com",
      other: "2024-10-01-preview",
      created_time: AZURE_NO_REMOVE_DOT_TIME,
    }),
    req,
    "gpt-4o-realtime-preview",
  );
  assert.equal(
    target.url,
    "wss://west.openai.azure.com/openai/realtime?deployment=gpt-4o-realtime-preview&api-version=2024-10-01-preview",
  );
  assert.equal(target.headers["api-key"], "azure-secret");
  assert.equal("Authorization" in target.headers, false);
  assert.equal("openai-beta" in target.headers, false);
  assert.equal(target.headers["Content-Type"], "application/json");
});
