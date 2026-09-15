import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME, LOG_REFUND, ROOT_QUOTA } from "../src/constants.js";
import { formatQuotaOriginal, insufficientWalletQuotaMessage } from "../src/quota.js";
import { MAX_QUOTA, quotaClampMessage } from "../src/task-plugin-usage.js";
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
  taskBillingOther,
} from "../src/task-plugin-billing.js";
import { runTaskPollingOnce, SYSTEM_TASK_TYPE_ASYNC_TASK_POLL, TASK_TIMEOUT_MINUTES } from "../src/task-plugin-poll.js";
import worker from "../src/worker.js";
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

test("original LogTaskConsumption appendBillingInfo subscription JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      billing: {
        billingSource: "subscription",
        billingPreference: "subscription_only",
        subscriptionId: 42,
        subscriptionPreConsumed: 1750000,
        subscriptionPostDelta: 0,
        subscriptionPlanId: 7,
        subscriptionPlanTitle: "Task Subscription",
        subscriptionAmountTotal: 100_000_000,
        subscriptionAmountUsedAfterPreConsume: 1750000,
      },
    }),
  );
  assert.equal(other.billing_source, "subscription");
  assert.equal(other.billing_preference, "subscription_only");
  assert.equal(other.subscription_id, 42);
  assert.equal(other.subscription_pre_consumed, 1750000);
  assert.equal("subscription_post_delta" in other, false);
  assert.equal(other.subscription_plan_id, 7);
  assert.equal(other.subscription_plan_title, "Task Subscription");
  assert.equal(other.subscription_total, 100_000_000);
  assert.equal(other.subscription_used, 1750000);
  assert.equal(other.subscription_remain, 98_250_000);
  assert.equal(other.subscription_consumed, 1750000);
  assert.equal(other.wallet_quota_deducted, 0);
});

