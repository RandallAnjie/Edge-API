import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePlugin } from "../src/jsplugin.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { FACTORY_TASK_PLUGIN_SOURCES } from "../src/task-plugin-factory-data.js";
import { convertToOpenAIVideo, pluginClaimsOpenAIVideo } from "../src/task-plugin-video.js";
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
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "openai-video", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, sk };
}

const soraTaskData = {
  id: "upstream-task-id",
  task_id: "upstream-task-id",
  object: "provider-video",
  model: "provider-model",
  status: "completed",
  progress: 100,
  created_at: 10,
  completed_at: 20,
  url: "https://cdn.example/video.mp4",
  metadata: { url: "https://cdn.example/video.mp4", URL: "https://cdn.example/uppercase.mp4" },
  provider_payload: { task_id: "upstream-task-id", items: [{ enabled: false, count: 0, value: null }] },
  seconds: 8,
  resolution: "720p",
  aspect_ratio: "16:9",
  reference_images: ["https://cdn.example/reference.png"],
  error: { code: "provider_error", message: "provider rejected request", detail: { retryable: false } },
};

test("original ConvertToOpenAIVideo preserves sora provider JSON fields", () => {
  const source = FACTORY_TASK_PLUGIN_SOURCES.sora;
  assert.ok(source);
  const loaded = compilePlugin(source, { key: "sora", version: "1.0.0" });
  assert.equal(pluginClaimsOpenAIVideo((loaded.meta || {}) as Record<string, unknown>), true);

  for (const [status, want] of [
    ["IN_PROGRESS", "in_progress"],
    ["SUCCESS", "completed"],
    ["FAILURE", "failed"],
  ] as const) {
    const rendered = convertToOpenAIVideo(loaded.engine, {
      task_id: "task_public",
      status,
      progress: "42%",
      created_at: 100,
      finish_time: 200,
      properties: JSON.stringify({ origin_model_name: "origin-model" }),
      private_data: JSON.stringify({ upstream_task_id: "upstream-task-id" }),
      data: JSON.stringify(soraTaskData),
    });
    assert.equal(rendered.id, "task_public");
    assert.equal(Object.prototype.hasOwnProperty.call(rendered, "task_id"), false);
    assert.equal(rendered.object, "video");
    assert.equal(rendered.model, "origin-model");
    assert.equal(rendered.status, want);
    assert.equal(rendered.progress, 42);
    assert.equal(rendered.created_at, 100);
    if (status === "SUCCESS") assert.equal(rendered.completed_at, 200);
    else assert.equal(Object.prototype.hasOwnProperty.call(rendered, "completed_at"), false);
    assert.equal(rendered.url, "https://cdn.example/video.mp4");
    assert.deepEqual(rendered.metadata, {
      url: "https://cdn.example/video.mp4",
      URL: "https://cdn.example/uppercase.mp4",
    });
    assert.deepEqual(rendered.provider_payload, {
      task_id: "task_public",
      items: [{ enabled: false, count: 0, value: null }],
    });
    assert.equal(rendered.seconds, 8);
    assert.equal(rendered.resolution, "720p");
    assert.equal(rendered.aspect_ratio, "16:9");
    assert.deepEqual(rendered.reference_images, ["https://cdn.example/reference.png"]);
    assert.deepEqual(rendered.error, {
      code: "provider_error",
      message: "provider rejected request",
      detail: { retryable: false },
    });
  }
});

test("original ConvertToOpenAIVideo rejects non-object renderer JSON", () => {
  for (const value of ["null", "[]", `"video"`, "42", "false"]) {
    const source = `
export const meta = {apiVersion:1,key:"mock-task",name:"Mock Task",version:"1.0.0",author:{name:"Test"},models:["mock-v1"],fetchMode:"per_task",protocols:["openai_video"]};
export function buildSubmitRequest(){return {url:"https://provider.example"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
export const protocols = {openai_video: {decodeRequest: function(){return {kind:"submit",model:"mock-v1",requestBody:{}}}, render: function(){ return ${value}; }}};
`;
    const loaded = compilePlugin(source, { key: "mock-task", version: "1.0.0" });
    assert.throws(
      () => convertToOpenAIVideo(loaded.engine, { task_id: "task_public", status: "SUCCESS", progress: "100%" }),
      /plugin returned an invalid OpenAI video object/,
    );
  }
});

test("original /v1/videos/:task_id ConvertToOpenAIVideo HTTP JSON fields", async () => {
  const { e, sk } = await boot();
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  await store.insertTask({
    task_id: "task_public",
    user_id: Number(root?.id || 1),
    platform: "sora",
    status: "SUCCESS",
    progress: "42%",
    properties: { origin_model_name: "origin-model" },
    private_data: { upstream_task_id: "upstream-task-id" },
    data: soraTaskData,
    finish_time: 200,
  });
  const hit = await json(
    new Request("http://local/v1/videos/task_public", { headers: { authorization: "Bearer " + sk } }),
    e,
  );
  assert.equal(hit.res.status, 200, hit.text);
  assert.equal(hit.body.id, "task_public");
  assert.equal(Object.prototype.hasOwnProperty.call(hit.body, "task_id"), false);
  assert.equal(hit.body.object, "video");
  assert.equal(hit.body.model, "origin-model");
  assert.equal(hit.body.status, "completed");
  assert.equal(hit.body.progress, 42);
  assert.equal(hit.body.url, "https://cdn.example/video.mp4");
  assert.deepEqual(hit.body.provider_payload, {
    task_id: "task_public",
    items: [{ enabled: false, count: 0, value: null }],
  });
});
