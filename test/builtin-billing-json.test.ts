import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_MODE_TIERED_EXPR,
  BUILTIN_BILLING_EXPR,
  billingCopies,
  getBillingExpr,
  getBillingMode,
} from "../src/billing-setting.js";
import { computeTieredQuota, exprHashString, usedVars } from "../src/billing-expr.js";
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
    const settled = tryTieredSettle(snap, params);
    assert.equal(settled.ok, true);
    if (settled.ok) assert.equal(settled.quota, 4113);
  }
});
