import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_TYPE_ANTHROPIC,
  CHANNEL_TYPE_GEMINI,
  CHANNEL_TYPE_OPENAI,
  LOG_CONSUME,
} from "../src/constants.js";
import { MAX_IMAGE_N } from "../src/task-plugin-usage.js";
import {
  BUILD_IN_TOOL_FILE_SEARCH,
  BUILD_IN_TOOL_GOOGLE_SEARCH,
  BUILD_IN_TOOL_IMAGE_GENERATION,
  BUILD_IN_TOOL_WEB_SEARCH,
  BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
} from "../src/tool-price.js";
import {
  BUILD_IN_CALL_FILE_SEARCH_CALL,
  BUILD_IN_CALL_FUNCTION_CALL,
  BUILD_IN_CALL_WEB_SEARCH_CALL,
  ImageGenerationCallCounter,
  RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL,
  RESPONSES_OUTPUT_TYPE_ITEM_DONE,
  applyResponsesStreamEvent,
  builtInToolCallCounts,
  collectStreamFunctionCallNames,
  countBillableToolCall,
  countClaudeHandler,
  countClaudeStreamBillableTools,
  countGeminiBillableFunctionCalls,
  countOpenAIResponsesHandler,
  createToolUsageState,
  ingestUpstreamToolUsage,
  isNonBillableResponsesStatus,
  markGeminiGoogleSearchCall,
} from "../src/tool-usage.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(Promise.resolve(promise));
      },
    } as ExecutionContextLike,
    drain: () => Promise.all(pending),
  };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env, harness = makeCtx()) {
  const res = await handleFetch(req, e, harness.ctx);
  await harness.drain();
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { res, body, text };
}

async function boot(e: Env) {
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
  return { token, auth, store: new Store(e.DB) };
}

async function putOption(e: Env, auth: Record<string, string>, key: string, value: string) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
}

async function createChannel(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<number> {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        group: "default",
        key: "sk-tool-usage",
        base_url: "https://tool-usage.example.test",
        type: CHANNEL_TYPE_OPENAI,
        ...body,
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  return Number((ch.body.data as { id: number }).id);
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "tool-usage", remain_quota: 100000000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

async function withMockedFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

async function lastConsume(e: Env, auth: Record<string, string>, model: string) {
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === model && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  return { row: items[0], other: parseOther(items[0].other) };
}

test("original CountBillableToolCall web_search prefers declared web_search", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  state.builtInTools[BUILD_IN_TOOL_WEB_SEARCH] = { toolName: BUILD_IN_TOOL_WEB_SEARCH, callCount: 0 };
  countBillableToolCall(state, BUILD_IN_CALL_WEB_SEARCH_CALL);
  assert.equal(state.builtInTools[BUILD_IN_TOOL_WEB_SEARCH].callCount, 1);
  assert.equal(BUILD_IN_TOOL_WEB_SEARCH_PREVIEW in state.builtInTools, false);
});

test("original CountBillableToolCall web_search defaults to preview", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  countBillableToolCall(state, BUILD_IN_CALL_WEB_SEARCH_CALL);
  assert.equal(state.builtInTools[BUILD_IN_TOOL_WEB_SEARCH_PREVIEW].callCount, 1);
});

test("original CountBillableToolCall function_call requires price", () => {
  const state = createToolUsageState({ model: "gpt-5.1", toolPrices: { my_priced_fn: 5 } });
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, "my_priced_fn");
  assert.equal(state.builtInTools.my_priced_fn.callCount, 1);
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, "unpriced_fn");
  assert.equal("unpriced_fn" in state.builtInTools, false);
});

