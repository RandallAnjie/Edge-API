import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_CLOUDFLARE } from "../src/constants.js";
import {
  cloudflareRequestURL,
  cloudflareSTTUsage,
  convertCloudflareAudioRequest,
  isCloudflareSTTRelayMode,
  openaiFromCloudflareSTT,
} from "../src/cloudflare-convert.js";
import { estimateTokenByModel } from "../src/openai-realtime-usage.js";
import { usesOpenAIAudioAdaptor } from "../src/openai-audio-convert.js";
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

function latin1Buffer(raw: string): ArrayBuffer {
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function audioForm(model = "customer-audio"): { buf: ArrayBuffer; ct: string } {
  const boundary = "----CfAudio";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFWAV\r\n` +
    `--${boundary}--\r\n`;
  return { buf: latin1Buffer(raw), ct: `multipart/form-data; boundary=${boundary}` };
}

test("original Cloudflare ConvertAudioRequest JSON, GetRequestURL, and cfSTTHandler fields", () => {
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_CLOUDFLARE), false);
  assert.equal(isCloudflareSTTRelayMode("audio_transcription"), true);
  assert.equal(isCloudflareSTTRelayMode("audio_translation"), true);
  assert.equal(isCloudflareSTTRelayMode("audio_speech"), false);
  assert.equal(
    cloudflareRequestURL("https://api.cloudflare.com", "acct-1", "audio_transcription", "whisper-1"),
    "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/whisper-1",
  );

  const { buf, ct } = audioForm();
  const file = convertCloudflareAudioRequest(buf, ct);
  assert.equal(new TextDecoder("latin1").decode(file), "RIFFWAV");

  const noFile = `------b\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n------b--\r\n`;
  assert.throws(
    () => convertCloudflareAudioRequest(latin1Buffer(noFile), "multipart/form-data; boundary=----b"),
    /file is required/,
  );
  assert.throws(
    () => convertCloudflareAudioRequest(latin1Buffer("not-multipart"), "multipart/form-data; boundary=----missing"),
    /file is required/,
  );

  assert.deepEqual(openaiFromCloudflareSTT({ result: { text: "hello from workers ai" } }), {
    text: "hello from workers ai",
  });
  assert.deepEqual(openaiFromCloudflareSTT({ result: {} }), { text: "" });
  assert.deepEqual(openaiFromCloudflareSTT({}), { text: "" });
  assert.throws(() => openaiFromCloudflareSTT({ result: "nope" }), /bad_response_body/);
  assert.throws(() => openaiFromCloudflareSTT({ result: { text: 1 } }), /bad_response_body/);
  assert.throws(() => openaiFromCloudflareSTT(null), /bad_response_body/);

  const usage = cloudflareSTTUsage("hello from workers ai", "whisper-1", 0);
  assert.equal(usage.prompt_tokens, 0);
  assert.equal(usage.completion_tokens, estimateTokenByModel("whisper-1", "hello from workers ai"));
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  assert.equal("text" in usage, false);
});

test("original Cloudflare multipart STT ConvertAudioRequest is raw file bytes and cfSTTHandler {text}", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "cf-stt",
        type: CHANNEL_TYPE_CLOUDFLARE,
        key: "cfk",
        other: "acct-1",
        models: "customer-audio,whisper-1",
        group: "default",
        base_url: "https://api.cloudflare.com",
        model_mapping: JSON.stringify({ "customer-audio": "whisper-1" }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const { buf, ct } = audioForm("customer-audio");
  const origFetch = globalThis.fetch;
  const calls: { url: string; contentType: string | null; authorization: string | null; file: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    let bytes: Uint8Array;
    if (raw instanceof Uint8Array) bytes = raw;
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (typeof raw === "string") bytes = new TextEncoder().encode(raw);
    else throw new Error("unexpected cloudflare audio body " + typeof raw);
    calls.push({
      url,
      contentType: headers.get("content-type"),
      authorization: headers.get("authorization"),
      file: new TextDecoder("latin1").decode(bytes),
    });
    return new Response(JSON.stringify({ result: { text: "hello from workers ai" }, success: true }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const audio = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": ct },
        body: buf,
      }),
      e,
    );
    assert.equal(audio.res.status, 200, audio.text);
    assert.equal(audio.body.text, "hello from workers ai");
    assert.equal(Object.prototype.hasOwnProperty.call(audio.body, "text"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(audio.body, "choices"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(audio.body, "usage"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/whisper-1");
    assert.equal(calls[0].authorization, "Bearer cfk");
    assert.equal(calls[0].contentType, null);
    assert.equal(calls[0].file, "RIFFWAV");

    const translated = await json(
      new Request("http://local/v1/audio/translations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": ct },
        body: buf,
      }),
      e,
    );
    assert.equal(translated.res.status, 200, translated.text);
    assert.equal(translated.body.text, "hello from workers ai");
    assert.equal(calls[1].url, "https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/whisper-1");
    assert.equal(calls[1].contentType, null);
    assert.equal(calls[1].file, "RIFFWAV");

    const missing = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + sk,
          "content-type": "multipart/form-data; boundary=----b",
        },
        body: latin1Buffer(`------b\r\nContent-Disposition: form-data; name="model"\r\n\r\ncustomer-audio\r\n------b--\r\n`),
      }),
      e,
    );
    assert.equal(missing.res.status, 500, missing.text);
    assert.equal((missing.body.error as { message: string }).message, "file is required");
    assert.equal((missing.body.error as { code: string }).code, "convert_request_failed");

    const jsonBody = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "customer-audio" }),
      }),
      e,
    );
    assert.equal(jsonBody.res.status, 500, jsonBody.text);
    assert.equal((jsonBody.body.error as { message: string }).message, "file is required");
    assert.equal((jsonBody.body.error as { code: string }).code, "convert_request_failed");

    globalThis.fetch = (async () => new Response("not-json", { headers: { "content-type": "text/plain" } })) as typeof fetch;
    const bad = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": ct },
        body: buf,
      }),
      e,
    );
    assert.equal(bad.res.status, 500, bad.text);
    assert.equal((bad.body.error as { code: string }).code, "bad_response_body");
  } finally {
    globalThis.fetch = origFetch;
  }
});
