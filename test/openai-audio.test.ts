import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_ALI,
  CHANNEL_TYPE_AZURE,
  CHANNEL_TYPE_MOONSHOT,
  CHANNEL_TYPE_NEW_API,
  CHANNEL_TYPE_OPENAI,
  CHANNEL_TYPE_OPENROUTER,
  CHANNEL_TYPE_SILICONFLOW,
  CHANNEL_TYPE_XINFERENCE,
} from "../src/constants.js";
import { convertOpenAIAudioForm, formFileContentType, usesOpenAIAudioAdaptor } from "../src/openai-audio-convert.js";
import { audioRequestIsStream, getAndValidAudioRequest } from "../src/audio-request.js";
import { parseMultipartForm } from "../src/multipart-form.js";
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
  await mergeModelRatio(new Store(e.DB), { "customer-audio": 1 });
  return { e, auth, sk };
}

function latin1Buffer(raw: string): ArrayBuffer {
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function audioForm(model = "whisper-1", language = "en"): { buf: ArrayBuffer; ct: string } {
  const boundary = "----OpenAIAudio";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n` +
    `--${boundary}--\r\n`;
  return { buf: latin1Buffer(raw), ct: `multipart/form-data; boundary=${boundary}` };
}

test("original OpenAI ConvertAudioRequest multipart transcriptions rewrite mapped model and file", () => {
  assert.equal(formFileContentType("a.wav"), "audio/wav");
  assert.equal(formFileContentType("clip.mp3"), "audio/mpeg");
  assert.equal(formFileContentType("noext"), "application/octet-stream");
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_OPENAI), true);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_AZURE), true);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_OPENROUTER), true);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_XINFERENCE), true);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_SILICONFLOW), true);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_ALI), false);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_MOONSHOT), false);
  assert.equal(usesOpenAIAudioAdaptor(CHANNEL_TYPE_NEW_API), false);

  const { buf, ct } = audioForm("customer-audio");
  const converted = convertOpenAIAudioForm(buf, ct, "whisper-1");
  assert.match(converted.contentType, /^multipart\/form-data; boundary=/);
  const replayed = parseMultipartForm(bytesBuffer(converted.body), converted.contentType);
  assert.equal(replayed.values.model?.[0], "whisper-1");
  assert.equal(replayed.values.language?.[0], "en");
  assert.equal(replayed.values.response_format?.[0], "json");
  assert.equal(replayed.files.length, 1);
  assert.equal(replayed.files[0].name, "file");
  assert.equal(replayed.files[0].filename, "a.wav");
  assert.equal(new TextDecoder("latin1").decode(replayed.files[0].data), "RIFF");

  const noFile =
    `------b\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n------b--\r\n`;
  assert.throws(
    () => convertOpenAIAudioForm(latin1Buffer(noFile), "multipart/form-data; boundary=----b", "whisper-1"),
    /file is required/,
  );
  assert.throws(
    () => convertOpenAIAudioForm(latin1Buffer("not-multipart"), "multipart/form-data; boundary=----missing", "whisper-1"),
    /error parsing multipart form/,
  );
});

test("original OpenAI multipart audio ConvertAudioRequest is re-serialized with mapped model", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-audio",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-up",
        models: "customer-audio,whisper-1",
        group: "default",
        base_url: "https://api.openai.com",
        model_mapping: JSON.stringify({ "customer-audio": "whisper-1" }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const { buf, ct } = audioForm("customer-audio");
  const origFetch = globalThis.fetch;
  const calls: { url: string; contentType: string; model: string; language: string; format: string; file: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get("content-type") || "";
    const raw = init?.body;
    let bytes: Uint8Array;
    if (raw instanceof Uint8Array) bytes = raw;
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (typeof raw === "string") bytes = new TextEncoder().encode(raw);
    else throw new Error("unexpected openai audio body " + typeof raw);
    const parsed = parseMultipartForm(bytesBuffer(bytes), contentType);
    calls.push({
      url,
      contentType,
      model: parsed.values.model?.[0] || "",
      language: parsed.values.language?.[0] || "",
      format: parsed.values.response_format?.[0] || "",
      file: new TextDecoder("latin1").decode(parsed.files[0]?.data || new Uint8Array()),
    });
    return new Response(JSON.stringify({ text: "hello" }), { headers: { "content-type": "application/json" } });
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
    assert.equal(audio.body.text, "hello");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/audio\/transcriptions/);
    assert.match(calls[0].contentType, /multipart\/form-data/);
    assert.notEqual(calls[0].contentType, ct);
    assert.equal(calls[0].model, "whisper-1");
    assert.equal(calls[0].language, "en");
    assert.equal(calls[0].format, "json");
    assert.equal(calls[0].file, "RIFF");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original GetAndValidAudioRequest JSON fields", () => {
  const speech = getAndValidAudioRequest("audio_speech", {
    model: "tts-1",
    input: "hello",
    voice: "alloy",
    extra: "drop-me",
  });
  assert.deepEqual(speech, { model: "tts-1", input: "hello", voice: "alloy" });
  assert.equal("response_format" in speech, false);
  assert.equal("extra" in speech, false);
  assert.equal(audioRequestIsStream(speech), false);

  const transcribe = getAndValidAudioRequest("audio_transcription", { model: "whisper-1", language: "en" });
  assert.equal(transcribe.response_format, "json");
  assert.equal(transcribe.language, "en");

  const sse = getAndValidAudioRequest("audio_speech", { model: "gpt-4o-mini-tts", input: "hi", stream_format: "sse" });
  assert.equal(audioRequestIsStream(sse), true);

  assert.throws(() => getAndValidAudioRequest("audio_speech", { input: "hi" }), /model is required/);
  assert.throws(() => getAndValidAudioRequest("audio_transcription", {}), /model is required/);

  const { buf, ct } = audioForm("whisper-1");
  const fromForm = getAndValidAudioRequest("audio_transcription", buf, ct);
  assert.equal(fromForm.model, "whisper-1");
  assert.equal(fromForm.response_format, "json");
  assert.equal(fromForm.language, "en");
  assert.equal("file" in fromForm, false);
});

test("original GetAndValidAudioRequest HTTP JSON rejects missing model", async () => {
  const { e, sk } = await boot();
  const missing = await json(
    new Request("http://local/v1/audio/speech", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ input: "hello", voice: "alloy" }),
    }),
    e,
  );
  assert.equal(missing.res.status, 400, missing.text);
  assert.equal((missing.body.error as { message?: string }).message, "model is required");
  assert.equal((missing.body.error as { code?: string }).code, "invalid_request");

  const boundary = "----MissingModel";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nen\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n` +
    `--${boundary}--\r\n`;
  const transcribe = await json(
    new Request("http://local/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: latin1Buffer(raw),
    }),
    e,
  );
  assert.equal(transcribe.res.status, 400, transcribe.text);
  assert.equal((transcribe.body.error as { message?: string }).message, "model is required");
  assert.equal((transcribe.body.error as { code?: string }).code, "invalid_request");
});

