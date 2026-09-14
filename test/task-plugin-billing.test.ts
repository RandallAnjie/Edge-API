import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import { MAX_QUOTA } from "../src/task-plugin-usage.js";
import {
  appendTaskPluginAuditInfo,
  attachQuotaSaturationToOther,
  formatOtherRatio,
  logOtherSnapshot,
  logTaskConsumptionOther,
  newLogOther,
  setLogOtherPublic,
  taskConsumptionLogContent,
  type TaskConsumptionLogInput,
  type TaskPriceData,
} from "../src/task-plugin-billing.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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

function price(partial: Partial<TaskPriceData> = {}): TaskPriceData {
  return {
    quota: 100,
    modelPrice: 0.02,
    modelRatio: 0,
    groupRatio: 1,
    groupSpecialRatio: -1,
    hasSpecialRatio: false,
    usePrice: true,
    freeModel: false,
    clamp: null,
    ...partial,
  };
}

function input(partial: Partial<TaskConsumptionLogInput> = {}): TaskConsumptionLogInput {
  return {
    action: "GENERATE",
    requestPath: "/v1/videos",
    originModelName: "test-model",
    upstreamModelName: "test-model",
    isModelMapped: false,
    price: price(),
    otherRatios: {},
    quota: 100,
    taskId: "task_public",
    upstreamTaskId: "",
    plugin: null,
    ...partial,
  };
}

test("original LogTaskConsumption OtherRatios content JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      otherRatios: { size: 2, identity: 1 },
    }),
  );
  assert.equal(other.is_task, true);
  assert.equal(other.request_path, "/v1/videos");
  assert.equal(other.model_price, 0.02);
  assert.equal("model_ratio" in other, false);
  assert.equal(other.group_ratio, 1);
  assert.equal("billing_mode" in other, false);
  assert.equal("expr_b64" in other, false);
  assert.equal("matched_tier" in other, false);
  assert.equal("usage_facts" in other, false);
  const content = taskConsumptionLogContent({
    action: "GENERATE",
    otherRatios: { size: 2, identity: 1 },
  });
  assert.match(content, /计算参数：/);
  assert.match(content, /size: 2\.00/);
  assert.equal(content.includes("identity"), false);
  assert.equal(formatOtherRatio(7), "7.00");
});

test("original LogTaskConsumption includes tiered snapshot usage_facts JSON", () => {
  const expression = `tier("720P", u("seconds") * 5)`;
  const facts = { resolution: "720P", seconds: 5 };
  const other = logTaskConsumptionOther(
    input({
      originModelName: "wan2.5-i2v-preview",
      tiered: { exprString: expression, estimatedTier: "720P", usageFacts: facts },
    }),
  );
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.expr_b64, Buffer.from(expression, "utf8").toString("base64"));
  assert.equal(other.matched_tier, "720P");
  assert.deepEqual(other.usage_facts, facts);
  assert.equal("resolution" in other, false);
  assert.equal("seconds" in other, false);
  const content = taskConsumptionLogContent({ action: "GENERATE", usageFacts: facts });
  assert.match(content, /计算参数：/);
  assert.match(content, /resolution: 720P/);
  assert.match(content, /seconds: 5/);
});

test("original LogTaskConsumption omits empty usage_facts JSON", () => {
  const expression = `tier("base", 1)`;
  const other = logTaskConsumptionOther(
    input({
      tiered: { exprString: expression, estimatedTier: "base", usageFacts: {} },
    }),
  );
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.matched_tier, "base");
  assert.equal("usage_facts" in other, false);
});

test("original LogTaskConsumption separates plugin admin_info and root_info JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      taskId: "task_public",
      upstreamTaskId: "upstream-private",
      nodeName: "node-a",
      plugin: {
        key: "document-parser",
        name: "Document Parser",
        version: "1.2.3",
        author: { name: "Community Author", url: "https://plugins.example/author" },
        apiVersion: 1,
        generation: 42,
      },
    }),
  );
  assert.equal(other.task_id, "task_public");
  const admin = other.admin_info as Record<string, unknown>;
  const pluginInfo = admin.task_plugin as Record<string, unknown>;
  assert.equal(pluginInfo.key, "document-parser");
  assert.equal(pluginInfo.version, "1.2.3");
  assert.deepEqual(pluginInfo.author, { name: "Community Author", url: "https://plugins.example/author" });
  const root = other.root_info as Record<string, unknown>;
  assert.equal(root.upstream_task_id, "upstream-private");
  assert.equal(root.node_name, "node-a");
  const runtime = root.task_plugin as Record<string, unknown>;
  assert.equal(runtime.generation, 42);
  assert.equal(runtime.api_version, 1);
  assert.equal("author" in runtime, false);
});

test("original attachQuotaSaturation nests under admin_info JSON", () => {
  const maps = newLogOther();
  setLogOtherPublic(maps, "model_price", 0.004);
  attachQuotaSaturationToOther(maps, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 1.8e19,
    clamped: MAX_QUOTA,
  });
  const snap = logOtherSnapshot(maps);
  const admin = snap.admin_info as Record<string, unknown>;
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 1.8e19,
    clamped: MAX_QUOTA,
  });
});

test("original attachQuotaSaturation preserves existing admin_info JSON", () => {
  const maps = newLogOther();
  appendTaskPluginAuditInfo(maps, { key: "kling", name: "Kling", version: "1.0.0", apiVersion: 1, generation: 0 });
  attachQuotaSaturationToOther(maps, {
    op: "QuotaFromFloat",
    kind: "underflow",
    original: -1e20,
    clamped: -2147483648,
  });
  const snap = logOtherSnapshot(maps);
  const admin = snap.admin_info as Record<string, unknown>;
  assert.equal((admin.task_plugin as { key: string }).key, "kling");
  assert.equal((admin.quota_saturation as { op: string }).op, "QuotaFromFloat");
});