test("original LogTaskConsumption appendBillingInfo wallet JSON", () => {
  const other = logTaskConsumptionOther(
    input({
      billing: { billingSource: "wallet", billingPreference: "subscription_first" },
    }),
  );
  assert.equal(other.billing_source, "wallet");
  assert.equal(other.billing_preference, "subscription_first");
  assert.equal("subscription_id" in other, false);
  assert.equal("wallet_quota_deducted" in other, false);
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

test("original logger.FormatQuota USD JSON", () => {
  assert.equal(formatQuotaOriginal(1000, 500000, "USD"), "＄0.002000");
  assert.equal(formatQuotaOriginal(1250000, 500000, "USD"), "＄2.500000");
  assert.equal(formatQuotaOriginal(1750000, 500000, "USD"), "＄3.500000");
  assert.equal(formatQuotaOriginal(42, 500000, "TOKENS"), "42");
  assert.equal(
    insufficientWalletQuotaMessage(1000, 1250000, "＄0.002000", "＄2.500000"),
    "预扣费额度失败, 用户剩余额度: ＄0.002000, 需要预扣费额度: ＄2.500000",
  );
  assert.equal(insufficientWalletQuotaMessage(0, 1250000, "＄0.000000", "＄2.500000"), "用户额度不足, 剩余额度: ＄0.000000");
  assert.equal(
    quotaClampMessage({ op: "QuotaFromFloat", kind: "overflow", original: 2.5e25, clamped: MAX_QUOTA }),
    `quota conversion (QuotaFromFloat) overflow: original=${2.5e25}, clamped=${MAX_QUOTA}`,
  );
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
export const meta = {apiVersion:1,key:"mock-http",name:"Mock Task",version:"1.0.0",author:{name:"Test"},models:["mock-v1"],fetchMode:"per_task",channelTypes:[${CHANNEL_TYPE_OPENAI}],usageSchema:{seconds:{type:"number",unit:"second"},mode:{enum:["std","pro"]}},routes:[{method:"POST",path:"/vendor/jobs",type:"submit",decode:"decode",render:"created"},{method:"GET",path:"/vendor/jobs/:task_id",type:"query",render:"status"}]};
export const native = {decode:function(ctx){return {kind:"submit",model:"mock-v1",requestBody:ctx.body.value};},created:function(ctx,task){return {data:{task_id:task.task_id},upstream:task.data};},status:function(ctx,task){return {data:{task_id:task.task_id,status:task.status,progress:task.progress,fail_reason:task.fail_reason}};}};
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
      body: JSON.stringify({ source: httpUsagePlugin, force: true }),
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

    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA - 1750000);
    assert.equal(Number(user?.used_quota), 1750000);
    assert.equal(Number(user?.request_count), 1);
    const token = await store.getTokenById(Number(priv.token_id));
    assert.equal(Number(token?.used_quota), 1750000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask immediate FAILURE LogTaskConsumption zero quota JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `taskData:{accepted:true,status:resp.statusCode}`,
    `taskData:{accepted:false},immediate:{status:"FAILURE",progress:"100%",reason:"provider rejected"}`,
  );
  await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, force: true }),
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
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    assert.equal(Number(user?.request_count), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

async function registerHttpUsage(
  e: Env,
  auth: Record<string, string>,
  source = httpUsagePlugin,
  channelName = "mock-usage",
  modelRatio: Record<string, number> = { "mock-v1": 1 },
) {
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source, force: true }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify(modelRatio) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: channelName,
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "mock-v1",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
}

async function seedTaskSubscription(
  store: Store,
  userId: number,
  opts: { amountTotal?: number; amountUsed?: number; title?: string } = {},
) {
  const amountTotal = opts.amountTotal ?? 100_000_000;
  const planId = await store.insertPlan({
    title: opts.title ?? "Task Subscription",
    quota_reset_period: "never",
    total_amount: amountTotal,
    grant_quota: amountTotal,
    enabled: 1,
    allow_wallet_overflow: 1,
  });
  const subId = await store.insertUserSub({
    user_id: userId,
    plan_id: planId,
    amount_total: amountTotal,
    amount_used: opts.amountUsed ?? 0,
    end_time: Math.floor(Date.now() / 1000) + 365 * 86400,
    status: "active",
  });
  return { planId, subId, amountTotal };
}

async function setBillingPreference(e: Env, auth: Record<string, string>, preference: string) {
  const res = await json(
    new Request("http://local/api/subscription/self/preference", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ billing_preference: preference }),
    }),
    e,
  );
  assert.equal(res.body.success, true, String(res.body.message));
  assert.equal((res.body.data as { billing_preference: string }).billing_preference, preference);
}

