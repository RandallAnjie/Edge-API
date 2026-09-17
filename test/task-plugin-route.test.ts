import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  BODY_JSON,
  BODY_NONE,
  TASK_PLUGIN_INVALID_ROUTE_RESULT,
  abortTaskPluginRouteErrorDetail,
  buildTaskPluginRouteRequestFromParts,
  buildTaskPluginView,
  loadCompiledPlugin,
  prepareTaskPluginRoute,
  resolvedTaskPluginIDs,
  routeRequestJSValue,
} from "../src/task-plugin-route.js";
import type { Env, ExecutionContextLike } from "../src/types.js";
import type { MatchedPlugin } from "../src/plugin-dispatch.js";

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
  const root = await store.getUserByUsername("root");
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "native-route", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, rootId: Number(root?.id || 1), sk };
}

const hooks = `
export function buildSubmitRequest() { return {url: "https://example.com"}; }
export function parseSubmitResponse() { return {taskId: "one"}; }
export function buildQueryRequest() { return {url: "https://example.com"}; }
export function parseTaskResult() { return {status: "SUCCESS"}; }
`;

function matchedFromSource(source: string, path: string, routeIndex = 0): MatchedPlugin {
  const loaded = loadCompiledPlugin(source, "", "");
  const meta = loaded.meta as { key?: string; version?: string; models?: string[]; channelTypes?: number[]; routes?: MatchedPlugin["route"][] };
  const route = (meta.routes || [])[routeIndex];
  return {
    key: String(meta.key || loaded.engine.key),
    path: String(route?.path || path),
    channelTypes: Array.isArray(meta.channelTypes) ? meta.channelTypes.map(Number) : [],
    kind: "route",
    models: Array.isArray(meta.models) ? meta.models.map(String) : [],
    source,
    version: String(meta.version || ""),
    route,
    params: {},
  };
}

test("original buildTaskPluginRouteRequest body union JSON fields", () => {
  const none = buildTaskPluginRouteRequestFromParts({ method: "GET", path: "/vendor/jobs/1" });
  assert.equal(none.body.kind, BODY_NONE);

  const jsonBody = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/body",
    contentTypes: ["application/problem+json; charset=utf-8"],
    contentLength: 13,
    body: new TextEncoder().encode(`{"model":"m"}`),
  });
  assert.equal(jsonBody.body.kind, BODY_JSON);
  assert.deepEqual(jsonBody.body.value, { model: "m" });

  const form = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/body",
    contentTypes: ["application/x-www-form-urlencoded"],
    contentLength: 15,
    body: new TextEncoder().encode("tag=one&tag=two"),
  });
  assert.equal(form.body.kind, "form");
  assert.deepEqual((form.body.fields as Record<string, string[]>).tag, ["one", "two"]);
});

test("original buildTaskPluginRouteRequest conflicting Content-Type JSON", () => {
  assert.throws(
    () =>
      buildTaskPluginRouteRequestFromParts({
        method: "POST",
        path: "/body",
        contentTypes: ["application/json", "application/x-www-form-urlencoded"],
        contentLength: 2,
        body: new TextEncoder().encode("{}"),
      }),
    /conflicting Content-Type/,
  );
});

test("original resolvedTaskPluginIDs public query contract", () => {
  const valid = resolvedTaskPluginIDs(["task-a", "task-b", "task-a"]);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.ids, ["task-a", "task-b", "task-a"]);
  assert.equal(resolvedTaskPluginIDs([]).ok, true);
  assert.equal(resolvedTaskPluginIDs(["task-a", ""]).ok, false);
  assert.equal(resolvedTaskPluginIDs(["task-a", "   "]).ok, false);
  assert.equal(resolvedTaskPluginIDs(["task-a", 2]).ok, false);
  assert.equal(resolvedTaskPluginIDs("task-a").ok, false);
  assert.equal(resolvedTaskPluginIDs(new Array(101).fill("task")).ok, false);
});

test("original BuildTaskPluginView rewrites only structured task_id fields", () => {
  const view = buildTaskPluginView({
    task_id: "task_public_123",
    platform: "kling",
    status: "SUCCESS",
    progress: "100%",
    fail_reason: "",
    created_at: 10,
    updated_at: 20,
    finish_time: 30,
    data: JSON.stringify({
      task_id: "upstream-task-123",
      id: "upstream-task-123",
      taskId: "upstream-task-123",
      url: "https://cdn.example.com/results/upstream-task-123/video.mp4",
      nested: [{ task_id: "upstream-task-123", url: "https://cdn.example.com/results/upstream-task-123/video.mp4" }, "upstream-task-123"],
    }),
    private_data: JSON.stringify({ upstream_task_id: "upstream-task-123" }),
  });
  const data = view.data as Record<string, unknown>;
  assert.equal(data.task_id, "task_public_123");
  assert.equal(data.id, "task_public_123");
  assert.equal(data.taskId, "task_public_123");
  assert.equal(data.url, "https://cdn.example.com/results/upstream-task-123/video.mp4");
  const nested = data.nested as unknown[];
  assert.equal((nested[0] as Record<string, unknown>).task_id, "task_public_123");
  assert.equal(nested[1], "upstream-task-123");
  assert.equal(view.updated_at, 20);
  assert.equal(view.finished_at, 30);
});

