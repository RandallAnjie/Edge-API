import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  decodePluginProtocolEventResult,
  PluginResponsesMachine,
} from "../src/task-plugin-protocol.js";
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
      body: JSON.stringify({ name: "protocol-responses", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

function protocolResponsesPluginSource(key: string, supports = `["stream","sync","background"]`): string {
  return `
export const meta = {apiVersion:1,key:${JSON.stringify(key)},name:"Mock Responses",version:"1.0.0",author:{name:"Test"},models:["resp-v1"],fetchMode:"per_task",protocols:[{name:"openai_responses",supports:${supports}}],channelTypes:[${CHANNEL_TYPE_OPENAI}]};
export function buildSubmitRequest(){return {url:"https://provider.example/submit",method:"POST",body:{}}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://provider.example/query"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
export const protocols = {openai_responses: {
  decodeRequest: function(ctx) {
    var value = ctx.body && ctx.body.value && typeof ctx.body.value === "object" ? ctx.body.value : {};
    return {kind:"submit", model: ctx.model, requestBody: value};
  },
  ${supports.includes("stream") ? `renderEvents: function(ctx, task) {
    var status = String(task.status||"").toUpperCase();
    if (status === "SUCCESS") return {events:[{type:"output",data:"done"}], state:{status:status}, done:true};
    if (status === "FAILURE") return {events:[{type:"error",message:"task failed"}], state:{status:status}, done:true};
    return {events:[{type:"progress",progress:10,message:"queued"}], state:{status:status}, done:false};
  },` : ""}
  renderFinal: function() {
    return {
      id: "plugin-controlled-id",
      status: "plugin-controlled-status",
      metadata: {plugin_field: "kept", task_id: "plugin-controlled-task"},
      output: [{
        id: "plugin-controlled-item",
        type: "message",
        status: "plugin-controlled-item-status",
        role: "assistant",
        content: [{
          id: "plugin-controlled-content",
          type: "output_text",
          text: "plugin-semantic-result",
          annotations: [],
          logprobs: []
        }]
      }],
      custom_field: "kept"
    };
  }
}};
`;
}

test("original PluginResponsesMachine PendingResponse JSON fields", () => {
  const cases = [
    { taskStatus: "SUBMITTED", wantStatus: "queued", background: false },
    { taskStatus: "NOT_START", wantStatus: "queued", background: false },
    { taskStatus: "IN_PROGRESS", wantStatus: "in_progress", background: false },
    { taskStatus: "QUEUED", wantStatus: "queued", background: true },
    { taskStatus: "SUCCESS", wantStatus: "in_progress", background: false },
  ];
  for (const testCase of cases) {
    const machine = new PluginResponsesMachine("task_pending", "video-model", 1_710_000_000);
    machine.setBackground(testCase.background);
    const response = machine.pendingResponse(testCase.taskStatus);
    assert.equal(response.id, "resp_pending");
    assert.equal(response.object, "response");
    assert.equal(response.created_at, 1_710_000_000);
    assert.equal(response.status, testCase.wantStatus);
    assert.equal(response.background, testCase.background);
    assert.equal(response.completed_at, null);
    assert.equal(response.error, null);
    assert.equal(response.incomplete_details, null);
    assert.equal(response.model, "video-model");
    assert.deepEqual(response.output, []);
    assert.equal(response.usage, null);
    assert.deepEqual(response.metadata, {
      task_id: "task_pending",
      task_status: testCase.wantStatus,
      retrieval_path: "/v1/responses/resp_pending",
    });
    const encoded = JSON.stringify(response);
    assert.equal(encoded.includes('"completed_at":null'), true);
    assert.equal(encoded.includes('"output":[]'), true);
    assert.equal(encoded.includes('"usage":null'), true);
  }
});

test("original PluginResponsesMachine FinalResponse host overwrite JSON", () => {
  const machine = new PluginResponsesMachine("task_final", "model", 99);
  const response = machine.finalResponse(
    {
      id: "plugin-controlled-id",
      object: "plugin-controlled-object",
      created_at: -1,
      status: "plugin-controlled-status",
      model: "plugin-controlled-model",
      error: { message: "plugin-controlled-error" },
      metadata: { plugin_field: "kept", task_id: "plugin-controlled-task" },
      output: [
        {
          id: "plugin-controlled-item",
          type: "message",
          status: "plugin-controlled-item-status",
          role: "assistant",
          content: [
            {
              id: "plugin-controlled-content",
              type: "output_text",
              text: "hello",
              annotations: [],
              logprobs: [],
            },
          ],
        },
      ],
      custom_field: { kept: true },
    },
    "SUCCESS",
  );
  assert.equal(response.id, "resp_final");
  assert.equal(response.object, "response");
  assert.equal(response.created_at, 99);
  assert.equal(response.status, "completed");
  assert.equal(response.model, "model");
  assert.equal(response.error, null);
  assert.equal(response.incomplete_details, null);
  assert.equal(response.instructions, null);
  assert.equal(response.parallel_tool_calls, true);
  assert.equal(response.temperature, 1);
  assert.equal(response.tool_choice, "auto");
  assert.deepEqual(response.tools, []);
  assert.equal(response.top_p, 1);
  assert.deepEqual(response.custom_field, { kept: true });
  const metadata = response.metadata as Record<string, string>;
  assert.equal(metadata.plugin_field, "kept");
  assert.equal(metadata.task_id, "task_final");
  assert.equal(metadata.task_status, "completed");
  const output = response.output as Record<string, unknown>[];
  assert.equal(output.length, 1);
  assert.equal(output[0].id, "item_task_final_0");
  assert.equal(output[0].status, "completed");
  const content = output[0].content as Record<string, unknown>[];
  assert.equal(content[0].id, "content_task_final_0_0");
  assert.equal(content[0].text, "hello");
});

test("original PluginResponsesMachine failed FinalResponse is generic", () => {
  const machine = new PluginResponsesMachine("task_failed", "model", 99);
  const response = machine.finalResponse({ secret: "ignored" }, "FAILURE");
  assert.equal(response.status, "failed");
  assert.deepEqual(response.output, []);
  const err = response.error as { code?: string; message?: string };
  assert.equal(err.code, "server_error");
  assert.equal(JSON.stringify(response).includes("secret"), false);
});

test("original DecodePluginProtocolEventResult rejects unknown fields", () => {
  assert.throws(() => decodePluginProtocolEventResult({ events: [], done: true, extra: true }), /unknown field "extra"/);
  const result = decodePluginProtocolEventResult({ events: [{ type: "progress", progress: 40 }], done: false });
  assert.equal(result.done, false);
  assert.equal(result.events[0].type, "progress");
  assert.equal(result.events[0].progress, 40);
});

test("original PluginResponsesMachine TimeoutResponse stays queued", () => {
  const machine = new PluginResponsesMachine("task_wait", "model", 99);
  const response = machine.timeoutResponse("QUEUED");
  assert.equal(response.status, "queued");
  assert.equal(response.error, null);
  assert.equal(response.incomplete_details, null);
  assert.equal(response.metadata.task_status, "queued");
  assert.equal(response.metadata.retrieval_path, "/v1/responses/resp_wait");
});

async function registerResponsesPlugin(e: Env, auth: Record<string, string>, source: string) {
  const registered = await json(
    new Request("http://local/api/plugin/task", { method: "POST", headers: auth, body: JSON.stringify({ source }) }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
}

async function priceAndChannel(e: Env, auth: Record<string, string>, name: string) {
  const priced = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelPrice", value: JSON.stringify({ "resp-v1": 0 }) }),
    }),
    e,
  );
  assert.equal(priced.body.success, true, String(priced.body.message));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "resp-v1",
        group: "default",
        base_url: "https://provider.example",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
}

test("original openai_responses create POST /v1/responses sync host envelope JSON", async () => {
  const { e, auth, sk } = await boot();
  await registerResponsesPlugin(e, auth, protocolResponsesPluginSource("endpoint-responses-sync"));
  await priceAndChannel(e, auth, "responses-sync");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ task_id: "upstream" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "resp-v1", input: "hello" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.notEqual(hit.res.headers.get("content-type"), "text/event-stream");
    assert.equal(hit.body.object, "response");
    assert.equal(hit.body.status, "completed");
    assert.equal(hit.body.model, "resp-v1");
    assert.match(String(hit.body.id), /^resp_/);
    assert.equal((hit.body.metadata as { task_id?: string }).task_id, String(hit.body.id).replace(/^resp_/, "task_"));
    assert.equal((hit.body.metadata as { plugin_field?: string }).plugin_field, "kept");
    const output = hit.body.output as { id?: string; status?: string; content?: { id?: string; text?: string }[] }[];
    assert.equal(output.length, 1);
    assert.match(String(output[0].id), /^item_task_/);
    assert.equal(output[0].status, "completed");
    assert.equal(output[0].content?.[0].text, "plugin-semantic-result");
    assert.match(String(output[0].content?.[0].id), /^content_task_/);
    assert.equal(hit.text.includes("plugin-controlled-id"), false);
    assert.equal(hit.body.custom_field, "kept");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original openai_responses background non-stream PendingResponse JSON", async () => {
  const { e, auth, sk } = await boot();
  await registerResponsesPlugin(e, auth, protocolResponsesPluginSource("endpoint-responses-bg"));
  await priceAndChannel(e, auth, "responses-bg");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ task_id: "upstream" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "resp-v1", input: "hello", background: true }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(hit.body.object, "response");
    assert.equal(hit.body.background, true);
    assert.ok(hit.body.status === "queued" || hit.body.status === "in_progress", String(hit.body.status));
    assert.deepEqual(hit.body.output, []);
    assert.equal(hit.body.usage, null);
    assert.equal(hit.body.completed_at, null);
    assert.match(String((hit.body.metadata as { retrieval_path?: string }).retrieval_path), /^\/v1\/responses\/resp_/);

    const retrieved = await json(
      new Request("http://local" + String((hit.body.metadata as { retrieval_path?: string }).retrieval_path), {
        headers: { authorization: "Bearer " + sk },
      }),
      e,
    );
    assert.equal(retrieved.res.status, 200, retrieved.text);
    assert.equal(retrieved.body.object, "response");
    assert.equal(retrieved.body.status, "completed");
    assert.equal(retrieved.body.id, hit.body.id);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original openai_responses stream create SSE host framing JSON", async () => {
  const { e, auth, sk } = await boot();
  await registerResponsesPlugin(e, auth, protocolResponsesPluginSource("endpoint-responses-stream"));
  await priceAndChannel(e, auth, "responses-stream");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ task_id: "upstream" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const res = await handleFetch(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "resp-v1", input: "hello", stream: true }),
      }),
      e,
      ctx(),
    );
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.match(text, /event: response.created/);
    assert.match(text, /event: response.completed/);
    assert.equal(text.includes("plugin-controlled-id"), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original PinTaskPluginEndpoint rejects unsupported stream form JSON", async () => {
  const { e, auth, sk } = await boot();
  await registerResponsesPlugin(e, auth, protocolResponsesPluginSource("endpoint-responses-sync-only", `["sync"]`));
  await priceAndChannel(e, auth, "responses-sync-only");
  const hit = await json(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "resp-v1", input: "hello", stream: true }),
    }),
    e,
  );
  assert.equal(hit.res.status, 400, hit.text);
  assert.equal((hit.body.error as { type?: string }).type, "new_api_error");
  assert.match(String((hit.body.error as { message?: string }).message), /Streaming is not supported for this model\. Set "stream": false\./);
});

test("original unclaimed POST /v1/responses stays on ordinary relay JSON", async () => {
  const { e, sk } = await boot();
  const hit = await json(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", input: "hello" }),
    }),
    e,
  );
  assert.notEqual(hit.body.object, "response");
  assert.ok(hit.res.status >= 400, hit.text);
});
