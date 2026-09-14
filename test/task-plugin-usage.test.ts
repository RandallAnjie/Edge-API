import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { compilePlugin } from "../src/jsplugin.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { isNativeQueryError, parseNativeTaskResult } from "../src/task-plugin-query.js";
import {
  MAX_IMAGE_N,
  MAX_QUOTA,
  MAX_TASK_DURATION_SECONDS,
  adjustBillingOnSubmit,
  applyRelayTaskSubmitBilling,
  estimateBilling,
  estimateBillingValidated,
  extractUsageFactsValidated,
  quotaFromFloat,
  validateResolvedUsageRequest,
} from "../src/task-plugin-usage.js";
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
  const store = new Store(e.DB);
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "usage-submit", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

const mockPlugin = `
export const meta = {
  apiVersion: 1, key: "mock-task", name: "Mock Task", version: "1.0.0",
  author: {name: "Test"},
  channelTypes: [1001], models: ["mock-v1"], fetchMode: "per_task",
  protocols: ["openai_video"],
  usageSchema: {seconds: {type: "number", unit: "second"}, mode: {enum: ["std", "pro"]}},
};
export function buildSubmitRequest(ctx) {
  if (!ctx.requestBody.prompt) throw new Error("prompt required");
  return { url: ctx.baseUrl + "/submit", method: "POST", headers: {"X-Plugin": "submit"}, body: {prompt: ctx.requestBody.prompt}, action: "text_to_video", model: "mock-v1", rewriteModel: "mock-upstream" };
}
export function parseSubmitResponse(ctx, resp) {
  return {
    taskId: resp.body.id,
    taskData: {accepted: true, status: resp.statusCode},
  };
}
export function extractUsage(ctx) { return {seconds: 5, mode: "pro"}; }
export function extractUsageOnSubmit(ctx, data) { return {seconds: data.seconds || 7}; }
export function extractUsageOnComplete(task, result) { return {upstreamUnits: 23}; }
export function buildQueryRequest(ctx) { return {url: ctx.baseUrl + "/tasks/" + ctx.taskId, method: "GET", headers: {"X-Plugin": "query"}}; }
export function parseTaskResult(ctx, body) { return {taskId: body.id, status: "SUCCESS", progress: "100%", url: body.url}; }
export function listArtifacts() { return []; }
export function buildContentRequest() { throw new Error("artifact_not_found"); }
export const protocols = {openai_video: {
  decodeRequest: function(ctx) { return {kind: "submit", model: ctx.model, requestBody: ctx.body.value}; },
  render: function(ctx, task) { return {id: task.task_id, status: "completed"}; }
}};
`;

function submitContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestBody: { prompt: "hello" },
    model: "mock-v1",
    upstreamModel: "mock-upstream",
    baseUrl: "https://provider.example",
    ...overrides,
  };
}

test("original EstimateBilling extractUsage JSON ratios", () => {
  const loaded = compilePlugin(mockPlugin, { key: "mock-task", version: "1.0.0" });
  const context = submitContext();
  assert.deepEqual(estimateBilling(loaded.engine, context, "mock-v1"), { seconds: 5 });
  const facts = extractUsageFactsValidated(loaded.engine, context, "mock-v1");
  assert.equal("error" in facts, false);
  if (!("error" in facts)) {
    assert.deepEqual(facts.facts, { seconds: 5, mode: "pro" });
  }
});

test("original AdjustBillingOnSubmit extractUsageOnSubmit JSON ratios", () => {
  const loaded = compilePlugin(mockPlugin, { key: "mock-task", version: "1.0.0" });
  assert.deepEqual(
    adjustBillingOnSubmit(loaded.engine, submitContext(), "mock-v1", { seconds: 7 }),
    { seconds: 7 },
  );
  assert.deepEqual(
    adjustBillingOnSubmit(loaded.engine, submitContext(), "mock-v1", '{"seconds":7}'),
    { seconds: 7 },
  );
  assert.deepEqual(
    adjustBillingOnSubmit(loaded.engine, submitContext(), "mock-v1", { accepted: true, status: 200 }),
    { seconds: 7 },
  );
});

