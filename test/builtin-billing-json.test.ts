import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import {
  BILLING_MODE_TIERED_EXPR,
  BUILTIN_BILLING_EXPR,
  billingCopies,
  getBillingExpr,
  getBillingMode,
} from "../src/billing-setting.js";
import {
  compileBillingExpr,
  computeTieredQuota,
  computeTieredQuotaWithRequest,
  emptyTokenParams,
  exprHashString,
  runExprWithRequest,
  usedVars,
} from "../src/billing-expr.js";
import { imageRequestCount, resolveImageBillingRequestInput } from "../src/image-billing.js";
import { MAX_IMAGE_N } from "../src/task-plugin-usage.js";
import {
  billingTokensJSON,
  buildTieredTokenParams,
  injectTieredBillingInfo,
  tryTieredSettle,
  type BillingUsage,
} from "../src/tiered-settle.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const IMAGE_BUILTIN_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
const IMAGE_EXPR = `tier("standard", p * 5 + cr * 1.25 + img * 8 + img_cr * 2 + c * 30)`;

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
  return { token, auth, login };
}

test("original builtinBillingExpr JSON keys and GetBillingModeCopy defaults", () => {
  assert.deepEqual(Object.keys(BUILTIN_BILLING_EXPR).sort(), [
    "gpt-6-astra",
    "gpt-image-2",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
  ]);
  for (const name of IMAGE_BUILTIN_MODELS) {
    assert.equal(BUILTIN_BILLING_EXPR[name], IMAGE_EXPR);
    assert.equal(getBillingMode(name, {}, {}, {}), BILLING_MODE_TIERED_EXPR);
    assert.equal(getBillingExpr(name, {}, {}, {}, {}), IMAGE_EXPR);
    assert.equal(getBillingMode(name, {}, { [name]: 0 }, {}), "ratio");
    assert.equal(getBillingMode(name, {}, {}, { [name]: 0.1 }), "ratio");
  }
  const copies = billingCopies({ billingMode: {}, billingExpr: {}, modelRatio: {}, modelPrice: {} });
  for (const name of IMAGE_BUILTIN_MODELS) {
    assert.equal(copies.billing_mode[name], BILLING_MODE_TIERED_EXPR);
    assert.equal(copies.billing_expr[name], IMAGE_EXPR);
  }
  assert.equal(copies.billing_mode["gpt-6-astra"], BILLING_MODE_TIERED_EXPR);
});

test("original GetRatioConfig and GetOptions expose builtin image billing JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("ExposeRatioEnabled", "true");

  const ratio = await json(new Request("http://local/api/ratio_config"), e);
  assert.equal(ratio.res.status, 200);
  assert.equal(ratio.body.success, true);
  assert.equal(ratio.body.message, "");
  const data = ratio.body.data as {
    model_ratio: Record<string, unknown>;
    completion_ratio: Record<string, unknown>;
    cache_ratio: Record<string, unknown>;
    create_cache_ratio: Record<string, unknown>;
    model_price: Record<string, unknown>;
    billing_mode: Record<string, string>;
    billing_expr: Record<string, string>;
  };
  for (const key of ["model_ratio", "completion_ratio", "cache_ratio", "create_cache_ratio", "model_price", "billing_mode", "billing_expr"]) {
    assert.ok(key in data, key);
  }
  for (const name of IMAGE_BUILTIN_MODELS) {
    assert.equal(data.billing_mode[name], BILLING_MODE_TIERED_EXPR);
    assert.equal(data.billing_expr[name], IMAGE_EXPR);
  }
  assert.equal(data.billing_mode["gpt-6-astra"], BILLING_MODE_TIERED_EXPR);

  const opts = await json(new Request("http://local/api/option/", { headers: auth }), e);
  assert.equal(opts.body.success, true);
  const rows = opts.body.data as { key: string; value: string }[];
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const modes = JSON.parse(byKey["billing_setting.billing_mode"]) as Record<string, string>;
  const exprs = JSON.parse(byKey["billing_setting.billing_expr"]) as Record<string, string>;
  for (const name of IMAGE_BUILTIN_MODELS) {
    assert.equal(modes[name], BILLING_MODE_TIERED_EXPR);
    assert.equal(exprs[name], IMAGE_EXPR);
  }
});

