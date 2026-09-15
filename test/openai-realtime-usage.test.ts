import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import {
  applyClientRealtimeEvent,
  applyUpstreamRealtimeEvent,
  calculateAudioQuota,
  countAudioTokenInput,
  countAudioTokenOutput,
  countTextToken,
  countTokenRealtime,
  emptyOpenaiRealtimeHandlerState,
  emptyRealtimeUsage,
  estimateToken,
  generateWssOtherInfo,
  isOpenAITextModel,
  parseAudio,
  parseRealtimeEvent,
  REALTIME_EVENT_INPUT_AUDIO_BUFFER_APPEND,
  REALTIME_EVENT_RESPONSE_AUDIO_DELTA,
  REALTIME_EVENT_RESPONSE_DONE,
  REALTIME_EVENT_SESSION_UPDATE,
  remainingRealtimePreConsume,
  realtimeUsageFromJSON,
} from "../src/openai-realtime-usage.js";
import { loadWssPriceData, postWssAudioQuota, preWssAudioQuota } from "../src/openai-realtime-billing.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";
import { Store } from "../src/store.js";

function drainCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContextLike & { drain(): Promise<void> } = {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    async drain() {
      while (pending.length) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch.map((p) => Promise.resolve(p).catch(() => {})));
      }
    },
  };
  return ctx;
}

async function json(req: Request, e: Env, c: ExecutionContextLike = { waitUntil() {} }) {
  const res = await handleFetch(req, e, c);
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

test("original RealtimeUsage JSON fields and CountTokenRealtime / EstimateToken", () => {
  assert.equal(isOpenAITextModel("gpt-4o-realtime-preview"), true);
  assert.equal(countTextToken("", "gpt-4o-realtime-preview"), 0);
  assert.equal(estimateToken("openai", "hello"), 2);
  assert.equal(countTextToken("hello", "gpt-4o-realtime-preview"), 2);
  assert.equal(countTextToken("你好", "gpt-4o-realtime-preview"), 2);

  const pcm1s = Buffer.alloc(48000).toString("base64");
  assert.equal(parseAudio(pcm1s, "pcm16"), 1);
  assert.equal(countAudioTokenInput("", "pcm16"), 0);
  assert.equal(countAudioTokenOutput("", "pcm16"), 0);
  assert.equal(countAudioTokenInput(pcm1s, "pcm16"), 27);
  assert.equal(countAudioTokenOutput(pcm1s, "pcm16"), 13);

  const g711 = Buffer.alloc(8000).toString("base64");
  assert.equal(parseAudio(g711, "g711_ulaw"), 1);

  const usage = realtimeUsageFromJSON({
    total_tokens: 30,
    input_tokens: 10,
    output_tokens: 20,
    input_token_details: { audio_tokens: 2, cached_tokens: 1, text_tokens: 8 },
    output_token_details: { audio_tokens: 5, text_tokens: 15 },
  });
  assert.ok(usage);
  assert.equal(usage.total_tokens, 30);
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 20);
  assert.equal(usage.input_token_details.audio_tokens, 2);
  assert.equal(usage.input_token_details.cached_tokens, 1);
  assert.equal(usage.input_token_details.text_tokens, 8);
  assert.equal(usage.output_token_details.audio_tokens, 5);
  assert.equal(usage.output_token_details.text_tokens, 15);

  const info = emptyOpenaiRealtimeHandlerState();
  const session = parseRealtimeEvent(
    JSON.stringify({ type: REALTIME_EVENT_SESSION_UPDATE, session: { instructions: "hello", tools: [{ type: "function", name: "t", description: "d", parameters: {} }] } }),
  );
  assert.equal(session?.type, REALTIME_EVENT_SESSION_UPDATE);
  applyClientRealtimeEvent(info, session!, "gpt-4o-realtime-preview");
  assert.equal(info.realtimeTools.length, 1);
  assert.equal(info.localUsage.input_tokens, 2);
  assert.equal(info.localUsage.input_token_details.text_tokens, 2);
  assert.equal(info.localUsage.output_tokens, 0);

  const append = countTokenRealtime(info, { type: REALTIME_EVENT_INPUT_AUDIO_BUFFER_APPEND, audio: pcm1s }, "gpt-4o-realtime-preview");
  assert.equal(append.audioToken, 27);
  assert.equal(append.textToken, 0);

  const delta = countTokenRealtime(info, { type: REALTIME_EVENT_RESPONSE_AUDIO_DELTA, delta: pcm1s }, "gpt-4o-realtime-preview");
  assert.equal(delta.audioToken, 13);

  const firstDone = countTokenRealtime(info, { type: REALTIME_EVENT_RESPONSE_DONE }, "gpt-4o-realtime-preview");
  assert.equal(firstDone.textToken, 0);
  info.isFirstRequest = false;
  const laterDone = countTokenRealtime(info, { type: REALTIME_EVENT_RESPONSE_DONE }, "gpt-4o-realtime-preview");
  assert.ok(laterDone.textToken >= 8);
});

