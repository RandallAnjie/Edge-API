import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER } from "../src/constants.js";
import { convertOpenAIImageEditForm, detectImageMimeType, usesOpenAIImageEditAdaptor } from "../src/openai-image-convert.js";
import { parseMultipartForm } from "../src/multipart-form.js";
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
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer;
}

function imageEditForm(prompt: string, model = "gpt-image-1"): { buf: ArrayBuffer; ct: string } {
  const boundary = "----OpenAIImageEdit";
  const raw =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="stream"\r\n\r\ntrue\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="partial_images"\r\n\r\n3\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: application/octet-stream\r\n\r\nfake image\r\n` +
    `--${boundary}--\r\n`;
  return { buf: latin1Buffer(raw), ct: `multipart/form-data; boundary=${boundary}` };
}

test("original OpenAI ConvertImageRequest multipart edits keep form fields and file bytes", () => {
  assert.equal(detectImageMimeType("input.png"), "image/png");
  assert.equal(detectImageMimeType("photo.JPG"), "image/jpeg");
  assert.equal(detectImageMimeType("a.webp"), "image/webp");
  assert.equal(detectImageMimeType("noext"), "image/png");
  assert.equal(usesOpenAIImageEditAdaptor(CHANNEL_TYPE_OPENAI), true);
  assert.equal(usesOpenAIImageEditAdaptor(CHANNEL_TYPE_OPENROUTER), true);
  assert.equal(usesOpenAIImageEditAdaptor(CHANNEL_TYPE_ALI), false);

  const prompt = "edit this image";
  const { buf, ct } = imageEditForm(prompt);
  const converted = convertOpenAIImageEditForm(buf, ct, "gpt-image-1");
  assert.match(converted.contentType, /^multipart\/form-data; boundary=/);
  const replayed = parseMultipartForm(converted.body.buffer.slice(converted.body.byteOffset, converted.body.byteOffset + converted.body.byteLength), converted.contentType);
  assert.equal(replayed.values.model?.[0], "gpt-image-1");
  assert.equal(replayed.values.prompt?.[0], prompt);
  assert.equal(replayed.values.stream?.[0], "true");
  assert.equal(replayed.values.partial_images?.[0], "3");
  assert.equal(replayed.files.length, 1);
  assert.equal(replayed.files[0].name, "image");
  assert.equal(replayed.files[0].filename, "input.png");
  assert.equal(new TextDecoder("latin1").decode(replayed.files[0].data), "fake image");

  const mapped = convertOpenAIImageEditForm(buf, ct, "gpt-image-1");
  const mappedForm = parseMultipartForm(
    mapped.body.buffer.slice(mapped.body.byteOffset, mapped.body.byteOffset + mapped.body.byteLength),
    mapped.contentType,
  );
  assert.equal(mappedForm.values.model?.[0], "gpt-image-1");

  const noImage =
    `------b\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n------b--\r\n`;
  assert.throws(
    () => convertOpenAIImageEditForm(latin1Buffer(noImage), "multipart/form-data; boundary=----b"),
    /image is required/,
  );
});

test("original OpenAI multipart image edits ConvertImageRequest is re-serialized with mapped model", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "openai-edit",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-up",
        models: "customer-image,gpt-image-1",
        group: "default",
        base_url: "https://api.openai.com",
        model_mapping: JSON.stringify({ "customer-image": "gpt-image-1" }),
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));

  const prompt = "edit this image";
  const { buf, ct } = imageEditForm(prompt, "customer-image");
  const origFetch = globalThis.fetch;
  const calls: { url: string; contentType: string; model: string; prompt: string; stream: string; partial: string; file: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const contentType = new Headers(init?.headers).get("content-type") || "";
    const raw = init?.body;
    let bytes: Uint8Array;
    if (raw instanceof Uint8Array) bytes = raw;
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (typeof raw === "string") bytes = new TextEncoder().encode(raw);
    else throw new Error("unexpected openai edit body " + typeof raw);
    const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parsed = parseMultipartForm(sliced, contentType);
    calls.push({
      url,
      contentType,
      model: parsed.values.model?.[0] || "",
      prompt: parsed.values.prompt?.[0] || "",
      stream: parsed.values.stream?.[0] || "",
      partial: parsed.values.partial_images?.[0] || "",
      file: new TextDecoder("latin1").decode(parsed.files[0]?.data || new Uint8Array()),
    });
    return new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://example.com/edited.png", b64_json: "", revised_prompt: "" }] }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const image = await json(
      new Request("http://local/v1/images/edits", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": ct },
        body: buf,
      }),
      e,
    );
    assert.equal(image.res.status, 200, image.text);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/images\/edits/);
    assert.match(calls[0].contentType, /multipart\/form-data/);
    assert.equal(calls[0].model, "gpt-image-1");
    assert.equal(calls[0].prompt, prompt);
    assert.equal(calls[0].stream, "true");
    assert.equal(calls[0].partial, "3");
    assert.equal(calls[0].file, "fake image");
  } finally {
    globalThis.fetch = origFetch;
  }
});
