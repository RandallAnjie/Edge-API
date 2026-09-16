import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import { imageHelperFloorUsageTokens, imageHelperLogContent, imageHelperLogParts } from "../src/image-billing.js";
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

test("original ImageHelper extraContent 大小/品质/生成数量 JSON", () => {
  assert.deepEqual(imageHelperLogParts({}), ["品质 standard", "生成数量 1"]);
  assert.equal(imageHelperLogContent({}), "品质 standard, 生成数量 1");
  assert.equal(
    imageHelperLogContent({ size: "1024x1024", quality: "hd", n: 2 }),
    "大小 1024x1024, 品质 hd, 生成数量 2",
  );
  assert.deepEqual(imageHelperLogParts({ n: 0, quality: "standard" }), ["品质 standard"]);
  const usage = { prompt: 0, total: 0 };
  imageHelperFloorUsageTokens(usage);
  assert.equal(usage.prompt, 1);
  assert.equal(usage.total, 1);
  const kept = { prompt: 12, total: 12 };
  imageHelperFloorUsageTokens(kept);
  assert.equal(kept.prompt, 12);
  assert.equal(kept.total, 12);
});

test("original HTTP ImageHelper consume-log content and prompt token floor JSON", async () => {
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
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "image-log",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-image-log",
        models: "dall-e-3",
        group: "default",
        base_url: "https://image-log.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "image-log", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        created: 1,
        data: [{ url: "https://example.test/cat.png" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", size: "1024x1024", n: 2, quality: "hd" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  } finally {
    globalThis.fetch = orig;
  }
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "dall-e-3" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length, 1, JSON.stringify(logs.body));
  assert.equal(items[0].content, "大小 1024x1024, 品质 hd, 生成数量 2");
  assert.equal(Number(items[0].prompt_tokens), 1);
});