test("original PrepareTaskPluginRoute decode hook and native.error JSON", async () => {
  const store = new Store(createMemoryD1());
  const source = `
export const meta = {
  apiVersion: 1, key: "route-decode-detail-test", name: "Decode", version: "1.0.0",
  author: {name: "Test"}, models: ["detail-model"], fetchMode: "per_task",
  routes: [{method: "POST", path: "/vendor/jobs", type: "submit", decode: "createTask", render: "created"}],
};
export const native = {createTask: function() { throw new Error("model is required"); }, created: function(ctx, task) { return task; }};
${hooks}
`;
  const plugin = matchedFromSource(source, "/vendor/jobs");
  const requestContext = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/vendor/jobs",
    contentTypes: ["application/json"],
    contentLength: 16,
    body: new TextEncoder().encode(`{"prompt":"x"}`),
  });
  const prepared = await prepareTaskPluginRoute(store, 1, plugin, requestContext, "");
  assert.equal(prepared.kind, "response");
  if (prepared.kind !== "response") return;
  assert.equal(prepared.response.status, 400);
  assert.deepEqual(await prepared.response.json(), {
    code: "invalid_request",
    message: "model is required",
    data: null,
  });

  const withError = `
export const meta = {
  apiVersion: 1, key: "route-error-detail-test", name: "Error", version: "1.0.0",
  author: {name: "Test"}, models: ["detail-model"], fetchMode: "per_task",
  routes: [{method: "POST", path: "/vendor/jobs", type: "submit", decode: "createTask", render: "created"}],
};
export const native = {
  createTask: function() { throw new Error("model is required"); },
  created: function(ctx, task) { return task; },
  error: function(ctx, error) { return {code: error.code, message: error.message, requestId: error.requestId}; },
};
${hooks}
`;
  const errPlugin = matchedFromSource(withError, "/vendor/jobs");
  const native = await prepareTaskPluginRoute(store, 1, errPlugin, requestContext, "native-error-req");
  assert.equal(native.kind, "response");
  if (native.kind !== "response") return;
  assert.equal(native.response.status, 400);
  assert.deepEqual(await native.response.json(), {
    code: "invalid_request",
    message: "model is required",
    requestId: "native-error-req",
  });
});

test("original PrepareTaskPluginRoute rejects non-object decode with fixed message", async () => {
  const store = new Store(createMemoryD1());
  const source = `
export const meta = {
  apiVersion: 1, key: "route-result-object-test", name: "Result", version: "1.0.0",
  author: {name: "Test"}, models: ["detail-model"], fetchMode: "per_task",
  routes: [{method: "POST", path: "/vendor/jobs", type: "submit", decode: "createTask", render: "created"}],
};
export const native = {createTask: function() { return "not-an-object"; }, created: function(ctx, task) { return task; }};
${hooks}
`;
  const plugin = matchedFromSource(source, "/vendor/jobs");
  const requestContext = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/vendor/jobs",
    contentTypes: ["application/json"],
    contentLength: 26,
    body: new TextEncoder().encode(`{"model":"detail-model"}`),
  });
  const prepared = await prepareTaskPluginRoute(store, 1, plugin, requestContext, "");
  assert.equal(prepared.kind, "response");
  if (prepared.kind !== "response") return;
  const body = (await prepared.response.json()) as { code?: string; message?: string };
  assert.equal(prepared.response.status, 400);
  assert.equal(body.code, "invalid_request");
  assert.equal(body.message, TASK_PLUGIN_INVALID_ROUTE_RESULT);
});

test("original PrepareTaskPluginRoute model scope rejects before JS", async () => {
  const store = new Store(createMemoryD1());
  const source = `
export const meta = {
  apiVersion: 1, key: "route-model-scope-test", name: "Scoped", version: "1.0.0",
  author: {name: "Test"}, models: ["gpt-5.5", "gpt-5.6"], fetchMode: "per_task",
  routes: [{method: "POST", path: "/vendor/batch", type: "submit", models: ["gpt-5.5"], decode: "decodeBatch", render: "batchCreated"}],
};
export const native = {decodeBatch: function() { throw new Error("decoder must not run"); }, batchCreated: function(ctx, task) { return task; }};
${hooks}
`;
  const plugin = matchedFromSource(source, "/vendor/batch");
  for (const body of [`{"model":"gpt-5.6","input":"x"}`, `{"input":"x"}`, `{"model":7,"input":"x"}`]) {
    const requestContext = buildTaskPluginRouteRequestFromParts({
      method: "POST",
      path: "/vendor/batch",
      contentTypes: ["application/json"],
      contentLength: body.length,
      body: new TextEncoder().encode(body),
    });
    const prepared = await prepareTaskPluginRoute(store, 1, plugin, requestContext, "");
    assert.equal(prepared.kind, "response");
    if (prepared.kind !== "response") continue;
    assert.equal(prepared.response.status, 400);
    const jsonBody = (await prepared.response.json()) as { message?: string };
    assert.match(String(jsonBody.message), /is not allowed on this route/);
  }
});

