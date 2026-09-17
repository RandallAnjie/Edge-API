import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { hasModelBillingConfig } from "../src/billing-setting.js";
import { CHANNEL_TYPE_ADVANCED_CUSTOM, tokenModelLimitsMap } from "../src/constants.js";
import { getModelSupportEndpointTypes, invalidatePricingCache } from "../src/pricing-cache.js";
import { listModelsTokenLimitAllows, tokenModelLimitAllows } from "../src/ratio-setting.js";
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
  return { token, auth, login };
}

async function apiKey(e: Env, auth: Record<string, string>, extra: Record<string, unknown> = {}): Promise<string> {
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "list-models", unlimited_quota: true, ...extra }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, String(tk.body.message));
  return (tk.body.data as { key: string }).key;
}

test("original helper.HasModelBillingConfig ignores self-use fallback and empty tiered expr", () => {
  assert.equal(hasModelBillingConfig("gpt-4o-mini", {}, { "gpt-4o-mini": 0.075 }, {}, {}), true);
  assert.equal(hasModelBillingConfig("zz-unpriced-model", {}, {}, {}, {}), false);
  assert.equal(
    hasModelBillingConfig(
      "zz-tiered-visible-model",
      {},
      {},
      { "zz-tiered-visible-model": "tiered_expr" },
      { "zz-tiered-visible-model": 'tier("base", p * 1 + c * 2)' },
    ),
    true,
  );
  assert.equal(
    hasModelBillingConfig(
      "zz-tiered-empty-expr-model",
      {},
      {},
      { "zz-tiered-empty-expr-model": "tiered_expr" },
      { "zz-tiered-empty-expr-model": "   " },
    ),
    false,
  );
  assert.equal(
    hasModelBillingConfig(
      "zz-tiered-missing-expr-model",
      {},
      {},
      { "zz-tiered-missing-expr-model": "tiered_expr" },
      {},
    ),
    false,
  );
});

test("original ListModels token-limit check is exact or RoutingMatchModelName only", () => {
  assert.equal(listModelsTokenLimitAllows({ "gpt-4o-mini": true }, "gpt-4o-mini"), true);
  assert.equal(listModelsTokenLimitAllows({ "claude-3-7-sonnet": true }, "claude-3-7-sonnet-thinking"), true);
  assert.equal(listModelsTokenLimitAllows({ "claude-3-7-sonnet-thinking": true }, "claude-3-7-sonnet"), false);
  const padded = tokenModelLimitsMap(" gpt-4o-mini ");
  assert.deepEqual(padded, { " gpt-4o-mini ": true });
  assert.equal(listModelsTokenLimitAllows(padded, "gpt-4o-mini"), false);
  const wildcard = { "gemini-2.5-flash-thinking-*": true };
  assert.equal(tokenModelLimitAllows(wildcard, "gemini-2.5-flash-thinking-8192"), true);
  assert.equal(listModelsTokenLimitAllows(wildcard, "gemini-2.5-flash-thinking-8192"), true);
});

test("original ListModels JSON uses GetModelLimitsMap exact/routing keys", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("SelfUseModeEnabled", "true");
  await store.insertChannel({
    name: "list-limits",
    type: 1,
    key: "sk-list",
    models: "gpt-4o-mini,gpt-4o",
    group: "default",
  });
  const paddedSk = await apiKey(e, auth, {
    model_limits_enabled: true,
    model_limits: " gpt-4o-mini ",
  });
  const padded = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + paddedSk } }), e);
  const paddedIds = ((padded.body.data as { id: string }[]) || []).map((m) => m.id);
  assert.equal(paddedIds.includes("gpt-4o-mini"), false);
  assert.equal(paddedIds.includes("gpt-4o"), false);

  const exactSk = await apiKey(e, auth, { name: "exact-limits", model_limits_enabled: true, model_limits: "gpt-4o-mini" });
  const exact = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + exactSk } }), e);
  const exactIds = ((exact.body.data as { id: string }[]) || []).map((m) => m.id);
  assert.equal(exactIds.includes("gpt-4o-mini"), true);
  assert.equal(exactIds.includes("gpt-4o"), false);
});