test("original native RelayTask PreConsume insufficient wallet JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-short");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.decreaseUserQuota(root.id, Number(root.quota) - 1000);
  const before = await store.getUserByUsername("root");
  assert.equal(Number(before?.quota), 1000);

  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response(JSON.stringify({ id: "should-not-fetch" }), {
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
    assert.equal(hit.res.status, 403, hit.text);
    assert.equal(hit.body.code, "permission_denied");
    assert.match(String(hit.body.message), /预扣费额度失败, 用户剩余额度: ＄0\.002000, 需要预扣费额度: ＄2\.500000/);
    assert.equal(submitHits, 0);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), 1000);
    assert.equal(Number(after?.used_quota), Number(before?.used_quota));
    assert.equal(Number(after?.request_count), Number(before?.request_count));
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: unknown[] }).items;
    assert.equal(items.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask Refund restores remaining after fetch 502 JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-502");
  const before = await store.getUserByUsername("root");
  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response("upstream boom", { status: 502 });
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
    assert.equal(hit.res.status, 502, hit.text);
    assert.equal(hit.body.code, "server_error");
    assert.equal(submitHits, 1);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), ROOT_QUOTA);
    assert.equal(Number(after?.used_quota), Number(before?.used_quota));
    assert.equal(Number(after?.request_count), Number(before?.request_count));
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: unknown[] }).items;
    assert.equal(items.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask QuotaClamp model_price_error JSON before PreConsume", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-clamp", { "mock-v1": 1e20 });
  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response(JSON.stringify({ id: "should-not-fetch" }), {
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
    assert.equal(hit.res.status, 400, hit.text);
    assert.equal(hit.body.code, "invalid_request");
    assert.match(String(hit.body.message), /quota conversion \(QuotaFromFloat\) overflow/);
    assert.equal(submitHits, 0);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), ROOT_QUOTA);
    assert.equal(Number(after?.used_quota), 0);
    assert.equal(Number(after?.request_count), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask tiered billing consume-log JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-tiered");
  const expression = `tier("720P", u("seconds") * 5)`;
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_mode", value: JSON.stringify({ "mock-v1": "tiered_expr" }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_expr", value: JSON.stringify({ "mock-v1": expression }) }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-tiered" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(Number(persisted?.quota), 12_500_000);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_context?: {
        other_ratios?: Record<string, number>;
        tiered_snapshot?: {
          billing_mode?: string;
          estimated_tier?: string;
          estimated_quota_after_group?: number;
          task_usage_billing?: boolean;
          usage_facts?: Record<string, unknown>;
          expr_string?: string;
        };
      };
    };
    assert.equal(priv.billing_context?.tiered_snapshot?.billing_mode, "tiered_expr");
    assert.equal(priv.billing_context?.tiered_snapshot?.estimated_tier, "720P");
    assert.equal(priv.billing_context?.tiered_snapshot?.estimated_quota_after_group, 12_500_000);
    assert.equal(priv.billing_context?.tiered_snapshot?.task_usage_billing, true);
    assert.equal(priv.billing_context?.tiered_snapshot?.expr_string, expression);
    assert.deepEqual(priv.billing_context?.tiered_snapshot?.usage_facts, { seconds: 5, mode: "pro" });

    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; other: string }[] }).items;
    assert.equal(items[0].quota, 12_500_000);
    assert.match(items[0].content, /seconds: 5/);
    assert.match(items[0].content, /mode: pro/);
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.billing_mode, "tiered_expr");
    assert.equal(other.expr_b64, Buffer.from(expression, "utf8").toString("base64"));
    assert.equal(other.matched_tier, "720P");
    assert.deepEqual(other.usage_facts, { seconds: 5, mode: "pro" });
    assert.equal(other.model_price, 0);
    assert.equal("model_ratio" in other, false);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA - 12_500_000);
    assert.equal(Number(user?.used_quota), 12_500_000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask EvaluateTaskCompletionUsage immediate SUCCESS JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `taskData:{accepted:true,status:resp.statusCode}`,
    `taskData:{accepted:true},immediate:{status:"SUCCESS",progress:"100%",usageFacts:{seconds:8}}`,
  );
  await registerHttpUsage(e, auth, source, "mock-tiered-complete");
  const expression = `tier("base", u("seconds") * 5)`;
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_mode", value: JSON.stringify({ "mock-v1": "tiered_expr" }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_expr", value: JSON.stringify({ "mock-v1": expression }) }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-complete" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(Number(persisted?.quota), 20_000_000);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_context?: { tiered_snapshot?: { estimated_tier?: string; usage_facts?: Record<string, unknown> } };
    };
    assert.equal(priv.billing_context?.tiered_snapshot?.estimated_tier, "base");
    assert.deepEqual(priv.billing_context?.tiered_snapshot?.usage_facts, { seconds: 8, mode: "pro" });
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; other: string }[] }).items;
    assert.equal(items[0].quota, 20_000_000);
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.matched_tier, "base");
    assert.deepEqual(other.usage_facts, { seconds: 8, mode: "pro" });
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA - 20_000_000);
    assert.equal(Number(user?.used_quota), 20_000_000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original taskBillingOther other_ratio keys and nested usage_facts JSON", () => {
  const expression = `tier("720P", u("seconds") * 5)`;
  const other = taskBillingOther({
    task_id: "task_public",
    model_name: "mock-v1",
    properties: JSON.stringify({ origin_model_name: "alias", upstream_model_name: "upstream-v1" }),
    private_data: JSON.stringify({
      upstream_task_id: "up-1",
      billing_context: {
        model_price: 0,
        model_ratio: 0,
        group_ratio: 1,
        other_ratios: { seconds: 7 },
        origin_model_name: "mock-v1",
        tiered_snapshot: {
          billing_mode: "tiered_expr",
          expr_string: expression,
          estimated_tier: "720P",
          usage_facts: { seconds: 5, mode: "pro" },
          group_ratio: 1,
          quota_per_unit: 500000,
          task_usage_billing: true,
        },
      },
      execution: { task_plugin: { key: "mock-http", name: "Mock Task", version: "1.0.0", api_version: 1, generation: 0, author: { name: "Test" } } },
    }),
  });
  assert.equal(other.model_price, 0);
  assert.equal("model_ratio" in other, false);
  assert.equal(other.group_ratio, 1);
  assert.equal(other.seconds, 7);
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.expr_b64, Buffer.from(expression, "utf8").toString("base64"));
  assert.equal(other.matched_tier, "720P");
  assert.deepEqual(other.usage_facts, { seconds: 5, mode: "pro" });
  assert.equal(other.is_model_mapped, true);
  assert.equal(other.upstream_model_name, "upstream-v1");
  assert.equal(other.task_id, "task_public");
  const admin = other.admin_info as { task_plugin?: { key: string; author?: { name: string } } };
  assert.equal(admin.task_plugin?.key, "mock-http");
  assert.equal(admin.task_plugin?.author?.name, "Test");
  const root = other.root_info as { upstream_task_id?: string; task_plugin?: { author?: unknown } };
  assert.equal(root.upstream_task_id, "up-1");
  assert.equal("author" in (root.task_plugin || {}), false);
});