test("original invalid post-submit adjustment is discarded before recalculation", () => {
  const source = `
export const meta = {
  apiVersion: 1, key: "bounded-usage", name: "Bounded Usage", version: "1.0.0",
  author: {name: "Test"}, models: ["model"], fetchMode: "per_task",
  usageSchema: {
    duration: {type: "number", unit: "second"},
    count: {type: "number", unit: "count"},
    tokens: {type: "number", unit: "token"},
    mode: {enum: ["std", "pro"]},
  },
};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit"}; }
export function parseSubmitResponse() { return {taskId: "1"}; }
export function buildQueryRequest() { return {url: "https://example.com"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function extractUsage() { return {seconds: 5}; }
export function extractUsageOnSubmit(ctx, data) { return (data || {}).usage || {}; }
`;
  const loaded = compilePlugin(source, { key: "bounded-usage", version: "1.0.0" });
  assert.equal(
    adjustBillingOnSubmit(loaded.engine, submitContext({ requestBody: {} }), "model", {
      usage: { duration: 1000000000000000 },
    }),
    null,
  );
  const billed = applyRelayTaskSubmitBilling({
    engine: loaded.engine,
    submitContext: submitContext({ requestBody: {} }),
    modelName: "model",
    taskData: { usage: { duration: 1000000000000000 } },
    immediate: null,
    quota: 250000,
    otherRatios: { seconds: 5 },
  });
  assert.equal(billed.quota, 250000);
  assert.deepEqual(billed.otherRatios, { seconds: 5 });
});

test("original EstimateBillingValidated separates billing_ratios from facts JSON", () => {
  const source = `
export const meta = {
  apiVersion: 1, key: "usage-purpose", name: "Usage Purpose", version: "1.0.0",
  author: {name: "Test"}, models: ["usage-model"], fetchMode: "per_task",
  usageSchema: {seconds: {type: "number", unit: "second"}},
};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit"}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest(ctx) { return {url: ctx.baseUrl + "/query"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function extractUsage(ctx) {
  return ctx.usagePurpose === "billing_ratios" ? {legacy_multiplier: 2} : {seconds: 5};
}
`;
  const loaded = compilePlugin(source, { key: "usage-purpose", version: "1.0.0" });
  const context = { requestBody: { model: "usage-model" }, model: "usage-model" };
  const facts = extractUsageFactsValidated(loaded.engine, context, "usage-model");
  assert.equal("error" in facts, false);
  if (!("error" in facts)) {
    assert.deepEqual(facts.facts, { seconds: 5 });
    assert.equal(facts.facts && Object.keys(facts.facts).length, 1);
  }
  const ratios = estimateBillingValidated(loaded.engine, context, "usage-model");
  assert.equal("error" in ratios, false);
  if (!("error" in ratios)) {
    assert.deepEqual(ratios.ratios, { legacy_multiplier: 2 });
  }
});

test("original usage profiles AdjustBillingOnSubmit equals EstimateBillingValidated JSON", () => {
  const source = `
export const meta = {
  apiVersion:1, key:"profile-usage", name:"Profile Usage", version:"1.0.0", author:{name:"Test"},
  models:["image", "video"], fetchMode:"batch",
  usageSchema:{units:{type:"number",unit:"second"}},
  usageProfiles:[
    {models:["image"],schema:{units:{type:"number",unit:"count"},mode:{enum:["image"]}}},
    {models:["video"],schema:{units:{type:"number",unit:"token"},mode:{enum:["video"]}},
     examples:[{label:"video",facts:{units:1,mode:"video"}}]}
  ]
};
export function buildSubmitRequest(ctx) {
  return {url:ctx.baseUrl+"/submit",rewriteModel:ctx.requestBody.rewriteTo || ""};
}
export function parseSubmitResponse(){return {taskId:"task"};}
export function buildQueryRequest(){return {url:"https://provider.example/task"};}
export function buildBatchQueryRequest(){return {url:"https://provider.example/tasks"};}
export function parseTaskResult(){return {status:"SUCCESS"};}
export function parseBatchResult(ctx,body){return body.items;}
export function extractUsage(ctx){return {units:ctx.requestBody.hookUnits,mode:ctx.requestBody.hookMode,legacyRatio:2};}
export function extractUsageOnSubmit(ctx,body){return body.usage;}
export function extractUsageOnComplete(ctx,result,body){return body.usage;}
`;
  const loaded = compilePlugin(source, { key: "profile-usage", version: "1.0.0" });
  const context = { requestBody: { hookUnits: 2, hookMode: "image" }, model: "image" };
  const facts = extractUsageFactsValidated(loaded.engine, context, "image");
  assert.equal("error" in facts, false);
  if (!("error" in facts)) {
    assert.deepEqual(facts.facts, { units: 2, mode: "image", legacyRatio: 2 });
  }
  const ratios = estimateBillingValidated(loaded.engine, context, "image");
  assert.equal("error" in ratios, false);
  if (!("error" in ratios)) {
    assert.deepEqual(ratios.ratios, { units: 2, legacyRatio: 2 });
    assert.deepEqual(
      adjustBillingOnSubmit(loaded.engine, context, "image", { usage: facts && "facts" in facts ? facts.facts : {} }),
      ratios.ratios,
    );
  }
  const over = estimateBillingValidated(
    loaded.engine,
    { requestBody: { hookUnits: MAX_IMAGE_N + 1, hookMode: "image" }, model: "image" },
    "image",
  );
  assert.equal("error" in over, true);
  if ("error" in over) assert.equal(over.error, "plugin usage value exceeds the host limit");
  const video = estimateBillingValidated(
    loaded.engine,
    { requestBody: { hookUnits: 500000, hookMode: "video" }, model: "video" },
    "video",
  );
  assert.equal("error" in video, false);
  if (!("error" in video)) {
    assert.deepEqual(video.ratios, { units: 500000, legacyRatio: 2 });
  }
});