test("original CountBillableToolCall function_call skips reserved names", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, BUILD_IN_TOOL_WEB_SEARCH_PREVIEW);
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, BUILD_IN_TOOL_FILE_SEARCH);
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, BUILD_IN_TOOL_GOOGLE_SEARCH);
  countBillableToolCall(state, BUILD_IN_CALL_FUNCTION_CALL, BUILD_IN_TOOL_IMAGE_GENERATION);
  assert.equal(BUILD_IN_TOOL_WEB_SEARCH_PREVIEW in state.builtInTools, false);
  assert.equal(BUILD_IN_TOOL_FILE_SEARCH in state.builtInTools, false);
  assert.equal(BUILD_IN_TOOL_GOOGLE_SEARCH in state.builtInTools, false);
  assert.equal(BUILD_IN_TOOL_IMAGE_GENERATION in state.builtInTools, false);
});

test("original ImageGenerationCallCounter completed outputs JSON", () => {
  const cases: { name: string; observe: (c: ImageGenerationCallCounter) => void; want: number }[] = [
    {
      name: "one final result",
      observe: (c) => c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "completed", result: "base64-a" }, 0),
      want: 1,
    },
    {
      name: "two distinct finals",
      observe: (c) => {
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", result: "base64-a" }, 0);
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_2", result: "base64-b" }, 1);
      },
      want: 2,
    },
    {
      name: "empty result",
      observe: (c) => c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", result: "   " }, 0),
      want: 0,
    },
    {
      name: "failed status",
      observe: (c) => c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "failed", result: "base64-a" }, 0),
      want: 0,
    },
    {
      name: "incomplete status",
      observe: (c) => c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "incomplete", result: "base64-a" }, 0),
      want: 0,
    },
    {
      name: "id dedup",
      observe: (c) => {
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", call_id: "call_a", result: "base64-a" }, 0);
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", call_id: "call_b", result: "base64-b" }, 1);
      },
      want: 1,
    },
    {
      name: "index dedup",
      observe: (c) => {
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", result: "base64-a" }, 0);
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_2", result: "base64-b" }, 0);
      },
      want: 1,
    },
    {
      name: "result hash dedup",
      observe: (c) => {
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, result: "same-bytes" }, 0);
        c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, result: "same-bytes" }, 1);
      },
      want: 1,
    },
    {
      name: "in_progress with final result counts",
      observe: (c) => c.observe({ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "in_progress", result: "base64-a" }, 0),
      want: 1,
    },
    {
      name: "partial event equals zero",
      observe: (c) => c.observe({ type: "image_generation_call.partial_image", id: "img_1", result: "partial-bytes" }, 0),
      want: 0,
    },
  ];
  for (const tt of cases) {
    const counter = new ImageGenerationCallCounter();
    tt.observe(counter);
    assert.equal(counter.Count(), tt.want, tt.name);
  }
});

test("original ImageGenerationCallCounter Commit caps at MaxImageN", () => {
  const counter = new ImageGenerationCallCounter();
  for (let i = 0; i < MAX_IMAGE_N + 3; i++) {
    counter.observe(
      {
        type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL,
        id: "img_" + "a".repeat(i + 1),
        result: "result-" + "b".repeat(i + 1),
      },
      i,
    );
  }
  assert.equal(counter.Count(), MAX_IMAGE_N + 3);
  const state = createToolUsageState({ model: "gpt-5.1" });
  counter.commit(state);
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, MAX_IMAGE_N);
});

test("original ImageGenerationCallCounter Commit does not bill declarations alone", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION] = { toolName: BUILD_IN_TOOL_IMAGE_GENERATION, callCount: 0 };
  new ImageGenerationCallCounter().commit(state);
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, 0);
});

test("original IsNonBillableResponsesStatus JSON", () => {
  assert.equal(isNonBillableResponsesStatus('"failed"'), true);
  assert.equal(isNonBillableResponsesStatus('"incomplete"'), true);
  assert.equal(isNonBillableResponsesStatus('"cancelled"'), true);
  assert.equal(isNonBillableResponsesStatus('"canceled"'), true);
  assert.equal(isNonBillableResponsesStatus('"completed"'), false);
  assert.equal(isNonBillableResponsesStatus(null), false);
  assert.equal(isNonBillableResponsesStatus(new TextEncoder().encode('"failed"')), true);
});

