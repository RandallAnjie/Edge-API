import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CHANNEL_TYPE_GEMINI, LOG_CONSUME } from "../src/constants.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { createMemoryD1 } from "./d1-memory.js";
import type { Env, ExecutionContextLike } from "../src/types.js";
import {
  CONVERTER_CLAUDE_MESSAGES_TO_OPENAI_CHAT,
  CONVERTER_CLAUDE_TO_GEMINI,
  CONVERTER_GEMINI_TO_CLAUDE,
  CONVERTER_GEMINI_TO_RESPONSES,
  CONVERTER_OPENAI_CHAT_TO_GEMINI_CONTENT,
  expandRequestConversionTos,
  lookupRequestConverter,
} from "../src/request-convert-registry.js";
import {
  RELAY_FORMAT_CLAUDE,
  RELAY_FORMAT_GEMINI,
  RELAY_FORMAT_OPENAI,
  RELAY_FORMAT_OPENAI_RESPONSES,
  requestConversionChain,
} from "../src/log-info-generate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("request-convert-registry.ts must not import store / relay / convert / query / submit / log-info-generate", () => {
  const src = readFileSync(join(root, "src/request-convert-registry.ts"), "utf8");
  assert.doesNotMatch(src, /from ["']\.\/(store|relay|convert|query|submit|log-info-generate)/);
});

test("original ConvertRequest identity and direct hops append only step.To", () => {
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_OPENAI, RELAY_FORMAT_OPENAI), []);
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_OPENAI, RELAY_FORMAT_CLAUDE), [RELAY_FORMAT_CLAUDE]);
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_OPENAI, RELAY_FORMAT_GEMINI), [RELAY_FORMAT_GEMINI]);
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_CLAUDE, RELAY_FORMAT_OPENAI_RESPONSES), [
    RELAY_FORMAT_OPENAI_RESPONSES,
  ]);
  assert.equal(lookupRequestConverter(RELAY_FORMAT_CLAUDE, RELAY_FORMAT_GEMINI)?.id, CONVERTER_CLAUDE_TO_GEMINI);
  assert.equal(lookupRequestConverter(RELAY_FORMAT_CLAUDE, RELAY_FORMAT_GEMINI)?.stepIds[0], CONVERTER_CLAUDE_MESSAGES_TO_OPENAI_CHAT);
  assert.equal(lookupRequestConverter(RELAY_FORMAT_CLAUDE, RELAY_FORMAT_GEMINI)?.stepIds[1], CONVERTER_OPENAI_CHAT_TO_GEMINI_CONTENT);
});

test("original Claude→Gemini and Gemini→Claude request converter StepConverters JSON", () => {
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_CLAUDE, RELAY_FORMAT_GEMINI), [
    RELAY_FORMAT_OPENAI,
    RELAY_FORMAT_GEMINI,
  ]);
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_GEMINI, RELAY_FORMAT_CLAUDE), [
    RELAY_FORMAT_OPENAI,
    RELAY_FORMAT_CLAUDE,
  ]);
  assert.deepEqual(expandRequestConversionTos(RELAY_FORMAT_GEMINI, RELAY_FORMAT_OPENAI_RESPONSES), [
    RELAY_FORMAT_OPENAI,
    RELAY_FORMAT_OPENAI_RESPONSES,
  ]);
  assert.equal(lookupRequestConverter(RELAY_FORMAT_GEMINI, RELAY_FORMAT_CLAUDE)?.id, CONVERTER_GEMINI_TO_CLAUDE);
  assert.equal(lookupRequestConverter(RELAY_FORMAT_GEMINI, RELAY_FORMAT_OPENAI_RESPONSES)?.id, CONVERTER_GEMINI_TO_RESPONSES);
});

test("original request_conversion consume-log labels include convert-registry hops", () => {
  assert.deepEqual(
    requestConversionChain({
      clientFormat: "anthropic",
      mode: "messages",
      destinationFormat: RELAY_FORMAT_GEMINI,
    }).map((f) => f),
    [RELAY_FORMAT_CLAUDE, RELAY_FORMAT_OPENAI, RELAY_FORMAT_GEMINI],
  );
  assert.deepEqual(
    requestConversionChain({
      clientFormat: "gemini",
      mode: "gemini",
      destinationFormat: RELAY_FORMAT_CLAUDE,
    }),
    [RELAY_FORMAT_GEMINI, RELAY_FORMAT_OPENAI, RELAY_FORMAT_CLAUDE],
  );
  assert.deepEqual(
    requestConversionChain({
      clientFormat: "openai",
      mode: "chat",
      destinationFormat: RELAY_FORMAT_CLAUDE,
    }),
    [RELAY_FORMAT_OPENAI, RELAY_FORMAT_CLAUDE],
  );
  assert.deepEqual(
    requestConversionChain({
      clientFormat: "openai",
      mode: "chat",
    }),
    [RELAY_FORMAT_OPENAI],
  );
});

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

test("original Claude client → Gemini channel consume-log request_conversion JSON", async () => {
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
  const auth = {
    authorization: "Bearer " + (login.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "gemini-conv",
        type: CHANNEL_TYPE_GEMINI,
        key: "gkey",
        models: "gemini-2.0-flash",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "conv", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  const sk = String((tok.body.data as { key?: string })?.key || "");
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "gemini-2.0-flash",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  } finally {
    globalThis.fetch = orig;
  }
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gemini-2.0-flash" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const raw = items[0].other;
  const other = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  assert.deepEqual(other.request_conversion, ["Claude Messages", "OpenAI Compatible", "Google Gemini"]);
});
