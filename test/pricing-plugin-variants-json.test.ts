import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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

function pricingUsagePluginSource(key: string, field: string, unit: string): string {
  return `export const meta = {apiVersion:1,key:${JSON.stringify(key)},name:"Pricing Usage Probe",version:"1.0.0",author:{name:"Test"},models:["pricing-usage-model"],fetchMode:"per_task",usageSchema:{${field}:{type:"number",unit:${JSON.stringify(unit)}}},routes:[],protocols:[],allowedHosts:[],auth:{type:"none"}};
export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}`;
}

type PricingVariant = {
  plugin_key: string;
  plugin_name: string;
  icon?: string;
  billing_expr: string;
  billing_mode: string;
  billing_usage_schema: Record<string, { type?: string; unit?: string }>;
};

async function pricingItem(e: Env, auth: Record<string, string>, model: string) {
  const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricing.body.success, true, String(pricing.body.message));
  const rows = pricing.body.data as Record<string, unknown>[];
  const item = rows.find((row) => String(row.model_name) === model);
  assert.ok(item, "missing pricing item " + model);
  return { pricing, item: item!, text: pricing.text };
}

test("original GetPricing billing_plugin_variants JSON matches updatePricing", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const expression = `tier("base", u("seconds") * 0.4)`;
  const betaExpr = `tier("beta", u("credits") * 2)`;

  async function uploadPlugin(key: string, field: string, unit: string) {
    const uploaded = await json(
      new Request("http://local/api/plugin/task", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ source: pricingUsagePluginSource(key, field, unit) }),
      }),
      e,
    );
    assert.equal(uploaded.body.success, true, String(uploaded.body.message));
  }

  await uploadPlugin("pricing-alpha", "seconds", "second");

  const channel = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name: "pricing-variants",
          type: 1,
          key: "sk-pricing-variants",
          models: "pricing-usage-model",
          group: "default",
        },
      }),
    }),
    e,
  );
  assert.equal(channel.body.success, true, String(channel.body.message));

  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "pricing-usage-model": "tiered_expr" }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({ "pricing-usage-model": expression }));
  await putOption(e, auth, "billing_setting.plugin_billing_expr", "{}");
  await uploadPlugin("pricing-beta", "credits", "credit");

  const shared = await pricingItem(e, auth, "pricing-usage-model");
  const variants = shared.item.billing_plugin_variants as PricingVariant[];
  assert.equal(Array.isArray(variants), true);
  assert.equal(variants.length, 2);
  assert.equal(variants[0].plugin_key, "pricing-alpha");
  assert.equal(variants[1].plugin_key, "pricing-beta");
  assert.equal(variants[0].plugin_name, "Pricing Usage Probe");
  assert.equal(variants[0].billing_expr, expression);
  assert.equal(variants[1].billing_expr, "");
  assert.equal(variants[0].billing_mode, "tiered_expr");
  assert.equal(variants[1].billing_mode, "tiered_expr");
  assert.equal(variants[1].billing_usage_schema.credits.unit, "credit");
  assert.equal("icon" in variants[0], false);
  assert.equal(shared.item.billing_expr, expression);
  assert.equal(
    (shared.item.billing_usage_schema as { seconds: { unit: string } }).seconds.unit,
    "second",
  );

  await putOption(
    e,
    auth,
    "billing_setting.plugin_billing_expr",
    JSON.stringify({ "pricing-beta::pricing-usage-model": betaExpr }),
  );
  const overridden = (await pricingItem(e, auth, "pricing-usage-model")).item.billing_plugin_variants as PricingVariant[];
  assert.equal(overridden.length, 2);
  assert.equal(overridden[1].billing_expr, betaExpr);

  await putOption(e, auth, "ModelPrice", JSON.stringify({ "pricing-usage-model": 0.25 }));
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "pricing-usage-model": "ratio" }));
  const mixed = (await pricingItem(e, auth, "pricing-usage-model")).item.billing_plugin_variants as PricingVariant[];
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].billing_mode, "ratio");
  assert.equal(mixed[1].billing_mode, "tiered_expr");

  await putOption(e, auth, "billing_setting.plugin_billing_expr", "{}");
  const perCall = await pricingItem(e, auth, "pricing-usage-model");
  assert.equal("billing_plugin_variants" in perCall.item, false);
  assert.equal(perCall.item.quota_type, 1);
  assert.equal(perCall.item.model_price, 0.25);

  await putOption(
    e,
    auth,
    "billing_setting.plugin_billing_expr",
    JSON.stringify({ "pricing-beta::pricing-usage-model": betaExpr }),
  );
  const disabled = await json(
    new Request("http://local/api/plugin/task/pricing-alpha/status", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ enabled: false }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  const single = await pricingItem(e, auth, "pricing-usage-model");
  const singleVariants = single.item.billing_plugin_variants as PricingVariant[];
  assert.equal(singleVariants.length, 1);
  assert.equal(singleVariants[0].plugin_key, "pricing-beta");
  assert.equal(singleVariants[0].billing_expr, betaExpr);
  assert.equal(single.text.includes("billing_plugin_variants"), true);
});