test("original OaiResponsesHandler counts output calls not declarations", () => {
  const state = createToolUsageState({
    model: "gpt-5.1",
    toolPrices: { priced_fn: 5 },
    relayMode: "responses",
    requestTools: [{ type: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW }, { type: BUILD_IN_TOOL_FILE_SEARCH }],
  });
  countOpenAIResponsesHandler(state, {
    output: [
      { type: BUILD_IN_CALL_WEB_SEARCH_CALL },
      { type: BUILD_IN_CALL_WEB_SEARCH_CALL },
      { type: BUILD_IN_CALL_FUNCTION_CALL, name: "priced_fn" },
      { type: BUILD_IN_CALL_FUNCTION_CALL, name: "unpriced_fn" },
    ],
  });
  const counts = builtInToolCallCounts(state);
  assert.equal(counts[BUILD_IN_TOOL_WEB_SEARCH_PREVIEW], 2);
  assert.equal(counts[BUILD_IN_TOOL_FILE_SEARCH], 0);
  assert.equal(counts.priced_fn, 1);
  assert.equal("unpriced_fn" in counts, false);
});

test("original OaiResponsesHandler declared tools without output count zero", () => {
  const state = createToolUsageState({
    model: "gpt-5.1",
    relayMode: "responses",
    requestTools: [{ type: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW }, { type: BUILD_IN_TOOL_FILE_SEARCH }],
  });
  countOpenAIResponsesHandler(state, { output: [{ type: "message", role: "assistant" }] });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_WEB_SEARCH_PREVIEW].callCount, 0);
  assert.equal(state.builtInTools[BUILD_IN_TOOL_FILE_SEARCH].callCount, 0);
});

test("original OaiResponsesHandler counts completed image_generation outputs", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  countOpenAIResponsesHandler(state, {
    status: "completed",
    output: [
      { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "completed", result: "base64-a" },
      { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_2", status: "completed", result: "base64-b" },
      { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_empty", status: "completed", result: "" },
    ],
  });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, 2);
});

test("original OaiResponsesHandler incomplete status commits zero image_generation", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION] = { toolName: BUILD_IN_TOOL_IMAGE_GENERATION, callCount: 0 };
  countOpenAIResponsesHandler(state, {
    status: "incomplete",
    output: [{ type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "completed", result: "base64-a" }],
  });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, 0);
});

test("original OaiResponsesStreamHandler deduplicates completed image output", () => {
  const item = {
    type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL,
    id: "img_1",
    call_id: "call_1",
    status: "completed",
    result: "base64-a",
  };
  const state = createToolUsageState({ model: "gpt-5.1" });
  applyResponsesStreamEvent(state, { type: RESPONSES_OUTPUT_TYPE_ITEM_DONE, output_index: 0, item });
  applyResponsesStreamEvent(state, {
    type: "response.completed",
    response: { status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, 1);
});

test("original OaiResponsesStreamHandler discards image output on incomplete", () => {
  const state = createToolUsageState({ model: "gpt-5.1" });
  applyResponsesStreamEvent(state, {
    type: RESPONSES_OUTPUT_TYPE_ITEM_DONE,
    output_index: 0,
    item: { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "completed", result: "base64-a" },
  });
  applyResponsesStreamEvent(state, { type: "response.incomplete", response: { status: "incomplete" } });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_IMAGE_GENERATION].callCount, 0);
});

test("original collectStreamFunctionCallNames dedupes same index", () => {
  const seen: Record<string, true> = {};
  const names: string[] = [];
  const chunks = [
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"c2","type":"function","function":{"name":"get_time","arguments":""}}]}}]}`,
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{}"}}]}}]}`,
  ];
  for (const chunk of chunks) collectStreamFunctionCallNames(chunk, seen, names);
  assert.deepEqual(names, ["get_weather", "get_time"]);
});

