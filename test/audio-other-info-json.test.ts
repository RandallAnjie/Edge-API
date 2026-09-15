import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import { audioConsumeLogRatios, textConsumePriceData } from "../src/quota.js";
import {
  consumeLogOther,
  DEFAULT_RELAY_FRT_MS,
  generateAudioOtherInfo,
  RELAY_FORMAT_OPENAI,
  RELAY_FORMAT_OPENAI_AUDIO,
  RELAY_FORMAT_OPENAI_RESPONSES,
  shouldPostAudioConsumeQuota,
} from "../src/log-info-generate.js";
import { generateWssOtherInfo, emptyRealtimeUsage } from "../src/openai-realtime-usage.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
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

async function boot(e: Env) {
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
  return { token, auth, store: new Store(e.DB) };
}

async function createChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown> = {}) {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "audio-other",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-audio-other",
        models: "gpt-4o-audio-preview,gpt-4o-mini-tts,gpt-4o-mini,tts-1",
        group: "default",
        base_url: "https://audio-other.example.test",
        ...body,
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  return Number((ch.body.data as { id: number }).id);
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "audio-other", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

async function withMockedFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

async function consumeLogs(e: Env, auth: Record<string, string>, model: string): Promise<Record<string, unknown>[]> {
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  return ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === model && Number(row.type) === LOG_CONSUME,
  );
}

test("original GenerateAudioOtherInfo always-set consume-log JSON fields", () => {
  const other = generateAudioOtherInfo({
    modelRatio: 1.25,
    groupRatio: 1,
    completionRatio: 4,
    cacheTokens: 99,
    cacheRatio: 0.5,
    modelPrice: -1,
    userGroupRatio: -1,
    frt: DEFAULT_RELAY_FRT_MS,
    requestPath: "/v1/chat/completions",
    requestConversion: [RELAY_FORMAT_OPENAI],
    billingSource: "wallet",
    audioInput: 3,
    audioOutput: 7,
    textInput: 10,
    textOutput: 2,
    audioRatio: 16,
    audioCompletionRatio: 1,
  });
  assert.equal(other.audio, true);
  assert.equal("ws" in other, false);
  assert.equal(other.audio_input, 3);
  assert.equal(other.audio_output, 7);
  assert.equal(other.text_input, 10);
  assert.equal(other.text_output, 2);
  assert.equal(other.audio_ratio, 16);
  assert.equal(other.audio_completion_ratio, 1);
  assert.equal(other.cache_tokens, 0);
  assert.equal(other.cache_ratio, 0);
  assert.equal(other.model_ratio, 1.25);
  assert.equal(other.completion_ratio, 4);
  assert.equal(other.model_price, -1);
  assert.equal(other.user_group_ratio, -1);
  assert.equal(other.frt, -1000);
  assert.equal("group" in other, false);
});

test("original GenerateAudioOtherInfo always includes zero audio token JSON", () => {
  const other = generateAudioOtherInfo({
    modelRatio: 0,
    groupRatio: 1,
    completionRatio: 20,
    modelPrice: 0.3,
    userGroupRatio: -1,
    audioRatio: 25,
    audioCompletionRatio: 1,
  });
  assert.equal(other.audio, true);
  assert.equal(other.audio_input, 0);
  assert.equal(other.audio_output, 0);
  assert.equal(other.text_input, 0);
  assert.equal(other.text_output, 0);
  assert.equal(other.audio_ratio, 25);
  assert.equal(other.audio_completion_ratio, 1);
});

test("original GenerateWssOtherInfo is ws not audio", () => {
  const usage = emptyRealtimeUsage();
  usage.input_token_details.audio_tokens = 1;
  usage.output_token_details.audio_tokens = 1;
  const other = generateWssOtherInfo({
    usage,
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 2,
    audioRatio: 8,
    audioCompletionRatio: 2,
    modelPrice: -1,
    userGroupRatio: -1,
    frtMs: 12,
    requestPath: "/v1/realtime",
    isModelMapped: false,
    upstreamModelName: "gpt-4o-realtime-preview",
  });
  assert.equal(other.ws, true);
  assert.equal("audio" in other, false);
  assert.equal(other.audio_ratio, 8);
});

