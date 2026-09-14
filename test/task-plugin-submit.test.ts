import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_KLING } from "../src/constants.js";
import { compilePlugin } from "../src/jsplugin.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  buildNativeSubmitContext,
  buildNativeSubmitDescriptor,
  generateTaskID,
  parseNativeSubmitResponse,
  presentTaskSubmission,
  shouldRetryNativeTaskRelay,
} from "../src/task-plugin-submit.js";
import { BODY_JSON, loadCompiledPlugin } from "../src/task-plugin-route.js";
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
  const root = await store.getUserByUsername("root");
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "native-submit", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, rootId: Number(root?.id || 1), sk };
}

const presenterSource = `
export const meta = {apiVersion:1,key:"presenter-test",name:"Presenter",version:"1.0.0",author:{name:"Test"},models:["model"],fetchMode:"per_task",routes:[{method:"POST",path:"/vendor/jobs",type:"submit",decode:"decode",render:"created"}]};
export const native = {decode:function(ctx){return {kind:"submit",model:"model",requestBody:ctx.body.value};},created:function(ctx,task){return {data:{task_id:task.task_id},upstream:task.data};}};
export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(ctx, resp){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`;

test("original GenerateTaskID prefix JSON", () => {
  const id = generateTaskID();
  assert.match(id, /^task_[0-9a-zA-Z]{32}$/);
});

test("original presentTaskSubmission native presenter JSON fields", async () => {
  const loaded = compilePlugin(presenterSource, { key: "presenter-test", version: "1.0.0" });
  const res = presentTaskSubmission({
    engine: loaded.engine,
    requestContext: {
      path: "/vendor/jobs",
      method: "POST",
      params: {},
      query: {},
      body: { kind: BODY_JSON, value: { model: "model" } },
      files: [],
      requestBody: { model: "model" },
    },
    render: "created",
    taskRow: {
      task_id: "task_public",
      submit_time: 123,
      data: JSON.stringify({ task_id: "upstream_private" }),
      private_data: "{}",
    },
    originModelName: "model",
    otherRatios: { seconds: 5 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    data: { task_id: "task_public" },
    upstream: { task_id: "upstream_private" },
  });
  assert.equal(res.headers.get("X-New-Api-Other-Ratios"), JSON.stringify({ seconds: 5 }));
});

test("original presentTaskSubmission fallback uses persisted public ID JSON", async () => {
  const loaded = compilePlugin(presenterSource, { key: "presenter-test", version: "1.0.0" });
  const res = presentTaskSubmission({
    engine: loaded.engine,
    requestContext: {
      path: "/vendor/jobs",
      method: "POST",
      params: {},
      query: {},
      body: { kind: BODY_JSON, value: {} },
      files: [],
      requestBody: {},
    },
    render: "",
    taskRow: { task_id: "task_persisted", submit_time: 456 },
    originModelName: "video-model",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: "task_persisted",
    task_id: "task_persisted",
    status: "queued",
    model: "video-model",
    created_at: 456,
  });
  assert.equal(res.headers.get("X-New-Api-Other-Ratios"), "{}");
});

test("original parseSubmitResponse must not return clientResponse JSON", () => {
  const source = presenterSource.replace(
    `return {taskId:"upstream"}`,
    `return {taskId:"upstream", clientResponse: {id: ctx.publicTaskId}}`,
  );
  const loaded = compilePlugin(source, { key: "presenter-test", version: "1.0.0" });
  const parsed = parseNativeSubmitResponse(loaded.engine, { publicTaskId: "task_public" }, 200, {}, { id: "upstream" });
  assert.equal("statusCode" in parsed, true);
  if ("statusCode" in parsed) {
    assert.equal(parsed.code, "plugin_submit_response_invalid");
    assert.equal(parsed.message, "parseSubmitResponse must not return clientResponse");
    assert.equal(parsed.statusCode, 502);
    assert.equal(parsed.localError, true);
  }
});

test("original parseSubmitResponse empty taskId JSON", () => {
  const source = presenterSource.replace(`return {taskId:"upstream"}`, `return {taskId:""}`);
  const loaded = compilePlugin(source, { key: "presenter-test", version: "1.0.0" });
  const parsed = parseNativeSubmitResponse(loaded.engine, {}, 200, {}, {});
  assert.equal("statusCode" in parsed, true);
  if ("statusCode" in parsed) {
    assert.equal(parsed.message, "plugin returned an empty taskId");
    assert.equal(parsed.statusCode, 502);
  }
});

test("original buildSubmitRequest empty URL JSON", () => {
  const source = presenterSource.replace(
    `return {url:"https://provider.example/submit"}`,
    `return {url:""}`,
  );
  const loaded = compilePlugin(source, { key: "presenter-test", version: "1.0.0" });
  const descriptor = buildNativeSubmitDescriptor(loaded.engine, { baseUrl: "https://provider.example" }, "https://provider.example");
  assert.equal("statusCode" in descriptor, true);
  if ("statusCode" in descriptor) {
    assert.equal(parsedMessage(descriptor), "plugin returned an empty submit URL");
    assert.equal(descriptor.statusCode, 400);
  }
});

function parsedMessage(err: { message: string }): string {
  return err.message;
}

test("original buildSubmitRequest ValidateRequestURL host JSON", () => {
  const loaded = compilePlugin(presenterSource, { key: "presenter-test", version: "1.0.0" });
  const descriptor = buildNativeSubmitDescriptor(
    loaded.engine,
    { baseUrl: "https://other.example" },
    "https://channel.example",
  );
  assert.equal("statusCode" in descriptor, true);
  if ("statusCode" in descriptor) {
    assert.match(descriptor.message, /plugin request host .* is not allowed/);
    assert.equal(descriptor.statusCode, 400);
  }
});

test("original submitContext JSON fields for factory plugins", () => {
  const source = `
export const meta = {apiVersion:1,key:"ctx-test",name:"Ctx",version:"1.0.0",author:{name:"Test"},models:["alias"],fetchMode:"per_task"};
export function buildSubmitRequest(ctx) {
  return {url: ctx.baseUrl+"/submit", method:"POST", body:{upstreamModel: ctx.upstreamModel, model: ctx.model, prompt: ctx.requestBody.prompt, action: ctx.action, publicTaskId: ctx.publicTaskId, apiKey: ctx.apiKey}};
}
export function parseSubmitResponse(){return {taskId:"1"};}
export function buildQueryRequest(){return {url:"https://provider.example"};}
export function parseTaskResult(){return {status:"SUCCESS"};}
`;
  const loaded = compilePlugin(source, { key: "ctx-test", version: "1.0.0" });
  const req = new Request("http://local/vendor/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  const submitContext = buildNativeSubmitContext({
    engine: loaded.engine,
    requestContext: {
      path: "/vendor/jobs",
      method: "POST",
      params: {},
      query: {},
      body: { kind: BODY_JSON, value: { prompt: "p" } },
      files: [],
      requestBody: { prompt: "p" },
    },
    requestBody: { prompt: "p" },
    req,
    info: {
      originModelName: "alias",
      upstreamModelName: "declared-model",
      action: "text_to_video",
      publicTaskId: "task_public",
      apiKey: "sk-test",
      channelBaseUrl: "https://provider.example",
      channelId: 1,
      channelType: 1,
      usingGroup: "default",
    },
  });
  const descriptor = buildNativeSubmitDescriptor(loaded.engine, submitContext, "https://provider.example");
  assert.equal("statusCode" in descriptor, false);
  if (!("statusCode" in descriptor)) {
    assert.equal(descriptor.url, "https://provider.example/submit");
    assert.deepEqual(descriptor.body, {
      upstreamModel: "declared-model",
      model: "alias",
      prompt: "p",
      action: "text_to_video",
      publicTaskId: "task_public",
      apiKey: "sk-test",
    });
  }
});