test("original calculateAudioQuota and GenerateWssOtherInfo JSON fields", () => {
  const usage = emptyRealtimeUsage();
  usage.total_tokens = 30;
  usage.input_tokens = 10;
  usage.output_tokens = 20;
  usage.input_token_details = { text_tokens: 8, audio_tokens: 2, cached_tokens: 0 };
  usage.output_token_details = { text_tokens: 15, audio_tokens: 5 };
  const quota = calculateAudioQuota({
    inputTextTokens: 8,
    inputAudioTokens: 2,
    outputTextTokens: 15,
    outputAudioTokens: 5,
    modelName: "gpt-4o-realtime-preview",
    usePrice: false,
    modelPrice: -1,
    modelRatio: 2.5,
    groupRatio: 1,
    completionRatio: 4,
    audioRatio: 8,
    audioCompletionRatio: 1,
    quotaPerUnit: 500000,
  });
  assert.equal(quota.quota, 310);
  assert.equal(quota.clamp, null);

  const priced = calculateAudioQuota({
    inputTextTokens: 0,
    inputAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    modelName: "gpt-4o-realtime-preview",
    usePrice: true,
    modelPrice: 0.04,
    modelRatio: 0,
    groupRatio: 1,
    completionRatio: 4,
    audioRatio: 8,
    audioCompletionRatio: 1,
    quotaPerUnit: 500000,
  });
  assert.equal(priced.quota, 20000);

  const zeroForced = calculateAudioQuota({
    inputTextTokens: 0,
    inputAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    modelName: "gpt-4o-realtime-preview",
    usePrice: false,
    modelPrice: -1,
    modelRatio: 2.5,
    groupRatio: 1,
    completionRatio: 4,
    audioRatio: 8,
    audioCompletionRatio: 1,
    quotaPerUnit: 500000,
  });
  assert.equal(zeroForced.quota, 1);

  const other = generateWssOtherInfo({
    usage,
    modelRatio: 2.5,
    groupRatio: 1,
    completionRatio: 4,
    audioRatio: 8,
    audioCompletionRatio: 1,
    modelPrice: -1,
    userGroupRatio: -1,
    frtMs: 12,
    requestPath: "/v1/realtime",
    isModelMapped: false,
    upstreamModelName: "gpt-4o-realtime-preview",
  });
  assert.equal(other.ws, true);
  assert.equal(other.audio_input, 2);
  assert.equal(other.audio_output, 5);
  assert.equal(other.text_input, 8);
  assert.equal(other.text_output, 15);
  assert.equal(other.audio_ratio, 8);
  assert.equal(other.audio_completion_ratio, 1);
  assert.equal(other.model_ratio, 2.5);
  assert.equal(other.group_ratio, 1);
  assert.equal(other.completion_ratio, 4);
  assert.equal(other.cache_tokens, 0);
  assert.equal(other.cache_ratio, 0);
  assert.equal(other.request_path, "/v1/realtime");
  assert.equal(other.billing_source, "wallet");
  assert.equal(other.frt, 12);
  assert.equal("is_model_mapped" in other, false);

  const state = emptyOpenaiRealtimeHandlerState();
  applyUpstreamRealtimeEvent(
    state,
    {
      type: REALTIME_EVENT_RESPONSE_DONE,
      response: { usage },
    },
    "gpt-4o-realtime-preview",
  );
  assert.equal(state.usage.total_tokens, 0);
  assert.equal(remainingRealtimePreConsume(state).length, 0);
});

test("original PreWss ratio quota uses OriginModelName maps from store options", async () => {
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
  const store = new Store(e.DB);
  const price = await loadWssPriceData(store, "gpt-4o-realtime-preview", "gpt-4o-realtime-preview", "default", "default");
  assert.equal(price.originModelRatio, 2.5);
  assert.equal(price.originCompletionRatio, 4);
  assert.equal(price.originAudioRatio, 8);
  assert.equal(price.originAudioCompletionRatio, 1);
  assert.equal(price.usePrice, false);
  const usage = realtimeUsageFromJSON({
    total_tokens: 30,
    input_tokens: 10,
    output_tokens: 20,
    input_token_details: { audio_tokens: 2, cached_tokens: 0, text_tokens: 8 },
    output_token_details: { audio_tokens: 5, text_tokens: 15 },
  })!;
  assert.equal(preWssAudioQuota(price, usage), 310);
  assert.equal(postWssAudioQuota(price, usage), 310);
});

