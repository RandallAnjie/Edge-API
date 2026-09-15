import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BILLING_MODE_TIERED_EXPR,
  BUILTIN_BILLING_EXPR,
  billingCopies,
  getBillingExpr,
  getBillingMode,
} from "../src/billing-setting.js";
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
