import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { getTokenCountMeta } from "../src/token-count.js";
import { modelPriceHelperQuotaToPreConsume } from "../src/quota.js";
import { MAX_QUOTA } from "../src/task-plugin-usage.js";
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

function quotaInput(
  over: Partial<Parameters<typeof modelPriceHelperQuotaToPreConsume>[0]> & { billingModelName: string },
): Parameters<typeof modelPriceHelperQuotaToPreConsume>[0] {
  return {
    promptTokens: 0,
    groupRatio: 1,
    quotaPerUnit: 500000,
    preConsumedQuota: 500,
    enableFreeModelPreConsume: true,
    modelRatioMap: {},
    modelPriceMap: {},
    modes: {},
    ...over,
  };
}

test("original ModelPriceHelper QuotaToPreConsume ratio / usePrice / other-ratio JSON", () => {
  const ratio = modelPriceHelperQuotaToPreConsume(
    quotaInput({ billingModelName: "gpt-4o-mini", promptTokens: 10, modelRatioMap: { "gpt-4o-mini": 0.075 } }),
  );
  assert.equal(ratio.error, undefined);
  assert.equal(ratio.usePrice, false);
  assert.equal(ratio.quotaToPreConsume, 37);

  const withPrompt = modelPriceHelperQuotaToPreConsume(
    quotaInput({ billingModelName: "gpt-4o-mini", promptTokens: 1000, modelRatioMap: { "gpt-4o-mini": 0.075 } }),
  );
  assert.equal(withPrompt.quotaToPreConsume, 75);

  const withMax = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "gpt-4o-mini",
      promptTokens: 10,
      maxTokens: 100,
      modelRatioMap: { "gpt-4o-mini": 0.075 },
    }),
  );
  assert.equal(withMax.quotaToPreConsume, 45);

  const priced = modelPriceHelperQuotaToPreConsume(
    quotaInput({ billingModelName: "dall-e-3", modelPriceMap: { "dall-e-3": 0.04 } }),
  );
  assert.equal(priced.usePrice, true);
  assert.equal(priced.quotaToPreConsume, 20000);

  const fixedImage = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "fixed-image-price",
      promptTokens: 1000,
      imagePriceRatio: 3,
      billingRatios: { n: 3 },
      modelPriceMap: { "fixed-image-price": 0.04 },
    }),
  );
  assert.equal(fixedImage.usePrice, true);
  assert.equal(fixedImage.quotaToPreConsume, 180000);
  assert.equal(fixedImage.otherRatios.n, 3);

  const ratioIgnoresN = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "ratio-image-price",
      promptTokens: 1000,
      imagePriceRatio: 3,
      billingRatios: { n: 3 },
      modelRatioMap: { "ratio-image-price": 15 },
    }),
  );
  assert.equal(ratioIgnoresN.usePrice, false);
  assert.equal(ratioIgnoresN.quotaToPreConsume, 15000);
  assert.equal(ratioIgnoresN.otherRatios.n, undefined);

  const fractional = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "fractional-image-price",
      billingRatios: { n: 3 },
      modelPriceMap: { "fractional-image-price": 0.0000012 },
    }),
  );
  assert.equal(fractional.quotaToPreConsume, 1);

  const overflow = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "overflow-image-price",
      billingRatios: { n: 3 },
      modelPriceMap: { "overflow-image-price": MAX_QUOTA / 500000 / 2 },
    }),
  );
  assert.match(String(overflow.error || ""), /quota conversion \(QuotaFromFloat\) overflow/);
});

test("original ModelPriceHelper image n overlay and Ali prompt_extend JSON", () => {
  const openaiImage = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "dall-e-3",
      relayMode: "images",
      channelType: CHANNEL_TYPE_OPENAI,
      body: { model: "dall-e-3", n: 2 },
      billingRatios: { n: 2 },
      modelPriceMap: { "dall-e-3": 0.04 },
    }),
  );
  assert.equal(openaiImage.quotaToPreConsume, 40000);
  assert.equal(openaiImage.otherRatios.n, 2);
  assert.equal(openaiImage.imageQuotaBeforeGroup, 20000);
  assert.equal(openaiImage.groupRatio, 1);

  const aliRatio = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "qwen-image",
      promptTokens: 10,
      relayMode: "images",
      channelType: CHANNEL_TYPE_ALI,
      body: { model: "qwen-image", n: 3 },
      modelRatioMap: { "qwen-image": 1 },
    }),
  );
  assert.equal(aliRatio.otherRatios.n, 3);
  assert.equal(aliRatio.quotaToPreConsume, 1500);

  const zImage = modelPriceHelperQuotaToPreConsume(
    quotaInput({
      billingModelName: "z-image",
      relayMode: "images",
      channelType: CHANNEL_TYPE_ALI,
      originModelName: "z-image",
      upstreamModelName: "z-image",
      body: { model: "z-image", n: 1, parameters: { prompt_extend: true } },
      billingRatios: { n: 1 },
      modelPriceMap: { "z-image": 0.04 },
    }),
  );
  assert.equal(zImage.otherRatios.prompt_extend, 2);
  assert.equal(zImage.quotaToPreConsume, 40000);
});

test("original ImageRequest GetTokenCountMeta image_ratio and billing_ratios JSON", () => {
  const meta = getTokenCountMeta({
    mode: "images",
    clientFormat: "openai",
    body: { model: "dall-e-3", prompt: "cat", n: 3, size: "1024x1792", quality: "hd" },
  });
  assert.equal(meta.maxTokens, 1584);
  assert.equal(meta.imagePriceRatio, 3);
  assert.deepEqual(meta.billingRatios, { n: 3 });
});

test("original ModelPriceHelper QuotaToPreConsume is HTTP 403 when token remain is below pre-consume", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "pre-consume",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-pre",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://pre-consume.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const shortTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "short", remain_quota: 36, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(shortTok.body.success, true, String(shortTok.body.message));
  const shortSk = (shortTok.body.data as { key: string }).key;

  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("should-not-fetch")) as typeof fetch;
  try {
    const short = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + shortSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(short.res.status, 403, short.text);
    assert.equal((short.body.error as { code?: string })?.code, "pre_consume_token_quota_failed");
    assert.equal(
      (short.body.error as { message?: string })?.message,
      "token quota is not enough, token remain quota: ＄0.000072, need quota: ＄0.000074",
    );
  } finally {
    globalThis.fetch = orig;
  }

  const okTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ok-pre", remain_quota: 37, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(okTok.body.success, true, String(okTok.body.message));
  const okSk = (okTok.body.data as { key: string }).key;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-pre",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const ok = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + okSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(ok.res.status, 200, ok.text);
  } finally {
    globalThis.fetch = orig;
  }
});

test("original ModelPriceHelper QuotaFromFloatStrict overflow is HTTP 400 model_price_error JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const prices = JSON.parse((await store.option("ModelPrice")) || "{}") as Record<string, number>;
  await store.setOption("ModelPrice", JSON.stringify({ ...prices, "overflow-pre": 10000 }));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "overflow-pre",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-ovf",
        models: "overflow-pre",
        group: "default",
        base_url: "https://overflow-pre.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ovf", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tok.body.data as { key: string }).key;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("should-not-fetch")) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "overflow-pre", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(hit.res.status, 400, hit.text);
    const err = (hit.body.error || {}) as { message?: string; code?: string };
    assert.equal(err.code, "model_price_error");
    assert.match(String(err.message || ""), /quota conversion \(QuotaFromFloat\) overflow/);
  } finally {
    globalThis.fetch = orig;
  }
});
