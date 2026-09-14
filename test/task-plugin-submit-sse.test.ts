import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { compilePlugin, goJSONByteLength, goJSONMarshal } from "../src/jsplugin.js";
import { JSONState, newJSONState } from "../src/jsplugin-json-state.js";
import { FACTORY_TASK_PLUGIN_SOURCES } from "../src/task-plugin-factory-data.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import {
  applyNativeSubmitCompletionUsage,
  buildNativeSubmitDescriptor,
  parseNativeSubmitResponse,
  type NativeSubmitInfo,
} from "../src/task-plugin-submit.js";
import {
  MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES,
  parseSubmitMediaType,
  readSubmitEvents,
} from "../src/task-plugin-submit-sse.js";
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
      body: JSON.stringify({ name: "sse-submit", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, store, sk };
}

const documentStreamPlugin = `
export const meta = {apiVersion:1,key:"document-stream",name:"Document stream",version:"1.0.0",author:{name:"Test"},models:["document"],fetchMode:"per_task",submitResponseTypes:["json","sse"],usageSchema:{units:{type:"number",unit:"count"}}};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/compile",responseType:ctx.requestBody.responseType || "sse"};}
export function parseSubmitEvent(ctx,event,previous) {
  const chunk = JSON.parse(event.data);
  if (chunk.error) throw new Error("provider stream failure");
  if (chunk.badState) return {state:null};
  if (chunk.largeState) return {state:{document:"x".repeat(1048577)},done:chunk.complete === true};
  if (chunk.escapedState) return {state:{document:"<".repeat(200000)},done:true};
  if (chunk.resetState) return {state:{document:"",units:0},done:true};
  const state = Object.assign({}, previous || {document:"",units:0});
  state.document += chunk.part || "";
  if (chunk.units !== undefined) state.units = chunk.units;
  state.event = event.event; state.id = event.id;
  return {state:state,done:chunk.complete === true};
}
export function parseSubmitResponse(ctx,response){return {taskId:"vendor-document",taskData:response.body,immediate:{status:"SUCCESS"},state:{revision:1}};}
export function parseTaskResult(){return {status:"SUCCESS"};}
export function buildQueryRequest(ctx){return {url:ctx.baseUrl+"/query"};}
export function extractUsageOnComplete(ctx,result,body){
  if(ctx.model!=="alias" || ctx.upstreamModel!=="document" || ctx.taskId!=="vendor-document" || ctx.publicTaskId!=="public-document" || ctx.state.revision!==1 || ctx.data.document!==body.document) throw new Error("invalid completion context");
  return {units:body.units};
}
`;

const documentDeltaPlugin =
  documentStreamPlugin.replace(
    `submitResponseTypes:["json","sse"],`,
    `submitResponseTypes:["json","sse"],requiredCapabilities:["submit-sse-delta@1"],`,
  ) +
  `
export function parseSubmitEventDelta(ctx,event,previous) {
  if(previous && previous.document !== undefined) throw new Error("full result leaked into control state");
  const chunk=JSON.parse(event.data);
  let changes=chunk.changes;
  if(chunk.largeResult) changes=[{op:"set",path:[],value:{document:"<".repeat(200000)}}];
  if(chunk.resetAfterLarge) changes.push({op:"set",path:[],value:{document:"",units:0}});
  const result={changes:changes,state:{events:(previous ? previous.events : 0)+1},done:chunk.complete===true};
  if(chunk.largeControl) result.state={text:"x".repeat(65537)};
  if(chunk.extra) result.extra=true;
  return result;
}
`;

const submitInfo: NativeSubmitInfo = {
  originModelName: "alias",
  upstreamModelName: "document",
  action: "",
  publicTaskId: "public-document",
  apiKey: "",
  channelBaseUrl: "https://provider.example",
  channelId: 1,
  channelType: 1,
  usingGroup: "default",
};

function submitContext(requestBody: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestBody,
    model: "alias",
    upstreamModel: "document",
    publicTaskId: "public-document",
    baseUrl: "https://provider.example",
    action: "",
  };
}