test("original PostAudioConsumeQuota vs PostTextConsumeQuota branch JSON", () => {
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 0,
      audioOutput: 4,
      finalRequestFormat: RELAY_FORMAT_OPENAI_AUDIO,
    }),
    true,
  );
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 0,
      audioOutput: 0,
      finalRequestFormat: RELAY_FORMAT_OPENAI_AUDIO,
    }),
    false,
  );
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 2,
      audioOutput: 0,
      finalRequestFormat: RELAY_FORMAT_OPENAI,
      containsAudioRatios: true,
    }),
    true,
  );
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 2,
      audioOutput: 0,
      finalRequestFormat: RELAY_FORMAT_OPENAI,
      containsAudioRatios: false,
    }),
    false,
  );
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 0,
      audioOutput: 0,
      finalRequestFormat: RELAY_FORMAT_OPENAI_RESPONSES,
      originModelName: "gpt-4o-audio-preview",
    }),
    true,
  );
  assert.equal(
    shouldPostAudioConsumeQuota({
      audioInput: 0,
      audioOutput: 0,
      finalRequestFormat: RELAY_FORMAT_OPENAI_RESPONSES,
      originModelName: "gpt-4o-mini",
    }),
    false,
  );
});

test("original consumeLogOther AudioHelper JSON omits PostText extras", () => {
  const parsed = JSON.parse(
    consumeLogOther({
      model: "tts-1",
      group: "default",
      groupRatio: 1,
      modelRatio: 7.5,
      completionRatio: 1,
      cacheTokens: 12,
      cacheRatio: 0.5,
      modelPrice: -1,
      userGroupRatio: -1,
      frt: -1000,
      channelId: 4,
      channelName: "oa",
      channelType: CHANNEL_TYPE_OPENAI,
      ok: true,
      requestPath: "/v1/audio/speech",
      requestConversion: [RELAY_FORMAT_OPENAI_AUDIO],
      finalRequestFormat: RELAY_FORMAT_OPENAI_AUDIO,
      billingSource: "wallet",
      imageTokens: 9,
      imageRatio: 2,
      audioInput: 0,
      audioOutput: 20,
      textInput: 8,
      textOutput: 0,
      audioRatio: 1,
      audioCompletionRatio: 0,
      containsAudioRatios: true,
    }),
  ) as Record<string, unknown>;
  assert.equal(parsed.audio, true);
  assert.equal(parsed.audio_output, 20);
  assert.equal(parsed.audio_ratio, 1);
  assert.equal(parsed.audio_completion_ratio, 0);
  assert.equal(parsed.cache_tokens, 0);
  assert.equal(parsed.cache_ratio, 0);
  assert.equal("image" in parsed, false);
  assert.equal("ws" in parsed, false);
  assert.equal("group" in parsed, false);
});

test("original consumeLogOther Responses gpt-4o-audio prefix uses GenerateAudioOtherInfo zeros", () => {
  const parsed = JSON.parse(
    consumeLogOther({
      model: "gpt-4o-audio-preview",
      group: "default",
      groupRatio: 1,
      modelRatio: 1.25,
      completionRatio: 4,
      cacheTokens: 0,
      cacheRatio: 0,
      modelPrice: -1,
      userGroupRatio: -1,
      channelId: 1,
      channelName: "oa",
      channelType: CHANNEL_TYPE_OPENAI,
      ok: true,
      requestConversion: [RELAY_FORMAT_OPENAI_RESPONSES],
      finalRequestFormat: RELAY_FORMAT_OPENAI_RESPONSES,
      billingSource: "wallet",
      audioInput: 0,
      audioOutput: 0,
      audioRatio: 16,
      audioCompletionRatio: 1,
    }),
  ) as Record<string, unknown>;
  assert.equal(parsed.audio, true);
  assert.equal(parsed.audio_input, 0);
  assert.equal(parsed.audio_output, 0);
  assert.equal(parsed.audio_ratio, 16);
});