test("original PrepareTaskPluginRoute canonical ctx + resolved submit JSON", async () => {
  const store = new Store(createMemoryD1());
  const source = `
export const meta = {
  apiVersion: 1, key: "route-submit-test", name: "Submit", version: "1.0.0",
  author: {name: "Test"}, models: ["resolved-model"], fetchMode: "per_task",
  routes: [{method: "POST", path: "/vendor/jobs/:category", type: "submit", action: "static-action", decode: "decodeJob", render: "jobCreated"}],
};
export const native = {
  decodeJob: function(ctx) {
    if (ctx.path !== "/vendor/jobs/video" || ctx.method !== "POST") throw new Error("bad path");
    if (ctx.params.category !== "video") throw new Error("bad params");
    if (ctx.query.tag.length !== 2 || ctx.query.tag[0] !== "first" || ctx.query.tag[1] !== "second") throw new Error("bad query");
    if (ctx.body.kind !== "json" || !Array.isArray(ctx.body.value) || ctx.body.value[0] !== "prompt") throw new Error("bad body");
    return {kind: "submit", model: "resolved-model", action: "resolved-action", requestBody: {prompt: "normalized"}};
  },
  jobCreated: function(ctx, task) { return task; },
};
${hooks}
`;
  const plugin = matchedFromSource(source, "/vendor/jobs/video");
  plugin.params = { category: "video" };
  const requestContext = buildTaskPluginRouteRequestFromParts({
    method: "POST",
    path: "/vendor/jobs/video",
    params: { category: "video" },
    query: "tag=first&tag=second",
    contentTypes: ["application/json"],
    contentLength: 12,
    body: new TextEncoder().encode(`["prompt",2]`),
  });
  const js = routeRequestJSValue(requestContext);
  assert.deepEqual((js.query as Record<string, string[]>).tag, ["first", "second"]);
  const prepared = await prepareTaskPluginRoute(store, 1, plugin, requestContext, "");
  assert.equal(prepared.kind, "submit");
  if (prepared.kind !== "submit") return;
  assert.equal(prepared.model, "resolved-model");
  assert.equal(prepared.action, "resolved-action");
  assert.deepEqual(prepared.requestBody, { prompt: "normalized" });
});

test("original host fallback request id JSON", async () => {
  const res = abortTaskPluginRouteErrorDetail(null, null, 400, "model is required", "req-fallback-1");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    code: "invalid_request",
    message: "model is required (request id: req-fallback-1)",
    data: null,
  });
});

test("original native plugin route HTTP JSON fields", async () => {
  const { e, sk, store, rootId } = await boot();
  const headers = { authorization: "Bearer " + sk, "content-type": "application/json" };

  const klingMissing = await json(
    new Request("http://local/kling/v1/videos/text2video", {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "a cat" }),
    }),
    e,
  );
  assert.equal(klingMissing.res.status, 400, klingMissing.text);
  assert.equal(klingMissing.body.code, "invalid_request");
  assert.equal(klingMissing.body.message, "model is required");

  const boundary = "----native-route-test";
  const multipart = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="caption"`,
    "",
    "hello",
    `--${boundary}`,
    `Content-Disposition: form-data; name="media"; filename="clip.bin"`,
    "Content-Type: application/octet-stream",
    "",
    "opaque-file",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const mp = await json(
    new Request("http://local/kling/v1/videos/text2video", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    }),
    e,
  );
  assert.equal(mp.res.status, 415, mp.text);
  assert.equal(mp.body.code, "invalid_request");
  assert.equal(mp.body.message, "this route requires a JSON body");

  const sunoEmpty = await json(
    new Request("http://local/suno/fetch", {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: [] }),
    }),
    e,
  );
  assert.equal(sunoEmpty.res.status, 200, sunoEmpty.text);
  assert.deepEqual(sunoEmpty.body, { code: "success", message: "", data: [] });

  await store.insertTask({
    task_id: "legacy-task",
    user_id: rootId,
    platform: "50",
    status: "SUCCESS",
    progress: "100%",
    data: JSON.stringify({ data: { task_id: "private-up" } }),
    private_data: JSON.stringify({ upstream_task_id: "private-up" }),
  });
  const klingGet = await json(
    new Request("http://local/kling/v1/videos/text2video/legacy-task", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(klingGet.res.status, 200, klingGet.text);
  assert.equal((klingGet.body.data as { task_id?: string } | undefined)?.task_id, "legacy-task");

  const missing = await json(
    new Request("http://local/kling/v1/videos/text2video/missing-task", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(missing.res.status, 404, missing.text);
  assert.equal(missing.body.code, "task_not_found");
  assert.equal(missing.body.message, "Task not found");
});