function parseLikeOriginal(source: string, body: string, contentType: string, requestBody: Record<string, unknown> = {}) {
  const loaded = compilePlugin(source);
  const context = submitContext(requestBody);
  const descriptor = buildNativeSubmitDescriptor(loaded.engine, context, "https://provider.example");
  if ("statusCode" in descriptor) return { error: descriptor };
  const streaming = descriptor.responseType === "sse";
  const acceptedStream = streaming || parseSubmitMediaType(contentType) === "text/event-stream";
  if (!streaming && acceptedStream) {
    return {
      error: {
        code: "plugin_submit_response_invalid",
        message: "unexpected SSE response for a JSON submission",
        statusCode: 502,
        localError: true,
        noRetry: true,
      },
    };
  }
  let parsedBody: unknown = body;
  if (streaming) {
    try {
      parsedBody = readSubmitEvents({
        engine: loaded.engine,
        driverContext: context,
        contentType,
        body,
        requiredCapabilities: Array.isArray(loaded.meta.requiredCapabilities)
          ? (loaded.meta.requiredCapabilities as unknown[]).map(String)
          : [],
      });
    } catch (err) {
      return {
        error: {
          code: "read_response_body_failed",
          message: err instanceof Error ? err.message : String(err),
          statusCode: 502,
          localError: false,
          noRetry: true,
        },
      };
    }
  } else {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body;
    }
  }
  const parsed = parseNativeSubmitResponse(loaded.engine, context, 200, { "content-type": [contentType] }, parsedBody);
  if ("statusCode" in parsed) {
    if (acceptedStream) parsed.noRetry = true;
    return { error: parsed };
  }
  applyNativeSubmitCompletionUsage(loaded.engine, parsed, submitInfo);
  return { parsed };
}

test("original TaskSubmitStreamContract JSON fields", () => {
  const cases: { name: string; body: string; contentType: string; valid: boolean }[] = [
    {
      name: "multiline and CRLF",
      body: ': heartbeat\r\nid: doc-1\r\nevent: update\r\ndata: {"part":\r\ndata: "hello","units":2}\r\n\r\ndata: {"part":"world","units":3,"complete":true}\n\n',
      contentType: "text/event-stream; charset=utf-8",
      valid: true,
    },
    { name: "zero actual units", body: 'data: {"part":"free","units":0,"complete":true}\n\n', contentType: "text/event-stream", valid: true },
    { name: "premature EOF", body: 'data: {"part":"partial"}\n\n', contentType: "text/event-stream", valid: false },
    { name: "unterminated event", body: 'data: {"complete":true}', contentType: "text/event-stream", valid: false },
    { name: "provider error", body: 'data: {"error":true}\n\n', contentType: "text/event-stream", valid: false },
    { name: "invalid hook result", body: 'data: {"badState":true}\n\n', contentType: "text/event-stream", valid: false },
    { name: "state limit", body: 'data: {"largeState":true}\n\n', contentType: "text/event-stream", valid: false },
    {
      name: "intermediate state limit",
      body: 'data: {"largeState":true}\n\ndata: {"resetState":true}\n\n',
      contentType: "text/event-stream",
      valid: false,
    },
    { name: "encoded state limit", body: 'data: {"escapedState":true}\n\n', contentType: "text/event-stream", valid: false },
    { name: "event limit", body: "data: " + "x".repeat(MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES) + "\n\n", contentType: "text/event-stream", valid: false },
    { name: "wrong response type", body: "{}", contentType: "application/json", valid: false },
    { name: "undeclared stream", body: "data: {}\n\n", contentType: "text/event-stream", valid: false },
  ];
  for (const tc of cases) {
    const requestBody = tc.name === "undeclared stream" ? { responseType: "json" } : {};
    const got = parseLikeOriginal(documentStreamPlugin, tc.body, tc.contentType, requestBody);
    if (!tc.valid) {
      assert.ok(got.error, tc.name);
      assert.equal(got.error?.noRetry, true, tc.name + " " + got.error?.message);
      continue;
    }
    assert.equal(got.error, undefined, tc.name + " " + got.error?.message);
    const immediate = got.parsed?.immediate as Record<string, unknown>;
    assert.ok(immediate, tc.name);
    if (tc.name === "zero actual units") {
      assert.deepEqual(immediate.usageFacts, { units: 0 });
      assert.deepEqual(immediate.usage_facts, { units: 0 });
      continue;
    }
    assert.deepEqual(immediate.usageFacts, { units: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(got.parsed?.taskData)), {
      document: "helloworld",
      units: 3,
      event: "message",
      id: "doc-1",
    });
  }
});

test("original TaskSubmitDeltaStreamContract JSON fields", () => {
  const first = '{"changes":[{"op":"set","path":[],"value":{"document":"hello","units":2}}]}';
  const last = '{"changes":[{"op":"appendText","path":["document"],"value":"world"},{"op":"set","path":["units"],"value":0}],"complete":true}';
  const cases: { name: string; frames: string[]; valid: boolean }[] = [
    { name: "control state and zero usage", frames: [first, last], valid: true },
    { name: "oversized intermediate result", frames: ['{"largeResult":true}', last], valid: false },
    { name: "oversized operation before reset", frames: ['{"largeResult":true,"resetAfterLarge":true,"complete":true}'], valid: false },
    { name: "control state limit", frames: [first, '{"changes":[],"largeControl":true,"complete":true}'], valid: false },
    { name: "missing changes", frames: ['{"complete":true}'], valid: false },
    { name: "extra result fields", frames: [first, '{"changes":[],"extra":true,"complete":true}'], valid: false },
    { name: "unfinished delta stream", frames: [first], valid: false },
  ];
  for (const tc of cases) {
    const stream = tc.frames.map((frame) => "data: " + frame + "\n\n").join("");
    const got = parseLikeOriginal(documentDeltaPlugin, stream, "text/event-stream");
    if (!tc.valid) {
      assert.ok(got.error, tc.name);
      assert.equal(got.error?.noRetry, true, tc.name + " " + got.error?.message);
      continue;
    }
    assert.equal(got.error, undefined, tc.name + " " + got.error?.message);
    assert.deepEqual(JSON.parse(JSON.stringify(got.parsed?.taskData)), { document: "helloworld", units: 0 });
    assert.deepEqual((got.parsed?.immediate as Record<string, unknown>).usageFacts, { units: 0 });
  }
});

