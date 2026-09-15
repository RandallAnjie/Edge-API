import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CHANNEL_TYPE_GEMINI, CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import {
  countTextToken,
  estimateRequestPromptTokens,
  estimateToken,
  getTokenCountMeta,
  isOpenAITextModel,
  openaiTextTokenEstimate,
  runeCount,
  TOKEN_TYPE_TEXT_NUMBER,
  TOKEN_TYPE_TOKENIZER,
} from "../src/token-count.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("token-count.ts must not import store / relay / convert / query / submit", () => {
  const src = readFileSync(join(root, "src/token-count.ts"), "utf8");
  assert.doesNotMatch(src, /from ["']\.\/(store|relay|convert|query|submit)/);
});

test("original AudioRequest GetTokenCountMeta uses Input rune count unless model contains gpt", () => {
  assert.equal(runeCount("hello"), 5);
  assert.equal(estimateToken("openai", "hello"), 2);
  assert.equal(isOpenAITextModel("tts-1"), false);
  assert.equal(isOpenAITextModel("gpt-4o-mini-tts"), true);

  const tts = getTokenCountMeta({
    mode: "audio_speech",
    clientFormat: "openai",
    body: { model: "tts-1", input: "hello", voice: "alloy" },
    model: "tts-1",
  });
  assert.equal(tts.combineText, "hello");
  assert.equal(tts.tokenType, TOKEN_TYPE_TEXT_NUMBER);
  assert.equal(
    estimateRequestPromptTokens({
      mode: "audio_speech",
      clientFormat: "openai",
      body: { model: "tts-1", input: "hello" },
      model: "tts-1",
    }),
    5,
  );

  const gptTts = getTokenCountMeta({
    mode: "audio_speech",
    clientFormat: "openai",
    body: { model: "gpt-4o-mini-tts", input: "hello" },
    model: "gpt-4o-mini-tts",
  });
  assert.equal(gptTts.tokenType, TOKEN_TYPE_TOKENIZER);
  assert.equal(
    estimateRequestPromptTokens({
      mode: "audio_speech",
      clientFormat: "openai",
      body: { model: "gpt-4o-mini-tts", input: "hello" },
      model: "gpt-4o-mini-tts",
    }),
    openaiTextTokenEstimate("hello"),
  );

  assert.equal(
    estimateRequestPromptTokens({
      mode: "audio_transcription",
      clientFormat: "openai",
      body: { model: "whisper-1" },
      model: "whisper-1",
    }),
    0,
  );
});

test("original EmbeddingRequest / RerankRequest / Gemini GetTokenCountMeta CombineText", () => {
  assert.equal(
    estimateRequestPromptTokens({
      mode: "embeddings",
      clientFormat: "openai",
      body: { model: "text-embedding-3-small", input: "hello" },
      model: "text-embedding-3-small",
    }),
    openaiTextTokenEstimate("hello"),
  );
  assert.equal(
    getTokenCountMeta({
      mode: "embeddings",
      clientFormat: "openai",
      body: { input: ["hello", "world"] },
    }).combineText,
    "hello\nworld",
  );
  assert.equal(
    getTokenCountMeta({
      mode: "rerank",
      clientFormat: "openai",
      body: { query: "q", documents: ["a", "b"] },
    }).combineText,
    "a\nb\nq",
  );
  const gemini = getTokenCountMeta({
    mode: "gemini",
    clientFormat: "gemini",
    body: { contents: [{ parts: [{ text: "hi" }, { text: "there" }] }] },
  });
  assert.equal(gemini.combineText, "hi\nthere");
  assert.equal(countTextToken("", "llama3"), 0);
});

test("original OpenAI CountRequestToken adds message/tool extras", () => {
  const tokens = estimateRequestPromptTokens({
    mode: "chat",
    clientFormat: "openai",
    body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    model: "gpt-4o-mini",
  });
  const text = openaiTextTokenEstimate("user\nhi");
  assert.equal(tokens, text + 3 + 3);
  const named = getTokenCountMeta({
    mode: "chat",
    clientFormat: "openai",
    body: {
      model: "gpt-4o-mini",
      messages: [{ role: "user", name: "bob", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", description: "find", parameters: { type: "object" } } }],
    },
  });
  assert.equal(named.messagesCount, 1);
  assert.equal(named.nameCount, 1);
  assert.equal(named.toolsCount, 1);
  assert.match(named.combineText, /lookup/);
});

test("original ImageRequest GetTokenCountMeta MaxTokens is 1584", () => {
  const meta = getTokenCountMeta({
    mode: "images",
    clientFormat: "openai",
    body: { model: "dall-e-3", prompt: "a cat", n: 2 },
  });
  assert.equal(meta.combineText, "a cat");
  assert.equal(meta.maxTokens, 1584);
});

test("original AudioRequest HTTP speech consume-log prompt_tokens uses Input rune count", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "speech-tokens",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-up",
        models: "tts-1",
        group: "default",
        base_url: "https://api.openai.com",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("ID3fake-mp3", { status: 200, headers: { "content-type": "audio/mpeg" } })) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/audio/speech", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "tts-1", input: "hello", voice: "alloy" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  } finally {
    globalThis.fetch = origFetch;
  }
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "tts-1" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(items));
  assert.equal(items[0].prompt_tokens, 5);
});

test("original EmbeddingRequest HTTP fallback usage prompt_tokens uses CombineText", async () => {
  const { e, auth, sk } = await boot();
  const add = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-embed-tokens",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "text-embedding-004",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(add.body.success, true, String(add.body.message));
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ embeddings: [{ values: [0.1, 0.2] }] }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const embed = await json(
      new Request("http://local/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "text-embedding-004", input: "hello" }),
      }),
      e,
    );
    assert.equal(embed.res.status, 200, embed.text);
    assert.equal((embed.body.usage as { prompt_tokens?: number }).prompt_tokens, openaiTextTokenEstimate("hello"));
  } finally {
    globalThis.fetch = origFetch;
  }
});
