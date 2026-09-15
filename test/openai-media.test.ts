import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ANTHROPIC, CHANNEL_TYPE_GEMINI } from "../src/constants.js";
import {
  collectOpenAIHttpMediaUrls,
  fileSourceIdentifier,
  openAIChatPartToFileSource,
  openAIHttpMediaDialect,
  prefetchOpenAIHttpMedia,
  resolveOpenAIChatFileSource,
} from "../src/openai-media.js";
import { geminiUnsupportedMimeError } from "../src/gemini-convert.js";
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

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

test("original FileSource GetIdentifier truncates URL and base64 JSON fields", () => {
  assert.equal(fileSourceIdentifier("https://example.com/cat.png"), "https://example.com/cat.png");
  const long = `https://example.com/${"a".repeat(120)}.png`;
  assert.equal(fileSourceIdentifier(long), long.slice(0, 100) + "...");
  assert.equal(fileSourceIdentifier("short"), "base64:short");
  const b64 = "A".repeat(80);
  assert.equal(fileSourceIdentifier(b64), "base64:" + "A".repeat(50) + "...");
});

test("original OpenAI ConvertRequest collects HTTP file source URLs", () => {
  assert.deepEqual(
    collectOpenAIHttpMediaUrls({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "image_url", image_url: { url: "https://cdn.example/a.png" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,YWE=" } },
            { type: "image_url", image_url: { url: "https://cdn.example/a.png" } },
          ],
        },
      ],
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://cdn.example/b.png" }],
        },
      ],
    }),
    ["https://cdn.example/a.png", "https://cdn.example/b.png"],
  );
  assert.deepEqual(
    collectOpenAIHttpMediaUrls({
      messages: [
        {
          role: "user",
          content: [
            { type: "file", file: { file_data: "https://cdn.example/doc.pdf" } },
            { type: "video_url", video_url: { url: "https://cdn.example/v.mp4" } },
            { type: "file", file: { file_data: "data:application/pdf;base64,AAA" } },
          ],
        },
      ],
    }),
    ["https://cdn.example/doc.pdf", "https://cdn.example/v.mp4"],
  );
  assert.equal(openAIHttpMediaDialect({ client: "openai", channelType: CHANNEL_TYPE_ANTHROPIC, kind: "anthropic" }), "claude");
  assert.equal(openAIHttpMediaDialect({ client: "openai", channelType: CHANNEL_TYPE_GEMINI, kind: "gemini" }), "gemini");
  assert.equal(openAIHttpMediaDialect({ client: "anthropic", channelType: CHANNEL_TYPE_ANTHROPIC, kind: "anthropic" }), undefined);
});

test("original MediaContent.ToFileSource and loadFromBase64 JSON fields", () => {
  assert.deepEqual(openAIChatPartToFileSource({ type: "file", file: { file_data: "data:application/pdf;base64,AAA" } }), {
    data: "data:application/pdf;base64,AAA",
    mime: "",
  });
  assert.deepEqual(openAIChatPartToFileSource({ type: "input_audio", input_audio: { data: "YWE=", format: "wav" } }), {
    data: "YWE=",
    mime: "audio/wav",
  });
  assert.deepEqual(openAIChatPartToFileSource({ type: "video_url", video_url: { url: "https://cdn.example/v.mp4" } }), {
    data: "https://cdn.example/v.mp4",
    mime: "",
  });
  assert.equal(openAIChatPartToFileSource({ type: "file", file: { filename: "a.pdf" } }), null);
  assert.deepEqual(resolveOpenAIChatFileSource({ data: "data:application/pdf;base64,JVBERi0=", mime: "" }), {
    data: "JVBERi0=",
    mime: "application/pdf",
  });
  assert.deepEqual(
    resolveOpenAIChatFileSource({ data: "data:image/png;base64,YWE=", mime: "image/jpeg" }),
    { data: "YWE=", mime: "image/jpeg" },
  );
});