test("original LogTaskConsumption model_ratio and mapping JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      originModelName: "alias",
      upstreamModelName: "upstream-v1",
      isModelMapped: true,
      price: price({ modelPrice: -1, modelRatio: 1, usePrice: false }),
    }),
  );
  assert.equal(other.model_price, -1);
  assert.equal(other.model_ratio, 1);
  assert.equal(other.is_model_mapped, true);
  assert.equal(other.upstream_model_name, "upstream-v1");
});

test("original LogTaskConsumption user_group_ratio JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      price: price({ groupRatio: 0.5, groupSpecialRatio: 0.5, hasSpecialRatio: true }),
    }),
  );
  assert.equal(other.group_ratio, 0.5);
  assert.equal(other.user_group_ratio, 0.5);
});

test("original LogTaskConsumption per-call content JSON", () => {
  assert.equal(taskConsumptionLogContent({ action: "IMAGINE", perCall: true }), "操作 IMAGINE，按次计费");
});

test("original LogOther SetPublic rejects reserved keys JSON", () => {
  const maps = newLogOther();
  assert.equal(setLogOtherPublic(maps, "channel_id", 9), false);
  assert.equal(setLogOtherPublic(maps, "admin_info", {}), false);
  assert.equal(setLogOtherPublic(maps, "is_task", true), true);
  assert.equal("channel_id" in logOtherSnapshot(maps), false);
});

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

test("original native RelayTask LogTaskConsumption consume-log JSON", async () => {
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
  await json(
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
    const data = (hit.body as { data?: { task_id?: string } }).data;
    const taskId = String(data?.task_id);
    const persisted = await store.getTaskByTid(taskId);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_context?: {
        other_ratios?: Record<string, number>;
        model_price?: number;
        model_ratio?: number;
        group_ratio?: number;
        origin_model_name?: string;
        per_call_billing?: boolean;
      };
      token_id?: number;
      billing_source?: string;
    };
    assert.deepEqual(priv.billing_context?.other_ratios, { seconds: 7 });
    assert.equal(priv.billing_context?.model_price, -1);
    assert.equal(priv.billing_context?.model_ratio, 1);
    assert.equal(priv.billing_context?.group_ratio, 1);
    assert.equal(priv.billing_context?.origin_model_name, "mock-v1");
    assert.equal(priv.billing_context?.per_call_billing, false);
    assert.equal(priv.billing_source, "wallet");
    assert.ok(Number(priv.token_id) > 0);

    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { type: number; quota: number; content: string; other: string; model_name: string; token_name: string }[] }).items;
    assert.ok(items.length, logs.text);
    const consume = items[0];
    assert.equal(consume.type, LOG_CONSUME);
    assert.equal(consume.quota, 1750000);
    assert.equal(consume.model_name, "mock-v1");
    assert.equal(consume.token_name, "usage-submit");
    assert.match(consume.content, /计算参数：/);
    assert.match(consume.content, /seconds: 7\.00/);
    const other = JSON.parse(consume.other || "{}") as Record<string, unknown>;
    assert.equal(other.is_task, true);
    assert.equal(other.request_path, "/vendor/jobs");
    assert.equal(other.model_price, -1);
    assert.equal(other.model_ratio, 1);
    assert.equal(other.group_ratio, 1);
    assert.equal(other.task_id, taskId);
    assert.equal("billing_mode" in other, false);
    const admin = other.admin_info as { task_plugin?: { key: string; name: string; version: string; author?: { name: string } } };
    assert.equal(admin.task_plugin?.key, "mock-http");
    assert.equal(admin.task_plugin?.name, "Mock Task");
    assert.equal(admin.task_plugin?.version, "1.0.0");
    assert.equal(admin.task_plugin?.author?.name, "Test");
    const root = other.root_info as { upstream_task_id?: string; task_plugin?: { key: string; generation: number; api_version: number } };
    assert.equal(root.upstream_task_id, "upstream-1");
    assert.equal(root.task_plugin?.key, "mock-http");
    assert.equal(root.task_plugin?.api_version, 1);
    assert.equal(root.task_plugin?.generation, 0);
    assert.equal("author" in (root.task_plugin || {}), false);

    const selfLogs = await json(new Request("http://local/api/log/self?type=2", { headers: auth }), e);
    const selfItems = (selfLogs.body.data as { items: { other: string; channel_name: string }[] }).items;
    assert.ok(selfItems.length);
    const selfOther = JSON.parse(selfItems[0].other || "{}") as Record<string, unknown>;
    assert.equal(selfOther.is_task, true);
    assert.equal(selfOther.request_path, "/vendor/jobs");
    assert.equal("admin_info" in selfOther, false);
    assert.equal("root_info" in selfOther, false);
    assert.equal(selfItems[0].channel_name, "");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask immediate FAILURE LogTaskConsumption zero quota JSON", async () => {
  const { e, auth, sk } = await boot();
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
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; other: string }[] }).items;
    assert.ok(items.length, logs.text);
    assert.equal(items[0].quota, 0);
    assert.match(items[0].content, /seconds: 5\.00/);
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.is_task, true);
    assert.equal(other.request_path, "/vendor/jobs");
  } finally {
    globalThis.fetch = origFetch;
  }
});
