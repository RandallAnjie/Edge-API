import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_VOLC } from "../src/constants.js";
import {
  MSG_TYPE_AUDIO_ONLY_SERVER,
  MSG_TYPE_FULL_CLIENT_REQUEST,
  VOLC_TTS_INVALID_KEY,
  VOLC_TTS_UNSUPPORTED_AUDIO,
  VOLC_TTS_WS_URL,
  convertVolcTTSRequest,
  marshalVolcAudioOnlyServer,
  marshalVolcErrorMessage,
  marshalVolcFullClientRequest,
  parseVolcengineAuth,
  unmarshalVolcBinaryMessage,
  volcTtsHttpDoResponse,
  volcTtsIsStream,
  volcTtsRequestURL,
} from "../src/volc-tts.js";
import { convertOpenAIRequest } from "../src/convert.js";
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

type WsListener = (ev: { data?: unknown }) => void;

class MockVolcTtsSocket {
  static sent: Uint8Array[] = [];
  listeners: Record<string, WsListener[]> = { open: [], message: [], error: [], close: [] };
  readyState = 1;
  accept() {}
  addEventListener(type: string, fn: WsListener) {
    (this.listeners[type] ||= []).push(fn);
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(data);
    MockVolcTtsSocket.sent.push(bytes);
    queueMicrotask(() => {
      const first = marshalVolcAudioOnlyServer(new Uint8Array([1, 2, 3]), 1);
      const last = marshalVolcAudioOnlyServer(new Uint8Array([4, 5]), -1);
      for (const fn of this.listeners.message) {
        fn({ data: first });
        fn({ data: last });
      }
    });
  }
  close() {
    this.readyState = 3;
  }
}

test("original Volcengine ConvertAudioRequest JSON fields, GetRequestURL, and auth split", () => {
  assert.deepEqual(parseVolcengineAuth("app|token"), { appId: "app", token: "token" });
  assert.throws(() => parseVolcengineAuth("only-one"), new RegExp(VOLC_TTS_INVALID_KEY));
  assert.equal(volcTtsRequestURL(""), VOLC_TTS_WS_URL);
  assert.equal(volcTtsRequestURL("https://ark.cn-beijing.volces.com"), VOLC_TTS_WS_URL);
  assert.equal(volcTtsRequestURL("https://tts.example"), "https://tts.example/v1/audio/speech");

  const converted = convertVolcTTSRequest(
    { model: "seed-tts", input: "你好", voice: "echo", response_format: "wav", speed: 0.8 },
    { originModelName: "seed-tts", apiKey: "aid|tok", reqId: "req-1" },
  );
  assert.deepEqual(converted, {
    app: { appid: "aid", token: "tok", cluster: "volcano_tts" },
    user: { uid: "openai_relay_user" },
    audio: {
      voice_type: "zh_male_wenhao_mars_bigtts",
      encoding: "wav",
      speed_ratio: 0.8,
      rate: 24000,
    },
    request: { reqid: "req-1", text: "你好", operation: "submit", model: "seed-tts" },
  });
  assert.equal(volcTtsIsStream(converted), true);

  const queried = convertVolcTTSRequest(
    { input: "hi", metadata: { request: { operation: "query" } } },
    { originModelName: "seed-tts", apiKey: "aid|tok", reqId: "req-2" },
  );
  assert.equal((queried.request as { operation: string }).operation, "query");
  assert.equal(volcTtsIsStream(queried), false);

  const merged = convertVolcTTSRequest(
    { input: "hi", voice: "custom-voice", metadata: { audio: { emotion: "happy", enable_emotion: true } } },
    { originModelName: "seed-tts", apiKey: "aid|tok", reqId: "req-3" },
  );
  assert.equal((merged.audio as { voice_type: string }).voice_type, "custom-voice");
  assert.equal((merged.audio as { emotion: string }).emotion, "happy");
  assert.equal((merged.audio as { enable_emotion: boolean }).enable_emotion, true);
  assert.equal((merged.audio as { rate: number }).rate, 24000);

  assert.throws(
    () =>
      convertOpenAIRequest(
        { model: "seed-tts", input: "hi" },
        { channelType: CHANNEL_TYPE_VOLC, originModelName: "seed-tts", upstreamModelName: "seed-tts", relayMode: "audio_transcription" },
      ),
    new RegExp(VOLC_TTS_UNSUPPORTED_AUDIO),
  );

  const payload = new TextEncoder().encode('{"hello":true}');
  const frame = marshalVolcFullClientRequest(payload);
  const parsed = unmarshalVolcBinaryMessage(frame);
  assert.equal(parsed.msgType, MSG_TYPE_FULL_CLIENT_REQUEST);
  assert.equal(new TextDecoder().decode(parsed.payload), '{"hello":true}');
  const audio = unmarshalVolcBinaryMessage(marshalVolcAudioOnlyServer(new Uint8Array([9, 8]), -1));
  assert.equal(audio.msgType, MSG_TYPE_AUDIO_ONLY_SERVER);
  assert.equal(audio.sequence, -1);
  assert.deepEqual([...audio.payload], [9, 8]);

  const http = volcTtsHttpDoResponse({ code: 3000, message: "ok", data: btoa("ABC") }, "mp3");
  assert.equal(http.contentType, "audio/mpeg");
  assert.deepEqual([...http.body], [65, 66, 67]);
  assert.throws(() => volcTtsHttpDoResponse({ code: 3001, message: "upstream fail" }, "mp3"), /upstream fail/);
});