test("original OpenAI→Claude ConvertRequest HTTP image GetBase64Data wrap JSON", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        prefetchOpenAIHttpMedia(
          {
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example/missing.png" } }] }],
          },
          "claude",
        ),
      /get file data failed: failed to download file, status code: 404/,
    );
    await assert.rejects(
      () =>
        prefetchOpenAIHttpMedia(
          {
            messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example/missing.png" } }] }],
          },
          "gemini",
        ),
      /get file data from 'https:\/\/cdn\.example\/missing\.png' failed: failed to download file, status code: 404/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original Gemini ConvertRequest unsupported mime JSON fields", () => {
  const msg = geminiUnsupportedMimeError("application/zip", "https://cdn.example/a.zip");
  assert.match(msg, /^mime type is not supported by Gemini: 'application\/zip', url: 'https:\/\/cdn\.example\/a\.zip', supported types are: \[/);
  assert.match(msg, /image\/png/);
});

test("original OpenAI→Claude and OpenAI→Gemini ConvertRequest HTTP image JSON is sent upstream", async () => {
  const { e, auth, sk } = await boot();
  const anthropic = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "anthropic-img",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-3-haiku-20240307",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(anthropic.body.success, true, String(anthropic.body.message));
  const gemini = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-img",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-2.0-flash",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(gemini.body.success, true, String(gemini.body.message));

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const origFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cdn.example/cat.png") {
      return new Response(png as unknown as BodyInit, { headers: { "content-type": "image/png" } });
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = { url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
    if (url.includes("generativelanguage.googleapis.com")) {
      return new Response(
        JSON.stringify({
          candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "saw it" }] } }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "msg_img",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "saw it" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "image_url", image_url: { url: "https://cdn.example/cat.png" } },
              ],
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    if (!captured) throw new Error("missing anthropic openai image upstream");
    const msgs = captured.body.messages as Record<string, unknown>[];
    const parts = msgs[0].content as Record<string, unknown>[];
    assert.deepEqual(parts[0], { type: "text", text: "what is this" });
    assert.deepEqual(parts[1].source, { type: "base64", media_type: "image/png", data: bytesToB64(png) });
    assert.equal("url" in (parts[1].source as object), false);

    const geminiChat = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this" },
                { type: "image_url", image_url: { url: "https://cdn.example/cat.png" } },
              ],
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(geminiChat.res.status, 200, geminiChat.text);
    if (!captured) throw new Error("missing gemini openai image upstream");
    assert.match(captured.url, /generativelanguage\.googleapis\.com/);
    const contents = captured.body.contents as { parts: Record<string, unknown>[] }[];
    assert.equal(contents[0].parts[0].text, "what is this");
    assert.deepEqual(contents[0].parts[1].inlineData, { mimeType: "image/png", data: bytesToB64(png) });

    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const fail = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.example/missing.png" } }] }],
        }),
      }),
      e,
    );
    assert.equal(fail.res.status, 500, fail.text);
    assert.equal((fail.body.error as { code: string }).code, "convert_request_failed");
    assert.equal(
      (fail.body.error as { message: string }).message,
      "get file data failed: failed to download file, status code: 404",
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original OpenAI→Claude ConvertRequest HTTP file ToFileSource document JSON", async () => {
  const { e, auth, sk } = await boot();
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "claude-pdf",
        type: CHANNEL_TYPE_ANTHROPIC,
        key: "sk-ant",
        models: "claude-3-haiku-20240307",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  const origFetch = globalThis.fetch;
  let captured: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://cdn.example/doc.pdf") {
      return new Response(pdf as unknown as BodyInit, { headers: { "content-type": "application/pdf" } });
    }
    const raw = typeof init?.body === "string" ? init.body : "";
    captured = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return new Response(
      JSON.stringify({
        id: "msg_pdf",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "pdf" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const claude = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "summarize" },
                { type: "file", file: { file_data: "https://cdn.example/doc.pdf" } },
              ],
            },
          ],
        }),
      }),
      e,
    );
    assert.equal(claude.res.status, 200, claude.text);
    if (!captured) throw new Error("missing anthropic openai file upstream");
    const msgs = captured.messages as Record<string, unknown>[];
    const parts = msgs[0].content as Record<string, unknown>[];
    assert.deepEqual(parts[0], { type: "text", text: "summarize" });
    assert.equal(parts[1].type, "document");
    assert.deepEqual(parts[1].source, { type: "base64", media_type: "application/pdf", data: bytesToB64(pdf) });
  } finally {
    globalThis.fetch = origFetch;
  }
});