test("original ListModels JSON hides unpriced models and empty tiered expr", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("SelfUseModeEnabled", "false");
  await store.setOption(
    "billing_setting.billing_mode",
    JSON.stringify({
      "zz-tiered-visible-model": "tiered_expr",
      "zz-tiered-empty-expr-model": "tiered_expr",
      "zz-tiered-missing-expr-model": "tiered_expr",
    }),
  );
  await store.setOption(
    "billing_setting.billing_expr",
    JSON.stringify({
      "zz-tiered-visible-model": 'tier("base", p * 1 + c * 2)',
      "zz-tiered-empty-expr-model": "   ",
    }),
  );
  await store.insertChannel({
    name: "list-billing",
    type: 1,
    key: "sk-list",
    models: "gpt-4o-mini,zz-tiered-visible-model,zz-tiered-empty-expr-model,zz-tiered-missing-expr-model,zz-unpriced-model",
    group: "default",
  });
  const sk = await apiKey(e, auth);
  const listed = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(listed.body.success, true);
  assert.equal(listed.body.object, "list");
  const ids = ((listed.body.data as { id: string }[]) || []).map((m) => m.id);
  assert.equal(ids.includes("gpt-4o-mini"), true);
  assert.equal(ids.includes("zz-tiered-visible-model"), true);
  assert.equal(ids.includes("zz-tiered-empty-expr-model"), false);
  assert.equal(ids.includes("zz-tiered-missing-expr-model"), false);
  assert.equal(ids.includes("zz-unpriced-model"), false);
});

test("original ListModels JSON owned_by uses preferred ability channel type", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.insertChannel({
    name: "openai-owner",
    type: 1,
    key: "sk-oai",
    models: "gpt-4o-mini",
    group: "default",
    priority: 0,
  });
  await store.insertChannel({
    name: "gemini-owner",
    type: 24,
    key: "sk-gem",
    models: "gpt-4o-mini",
    group: "default",
    priority: 10,
  });
  const sk = await apiKey(e, auth);
  const listed = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + sk } }), e);
  const mini = ((listed.body.data as { id: string; owned_by: string }[]) || []).find((m) => m.id === "gpt-4o-mini");
  assert.ok(mini);
  assert.equal(mini.owned_by, "google gemini");
});

test("original GetModelSupportEndpointTypes is empty until GetPricing fills the cache", () => {
  invalidatePricingCache();
  assert.deepEqual(getModelSupportEndpointTypes(""), []);
  assert.deepEqual(getModelSupportEndpointTypes("gemini-3.5-flash"), []);
});

test("original ListModels JSON uses GetModelSupportEndpointTypes from pricing cache", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const store = new Store(e.DB);
  await store.setOption("SelfUseModeEnabled", "true");
  await store.insertChannel({
    name: "advanced-custom-channel",
    type: CHANNEL_TYPE_ADVANCED_CUSTOM,
    key: "advanced-custom-key",
    models: "gemini-3.5-flash",
    group: "default",
    settings: JSON.stringify({
      advanced_custom: {
        advanced_routes: [
          { incoming_path: "/v1/chat/completions", upstream_path: "/v1/chat/completions" },
          {
            incoming_path: "/v1/responses",
            upstream_path: "/v1beta/models/{model}:generateContent",
            converter: "openai_responses_to_gemini_generate_content",
            models: ["re:^gemini-"],
          },
        ],
      },
    }),
  });
  const sk = await apiKey(e, auth);
  const before = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + sk } }), e);
  const beforeRow = ((before.body.data as { id: string; supported_endpoint_types: string[] }[]) || []).find(
    (m) => m.id === "gemini-3.5-flash",
  );
  assert.ok(beforeRow);
  assert.deepEqual(beforeRow.supported_endpoint_types, []);

  const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricing.body.success, true);
  const priced = ((pricing.body.data as { model_name: string; supported_endpoint_types: string[] }[]) || []).find(
    (m) => m.model_name === "gemini-3.5-flash",
  );
  assert.ok(priced);
  assert.deepEqual(priced.supported_endpoint_types, ["openai", "openai-response"]);
  assert.deepEqual(getModelSupportEndpointTypes("gemini-3.5-flash"), ["openai", "openai-response"]);

  const listed = await json(new Request("http://local/v1/models", { headers: { authorization: "Bearer " + sk } }), e);
  const row = ((listed.body.data as { id: string; supported_endpoint_types: string[] }[]) || []).find(
    (m) => m.id === "gemini-3.5-flash",
  );
  assert.ok(row);
  assert.deepEqual(row.supported_endpoint_types, ["openai", "openai-response"]);
});