test("original GetAndValidAudioRequest multipart without response_format still relays json default", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-audio-default-fmt",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-up",
        models: "whisper-1",
        group: "default",
        base_url: "https://api.openai.com",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));
  const boundary = "----NoFmt";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\r\n` +
    `--${boundary}--\r\n`;
  const origFetch = globalThis.fetch;
  const calls: { model: string; format: string | undefined }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const contentType = new Headers(init?.headers).get("content-type") || "";
    const rawBody = init?.body;
    let bytes: Uint8Array;
    if (rawBody instanceof Uint8Array) bytes = rawBody;
    else if (rawBody instanceof ArrayBuffer) bytes = new Uint8Array(rawBody);
    else if (typeof rawBody === "string") bytes = new TextEncoder().encode(rawBody);
    else throw new Error("unexpected body");
    const parsed = parseMultipartForm(bytesBuffer(bytes), contentType);
    calls.push({ model: parsed.values.model?.[0] || "", format: parsed.values.response_format?.[0] });
    return new Response(JSON.stringify({ text: "hello" }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const audio = await json(
      new Request("http://local/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
        body: latin1Buffer(raw),
      }),
      e,
    );
    assert.equal(audio.res.status, 200, audio.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "whisper-1");
    assert.equal(calls[0].format, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

