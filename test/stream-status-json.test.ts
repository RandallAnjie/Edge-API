import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import { consumeLogOther, generateTextOtherInfo, RELAY_FORMAT_OPENAI } from "../src/log-info-generate.js";
import {
  STREAM_END_REASON_DONE,
  STREAM_END_REASON_TIMEOUT,
  StreamStatus,
} from "../src/stream-status.js";
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
  const text = await res.text();
  await harness.drain();
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

async function createChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown> = {}) {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "stream-po",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-stream-po",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://stream-po.example.test",
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
      body: JSON.stringify({ name: "stream-po", remain_quota: 100000, unlimited_quota: true }),
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

test("original GenerateTextOtherInfo po is ParamOverrideAudit string array", () => {
  const other = generateTextOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    paramOverrideAudit: ["set reasoning.effort = max"],
  });
  assert.deepEqual(other.po, ["set reasoning.effort = max"]);
  assert.equal(Array.isArray(other.po), true);
});

test("original GenerateTextOtherInfo omits po when audit is empty", () => {
  const other = generateTextOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    paramOverrideAudit: [],
  });
  assert.equal("po" in other, false);
});

test("original GenerateTextOtherInfo stream_status ok/error JSON", () => {
  const okStatus = new StreamStatus();
  okStatus.setEndReason(STREAM_END_REASON_DONE);
  const ok = generateTextOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    streamStatus: okStatus,
  });
  assert.deepEqual(ok.stream_status, { status: "ok", end_reason: "done" });

  const errStatus = new StreamStatus();
  errStatus.setEndReason(STREAM_END_REASON_TIMEOUT, new Error("streaming timeout"));
  for (let i = 0; i < 30; i++) errStatus.recordError(`error_${i}`);
  const err = generateTextOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    streamStatus: errStatus,
  });
  const stream = err.stream_status as Record<string, unknown>;
  assert.equal(stream.status, "error");
  assert.equal(stream.end_reason, "timeout");
  assert.equal(stream.end_error, "streaming timeout");
  assert.equal(stream.error_count, 30);
  assert.equal(Array.isArray(stream.errors), true);
  assert.equal((stream.errors as string[]).length, 20);
  assert.equal((stream.errors as string[])[0], "error_0");
});

test("original consumeLogOther stream_status omitted when StreamStatus is nil", () => {
  const parsed = JSON.parse(
    consumeLogOther({
      model: "gpt-4o-mini",
      group: "default",
      groupRatio: 1,
      modelRatio: 1,
      completionRatio: 1,
      channelId: 1,
      channelName: "oa",
      channelType: CHANNEL_TYPE_OPENAI,
      ok: true,
      requestConversion: [RELAY_FORMAT_OPENAI],
    }),
  ) as Record<string, unknown>;
  assert.equal("stream_status" in parsed, false);
  assert.equal("po" in parsed, false);
});

test("original text-relay consume log po JSON is audit lines not the override object", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth, {
    param_override: JSON.stringify({
      operations: [{ mode: "set", path: "reasoning.effort", value: "max" }],
    }),
  });
  const sk = await createSk(e, auth);
  let upstreamBody = "";
  await withMockedFetch(
    async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      upstreamBody = await req.text();
      return new Response(
        JSON.stringify({
          id: "chatcmpl-po",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            reasoning: { effort: "high" },
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  assert.match(upstreamBody, /"effort":"max"/);
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gpt-4o-mini" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.deepEqual(other.po, ["set reasoning.effort = max"]);
  assert.equal("stream_status" in other, false);
});

test("original text-relay consume log omits po for non-sensitive temperature override", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth, {
    name: "temp-only",
    param_override: JSON.stringify({ temperature: 0.1 }),
  });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-temp",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gpt-4o-mini",
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.equal("po" in other, false);
});

test("original stream consume log stream_status JSON is ok/done", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  const sse = [
    'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  await withMockedFetch(
    () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gpt-4o-mini" && Number(row.is_stream) === 1,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.deepEqual(other.stream_status, { status: "ok", end_reason: "done" });
});