function quotaSnap(expression: string) {
  return {
    billingMode: BILLING_MODE_TIERED_EXPR,
    modelName: "gpt-image-2",
    exprString: expression,
    exprHash: exprHashString(expression),
    groupRatio: 1,
    estimatedPromptTokens: 0,
    estimatedCompletionTokens: 0,
    estimatedQuotaBeforeGroup: 0,
    estimatedQuotaAfterGroup: 0,
    estimatedTier: "",
    quotaPerUnit: 500000,
    exprVersion: 1,
    taskUsageBilling: false,
    usageFacts: {},
  };
}

test("original gpt-6-astra builtin ComputeTieredQuota JSON", () => {
  const expression = BUILTIN_BILLING_EXPR["gpt-6-astra"];
  const vars = usedVars(expression);
  assert.equal(vars?.len, true);
  assert.equal(vars?.cr, true);
  assert.equal(vars?.cc, true);
  const snap = { ...quotaSnap(expression), modelName: "gpt-6-astra" };
  for (const tc of [
    { name: "standard", input: 1000, output: 100, cached: 0, written: 0, quota: 7500 },
    { name: "cache at context boundary", input: 272000, output: 1000, cached: 200000, written: 20000, quota: 510000 },
    { name: "whole request above boundary", input: 272001, output: 1000, cached: 200000, written: 20000, quota: 1007510 },
  ]) {
    const usage: BillingUsage = {
      prompt_tokens: tc.input,
      completion_tokens: tc.output,
      prompt_tokens_details: { cached_tokens: tc.cached, cache_write_tokens: tc.written },
    };
    const params = buildTieredTokenParams(usage, false, vars);
    const result = computeTieredQuota(snap, params);
    assert.equal(result.actualQuotaAfterGroup, tc.quota, tc.name);
    assert.equal(result.billingUnit, "token");
    assert.equal(result.matchedTier, tc.input <= 272000 ? "standard" : "long_context");
  }
});

test("original image builtin ComputeTieredQuota is 4113 with billing_tokens JSON", () => {
  for (const name of IMAGE_BUILTIN_MODELS) {
    const expression = BUILTIN_BILLING_EXPR[name];
    const usage: BillingUsage = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: {
        cached_tokens: 300,
        image_tokens: 600,
        cached_tokens_details: { image_tokens: 200 },
      },
    };
    const params = buildTieredTokenParams(usage, false, usedVars(expression));
    assert.deepEqual(params, {
      p: 300,
      c: 100,
      len: 1000,
      cr: 100,
      cc: 0,
      cc1h: 0,
      img: 400,
      img_cr: 200,
      img_o: 0,
      ai: 0,
      ao: 0,
    });
    const snap = { ...quotaSnap(expression), modelName: name };
    const result = computeTieredQuota(snap, params);
    assert.equal(result.actualQuotaAfterGroup, 4113, name);
    assert.equal(result.matchedTier, "standard");
    assert.equal(result.billingUnit, "token");
    assert.ok(result.billingTokens);
    const tokens = billingTokensJSON(result.billingTokens!);
    assert.deepEqual(Object.keys(tokens).sort(), ["ai", "ao", "c", "cc", "cc1h", "cr", "img", "img_cr", "img_o", "len", "p"]);
    assert.equal(tokens.p, 300);
    assert.equal(tokens.cr, 100);
    assert.equal(tokens.img, 400);
    assert.equal(tokens.img_cr, 200);
    assert.equal(tokens.c, 100);
    const other = injectTieredBillingInfo({}, snap, result);
    assert.equal(other.billing_mode, "tiered_expr");
    assert.equal(other.matched_tier, "standard");
    assert.equal(other.billing_unit, "token");
    assert.equal(other.image_cache_tokens, 200);
    assert.deepEqual(other.billing_tokens, tokens);
    assert.equal(other.expr_b64, Buffer.from(expression, "utf8").toString("base64"));
    assert.equal("image_count" in other, false);
    assert.equal("fixed_price" in other, false);
    const settled = tryTieredSettle(snap, params);
    assert.equal(settled.ok, true);
    if (settled.ok) assert.equal(settled.quota, 4113);
  }
});

const IMAGE_FIXED_EXPR = `tier("image", fixed(0.04)) * image_count`;

