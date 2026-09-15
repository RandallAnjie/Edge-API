import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_KLING } from "../src/constants.js";
import { compilePlugin } from "../src/jsplugin.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  lookupHostProtocolOperation,
  lookupEndpointCandidates,
} from "../src/plugin-dispatch.js";
import {
  BODY_JSON,
  protocolRequestJSValue,
} from "../src/task-plugin-route.js";
import { pinEndpointModel } from "../src/task-plugin-endpoint.js";
import { validateFinalProtocolDecoder } from "../src/task-plugin-submit.js";
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
      body: JSON.stringify({ name: "protocol-create", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

function protocolVideoPluginSource(key: string, decodeBody: string): string {
  return `
export const meta = {apiVersion:1,key:${JSON.stringify(key)},name:"Mock Video",version:"1.0.0",author:{name:"Test"},models:["mock-v1"],fetchMode:"per_task",protocols:["openai_video"]};
export function buildSubmitRequest(){return {url:"https://provider.example/submit"}}
export function parseSubmitResponse(ctx, resp){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
export function listArtifacts(){return [];}
export function buildContentRequest(){ throw new Error("artifact_not_found"); }
export const protocols = {openai_video: {
  decodeRequest: function(ctx) { ${decodeBody} },
  render: function(){ return {id: "plugin"}; }
}};
`;
}

test("original ProtocolRequestContext JSValue JSON fields", () => {
  const js = protocolRequestJSValue({
    path: "/v1/videos",
    method: "POST",
    params: {},
    query: { tag: ["first", "second"] },
    body: { kind: BODY_JSON, value: { model: "kling-v1", prompt: "a cat" } },
    files: [],
    requestBody: { secret: true },
    protocol: "openai_video",
    operation: "create",
    model: "kling-v1",
    stream: false,
  });
  assert.equal(js.protocol, "openai_video");
  assert.equal(js.operation, "create");
  assert.equal(js.model, "kling-v1");
  assert.equal(js.stream, false);
  assert.equal("requestBody" in js, false);
  assert.equal("upstreamModel" in js, false);
  assert.equal("files" in js, false);
  assert.deepEqual(js.body, { kind: BODY_JSON, value: { model: "kling-v1", prompt: "a cat" } });
  assert.deepEqual(js.query, { tag: ["first", "second"] });
  const mapped = protocolRequestJSValue({
    path: "/v1/videos",
    method: "POST",
    params: {},
    query: {},
    body: { kind: BODY_JSON, value: {} },
    files: [],
    requestBody: {},
    protocol: "openai_video",
    operation: "create",
    model: "alias",
    upstreamModel: "kling-v1",
    stream: true,
  });
  assert.equal(mapped.upstreamModel, "kling-v1");
  assert.equal(mapped.stream, true);
});

test("original LookupHostProtocolOperation JSON fields", () => {
  const create = lookupHostProtocolOperation("POST", "/v1/videos");
  assert.ok(create);
  assert.equal(create?.protocol, "openai_video");
  assert.equal(create?.operation, "create");
  assert.deepEqual(create?.bodyKinds, ["json", "multipart"]);
  assert.equal(create?.modelField, "model");
  assert.equal(lookupHostProtocolOperation("POST", "/v1/video/generations"), null);
  assert.equal(lookupHostProtocolOperation("GET", "/v1/videos/task_public"), null);
  assert.equal(lookupHostProtocolOperation("POST", "/v1/responses")?.protocol, "openai_responses");
});

test("original pinEndpointModel invalid JSON is protocol request error", async () => {
  const pinned = await pinEndpointModel(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  );
  assert.deepEqual(pinned, { error: "Invalid task protocol request" });
});

test("original ValidateRequestAndSetAction rejects decoder renderer JSON", () => {
  const source = protocolVideoPluginSource(
    "renderer-reject",
    `return {kind:"submit",model:ctx.model,requestBody:ctx.body.value,renderer:"legacy"};`,
  );
  const loaded = compilePlugin(source, { key: "renderer-reject", version: "1.0.0" });
  const rejected = validateFinalProtocolDecoder(loaded.engine, "openai_video", "mock-v1", {
    path: "/v1/videos",
    method: "POST",
    params: {},
    query: {},
    body: { kind: BODY_JSON, value: { model: "mock-v1" } },
    files: [],
    requestBody: { model: "mock-v1" },
    protocol: "openai_video",
    operation: "create",
    model: "mock-v1",
    stream: false,
  });
  assert.equal("statusCode" in rejected, true);
  assert.equal((rejected as { code: string }).code, "plugin_request_invalid");
  assert.match((rejected as { message: string }).message, /must not return renderer/);
});

test("original PrepareTaskPluginEndpoint decode JSON fields", async () => {
  const { e, auth, store, sk } = await boot();
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: protocolVideoPluginSource("endpoint-drift-test", `return {kind:"submit",model:"outside-model",requestBody:ctx.body.value};`),
      }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const candidates = await lookupEndpointCandidates(store, "POST", "/v1/videos", "mock-v1");
  assert.ok(candidates.some((item) => item.plugin.key === "endpoint-drift-test"));

  const drift = await json(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-v1", prompt: "hello" }),
    }),
    e,
  );
  assert.equal(drift.res.status, 400, drift.text);
  const err = drift.body.error as { message?: string; type?: string; code?: string };
  assert.ok(err, drift.text);
  assert.equal(err.type, "new_api_error");
  assert.match(String(err.message), /model "outside-model" is not served by this plugin/);

  const form = await json(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/x-www-form-urlencoded" },
      body: "model=mock-v1&prompt=hello",
    }),
    e,
  );
  assert.equal(form.res.status, 415, form.text);
  assert.match(String((form.body.error as { message?: string }).message), /unsupported request body for this operation/);

  const thrown = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: protocolVideoPluginSource("endpoint-decode-detail-test", `throw new Error("model is required");`),
      }),
    }),
    e,
  );
  assert.equal(thrown.body.success, true, String(thrown.body.message));
  const detail = await json(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-v1" }),
    }),
    e,
  );
  assert.equal(detail.res.status, 400, detail.text);
  assert.match(String((detail.body.error as { message?: string }).message), /model is required/);
  assert.equal(String(detail.text).includes("Invalid task protocol request"), false);

  const malformed = await json(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: "{",
    }),
    e,
  );
  assert.equal(malformed.res.status, 400, malformed.text);
  assert.match(String((malformed.body.error as { message?: string }).message), /Invalid task protocol request/);
});