test("original Alibaba parseSubmitEventDelta does not mutate control state JSON", () => {
  const loaded = compilePlugin(FACTORY_TASK_PLUGIN_SOURCES.alibaba);
  const control = { choices: [{ count: 1, lastText: true, finishReason: "" }], hasUsage: true };
  const previous = JSON.parse(JSON.stringify(control)) as Record<string, unknown>;
  const initial = JSON.parse(
    '{"request_id":"old","usage":{"image_count":1},"output":{"finished":false,"choices":[{"message":{"role":"assistant","content":[{"text":"hello"}]}}]}}',
  );
  const accumulated = newJSONState(MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES);
  accumulated.apply([{ op: "set", path: [], value: initial }]);
  const value = loaded.engine.call(
    "parseSubmitEventDelta",
    {},
    {
      event: "message",
      data: '{"request_id":"new","usage":{"image_count":2},"output":{"choices":[{"finish_reason":"stop","message":{"content":[{"text":" world"},{"image":"https://cdn.example/image.png"}]}}]}}',
    },
    previous,
  );
  assert.deepEqual(JSON.parse(goJSONMarshal(previous)), control);
  assert.ok(value && typeof value === "object");
  const result = value as Record<string, unknown>;
  assert.equal(result.done, true);
  accumulated.apply(result.changes);
  const encoded = goJSONMarshal(accumulated.value());
  assert.deepEqual(
    JSON.parse(encoded),
    JSON.parse(
      '{"request_id":"new","usage":{"image_count":2},"output":{"finished":true,"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":[{"text":"hello world"},{"image":"https://cdn.example/image.png"}]}}]}}',
    ),
  );
  assert.deepEqual(JSON.parse(goJSONMarshal(result.state)), {
    choices: [{ count: 2, lastText: false, finishReason: "stop" }],
    hasUsage: true,
  });
});

test("original JSONState Apply encoded HTML-escape JSON fields", () => {
  const frames = JSON.parse(`[
  [{"op":"set","path":[],"value":{"text":"<","parts":[],"nested":{"value":null}}}],
  [{"op":"appendText","path":["text"],"value":"&\\n\\"图像😀\\u2028"},
   {"op":"append","path":["parts"],"value":{"text":"a","enabled":false}},
   {"op":"set","path":["nested","value"],"value":[1,2]}],
  [{"op":"appendText","path":["parts",0,"text"],"value":"b"},
   {"op":"set","path":["nested","value",0],"value":0},
   {"op":"set","path":["nested","a<b"],"value":{}}]
]`) as unknown[][];
  const want = JSON.parse(
    '{"text":"<&\\n\\"图像😀\\u2028","parts":[{"text":"ab","enabled":false}],"nested":{"value":[0,2],"a<b":{}}}',
  );
  const state = new JSONState(goJSONByteLength(want));
  for (const frame of frames) {
    state.apply(frame);
    state.value();
  }
  assert.deepEqual(JSON.parse(goJSONMarshal(state.value())), want);
  assert.throws(() => state.apply([{ op: "appendText", path: ["text"], value: "x" }]));
  assert.throws(() => state.value());

  const replace = newJSONState(16);
  for (const value of ["abcdefghijklmn", {}, [0, false, null], null]) {
    replace.apply([{ op: "set", path: [], value }]);
    replace.value();
  }

  const escaped = newJSONState(13);
  escaped.apply([{ op: "set", path: [], value: "<" }]);
  assert.throws(() => escaped.apply([{ op: "appendText", path: [], value: "<" }]));

  const canceled = new AbortController();
  canceled.abort();
  assert.throws(() => newJSONState(64).apply([], canceled.signal));

  const many = Array.from({ length: 257 }, () => ({ op: "set", path: [], value: null }));
  assert.throws(() => newJSONState(1024).apply(many));
  let deep: unknown = null;
  for (let i = 0; i < 33; i++) deep = [deep];
  for (const value of [deep, Array.from({ length: 32768 }), Number.POSITIVE_INFINITY]) {
    const s = newJSONState(1 << 20);
    assert.throws(() => s.apply([{ op: "set", path: [], value }]));
  }

  const first = frames[0];
  for (const invalid of [
    '[{"op":"remove","path":[],"value":null}]',
    '[{"op":"set","path":[],"value":null,"extra":true}]',
    '[{"op":"set","path":["missing","child"],"value":1}]',
    '[{"op":"set","path":["parts",-1],"value":1}]',
    '[{"op":"set","path":["parts",0.5],"value":1}]',
    '[{"op":"set","path":["parts",100000000000000000000],"value":1}]',
    '[{"op":"appendText","path":["parts"],"value":"x"}]',
    '[{"op":"append","path":["text"],"value":"x"}]',
  ]) {
    const s = newJSONState(1024);
    s.apply(first);
    assert.throws(() => s.apply(JSON.parse(invalid)));
    assert.throws(() => s.value());
  }
});