test("original fractional usage facts survive EstimateBillingValidated JSON", () => {
  const source = `
export const meta = {apiVersion:1,key:"frac",name:"Frac",version:"1.0.0",author:{name:"Test"},models:["model"],fetchMode:"per_task",usageSchema:{units:{type:"number",unit:"token"}}};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit"}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest() { return {url: "https://example.com"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function extractUsage() { return {units: 3.5}; }
`;
  const loaded = compilePlugin(source, { key: "frac", version: "1.0.0" });
  const facts = extractUsageFactsValidated(loaded.engine, { requestBody: { model: "model" } }, "model");
  assert.equal("error" in facts, false);
  if (!("error" in facts)) assert.equal(facts.facts?.units, 3.5);
  const ratios = estimateBillingValidated(loaded.engine, { requestBody: { model: "model" } }, "model");
  assert.equal("error" in ratios, false);
  if (!("error" in ratios)) assert.equal(ratios.ratios?.units, 3.5);
});

test("original RelayTask immediate FAILURE zeros finalQuota JSON", () => {
  const loaded = compilePlugin(mockPlugin, { key: "mock-task", version: "1.0.0" });
  const billed = applyRelayTaskSubmitBilling({
    engine: loaded.engine,
    submitContext: submitContext(),
    modelName: "mock-v1",
    taskData: { seconds: 7 },
    immediate: { status: "FAILURE", progress: "100%" },
    quota: 1250000,
    otherRatios: { seconds: 5 },
  });
  assert.equal(billed.quota, 0);
  assert.deepEqual(billed.otherRatios, { seconds: 5 });
});

test("original RelayTask AdjustBillingOnSubmit replaces OtherRatios JSON", () => {
  const loaded = compilePlugin(mockPlugin, { key: "mock-task", version: "1.0.0" });
  const reserved = quotaFromFloat(applyOtherRatios(250000, { seconds: 5 }));
  const billed = applyRelayTaskSubmitBilling({
    engine: loaded.engine,
    submitContext: submitContext(),
    modelName: "mock-v1",
    taskData: { seconds: 7 },
    immediate: null,
    quota: reserved,
    otherRatios: { seconds: 5 },
  });
  assert.equal(billed.quota, quotaFromFloat(250000 * 7));
  assert.deepEqual(billed.otherRatios, { seconds: 7 });
});

function applyOtherRatios(quota: number, ratios: Record<string, number>): number {
  let value = quota;
  for (const ratio of Object.values(ratios)) value *= ratio;
  return value;
}

const httpUsagePlugin = `
export const meta = {apiVersion:1,key:"mock-http",name:"Mock Task",version:"1.0.0",author:{name:"Test"},models:["mock-v1"],fetchMode:"per_task",channelTypes:[${CHANNEL_TYPE_OPENAI}],usageSchema:{seconds:{type:"number",unit:"second"},mode:{enum:["std","pro"]}},routes:[{method:"POST",path:"/vendor/jobs",type:"submit",decode:"decode",render:"created"}]};
export const native = {decode:function(ctx){return {kind:"submit",model:"mock-v1",requestBody:ctx.body.value};},created:function(ctx,task){return {data:{task_id:task.task_id},upstream:task.data};}};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit",method:"POST",body:{prompt:ctx.requestBody.prompt}};}
export function parseSubmitResponse(ctx,resp){return {taskId:resp.body.id,taskData:{accepted:true,status:resp.statusCode}};}
export function extractUsage(){return {seconds:5,mode:"pro"};}
export function extractUsageOnSubmit(ctx,data){return {seconds:data.seconds || 7};}
export function buildQueryRequest(){return {url:"https://provider.example.test/query"};}
export function parseTaskResult(){return {status:"SUCCESS"};}
`;