test("original openai_video create POST /v1/videos kling ToOpenAIVideo JSON", async () => {
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
        name: "kling-video-create",
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
      new Request("http://local/v1/videos", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "kling-v1", prompt: "a lighthouse" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://kling.example.test/kling/v1/videos/text2video");
    assert.equal(hit.body.object, "video");
    assert.equal(hit.body.status, "queued");
    assert.equal(hit.body.model, "kling-v1");
    assert.equal(hit.body.progress, 0);
    assert.equal(typeof hit.body.created_at, "number");
    assert.match(String(hit.body.id), /^task_[0-9a-zA-Z]{32}$/);
    assert.equal("task_id" in hit.body, false);
    assert.equal(JSON.stringify(hit.body).includes("kling-private-1"), false, hit.text);
    assert.equal(hit.res.headers.get("X-New-Api-Other-Ratios"), "{}");

    const persisted = await store.getTaskByTid(String(hit.body.id));
    assert.ok(persisted, "persisted task");
    assert.equal(String(persisted?.platform), "kling");
    const priv = JSON.parse(String(persisted?.private_data || "{}")) as { upstream_task_id?: string };
    assert.equal(priv.upstream_task_id, "kling-private-1");

    seen.length = 0;
    const generations = await json(
      new Request("http://local/v1/video/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "kling-v1", prompt: "a lighthouse" }),
      }),
      e,
    );
    assert.equal(
      seen.some((item) => item.url === "https://kling.example.test/kling/v1/videos/text2video"),
      false,
      generations.text,
    );
    assert.notEqual(generations.body.object, "video");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original unclaimed POST /v1/videos stays on ordinary relay JSON", async () => {
  const { e, sk } = await boot();
  const hit = await json(
    new Request("http://local/v1/videos", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", prompt: "a lighthouse" }),
    }),
    e,
  );
  assert.notEqual(hit.body.object, "video");
  assert.ok(hit.res.status >= 400, hit.text);
});
