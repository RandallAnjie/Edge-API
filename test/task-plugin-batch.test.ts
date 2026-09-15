import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePlugin } from "../src/jsplugin.js";
import {
  buildNativeBatchQueryContext,
  buildNativeBatchQueryDescriptor,
  fetchNativeQuery,
  isNativeQueryError,
  parseNativeBatchResult,
} from "../src/task-plugin-query.js";

const batchMockPlugin = `
export const meta = { apiVersion: 1, key: "mock-batch", name: "Mock Batch", version: "1.0.0", author: {name: "Test"}, channelTypes: [1002], models: ["batch-v1"], fetchMode: "batch" };
export function buildSubmitRequest(ctx) { return { url: ctx.baseUrl + "/submit", method: "POST", body: {} }; }
export function parseSubmitResponse(ctx, resp) { return { taskId: resp.body.id }; }
export function buildQueryRequest(ctx) { return { url: ctx.baseUrl + "/tasks/" + ctx.taskId }; }
export function parseTaskResult(ctx, body) { return { taskId: body.id, status: "SUCCESS" }; }
export function buildBatchQueryRequest(ctx, tasks) { return { url: ctx.baseUrl + "/batch", method: "POST", headers: { "X-Plugin": "batch" }, body: { ids: (tasks || []).map(function (task) { return task.taskId; }) } }; }
export function parseBatchResult(ctx, body) {
  return body.items.map(function (item) {
    return { taskId: item.id, action: item.action, status: item.status, progress: item.progress, url: (item.urls || [])[0] || "", finishTime: item.finish || 0, data: item };
  });
}
export function extractUsageOnComplete(task, result, body) { return {upstreamUnits: body.usage || 0}; }
`;

function taskRow(upstreamId: string, originModel = ""): Record<string, unknown> {
  return {
    task_id: "task_public_" + upstreamId,
    properties: { origin_model_name: originModel },
    private_data: { upstream_task_id: upstreamId },
  };
}

test("original TaskAdaptorBatchBridge JSON fields", async () => {
  const loaded = compilePlugin(batchMockPlugin);
  const tasks = [taskRow("task-a"), taskRow("task-b")];
  const packed = await buildNativeBatchQueryContext(loaded.engine, tasks, "secret", "https://provider.example");
  assert.equal(isNativeQueryError(packed), false);
  if (isNativeQueryError(packed)) return;
  const descriptor = buildNativeBatchQueryDescriptor(loaded.engine, packed.ctx, packed.taskContexts, "https://provider.example");
  assert.equal(isNativeQueryError(descriptor), false);
  if (isNativeQueryError(descriptor)) return;
  assert.equal(descriptor.url, "https://provider.example/batch");
  assert.equal(descriptor.method, "POST");
  assert.equal(descriptor.headers["X-Plugin"], "batch");
  assert.deepEqual(descriptor.body, { ids: ["task-a", "task-b"] });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://provider.example/batch");
    assert.equal(String(init?.method || "GET").toUpperCase(), "POST");
    assert.equal(new Headers(init?.headers).get("X-Plugin"), "batch");
    const body = typeof init?.body === "string" ? init.body : "";
    assert.deepEqual(JSON.parse(body), { ids: ["task-a", "task-b"] });
    return new Response(
      JSON.stringify({
        items: [
          {
            id: "task-a",
            action: "music",
            status: "SUCCESS",
            progress: "100%",
            urls: ["https://cdn.example/a1.mp3", "https://cdn.example/a2.mp3"],
            finish: 1700000000,
            usage: 23,
          },
          { id: "task-b", status: "IN_PROGRESS", progress: "40%" },
          { id: "", status: "SUCCESS" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const fetched = await fetchNativeQuery(descriptor);
    assert.equal(isNativeQueryError(fetched), false);
    if (isNativeQueryError(fetched)) return;
    const results = parseNativeBatchResult(
      loaded.engine,
      packed.ctx,
      packed.taskContexts,
      fetched.status,
      fetched.headers,
      fetched.body,
    );
    assert.equal(isNativeQueryError(results), false);
    if (isNativeQueryError(results)) return;
    assert.equal(Object.keys(results).length, 2, "entry without taskId must be skipped");
    const done = results["task-a"];
    assert.ok(done);
    assert.equal(done.action, "music");
    assert.equal(done.taskInfo.status, "SUCCESS");
    assert.equal(done.taskInfo.progress, "100%");
    assert.equal(done.taskInfo.url, "https://cdn.example/a1.mp3");
    assert.equal(done.finishTime, 1700000000);
    assert.equal(done.taskInfo.usageFacts?.upstreamUnits, 23);
    assert.equal(done.taskInfo.totalTokens, 23);
    assert.ok(done.data);
    const pending = results["task-b"];
    assert.ok(pending);
    assert.equal(pending.taskInfo.status, "IN_PROGRESS");
    assert.equal(pending.taskInfo.progress, "40%");
    assert.equal(pending.taskInfo.url, "");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original batch query receives task objects without requestBody JSON", async () => {
  const source = `
export const meta = {apiVersion:1,key:"batch-ctx",name:"Batch Ctx",version:"1.0.0",author:{name:"Test"},models:["m"],fetchMode:"batch"};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit"}}
export function parseSubmitResponse(){return {taskId:"1"}}
export function buildQueryRequest(ctx){return {url:ctx.baseUrl+"/q"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
export function buildBatchQueryRequest(ctx, tasks){
  return {url:ctx.baseUrl+"/batch",method:"POST",body:{
    ids: (tasks||[]).map(function(task){return task.taskId;}),
    models: (tasks||[]).map(function(task){return task.model;}),
    hasRequestBody: (tasks||[]).some(function(task){return Object.prototype.hasOwnProperty.call(task,"requestBody");})
  }};
}
export function parseBatchResult(){return [];}
`;
  const loaded = compilePlugin(source);
  const tasks = [taskRow("task-a", "model-a"), taskRow("task-b", "model-b")];
  const packed = await buildNativeBatchQueryContext(loaded.engine, tasks, "secret", "https://provider.example");
  assert.equal(isNativeQueryError(packed), false);
  if (isNativeQueryError(packed)) return;
  for (const taskCtx of packed.taskContexts) {
    assert.equal(Object.prototype.hasOwnProperty.call(taskCtx, "requestBody"), false);
  }
  const descriptor = buildNativeBatchQueryDescriptor(loaded.engine, packed.ctx, packed.taskContexts, "https://provider.example");
  assert.equal(isNativeQueryError(descriptor), false);
  if (isNativeQueryError(descriptor)) return;
  assert.deepEqual(descriptor.body, { ids: ["task-a", "task-b"], models: ["model-a", "model-b"], hasRequestBody: false });
});