test("original native RelayTask submit AdjustBillingOnSubmit OtherRatios JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: httpUsagePlugin }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ "mock-v1": 1 }) }),
    }),
    e,
  );
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mock-usage",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "mock-v1",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-v1", prompt: "hello" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(hit.res.headers.get("X-New-Api-Other-Ratios"), JSON.stringify({ seconds: 7 }));
    const data = (hit.body as { data?: { task_id?: string } }).data;
    assert.ok(data?.task_id?.startsWith("task_"), hit.text);
    const persisted = await store.getTaskByTid(String(data?.task_id));
    assert.ok(persisted);
    assert.equal(Number(persisted?.quota), 1750000);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_context?: { other_ratios?: Record<string, number> };
    };
    assert.deepEqual(priv.billing_context?.other_ratios, { seconds: 7 });
    assert.deepEqual(JSON.parse(String(persisted?.data || "{}")), { accepted: true, status: 200 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask immediate FAILURE persists zero quota JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `taskData:{accepted:true,status:resp.statusCode}`,
    `taskData:{accepted:false},immediate:{status:"FAILURE",progress:"100%",reason:"provider rejected"}`,
  );
  await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ "mock-v1": 1 }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mock-fail",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "mock-v1",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-fail" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return origFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-v1", prompt: "hello" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    const data = (hit.body as { data?: { task_id?: string } }).data;
    const persisted = await store.getTaskByTid(String(data?.task_id));
    assert.ok(persisted);
    assert.equal(String(persisted?.status), "FAILURE");
    assert.equal(Number(persisted?.quota), 0);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_context?: { other_ratios?: Record<string, number> };
    };
    assert.deepEqual(priv.billing_context?.other_ratios, { seconds: 5 });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original duration ceiling is 3600 for undeclared ratios", () => {
  assert.equal(MAX_TASK_DURATION_SECONDS, 3600);
  assert.equal(MAX_IMAGE_N, 128);
});

const boundedUsagePlugin = `
export const meta = {
  apiVersion: 1, key: "bounded-usage", name: "Bounded Usage", version: "1.0.0",
  author: {name: "Test"}, models: ["model"], fetchMode: "per_task",
  usageSchema: {
    duration: {type: "number", unit: "second"},
    count: {type: "number", unit: "count"},
    tokens: {type: "number", unit: "token"},
    mode: {enum: ["std", "pro"]},
  },
  usageExamples: [{label: "std · 1s", facts: {duration: 1, count: 1, tokens: 1, mode: "std"}}],
};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit", method: "POST", body: {}}; }
export function parseSubmitResponse() { return {taskId: "1"}; }
export function buildQueryRequest() { return {url: "https://example.com"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function extractUsage(ctx) {
  const entries = (ctx.requestBody || {}).hookUsageEntries || [];
  const facts = {};
  entries.forEach(function(entry) { facts[entry.name] = entry.value; });
  return facts;
}
export function extractUsageOnSubmit(ctx, data) { return (data || {}).usage || {}; }
export function extractUsageOnComplete(task, result, body) { return (body || {}).completionUsage || {}; }
`;

test("original ValidateRequestAndSetAction bounds native usage request JSON", () => {
  const loaded = compilePlugin(boundedUsagePlugin, { key: "bounded-usage", version: "1.0.0" });
  const meta = loaded.meta;
  const reject = [
    { metadata: { duration: MAX_TASK_DURATION_SECONDS + 1 } },
    { metadata: { count: MAX_IMAGE_N + 1 } },
    { metadata: { mode: "turbo" } },
    { durationSeconds: MAX_TASK_DURATION_SECONDS + 1 },
    { image_count: MAX_IMAGE_N + 1 },
    { duration: -1 },
    { duration: Number.POSITIVE_INFINITY },
    { duration: MAX_TASK_DURATION_SECONDS, metadata: { duration: MAX_TASK_DURATION_SECONDS + 1 } },
    { metadata: { parameters: { duration: MAX_TASK_DURATION_SECONDS + 1 } } },
  ];
  for (const body of reject) {
    const err = validateResolvedUsageRequest(body, "", meta);
    assert.equal(typeof err, "string", JSON.stringify(body));
  }
  assert.equal(
    validateResolvedUsageRequest(
      { metadata: { duration: "5", count: "2", mode: "std" } },
      "",
      meta,
    ),
    null,
  );
  const hookErr = estimateBillingValidated(
    loaded.engine,
    { requestBody: { hookUsageEntries: [{ name: "duration", value: "5" }] } },
    "model",
  );
  assert.equal("error" in hookErr, true);
});

