import assert from "node:assert/strict";
import { test } from "node:test";
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

const compactFns = `export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}`;

const aliasPluginSource = `export const meta = {apiVersion:1,key:"pricing-usage-probe",name:"Pricing Usage Probe",version:"1.0.0",author:{name:"Test"},models:["pricing-usage-model"],fetchMode:"per_task",usageSchema:{seconds:{type:"number",unit:"second",description:"Estimated duration."}},routes:[],protocols:[],allowedHosts:[],auth:{type:"none"}};
${compactFns}`;

const profilesPluginSource = `export const meta = {apiVersion:1,key:"pricing-profiles",name:"Pricing Profiles",version:"1.0.0",author:{name:"Test"},models:["profile-image","profile-video"],fetchMode:"per_task",usageSchema:{fallback:{type:"number",unit:"count"}},usageExamples:[{label:"default",facts:{fallback:1}}],usageProfiles:[{models:["profile-image"],schema:{image_count:{type:"number",unit:"count"}}},{models:["profile-video"],schema:{seconds:{type:"number",unit:"second"}},examples:[{label:"5 seconds",facts:{seconds:5}}]}],routes:[],protocols:[],allowedHosts:[],auth:{type:"none"}};
${compactFns}`;

async function uploadPlugin(e: Env, auth: Record<string, string>, source: string) {
  const uploaded = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source }),
    }),
    e,
  );
  assert.equal(uploaded.body.success, true, String(uploaded.body.message));
}

async function addChannel(
  e: Env,
  auth: Record<string, string>,
  name: string,
  models: string,
  mapping: Record<string, string>,
) {
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        mode: "single",
        channel: {
          name,
          type: 1,
          key: "sk-" + name,
          models,
          group: "default",
          model_mapping: JSON.stringify(mapping),
        },
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
}

async function pricingByModel(e: Env, auth: Record<string, string>) {
  const pricing = await json(new Request("http://local/api/pricing", { headers: auth }), e);
  assert.equal(pricing.body.success, true, String(pricing.body.message));
  const rows = pricing.body.data as Record<string, unknown>[];
  return Object.fromEntries(rows.map((row) => [String(row.model_name), row]));
}

test("original GetPricing alias JSON carries plugin usage schema and tail expr", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await uploadPlugin(e, auth, aliasPluginSource);
  await addChannel(e, auth, "channel-alias", "alias-model,pricing-usage-model", {
    "alias-model": "pricing-usage-model",
  });
  await putOption(
    e,
    auth,
    "billing_setting.billing_mode",
    JSON.stringify({ "pricing-usage-model": "tiered_expr", "alias-own-expr": "tiered_expr" }),
  );
  await new Store(e.DB).setOption(
    "billing_setting.billing_expr",
    JSON.stringify({ "pricing-usage-model": `u("seconds")`, "alias-own-expr": `u("seconds") * 2` }),
  );

  const first = await pricingByModel(e, auth);
  assert.ok(first["alias-model"]);
  assert.ok(first["pricing-usage-model"]);
  assert.equal((first["alias-model"].billing_usage_schema as { seconds: { unit: string } }).seconds.unit, "second");
  assert.equal(first["alias-model"].billing_mode, "tiered_expr");
  assert.equal(first["alias-model"].billing_expr, `u("seconds")`);
  assert.equal(first["pricing-usage-model"].billing_mode, "tiered_expr");
  assert.equal(first["pricing-usage-model"].billing_expr, `u("seconds")`);

  await addChannel(e, auth, "channel-own-expr", "alias-own-expr,pricing-usage-model", {
    "alias-own-expr": "pricing-usage-model",
  });
  const refreshed = await pricingByModel(e, auth);
  assert.equal(refreshed["alias-own-expr"].billing_expr, `u("seconds") * 2`);
  assert.equal(
    (refreshed["alias-own-expr"].billing_usage_schema as { seconds: { unit: string } }).seconds.unit,
    "second",
  );
});

test("original GetPricing usage profiles and mapping aliases JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await uploadPlugin(e, auth, profilesPluginSource);
  await addChannel(e, auth, "channel-profiles-0", "profile-image,profile-video,image-alias,video-alias,ambiguous-alias", {
    "image-alias": "profile-image",
    "video-alias": "profile-video",
    "ambiguous-alias": "profile-image",
  });
  await addChannel(e, auth, "channel-profiles-1", "profile-image,profile-video,image-alias,video-alias,ambiguous-alias", {
    "ambiguous-alias": "profile-video",
  });

  const pricing = await pricingByModel(e, auth);
  const cases: { name: string; field: string; unit: string; examples: number }[] = [
    { name: "profile-image", field: "image_count", unit: "count", examples: 0 },
    { name: "profile-video", field: "seconds", unit: "second", examples: 1 },
    { name: "image-alias", field: "image_count", unit: "count", examples: 0 },
    { name: "video-alias", field: "seconds", unit: "second", examples: 1 },
    { name: "ambiguous-alias", field: "fallback", unit: "count", examples: 1 },
  ];
  for (const tc of cases) {
    const schema = pricing[tc.name].billing_usage_schema as Record<string, { type: string; unit: string }>;
    assert.deepEqual(schema, { [tc.field]: { type: "number", unit: tc.unit } }, tc.name);
    const examples = (pricing[tc.name].billing_usage_examples as unknown[] | undefined) || [];
    assert.equal(examples.length, tc.examples, tc.name + " examples");
  }
});