test("original HandleClaudeResponseData counts tool_use not server_tool_use", () => {
  const state = createToolUsageState({ model: "claude-3-7-sonnet", toolPrices: { lookup_fn: 3 } });
  countClaudeHandler(state, {
    type: "message",
    content: [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "tu1", name: "lookup_fn", input: {} },
      { type: "server_tool_use", id: "stu1", name: "web_search", input: {} },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(state.builtInTools.lookup_fn.callCount, 1);
  assert.equal("web_search" in state.builtInTools, false);
});

test("original countClaudeStreamBillableTools sets web_search_requests", () => {
  const state = createToolUsageState({ model: "claude-3-7-sonnet", toolPrices: { stream_fn: 2 } });
  countClaudeStreamBillableTools(state, {
    type: "message_delta",
    usage: { server_tool_use: { web_search_requests: 3 } },
  });
  assert.equal(state.claudeWebSearchRequests, 3);
  countClaudeStreamBillableTools(state, {
    type: "content_block_start",
    content_block: { type: "tool_use", name: "stream_fn" },
  });
  assert.equal(state.builtInTools.stream_fn.callCount, 1);
});

test("original Gemini grounding and functionCall billing JSON", () => {
  const state = createToolUsageState({ model: "gemini-2.5-flash", toolPrices: { lookup_places: 4 } });
  const json = {
    candidates: [
      {
        content: {
          parts: [
            { functionCall: { name: "lookup_places", args: {} } },
            { functionCall: { name: "will_skip", willContinue: true } },
          ],
        },
        groundingMetadata: { webSearchQueries: ["weather"] },
      },
    ],
  };
  markGeminiGoogleSearchCall(state, json);
  countGeminiBillableFunctionCalls(state, json);
  assert.equal(state.geminiGoogleSearchCall, true);
  assert.equal(state.builtInTools.lookup_places.callCount, 1);
  assert.equal("will_skip" in state.builtInTools, false);
});

test("original Responses HTTP tool_surcharges from output calls not declarations", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await putOption(e, auth, "tool_price_setting.prices", JSON.stringify({ priced_fn: 5 }));
  await createChannel(e, auth, { name: "responses-tools", models: "gpt-5.1" });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "resp_tools",
          object: "response",
          status: "completed",
          output: [
            { type: BUILD_IN_CALL_WEB_SEARCH_CALL },
            { type: BUILD_IN_CALL_WEB_SEARCH_CALL },
            { type: BUILD_IN_CALL_FUNCTION_CALL, name: "priced_fn" },
            { type: BUILD_IN_CALL_FUNCTION_CALL, name: "unpriced_fn" },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.1",
            tools: [{ type: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW }, { type: BUILD_IN_TOOL_FILE_SEARCH }],
            input: "hi",
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const { row, other } = await lastConsume(e, auth, "gpt-5.1");
  assert.equal(row.quota, 12502);
  assert.deepEqual(other.tool_surcharges, [
    { name: "priced_fn", count: 1, price: 5 },
    { name: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, count: 2, price: 10 },
  ]);
});

test("original Responses HTTP image_generation_call consume-log JSON 150002", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await createChannel(e, auth, { name: "responses-image", models: "gpt-5.1" });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "resp_img",
          object: "response",
          status: "completed",
          output: [
            { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_1", status: "completed", result: "base64-a" },
            { type: RESPONSES_OUTPUT_TYPE_IMAGE_GENERATION_CALL, id: "img_2", status: "completed", result: "base64-b" },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.1",
            tools: [{ type: BUILD_IN_TOOL_IMAGE_GENERATION }],
            input: "draw",
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const { row, other } = await lastConsume(e, auth, "gpt-5.1");
  assert.equal(row.quota, 150002);
  assert.deepEqual(other.tool_surcharges, [{ name: BUILD_IN_TOOL_IMAGE_GENERATION, count: 2, price: 150 }]);
});

test("original Claude HTTP tool_use + claude_web_search_requests consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "claude-3-7-sonnet": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "claude-3-7-sonnet": 1 }));
  await putOption(e, auth, "tool_price_setting.prices", JSON.stringify({ lookup_fn: 3 }));
  await createChannel(e, auth, {
    name: "claude-tools",
    type: CHANNEL_TYPE_ANTHROPIC,
    models: "claude-3-7-sonnet",
    key: "sk-ant",
  });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "tu1", name: "lookup_fn", input: {} },
            { type: "server_tool_use", id: "stu1", name: "web_search", input: {} },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            server_tool_use: { web_search_requests: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-3-7-sonnet", messages: [{ role: "user", content: "hi" }] }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const { row, other } = await lastConsume(e, auth, "claude-3-7-sonnet");
  assert.deepEqual(other.tool_surcharges, [
    { name: "lookup_fn", count: 1, price: 3 },
    { name: BUILD_IN_TOOL_WEB_SEARCH, count: 2, price: 10 },
  ]);
  assert.equal(row.quota, 11500 + Number(row.prompt_tokens) + Number(row.completion_tokens));
});

test("original Gemini HTTP google_search consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gemini-2.5-flash": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gemini-2.5-flash": 1 }));
  await createChannel(e, auth, {
    name: "gemini-tools",
    type: CHANNEL_TYPE_GEMINI,
    models: "gemini-2.5-flash",
    key: "gk",
  });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "ok" }] },
              groundingMetadata: { webSearchQueries: ["weather nyc"] },
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const { row, other } = await lastConsume(e, auth, "gemini-2.5-flash");
  assert.equal(row.quota, 7002);
  assert.deepEqual(other.tool_surcharges, [{ name: BUILD_IN_TOOL_GOOGLE_SEARCH, count: 1, price: 14 }]);
});