test("original OpenaiRealtimeHandler consume log JSON fields after response.done usage", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-rt-usage",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-upstream",
        models: "gpt-4o-realtime-preview",
        group: "default",
      }),
    }),
    e,
  );

  type WsListener = (ev: { data?: unknown }) => void;
  class MockSocket {
    peer: MockSocket | null = null;
    sent: unknown[] = [];
    closed = false;
    listeners: Record<string, WsListener[]> = { open: [], message: [], error: [], close: [] };
    accept() {}
    addEventListener(type: string, fn: WsListener) {
      (this.listeners[type] ||= []).push(fn);
    }
    emit(type: string, ev: { data?: unknown } = {}) {
      for (const fn of this.listeners[type] || []) fn(ev);
    }
    send(data: unknown) {
      this.sent.push(data);
      if (this.peer) this.peer.emit("message", { data });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
      if (this.peer && !this.peer.closed) this.peer.close();
    }
  }
  class MockPair {
    0: MockSocket;
    1: MockSocket;
    constructor() {
      this[0] = new MockSocket();
      this[1] = new MockSocket();
      this[0].peer = this[1];
      this[1].peer = this[0];
    }
  }

  const origFetch = globalThis.fetch;
  const OrigPair = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  const origTimeout = AbortSignal.timeout;
  let upstream = new MockSocket();
  AbortSignal.timeout = ((ms: number) => origTimeout.call(AbortSignal, ms)) as typeof AbortSignal.timeout;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = MockPair;
  globalThis.fetch = (async () => {
    upstream = new MockSocket();
    return { status: 101, ok: false, headers: new Headers(), webSocket: upstream, text: async () => "" } as unknown as Response;
  }) as typeof fetch;

  const ctx = drainCtx();
  try {
    const preview = await handleFetch(
      new Request("http://local/v1/realtime?model=gpt-4o-realtime-preview", {
        headers: { authorization: "Bearer " + sk, upgrade: "websocket", "content-type": "application/json" },
      }),
      e,
      ctx,
    );
    assert.equal(preview.status, 101, await preview.text().catch(() => ""));
    const client = (preview as unknown as { webSocket: MockSocket }).webSocket;
    client.send(JSON.stringify({ type: "session.update", session: { instructions: "hello" } }));
    await ctx.drain();
    assert.equal(String(upstream.sent[0]), JSON.stringify({ type: "session.update", session: { instructions: "hello" } }));

    const usageJSON = {
      total_tokens: 30,
      input_tokens: 10,
      output_tokens: 20,
      input_token_details: { audio_tokens: 2, cached_tokens: 0, text_tokens: 8 },
      output_token_details: { audio_tokens: 5, text_tokens: 15 },
    };
    upstream.emit("message", {
      data: JSON.stringify({ type: "response.done", response: { usage: usageJSON } }),
    });
    await ctx.drain();
    client.close();
    await ctx.drain();

    const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
    const items = (logs.body.data as { items?: Record<string, unknown>[] })?.items || (logs.body.data as Record<string, unknown>[]);
    const list = Array.isArray(items) ? items : [];
    const hit = list.find((row) => String(row.model_name || "") === "gpt-4o-realtime-preview" && Number(row.type) === LOG_CONSUME);
    assert.ok(hit, JSON.stringify(logs.body));
    assert.equal(hit.prompt_tokens, 10);
    assert.equal(hit.completion_tokens, 20);
    assert.equal(hit.quota, 310);
    assert.equal(hit.is_stream, true);
    assert.equal(hit.model_name, "gpt-4o-realtime-preview");
    const otherRaw = typeof hit.other === "string" ? hit.other : JSON.stringify(hit.other || {});
    const other = JSON.parse(otherRaw) as Record<string, unknown>;
    assert.equal(other.ws, true);
    assert.equal(other.audio_input, 2);
    assert.equal(other.audio_output, 5);
    assert.equal(other.text_input, 8);
    assert.equal(other.text_output, 15);
    assert.equal(other.audio_ratio, 8);
    assert.equal(other.audio_completion_ratio, 1);
    assert.equal(other.request_path, "/v1/realtime");
    assert.match(String(hit.content || ""), /音频倍率 8\.00/);
    assert.match(String(hit.content || ""), /模型倍率 2\.50/);
  } finally {
    globalThis.fetch = origFetch;
    AbortSignal.timeout = origTimeout;
    if (OrigPair) (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = OrigPair;
    else delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
  }
});