async function putOption(e: Env, auth: Record<string, string>, key: string, value: string) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "fixed-image", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

test("original ImageRequest.ImageCount provider vs top-level n JSON", () => {
  assert.equal(imageRequestCount({ model: "z-image", n: 2, parameters: { n: 3, prompt_extend: true } }, true), 3);
  assert.equal(imageRequestCount({ model: "gpt-image-2", n: 2, parameters: { n: 3 } }, false), 2);
  assert.equal(imageRequestCount({ model: "z-image", n: 2, parameters: {} }, true), 2);
  assert.equal(imageRequestCount({ model: "z-image", n: 2, parameters: { n: null } }, true), 2);
  assert.equal(imageRequestCount({ model: "z-image", n: 0 }, true), 1);
  assert.equal(imageRequestCount({ model: "gpt-image-2", n: 2, parameters: { n: 0 } }, false), 2);
  assert.equal(imageRequestCount({ model: "z-image", parameters: { n: 128 } }, true), 128);
  assert.throws(
    () => imageRequestCount({ model: "z-image", n: 2, parameters: { n: 129 } }, true),
    /parameters\.n must be an integer between 1 and 128/,
  );
  assert.throws(
    () => imageRequestCount({ model: "gpt-image-2", n: MAX_IMAGE_N + 1 }, false),
    /n must be an integer between 1 and 128/,
  );
  const ali = resolveImageBillingRequestInput(
    { model: "z-image", n: 2, parameters: { n: 3 }, size: "1024x1024", quality: "hd" },
    CHANNEL_TYPE_ALI,
  );
  assert.equal(ali.imageCount, 3);
  assert.deepEqual(ali.body, {
    model: "z-image",
    n: 2,
    size: "1024x1024",
    quality: "hd",
    parameters: { n: 3 },
  });
  const openai = resolveImageBillingRequestInput({ model: "gpt-image-2", n: 2, parameters: { n: 3 } }, CHANNEL_TYPE_OPENAI);
  assert.equal(openai.imageCount, 2);
});

test("original InjectTieredBillingInfo image_count / fixed_price JSON", () => {
  const snap = quotaSnap(IMAGE_FIXED_EXPR);
  const result = computeTieredQuotaWithRequest(snap, {}, emptyTokenParams(), { imageCount: 3 });
  assert.equal(result.actualQuotaAfterGroup, 60000);
  assert.equal(result.imageCount, 3);
  assert.equal(result.fixedPrice, 0.04);
  assert.equal(result.billingUnit, "request");
  assert.equal(result.matchedTier, "image");
  assert.equal(result.billingTokens, undefined);
  const other = injectTieredBillingInfo({}, snap, result);
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.matched_tier, "image");
  assert.equal(other.billing_unit, "request");
  assert.equal(other.image_count, 3);
  assert.equal(other.fixed_price, 0.04);
  assert.equal("billing_tokens" in other, false);
  assert.equal("image_cache_tokens" in other, false);
  assert.equal(other.expr_b64, Buffer.from(IMAGE_FIXED_EXPR, "utf8").toString("base64"));
  const two = tryTieredSettle(
    { ...snap, estimatedImageCount: 3, estimatedBillingUnit: "request", estimatedFixedPrice: 0.04, estimatedTier: "image" },
    emptyTokenParams(),
    { request: { imageCount: 3 }, billingImageCount: 2 },
  );
  assert.equal(two.ok, true);
  if (two.ok) {
    assert.equal(two.quota, 40000);
    assert.equal(two.result?.imageCount, 2);
  }
});

test("original InjectTieredBillingInfo estimated fallback JSON when result is nil", () => {
  const snap = {
    ...quotaSnap(IMAGE_FIXED_EXPR),
    estimatedTier: "image",
    estimatedBillingUnit: "request" as const,
    estimatedImageCount: 3,
    estimatedFixedPrice: 0.04,
  };
  const other = injectTieredBillingInfo({}, snap, null);
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.image_count, 3);
  assert.equal(other.matched_tier, "image");
  assert.equal(other.billing_unit, "request");
  assert.equal(other.fixed_price, 0.04);
  assert.equal("billing_tokens" in other, false);
});