test("original ModelPriceHelper audio ratios are 0 on usePrice but PostAudio log uses GetAudioRatio", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const price = await textConsumePriceData(store, "gpt-4o-mini-tts", "default", "default");
  assert.equal(price.usePrice, true);
  assert.equal(price.modelPrice, 0.3);
  assert.equal(price.modelRatio, 0);
  assert.equal(price.completionRatio, 0);
  assert.equal(price.audioRatio, 0);
  assert.equal(price.audioCompletionRatio, 0);
  const audioLog = await audioConsumeLogRatios(store, "gpt-4o-mini-tts");
  assert.equal(audioLog.audioRatio, 25);
  assert.equal(audioLog.audioCompletionRatio, 1);
  assert.equal(audioLog.completionRatio, 20);
  assert.equal(audioLog.containsAudioRatios, true);
});

test("original chat gpt-4o-audio-preview consume log JSON has GenerateAudioOtherInfo fields", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-audio-other",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
            prompt_tokens_details: { text_tokens: 9, audio_tokens: 3, cached_tokens: 2 },
            completion_tokens_details: { text_tokens: 1, audio_tokens: 7 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-audio-preview",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const items = await consumeLogs(e, auth, "gpt-4o-audio-preview");
  assert.equal(items.length >= 1, true, JSON.stringify(items));
  const other = parseOther(items[0].other);
  assert.equal(other.audio, true);
  assert.equal("ws" in other, false);
  assert.equal(other.audio_input, 3);
  assert.equal(other.audio_output, 7);
  assert.equal(other.text_input, 9);
  assert.equal(other.text_output, 1);
  assert.equal(other.audio_ratio, 16);
  assert.equal(other.audio_completion_ratio, 1);
  assert.equal(other.cache_tokens, 0);
  assert.equal(other.cache_ratio, 0);
  assert.equal(other.model_ratio, 1.25);
  assert.equal(other.completion_ratio, 4);
  assert.equal(other.model_price, -1);
  assert.equal(other.user_group_ratio, -1);
  assert.equal(other.billing_source, "wallet");
  assert.equal("group" in other, false);
});

test("original chat gpt-4o-mini-tts consume log JSON uses GetAudioRatio 25 under usePrice", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-mini-tts",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 6,
            completion_tokens: 4,
            total_tokens: 10,
            prompt_tokens_details: { text_tokens: 6, audio_tokens: 0 },
            completion_tokens_details: { text_tokens: 0, audio_tokens: 4 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini-tts",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const items = await consumeLogs(e, auth, "gpt-4o-mini-tts");
  assert.equal(items.length >= 1, true, JSON.stringify(items));
  const other = parseOther(items[0].other);
  assert.equal(other.audio, true);
  assert.equal(other.audio_ratio, 25);
  assert.equal(other.audio_completion_ratio, 1);
  assert.equal(other.model_price, 0.3);
  assert.equal(other.model_ratio, 0);
  assert.equal(other.completion_ratio, 20);
  assert.equal(other.cache_tokens, 0);
  assert.equal(other.audio_output, 4);
});

test("original chat gpt-4o-mini audio tokens without audio ratios stay GenerateTextOtherInfo", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-no-audio-ratio",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
            prompt_tokens_details: { cached_tokens: 1, audio_tokens: 2 },
            completion_tokens_details: { audio_tokens: 1 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const items = await consumeLogs(e, auth, "gpt-4o-mini");
  assert.equal(items.length >= 1, true, JSON.stringify(items));
  const other = parseOther(items[0].other);
  assert.equal("audio" in other, false);
  assert.equal(other.cache_tokens, 1);
  assert.equal(other.cache_ratio, 0.5);
});

test("original binary /v1/audio/speech without audio tokens stays PostTextConsumeQuota JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () => new Response("ID3fake-mp3", { status: 200, headers: { "content-type": "audio/mpeg" } }),
    async () => {
      const hit = await json(
        new Request("http://local/v1/audio/speech", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "tts-1", input: "hello", voice: "alloy" }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const items = await consumeLogs(e, auth, "tts-1");
  assert.equal(items.length >= 1, true, JSON.stringify(items));
  const other = parseOther(items[0].other);
  assert.equal("audio" in other, false);
  assert.equal(other.model_ratio, 7.5);
  assert.equal(typeof other.cache_tokens, "number");
  assert.equal(other.request_path, "/v1/audio/speech");
});