test("original native poll FAILURE RefundTaskQuota log type 6 JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(`export function parseTaskResult(){return {status:"SUCCESS"};}`, `export function parseTaskResult(){return {status:"FAILURE",reason:"upstream failed"};}`);
  await registerHttpUsage(e, auth, source, "mock-poll-fail");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-fail" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://provider.example.test/query") {
      return new Response(JSON.stringify({ status: "FAILURE" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const poll = await json(new Request("http://local/vendor/jobs/" + taskId, { headers: { authorization: "Bearer " + sk } }), e);
    assert.equal(poll.res.status, 200, poll.text);
    const view = (poll.body as { data?: { status?: string } }).data;
    assert.equal(view?.status, "FAILURE");
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(String(persisted?.status), "FAILURE");
    assert.equal(Number(persisted?.quota), 0);
    const refunds = await json(new Request("http://local/api/log/?type=6", { headers: auth }), e);
    const items = (refunds.body.data as { items: { type: number; quota: number; content: string; other: string }[] }).items;
    assert.ok(items.length, refunds.text);
    const refund = items[0];
    assert.equal(refund.type, LOG_REFUND);
    assert.equal(refund.quota, 1750000);
    assert.equal(refund.content, "");
    const other = JSON.parse(refund.other || "{}") as Record<string, unknown>;
    assert.equal(other.task_id, taskId);
    assert.equal(other.reason, "upstream failed");
    assert.equal(other.seconds, 7);
    assert.equal(other.model_ratio, 1);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    assert.equal(Number(user?.request_count), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native poll SUCCESS RecalculateTaskQuota pre_consumed_quota JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `export function parseTaskResult(){return {status:"SUCCESS"};}`,
    `export function parseTaskResult(){return {status:"SUCCESS"};}\nexport function extractUsageOnComplete(){return {seconds:8};}`,
  );
  await registerHttpUsage(e, auth, source, "mock-poll-recalc");
  const expression = `tier("720P", u("seconds") * 5)`;
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_mode", value: JSON.stringify({ "mock-v1": "tiered_expr" }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_expr", value: JSON.stringify({ "mock-v1": expression }) }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-recalc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://provider.example.test/query") {
      return new Response(JSON.stringify({ status: "SUCCESS", seconds: 8 }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const summary = await runTaskPollingOnce(store);
    assert.equal(summary.unfinished_tasks, 1);
    assert.equal(summary.platforms_scanned, 1);
    assert.equal(summary.null_tasks_failed, 0);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(String(persisted?.status), "SUCCESS");
    assert.equal(Number(persisted?.quota), 20_000_000);
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; other: string }[] }).items;
    const delta = items.find((item) => JSON.parse(item.other || "{}").pre_consumed_quota != null);
    assert.ok(delta, logs.text);
    assert.equal(delta?.quota, 7_500_000);
    assert.equal(delta?.content, "任务用量表达式结算");
    const other = JSON.parse(delta?.other || "{}") as Record<string, unknown>;
    assert.equal(other.task_id, taskId);
    assert.equal(other.pre_consumed_quota, 12_500_000);
    assert.equal(other.actual_quota, 20_000_000);
    assert.equal(other.billing_mode, "tiered_expr");
    assert.deepEqual(other.usage_facts, { seconds: 8, mode: "pro" });
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA - 20_000_000);
    assert.equal(Number(user?.used_quota), 20_000_000);
    assert.equal(Number(user?.request_count), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original sweepTimedOutTasks refunds with timeout reason JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-timeout");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-timeout" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const cutoff = Math.floor(Date.now() / 1000) - TASK_TIMEOUT_MINUTES * 60 - 10;
    await store.updateTaskByTid(taskId, { submit_time: cutoff });
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({}, e, { waitUntil(p) { pending.push(p); } });
    await Promise.all(pending);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(String(persisted?.status), "FAILURE");
    assert.equal(String(persisted?.fail_reason), `任务超时（${TASK_TIMEOUT_MINUTES}分钟）`);
    assert.equal(Number(persisted?.quota), 0);
    const refunds = await json(new Request("http://local/api/log/?type=6", { headers: auth }), e);
    const items = (refunds.body.data as { items: { type: number; quota: number; content: string; other: string }[] }).items;
    assert.equal(items[0].type, LOG_REFUND);
    assert.equal(items[0].quota, 1750000);
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.reason, `任务超时（${TASK_TIMEOUT_MINUTES}分钟）`);
    assert.equal(other.task_id, taskId);
    const tasks = await json(new Request("http://local/api/system-task/list", { headers: auth }), e);
    const sys = (tasks.body.data as { type?: string; result?: string }[]).find((item) => item.type === SYSTEM_TASK_TYPE_ASYNC_TASK_POLL);
    assert.ok(sys, tasks.text);
    const result = typeof sys?.result === "string" ? JSON.parse(sys.result) : sys?.result;
    assert.equal(typeof (result as { unfinished_tasks?: number }).unfinished_tasks, "number");
    assert.equal(typeof (result as { platforms_scanned?: number }).platforms_scanned, "number");
    assert.equal(typeof (result as { null_tasks_failed?: number }).null_tasks_failed, "number");
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    assert.equal(Number(user?.request_count), 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask BillingSourceSubscription consume-log JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-sub");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const seeded = await seedTaskSubscription(store, root.id, { title: "Task Subscription" });
  await setBillingPreference(e, auth, "subscription_only");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-sub" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const persisted = await store.getTaskByTid(taskId);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as {
      billing_source?: string;
      subscription_id?: number;
      token_id?: number;
    };
    assert.equal(priv.billing_source, "subscription");
    assert.equal(priv.subscription_id, seeded.subId);
    assert.equal(Number(persisted?.quota), 1750000);

    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { type: number; quota: number; other: string }[] }).items;
    assert.ok(items.length, logs.text);
    assert.equal(items[0].type, LOG_CONSUME);
    assert.equal(items[0].quota, 1750000);
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.billing_source, "subscription");
    assert.equal(other.billing_preference, "subscription_only");
    assert.equal(other.subscription_id, seeded.subId);
    assert.equal(other.subscription_pre_consumed, 1750000);
    assert.equal("subscription_post_delta" in other, false);
    assert.equal(other.subscription_plan_id, seeded.planId);
    assert.equal(other.subscription_plan_title, "Task Subscription");
    assert.equal(other.subscription_total, seeded.amountTotal);
    assert.equal(other.subscription_used, 1750000);
    assert.equal(other.subscription_remain, seeded.amountTotal - 1750000);
    assert.equal(other.subscription_consumed, 1750000);
    assert.equal(other.wallet_quota_deducted, 0);

    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 1750000);
    assert.equal(Number(user?.request_count), 1);
    const sub = await store.getUserSub(seeded.subId);
    assert.equal(Number(sub?.amount_used), 1750000);
    const token = await store.getTokenById(Number(priv.token_id));
    assert.equal(Number(token?.used_quota), 1750000);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native poll FAILURE RefundTaskQuota subscription JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `export function parseTaskResult(){return {status:"SUCCESS"};}`,
    `export function parseTaskResult(){return {status:"FAILURE",reason:"upstream failed"};}`,
  );
  await registerHttpUsage(e, auth, source, "mock-sub-fail");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const seeded = await seedTaskSubscription(store, root.id);
  await setBillingPreference(e, auth, "subscription_only");

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-sub-fail" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://provider.example.test/query") {
      return new Response(JSON.stringify({ status: "FAILURE" }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const poll = await json(new Request("http://local/vendor/jobs/" + taskId, { headers: { authorization: "Bearer " + sk } }), e);
    assert.equal(poll.res.status, 200, poll.text);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(String(persisted?.status), "FAILURE");
    assert.equal(Number(persisted?.quota), 0);
    const refunds = await json(new Request("http://local/api/log/?type=6", { headers: auth }), e);
    const items = (refunds.body.data as { items: { type: number; quota: number; content: string; other: string }[] }).items;
    assert.ok(items.length, refunds.text);
    assert.equal(items[0].type, LOG_REFUND);
    assert.equal(items[0].quota, 1750000);
    assert.equal(items[0].content, "");
    const other = JSON.parse(items[0].other || "{}") as Record<string, unknown>;
    assert.equal(other.task_id, taskId);
    assert.equal(other.reason, "upstream failed");
    assert.equal("billing_source" in other, false);
    assert.equal("subscription_id" in other, false);
    assert.equal("wallet_quota_deducted" in other, false);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 0);
    assert.equal(Number(user?.request_count), 1);
    const sub = await store.getUserSub(seeded.subId);
    assert.equal(Number(sub?.amount_used), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask subscription_only no active subscription JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-sub-none");
  await setBillingPreference(e, auth, "subscription_only");
  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response(JSON.stringify({ id: "should-not-fetch" }), {
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
    assert.equal(hit.res.status, 403, hit.text);
    assert.equal(hit.body.code, "permission_denied");
    assert.match(String(hit.body.message), /订阅额度不足或未配置订阅: no active subscription/);
    assert.equal(submitHits, 0);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), ROOT_QUOTA);
    assert.equal(Number(after?.used_quota), 0);
    assert.equal(Number(after?.request_count), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask subscription quota insufficient JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-sub-short");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await seedTaskSubscription(store, root.id, { amountTotal: 1000 });
  await setBillingPreference(e, auth, "subscription_only");
  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response(JSON.stringify({ id: "should-not-fetch" }), {
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
    assert.equal(hit.res.status, 403, hit.text);
    assert.equal(hit.body.code, "permission_denied");
    assert.match(String(hit.body.message), /订阅额度不足或未配置订阅: subscription quota insufficient, need=1250000/);
    assert.equal(submitHits, 0);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), ROOT_QUOTA);
    assert.equal(Number(after?.used_quota), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native RelayTask subscription Refund restores remaining after fetch 502 JSON", async () => {
  const { e, auth, store, sk } = await boot();
  await registerHttpUsage(e, auth, httpUsagePlugin, "mock-sub-502");
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const seeded = await seedTaskSubscription(store, root.id);
  await setBillingPreference(e, auth, "subscription_only");
  let submitHits = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/submit") {
      submitHits += 1;
      return new Response("upstream boom", { status: 502 });
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
    assert.equal(hit.res.status, 502, hit.text);
    assert.equal(submitHits, 1);
    const after = await store.getUserByUsername("root");
    assert.equal(Number(after?.quota), ROOT_QUOTA);
    assert.equal(Number(after?.used_quota), 0);
    assert.equal(Number(after?.request_count), 0);
    const sub = await store.getUserSub(seeded.subId);
    assert.equal(Number(sub?.amount_used), 0);
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: unknown[] }).items;
    assert.equal(items.length, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original native poll SUCCESS RecalculateTaskQuota subscription JSON", async () => {
  const { e, auth, store, sk } = await boot();
  const source = httpUsagePlugin.replace(
    `export function parseTaskResult(){return {status:"SUCCESS"};}`,
    `export function parseTaskResult(){return {status:"SUCCESS"};}\nexport function extractUsageOnComplete(){return {seconds:8};}`,
  );
  await registerHttpUsage(e, auth, source, "mock-sub-recalc");
  const expression = `tier("720P", u("seconds") * 5)`;
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_mode", value: JSON.stringify({ "mock-v1": "tiered_expr" }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "billing_setting.billing_expr", value: JSON.stringify({ "mock-v1": expression }) }),
    }),
    e,
  );
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const seeded = await seedTaskSubscription(store, root.id);
  await setBillingPreference(e, auth, "subscription_only");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://provider.example.test/submit") {
      return new Response(JSON.stringify({ id: "upstream-sub-recalc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "https://provider.example.test/query") {
      return new Response(JSON.stringify({ status: "SUCCESS", seconds: 8 }), {
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
    const taskId = String((hit.body as { data?: { task_id?: string } }).data?.task_id);
    const afterSubmit = await store.getUserSub(seeded.subId);
    assert.equal(Number(afterSubmit?.amount_used), 12_500_000);
    const summary = await runTaskPollingOnce(store);
    assert.equal(summary.null_tasks_failed, 0);
    const persisted = await store.getTaskByTid(taskId);
    assert.equal(String(persisted?.status), "SUCCESS");
    assert.equal(Number(persisted?.quota), 20_000_000);
    const logs = await json(new Request("http://local/api/log/?type=2", { headers: auth }), e);
    const items = (logs.body.data as { items: { quota: number; content: string; other: string }[] }).items;
    const delta = items.find((item) => JSON.parse(item.other || "{}").pre_consumed_quota != null);
    assert.ok(delta, logs.text);
    assert.equal(delta?.quota, 7_500_000);
    assert.equal(delta?.content, "任务用量表达式结算");
    const other = JSON.parse(delta?.other || "{}") as Record<string, unknown>;
    assert.equal(other.pre_consumed_quota, 12_500_000);
    assert.equal(other.actual_quota, 20_000_000);
    assert.equal("billing_source" in other, false);
    const user = await store.getUserByUsername("root");
    assert.equal(Number(user?.quota), ROOT_QUOTA);
    assert.equal(Number(user?.used_quota), 20_000_000);
    assert.equal(Number(user?.request_count), 1);
    const sub = await store.getUserSub(seeded.subId);
    assert.equal(Number(sub?.amount_used), 20_000_000);
  } finally {
    globalThis.fetch = origFetch;
  }
});