test("original encoded submit stream state uses HTML-escaped JSON size", () => {
  const encoded = goJSONMarshal({ document: "<".repeat(200000) });
  assert.ok(utf8Size(encoded) > MAX_TASK_PLUGIN_PERSISTED_JSON_BYTES);
  assert.ok(goJSONByteLength({ document: "<" }) > JSON.stringify({ document: "<" }).length);
});

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

const httpStreamPlugin = `
export const meta = {apiVersion:1,key:"document-http",name:"Document stream",version:"1.0.0",author:{name:"Test"},models:["document"],fetchMode:"per_task",submitResponseTypes:["json","sse"],channelTypes:[${CHANNEL_TYPE_OPENAI}],routes:[{method:"POST",path:"/vendor/jobs",type:"submit",decode:"decode",render:"created"}]};
export const native = {decode:function(ctx){return {kind:"submit",model:"document",requestBody:ctx.body.value};},created:function(_ctx,task){return {task_id:task.task_id,taskData:task.data};}};
export function buildSubmitRequest(ctx){return {url:ctx.baseUrl+"/compile",responseType:ctx.requestBody.responseType || "sse"};}
export function parseSubmitEvent(ctx,event,previous) {
  const chunk = JSON.parse(event.data);
  const state = Object.assign({}, previous || {document:"",units:0});
  state.document += chunk.part || "";
  if (chunk.units !== undefined) state.units = chunk.units;
  state.event = event.event; state.id = event.id;
  return {state:state,done:chunk.complete === true};
}
export function parseSubmitResponse(ctx,response){return {taskId:"vendor-document",taskData:response.body,immediate:{status:"SUCCESS"},state:{revision:1}};}
export function parseTaskResult(){return {status:"SUCCESS"};}
export function buildQueryRequest(ctx){return {url:ctx.baseUrl+"/query"};}
export function extractUsageOnComplete(){return {units:3};}
`;

test("original native SSE RelayTask submit JSON fields", async () => {
  const { e, auth, store, sk } = await boot();
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: httpStreamPlugin }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ document: 1 }) }),
    }),
    e,
  );
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "document-sse",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "document",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "https://provider.example.test/compile") {
      return new Response(': heartbeat\r\nid: doc-1\r\nevent: update\r\ndata: {"part":\r\ndata: "hello","units":2}\r\n\r\ndata: {"part":"world","units":3,"complete":true}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return origFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "document", prompt: "hello" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    const data = hit.body as { task_id?: string; taskData?: Record<string, unknown> };
    assert.ok(data.task_id?.startsWith("task_"), hit.text);
    assert.deepEqual(data.taskData, { document: "helloworld", units: 3, event: "message", id: "doc-1" });
    const persisted = await store.getTaskByTid(String(data.task_id));
    assert.ok(persisted);
    assert.equal(String(persisted?.status), "SUCCESS");
    assert.deepEqual(JSON.parse(String(persisted?.data || "{}")), {
      document: "helloworld",
      units: 3,
      event: "message",
      id: "doc-1",
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original undeclared SSE submit is local 502 JSON", async () => {
  const { e, auth, sk } = await boot();
  await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: httpStreamPlugin }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "ModelRatio", value: JSON.stringify({ document: 1 }) }),
    }),
    e,
  );
  await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "document-json",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-test",
        models: "document",
        group: "default",
        base_url: "https://provider.example.test",
      }),
    }),
    e,
  );
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === "https://provider.example.test/compile") {
      return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return origFetch(input as RequestInfo, undefined);
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "document", responseType: "json" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 502, hit.text);
    assert.equal(hit.body.code, "server_error");
    assert.match(String(hit.body.message || hit.text), /Task request failed \(request id: /);
    assert.equal(hit.body.data, null);
  } finally {
    globalThis.fetch = origFetch;
  }
});