test("original shouldRetryNativeTaskRelay 5xx JSON", () => {
  assert.equal(shouldRetryNativeTaskRelay({ code: "fail_to_fetch_task", message: "x", statusCode: 500, localError: false, noRetry: false }, 1, false), true);
  assert.equal(shouldRetryNativeTaskRelay({ code: "fail_to_fetch_task", message: "x", statusCode: 500, localError: false, noRetry: false }, 0, false), false);
  assert.equal(shouldRetryNativeTaskRelay({ code: "fail_to_fetch_task", message: "x", statusCode: 500, localError: false, noRetry: false }, 1, true), false);
  assert.equal(shouldRetryNativeTaskRelay({ code: "plugin_request_invalid", message: "x", statusCode: 400, localError: true, noRetry: false }, 1, false), false);
});

test("original kling native RelayTask submit JSON fields", async () => {
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
        name: "kling-native",
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

  const seen: { url: string; body: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url, body });
    return new Response(JSON.stringify({ code: 0, message: "", data: { task_id: "kling-private-1", task_status: "submitted" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/kling/v1/videos/text2video", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model_name: "kling-v1", prompt: "a lighthouse" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://kling.example.test/kling/v1/videos/text2video");
    assert.match(seen[0].body, /"model_name":"kling-v1"/);
    const data = hit.body.data as { task_id?: string } | undefined;
    assert.ok(data?.task_id?.startsWith("task_"), hit.text);
    assert.notEqual(data?.task_id, "kling-private-1");
    assert.equal(JSON.stringify(hit.body).includes("kling-private-1"), false, hit.text);
    assert.equal(hit.res.headers.get("X-New-Api-Other-Ratios"), "{}");

    const persisted = await store.getTaskByTid(String(data?.task_id));
    assert.ok(persisted, "persisted task");
    assert.equal(String(persisted?.platform), "kling");
    assert.equal(String(persisted?.status), "NOT_START");
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as { upstream_task_id?: string };
    assert.equal(priv.upstream_task_id, "kling-private-1");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("loadCompiledPlugin still compiles presenter-test", () => {
  const loaded = loadCompiledPlugin(presenterSource, "presenter-test", "1.0.0");
  assert.equal(loaded.engine.hasCallablePath("buildSubmitRequest"), true);
});