test("original Responses stream HTTP two web_search_call consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await createChannel(e, auth, { name: "responses-stream-tools", models: "gpt-5.1" });
  const sk = await createSk(e, auth);
  const sse = [
    `data: {"type":"${RESPONSES_OUTPUT_TYPE_ITEM_DONE}","output_index":0,"item":{"type":"${BUILD_IN_CALL_WEB_SEARCH_CALL}"}}`,
    `data: {"type":"${RESPONSES_OUTPUT_TYPE_ITEM_DONE}","output_index":1,"item":{"type":"${BUILD_IN_CALL_WEB_SEARCH_CALL}"}}`,
    `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}},"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  await withMockedFetch(
    () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    async () => {
      const hit = await json(
        new Request("http://local/v1/responses", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-5.1",
            stream: true,
            tools: [{ type: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW }],
            input: "hi",
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const { row, other } = await lastConsume(e, auth, "gpt-5.1");
  assert.equal(row.quota, 10002);
  assert.deepEqual(other.tool_surcharges, [{ name: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, count: 2, price: 10 }]);
});

test("ingestUpstreamToolUsage file_search_call increments file_search", () => {
  const state = createToolUsageState({
    model: "gpt-5.1",
    relayMode: "responses",
    requestTools: [{ type: BUILD_IN_TOOL_FILE_SEARCH }],
  });
  ingestUpstreamToolUsage(state, {
    json: { object: "response", output: [{ type: BUILD_IN_CALL_FILE_SEARCH_CALL }, { type: BUILD_IN_CALL_FILE_SEARCH_CALL }] },
  });
  assert.equal(state.builtInTools[BUILD_IN_TOOL_FILE_SEARCH].callCount, 2);
});

test("ingestUpstreamToolUsage SSE chat function names", () => {
  const state = createToolUsageState({ model: "gpt-5.1", toolPrices: { get_weather: 5 } });
  ingestUpstreamToolUsage(state, {
    sseText: [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather"}}]}}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}`,
      "data: [DONE]",
    ].join("\n"),
  });
  assert.equal(state.builtInTools.get_weather.callCount, 1);
});