test("original RunExprWithRequest image_count bounds and request n are distinct JSON", () => {
  const ran = runExprWithRequest(IMAGE_FIXED_EXPR, {}, {}, { imageCount: 2, body: { n: 3 } });
  assert.equal(ran.cost, 80000);
  assert.equal(ran.imageCount, 2);
  assert.equal(ran.fixedPrice, 0.04);
  assert.equal(ran.billingUnit, "request");
  for (const count of [-1, 0, 129]) {
    assert.throws(
      () => runExprWithRequest(IMAGE_FIXED_EXPR, {}, {}, { imageCount: count }),
      /image_count must be between 1 and 128/,
    );
  }
  const compileErr = compileBillingExpr(`_trace(0, true, 5.0)`);
  assert.ok(compileErr);
  assert.match(String(compileErr?.message), /identifier "_trace" is reserved for internal use/);
});

test("original request_rules compile traces JSON", () => {
  const expression = `(tier("base", p * 2)) * (param("service_tier") == "fast" ? 2 : 1) * (has(header("anthropic-beta"), "fast-mode-2026-02-01") ? 2.5 : 1)`;
  const matched = runExprWithRequest(
    expression,
    {},
    { p: 10 },
    { headers: { "Anthropic-Beta": "fast-mode-2026-02-01" }, body: { service_tier: "fast" } },
  );
  assert.equal(matched.cost, 100);
  assert.deepEqual(matched.requestRules, [
    { cond: `param("service_tier") == "fast"`, multiplier: 2, matched: true },
    { cond: `has(header("anthropic-beta"), "fast-mode-2026-02-01")`, multiplier: 2.5, matched: true },
  ]);
  const unmatched = runExprWithRequest(expression, {}, { p: 10 }, { body: { service_tier: "fast" } });
  assert.equal(unmatched.cost, 40);
  assert.equal(unmatched.requestRules[0]?.matched, true);
  assert.equal(unmatched.requestRules[1]?.matched, false);
  const hdExpr = `tier("image", fixed(0.04)) * image_count * (param("quality") == "hd" ? 2 : 1)`;
  const hd = runExprWithRequest(hdExpr, {}, {}, { imageCount: 3, body: { quality: "hd" } });
  assert.equal(hd.cost, 240000);
  assert.equal(hd.imageCount, 3);
  assert.equal(hd.requestRules[0]?.multiplier, 2);
  assert.equal(hd.requestRules[0]?.matched, true);
  const hdQuota = computeTieredQuotaWithRequest(quotaSnap(hdExpr), {}, emptyTokenParams(), {
    imageCount: 3,
    body: { quality: "hd" },
  });
  assert.equal(hdQuota.actualQuotaAfterGroup, 120000);
  const other = injectTieredBillingInfo({}, quotaSnap(hdExpr), hdQuota);
  assert.ok(Array.isArray(other.request_rules));
});

test("original image quantity consume-log JSON keeps request when actual missing and refunds extras", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "fixed-image": BILLING_MODE_TIERED_EXPR }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({ "fixed-image": IMAGE_FIXED_EXPR }));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "fixed-image",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-fixed-image",
        models: "fixed-image",
        group: "default",
        base_url: "https://fixed-image.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const sk = await createSk(e, auth);

  async function generate(n: number, images: number) {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          created: 1,
          data: Array.from({ length: images }, (_, i) => ({ url: `https://example.test/${i}.png` })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const hit = await json(
        new Request("http://local/v1/images/generations", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "fixed-image", prompt: "a cat", n }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    } finally {
      globalThis.fetch = orig;
    }
  }

  await generate(3, 3);
  await generate(3, 2);
  await generate(3, 0);

  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "fixed-image" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length, 3, JSON.stringify(logs.body));
  const others = items.map((row) => parseOther(row.other));
  const quotas = items.map((row) => Number(row.quota)).sort((a, b) => a - b);
  assert.deepEqual(quotas, [40000, 60000, 60000]);
  assert.equal(others.filter((other) => other.image_count === 3).length, 2);
  assert.equal(others.filter((other) => other.image_count === 2).length, 1);
  for (const other of others) {
    assert.equal(other.billing_unit, "request");
    assert.equal(other.fixed_price, 0.04);
    assert.equal(other.matched_tier, "image");
    assert.equal(other.billing_mode, "tiered_expr");
    assert.equal("billing_tokens" in other, false);
    assert.equal("image_cache_tokens" in other, false);
  }
});
