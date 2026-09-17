import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_KLING } from "../src/constants.js";
import { compilePlugin } from "../src/jsplugin.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  applyNativePollToTask,
  buildNativeQueryContext,
  buildNativeQueryDescriptor,
  buildProxyURL,
  classifyPollHTTP,
  getUpstreamTaskID,
  hookHTTPResponse,
  isNativeQueryError,
  isNonTerminalPollStatus,
  knownPollStatus,
  normalizeTaskAction,
  parseNativeTaskResult,
  PROGRESS_COMPLETE,
  PROGRESS_IN_PROGRESS,
  TASK_STATUS_FAILURE,
  TASK_STATUS_IN_PROGRESS,
  TASK_STATUS_SUCCESS,
} from "../src/task-plugin-query.js";
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
      body: JSON.stringify({ name: "native-query", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

const querySource = `
export const meta = {apiVersion:1,key:"query-ctx",name:"Query Ctx",version:"1.0.0",author:{name:"Test"},models:["alias"],fetchMode:"per_task"};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit"}}
export function parseSubmitResponse(){return {taskId:"1",state:{req_key:"from-submit"}}}
export function buildQueryRequest(ctx){
  return {url:ctx.baseUrl+"/query",method:"POST",body:{
    keys: Object.keys(ctx).sort(),
    taskId: ctx.taskId,
    publicTaskId: ctx.publicTaskId,
    action: ctx.action,
    model: ctx.model,
    upstreamModel: ctx.upstreamModel,
    data: ctx.data,
    state: ctx.state,
    hasRequestBody: Object.prototype.hasOwnProperty.call(ctx, "requestBody")
  }};
}
export function parseTaskResult(ctx, body, response){
  return {status:"IN_PROGRESS",reason:String(response && response.status),url:ctx.taskId,state:{round:"poll"}};
}
`;

test("original NormalizeTaskAction and GetUpstreamTaskID JSON", () => {
  assert.equal(normalizeTaskAction("generate"), "image_to_video");
  assert.equal(normalizeTaskAction("textGenerate"), "text_to_video");
  assert.equal(normalizeTaskAction("text_to_video"), "text_to_video");
  assert.equal(getUpstreamTaskID({ task_id: "task_public", private_data: JSON.stringify({ upstream_task_id: "upstream-1" }) }), "upstream-1");
  assert.equal(getUpstreamTaskID({ task_id: "task_public", private_data: "{}" }), "task_public");
});

test("original queryContext JSON fields omit requestBody", async () => {
  const loaded = compilePlugin(querySource, { key: "query-ctx", version: "1.0.0" });
  const queryContext = await buildNativeQueryContext(
    loaded.engine,
    {
      task_id: "task_public",
      action: "generate",
      properties: JSON.stringify({ origin_model_name: "alias", upstream_model_name: "declared" }),
      data: JSON.stringify({ snapshot: true }),
      private_data: JSON.stringify({ upstream_task_id: "upstream-1", plugin_state: { req_key: "kept" } }),
    },
    "secret",
    "https://provider.example",
  );
  assert.equal(isNativeQueryError(queryContext), false);
  if (isNativeQueryError(queryContext)) return;
  assert.equal(queryContext.taskId, "upstream-1");
  assert.equal(queryContext.publicTaskId, "task_public");
  assert.equal(queryContext.action, "image_to_video");
  assert.equal(queryContext.model, "alias");
  assert.equal(queryContext.upstreamModel, "declared");
  assert.deepEqual(queryContext.data, { snapshot: true });
  assert.deepEqual(queryContext.state, { req_key: "kept" });
  assert.equal(Object.prototype.hasOwnProperty.call(queryContext, "requestBody"), false);
  assert.deepEqual(queryContext.auth, { authHeader: "secret" });
  assert.equal(queryContext.apiKey, "secret");

  const descriptor = buildNativeQueryDescriptor(loaded.engine, queryContext, "https://provider.example");
  assert.equal(isNativeQueryError(descriptor), false);
  if (isNativeQueryError(descriptor)) return;
  assert.equal(descriptor.url, "https://provider.example/query");
  assert.equal(descriptor.method, "POST");
  const body = descriptor.body as Record<string, unknown>;
  assert.equal(body.hasRequestBody, false);
  assert.ok(Array.isArray(body.keys));
  assert.equal((body.keys as string[]).includes("requestBody"), false);
});

test("original FetchTask queryContext model identities JSON", async () => {
  const source = `
export const meta = {apiVersion:1,key:"query-model",name:"Query Model",version:"1.0.0",author:{name:"Test"},models:["alias"],fetchMode:"per_task"};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/submit"}}
export function parseSubmitResponse(){return {taskId:"1"}}
export function buildQueryRequest(ctx){return {url:ctx.baseUrl+"/tasks/"+ctx.model+"/"+ctx.upstreamModel+"/"+ctx.taskId,method:"GET"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`;
  const loaded = compilePlugin(source, { key: "query-model", version: "1.0.0" });
  const mapped = await buildNativeQueryContext(
    loaded.engine,
    {
      task_id: "task_public",
      properties: JSON.stringify({ origin_model_name: "alias", upstream_model_name: "declared-model" }),
      private_data: JSON.stringify({ upstream_task_id: "t1" }),
    },
    "secret",
    "https://provider.example",
  );
  assert.equal(isNativeQueryError(mapped), false);
  if (isNativeQueryError(mapped)) return;
  const mappedDesc = buildNativeQueryDescriptor(loaded.engine, mapped, "https://provider.example");
  assert.equal(isNativeQueryError(mappedDesc), false);
  if (isNativeQueryError(mappedDesc)) return;
  assert.equal(mappedDesc.url, "https://provider.example/tasks/alias/declared-model/t1");

  const unmapped = await buildNativeQueryContext(
    loaded.engine,
    {
      task_id: "task_public",
      properties: JSON.stringify({ origin_model_name: "alias" }),
      private_data: JSON.stringify({ upstream_task_id: "t1" }),
    },
    "secret",
    "https://provider.example",
  );
  assert.equal(isNativeQueryError(unmapped), false);
  if (isNativeQueryError(unmapped)) return;
  const unmappedDesc = buildNativeQueryDescriptor(loaded.engine, unmapped, "https://provider.example");
  assert.equal(isNativeQueryError(unmappedDesc), false);
  if (isNativeQueryError(unmappedDesc)) return;
  assert.equal(unmappedDesc.url, "https://provider.example/tasks/alias/alias/t1");
});

function queryContextOrThrow(value: Awaited<ReturnType<typeof buildNativeQueryContext>>): Record<string, unknown> {
  if (isNativeQueryError(value)) throw new Error(value.message);
  return value;
}

test("original parseTaskResult hookHTTPResponse and plugin state JSON", async () => {
  const loaded = compilePlugin(querySource, { key: "query-ctx", version: "1.0.0" });
  const queryContext = queryContextOrThrow(
    await buildNativeQueryContext(
      loaded.engine,
      {
        task_id: "task_public",
        action: "image_to_video",
        properties: JSON.stringify({ origin_model_name: "alias", upstream_model_name: "declared" }),
        data: JSON.stringify({ snapshot: true }),
        private_data: JSON.stringify({ upstream_task_id: "upstream-1", plugin_state: { req_key: "kept" } }),
      },
      "secret",
      "https://provider.example",
    ),
  );
  const parsed = parseNativeTaskResult(loaded.engine, queryContext, 418, {}, { ok: true });
  assert.equal(isNativeQueryError(parsed), false);
  if (isNativeQueryError(parsed)) return;
  assert.equal(parsed.status, "IN_PROGRESS");
  assert.equal(parsed.reason, "418");
  assert.equal(parsed.url, "upstream-1");
  assert.deepEqual(parsed.pluginState, { round: "poll" });
  assert.deepEqual(hookHTTPResponse(418, { "content-type": "application/json" }), {
    status: 418,
    headers: { "content-type": "application/json" },
  });
});

test("original updateVideoSingleTask poll apply JSON fields", () => {
  const applied = applyNativePollToTask(
    {
      task_id: "task_public",
      status: "NOT_START",
      progress: "0%",
      private_data: JSON.stringify({ upstream_task_id: "upstream-1" }),
    },
    {
      code: 0,
      taskId: "upstream-1",
      status: TASK_STATUS_SUCCESS,
      progress: "",
      reason: "",
      url: "https://cdn.example/video.mp4",
      remoteUrl: "",
      completionTokens: 0,
      totalTokens: 0,
      pluginState: { round: "poll" },
    },
    { code: 0, data: { task_id: "upstream-1", task_status: "succeed" } },
    "https://new-api.example",
    1700000000,
  );
  assert.equal(applied.status, TASK_STATUS_SUCCESS);
  assert.equal(applied.progress, PROGRESS_COMPLETE);
  assert.equal(applied.finish_time, 1700000000);
  const privateData = JSON.parse(String(applied.private_data)) as { result_url?: string; plugin_state?: unknown };
  assert.equal(privateData.result_url, "https://cdn.example/video.mp4");
  assert.deepEqual(privateData.plugin_state, { round: "poll" });
  assert.equal(JSON.parse(String(applied.data)).data.task_id, "upstream-1");

  const dataUri = applyNativePollToTask(
    { task_id: "task_public", status: "IN_PROGRESS", private_data: "{}" },
    {
      code: 0,
      taskId: "up",
      status: TASK_STATUS_SUCCESS,
      progress: "",
      reason: "",
      url: "data:video/mp4;base64,AAAA",
      remoteUrl: "",
      completionTokens: 0,
      totalTokens: 0,
    },
    {},
    "https://new-api.example",
    1,
  );
  assert.equal(JSON.parse(String(dataUri.private_data)).result_url, "https://new-api.example/v1/videos/task_public/content");
  assert.equal(buildProxyURL("task_public", "https://new-api.example"), "https://new-api.example/v1/videos/task_public/content");

  const failed = applyNativePollToTask(
    { task_id: "task_public", status: "IN_PROGRESS", private_data: "{}" },
    {
      code: 0,
      taskId: "up",
      status: TASK_STATUS_FAILURE,
      progress: "",
      reason: "provider rejected",
      url: "",
      remoteUrl: "",
      completionTokens: 0,
      totalTokens: 0,
    },
    {},
    "",
    2,
  );
  assert.equal(failed.status, TASK_STATUS_FAILURE);
  assert.equal(failed.fail_reason, "provider rejected");
  assert.equal(failed.progress, PROGRESS_COMPLETE);

  const inProgress = applyNativePollToTask(
    { task_id: "task_public", status: "NOT_START", start_time: 0, private_data: "{}" },
    {
      code: 0,
      taskId: "up",
      status: TASK_STATUS_IN_PROGRESS,
      progress: "",
      reason: "",
      url: "",
      remoteUrl: "",
      completionTokens: 0,
      totalTokens: 0,
    },
    {},
    "",
    3,
  );
  assert.equal(inProgress.status, TASK_STATUS_IN_PROGRESS);
  assert.equal(inProgress.progress, PROGRESS_IN_PROGRESS);
  assert.equal(inProgress.start_time, 3);
});

test("original classifyPollHTTP and knownPollStatus JSON", () => {
  assert.equal(classifyPollHTTP(200), "ok");
  assert.equal(classifyPollHTTP(404), "not_found");
  assert.equal(classifyPollHTTP(401), "auth");
  assert.equal(classifyPollHTTP(429), "transient");
  assert.equal(classifyPollHTTP(418), "other_client");
  assert.equal(knownPollStatus(TASK_STATUS_SUCCESS), true);
  assert.equal(knownPollStatus("UNKNOWN"), false);
  assert.equal(isNonTerminalPollStatus("NOT_START"), true);
  assert.equal(isNonTerminalPollStatus(TASK_STATUS_SUCCESS), false);
});

test("original kling native query poll JSON fields", async () => {
  const { e, auth, store, sk } = await boot();
  const priced = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ "kling-v1": 1 }) }),
    }),
    e,
  );
  assert.equal(priced.body.success, true, String(priced.body.message));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "kling-query",
        type: CHANNEL_TYPE_KLING,
        key: "sk-test",
        models: "kling-v1",
        group: "default",
        base_url: "https://kling.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "POST") {
      return new Response(JSON.stringify({ code: 0, message: "", data: { task_id: "kling-private-1", task_status: "submitted" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        code: 0,
        message: "",
        data: {
          task_id: "kling-private-1",
          task_status: "succeed",
          task_status_msg: "",
          task_result: { videos: [{ url: "https://cdn.example/kling.mp4" }] },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const created = await json(
      new Request("http://local/kling/v1/videos/text2video", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model_name: "kling-v1", prompt: "a lighthouse" }),
      }),
      e,
    );
    assert.equal(created.res.status, 200, created.text);
    const publicId = (created.body.data as { task_id?: string } | undefined)?.task_id;
    assert.ok(publicId?.startsWith("task_"), created.text);

    const hit = await json(
      new Request("http://local/kling/v1/videos/text2video/" + publicId, {
        headers: { authorization: "Bearer " + sk },
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.ok(seen.some((url) => url === "https://kling.example.test/kling/v1/videos/text2video/kling-private-1"), JSON.stringify(seen));
    const data = hit.body.data as { task_id?: string; task_status?: string } | undefined;
    assert.equal(data?.task_id, publicId, hit.text);
    assert.equal(data?.task_status, "succeed", hit.text);
    assert.equal(JSON.stringify(hit.body).includes("kling-private-1"), false, hit.text);

    const persisted = await store.getTaskByTid(String(publicId));
    assert.equal(String(persisted?.status), TASK_STATUS_SUCCESS);
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as { result_url?: string; upstream_task_id?: string };
    assert.equal(priv.upstream_task_id, "kling-private-1");
    assert.equal(priv.result_url, "https://cdn.example/kling.mp4");
  } finally {
    globalThis.fetch = origFetch;
  }
});