test("original native submit rejects over-limit usage request before upstream JSON", async () => {
  const { e, auth, sk } = await boot();
  const source = `
export const meta = {apiVersion:1,key:"bounded-http",name:"Bounded Usage",version:"1.0.0",author:{name:"Test"},models:["model"],fetchMode:"per_task",channelTypes:[${CHANNEL_TYPE_OPENAI}],usageSchema:{duration:{type:"number",unit:"second"}},routes:[{method:"POST",path:"/vendor/jobs",type:"submit",decode:"decode",render:"created"}]};
export const native = {decode:function(ctx){return {kind:"submit",model:"model",requestBody:ctx.body.value};},created:function(ctx,task){return {data:{task_id:task.task_id}};}};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit"};}
export function parseSubmitResponse(){return {taskId:"1"};}
export function buildQueryRequest(){return {url:"https://provider.example.test/query"};}
export function parseTaskResult(){return {status:"SUCCESS"};}
`;
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ model: 1 }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "bounded-http",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "model",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
  let fetched = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("provider.example.test")) fetched += 1;
    return origFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "model", metadata: { duration: MAX_TASK_DURATION_SECONDS + 1 } }),
      }),
      e,
    );
    assert.equal(hit.res.status, 400, hit.text);
    assert.equal(hit.body.code, "invalid_request");
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original ParseTaskResult discards invalid completion usage JSON", () => {
  const loaded = compilePlugin(boundedUsagePlugin, { key: "bounded-usage", version: "1.0.0" });
  for (const usage of [
    { duration: MAX_TASK_DURATION_SECONDS + 1 },
    { count: MAX_IMAGE_N + 1 },
    { duration: "5" },
  ]) {
    const parsed = parseNativeTaskResult(loaded.engine, {}, 200, {}, { completionUsage: usage });
    assert.equal(isNativeQueryError(parsed), false, JSON.stringify(usage));
    if (!isNativeQueryError(parsed)) {
      assert.equal(parsed.usageFacts, undefined);
      assert.equal(parsed.totalTokens, 0);
    }
  }
  const tokens = parseNativeTaskResult(loaded.engine, {}, 200, {}, { completionUsage: { tokens: 500000 } });
  assert.equal(isNativeQueryError(tokens), false);
  if (!isNativeQueryError(tokens)) {
    assert.equal(tokens.usageFacts?.tokens, 500000);
  }
});

test("original completion credit facts keep sub-integer precision JSON", () => {
  const source = `
export const meta = {
  apiVersion: 1, key: "credit-decimals", name: "Credit Decimals", version: "1.0.0",
  author: {name: "Test"}, models: ["model"], fetchMode: "per_task",
  usageSchema: {units: {type: "number", unit: "credit"}},
  usageExamples: [{label: "3.5 credits", facts: {units: 3.5}}],
};
export function buildSubmitRequest(ctx) { return {url: ctx.baseUrl + "/submit"}; }
export function parseSubmitResponse() { return {taskId: "task"}; }
export function buildQueryRequest() { return {url: "https://example.com"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
export function extractUsage() { return {units: 3.5}; }
export function extractUsageOnComplete() { return {units: 3.5}; }
`;
  const loaded = compilePlugin(source, { key: "credit-decimals", version: "1.0.0" });
  const parsed = parseNativeTaskResult(loaded.engine, {}, 200, {}, {});
  assert.equal(isNativeQueryError(parsed), false);
  if (!isNativeQueryError(parsed)) {
    assert.equal(parsed.usageFacts?.units, 3.5);
  }
});

test("original completion token facts saturate at MaxQuota JSON", () => {
  const loaded = compilePlugin(boundedUsagePlugin, { key: "bounded-usage", version: "1.0.0" });
  const parsed = parseNativeTaskResult(loaded.engine, {}, 200, {}, {
    completionUsage: { upstreamUnits: MAX_QUOTA + 1 },
  });
  assert.equal(isNativeQueryError(parsed), false);
  if (!isNativeQueryError(parsed)) {
    assert.equal(parsed.usageFacts?.upstreamUnits, MAX_QUOTA);
    assert.equal(parsed.totalTokens, MAX_QUOTA);
  }
});