test("original Volcengine TTS websocket binary JSON is sent upstream and audio bytes are returned", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-tts",
        type: CHANNEL_TYPE_VOLC,
        key: "appid|access-token",
        models: "seed-tts",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));
  const custom = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-tts-http",
        type: CHANNEL_TYPE_VOLC,
        key: "appid|access-token",
        models: "seed-tts-http",
        group: "default",
        base_url: "https://tts.example",
      }),
    }),
    e,
  );
  assert.equal(custom.body.success, true, String(custom.body.message));
  const bad = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-tts-bad",
        type: CHANNEL_TYPE_VOLC,
        key: "invalid",
        models: "seed-tts-bad",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(bad.body.success, true, String(bad.body.message));

  const origFetch = globalThis.fetch;
  MockVolcTtsSocket.sent = [];
  const httpCalls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === VOLC_TTS_WS_URL || url === "https://tts.example/v1/audio/speech") {
      if (headers.get("Upgrade") === "websocket") {
        const ws = new MockVolcTtsSocket();
        return { status: 101, ok: false, headers: new Headers(), webSocket: ws, text: async () => "" } as unknown as Response;
      }
      const raw = typeof init?.body === "string" ? init.body : "";
      httpCalls.push({ url, headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      return new Response(JSON.stringify({ code: 3000, message: "ok", data: btoa("WAV") }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    const speech = await handleFetch(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "seed-tts",
          input: "hello volc",
          voice: "nova",
          response_format: "mp3",
        }),
      }),
      e,
      ctx(),
    );
    assert.equal(speech.status, 200, await speech.clone().text());
    assert.equal(speech.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual([...new Uint8Array(await speech.arrayBuffer())], [1, 2, 3, 4, 5]);
    assert.equal(MockVolcTtsSocket.sent.length, 1);
    const sent = unmarshalVolcBinaryMessage(MockVolcTtsSocket.sent[0]);
    assert.equal(sent.msgType, MSG_TYPE_FULL_CLIENT_REQUEST);
    const payload = JSON.parse(new TextDecoder().decode(sent.payload)) as Record<string, unknown>;
    assert.deepEqual(payload.app, { appid: "appid", token: "access-token", cluster: "volcano_tts" });
    assert.deepEqual(payload.user, { uid: "openai_relay_user" });
    assert.equal((payload.audio as { voice_type: string }).voice_type, "zh_female_shuangkuaisisi_mars_bigtts");
    assert.equal((payload.audio as { encoding: string }).encoding, "mp3");
    assert.equal((payload.audio as { rate: number }).rate, 24000);
    assert.equal((payload.request as { text: string }).text, "hello volc");
    assert.equal((payload.request as { operation: string }).operation, "submit");
    assert.equal((payload.request as { model: string }).model, "seed-tts");
    assert.equal("stream_options" in payload, false);

    const query = await handleFetch(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "seed-tts-http",
          input: "http path",
          response_format: "wav",
          metadata: { request: { operation: "query" } },
        }),
      }),
      e,
      ctx(),
    );
    assert.equal(query.status, 200, await query.clone().text());
    assert.equal(query.headers.get("content-type"), "audio/wav");
    assert.deepEqual([...new Uint8Array(await query.arrayBuffer())], [87, 65, 86]);
    assert.equal(httpCalls.length, 1);
    assert.equal(httpCalls[0].url, "https://tts.example/v1/audio/speech");
    assert.equal(httpCalls[0].headers.get("authorization"), "Bearer;access-token");
    assert.equal((httpCalls[0].body.request as { operation: string }).operation, "query");
    assert.equal((httpCalls[0].body.request as { text: string }).text, "http path");
    assert.equal((httpCalls[0].body.audio as { encoding: string }).encoding, "wav");

    const fail = await json(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "seed-tts-bad", input: "hi" }),
      }),
      e,
    );
    assert.equal(fail.res.status, 500, fail.text);
    assert.equal((fail.body.error as { message: string }).message, VOLC_TTS_INVALID_KEY);
    assert.equal((fail.body.error as { code: string }).code, "convert_request_failed");

    const transcribe = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "seed-tts", input: "hi" }),
      }),
      e,
    );
    assert.equal(transcribe.res.status, 500, transcribe.text);
    assert.equal((transcribe.body.error as { message: string }).message, VOLC_TTS_UNSUPPORTED_AUDIO);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Volcengine TTS websocket error frame JSON", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "volc-tts-err",
        type: CHANNEL_TYPE_VOLC,
        key: "appid|access-token",
        models: "seed-tts-err",
        group: "default",
      }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(input) === VOLC_TTS_WS_URL && headers.get("Upgrade") === "websocket") {
      const ws = {
        readyState: 1,
        accept() {},
        listeners: { message: [] as WsListener[] },
        addEventListener(type: string, fn: WsListener) {
          if (type === "message") this.listeners.message.push(fn);
        },
        send() {
          queueMicrotask(() => {
            const frame = marshalVolcErrorMessage(1001, new TextEncoder().encode("quota"));
            for (const fn of this.listeners.message) fn({ data: frame });
          });
        },
        close() {},
      };
      return { status: 101, ok: false, headers: new Headers(), webSocket: ws, text: async () => "" } as unknown as Response;
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const res = await json(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "seed-tts-err", input: "hi" }),
      }),
      e,
    );
    assert.equal(res.res.status, 400, res.text);
    assert.equal((res.body.error as { message: string }).message, "received error from server: code=1001, quota");
    assert.equal((res.body.error as { code: string }).code, "bad_response");
  } finally {
    globalThis.fetch = origFetch;
  }
});
