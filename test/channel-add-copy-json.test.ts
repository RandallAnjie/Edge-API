import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_ADVANCED_CUSTOM } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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
  return { e, auth };
}

async function addChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>): Promise<number> {
  const added = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(added.body.success, true, String(added.body.message));
  return Number((added.body.data as { id: number }).id);
}

test("original AddChannel leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/channel/", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "EOF");

  const jsonNull = await json(
    new Request("http://local/api/channel/", { method: "POST", headers: auth, body: "null" }),
    e,
  );
  omitData(jsonNull.body, "channel cannot be empty");

  const arr = await json(
    new Request("http://local/api/channel/", { method: "POST", headers: auth, body: "[]" }),
    e,
  );
  omitData(arr.body, "json: cannot unmarshal array into Go value of type controller.AddChannelRequest");

  const modeType = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ mode: 1, channel: { name: "x", type: 1, key: "sk-x" } }),
    }),
    e,
  );
  omitData(modeType.body, "json: cannot unmarshal number into Go value of type string");

  const badMode = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ mode: "merge", channel: { name: "x", type: 1, key: "sk-x" } }),
    }),
    e,
  );
  omitData(badMode.body, "不支持的添加模式");

  const emptyKey = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ mode: "single", channel: { name: "empty-key", type: 1, key: "" } }),
    }),
    e,
  );
  omitData(emptyKey.body, "channel cannot be empty");
});

test("original CopyChannel leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const abc = await json(new Request("http://local/api/channel/copy/abc", { method: "POST", headers: auth }), e);
  assert.equal(abc.res.status, 200);
  omitData(abc.body, "invalid id");

  const missing = await json(new Request("http://local/api/channel/copy/999999", { method: "POST", headers: auth }), e);
  omitData(missing.body, "获取渠道信息失败，请稍后重试");
});

test("original GetChannel leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const abc = await json(new Request("http://local/api/channel/abc", { headers: auth }), e);
  assert.equal(abc.res.status, 200);
  omitData(abc.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/channel/999999", { headers: auth }), e);
  omitData(missing.body, "record not found");
});

test("original UpdateChannel leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const statusPut = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 1, name: "sync-ch", status: 2 }),
    }),
    e,
  );
  assert.equal(statusPut.res.status, 200);
  omitData(statusPut.body, "Invalid parameters");

  const missing = await json(
    new Request("http://local/api/channel/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 999999, name: "missing" }),
    }),
    e,
  );
  omitData(missing.body, "record not found");
});

test("original TestChannel leftover ApiError gin.H omit data", async () => {
  const { e, auth } = await boot();

  const abc = await json(new Request("http://local/api/channel/test/abc", { headers: auth }), e);
  assert.equal(abc.res.status, 200);
  omitData(abc.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/channel/test/999999", { headers: auth }), e);
  omitData(missing.body, "record not found");
});

test("original FetchUpstreamModels leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const abc = await json(new Request("http://local/api/channel/fetch_models/abc", { headers: auth }), e);
  omitData(abc.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/channel/fetch_models/999999", { headers: auth }), e);
  omitData(missing.body, "record not found");

  const id = await addChannel(e, auth, {
    name: "fetch-fail",
    type: 1,
    key: "sk-x",
    models: "gpt-4o-mini",
    group: "default",
    base_url: "https://example.invalid",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream down", { status: 500 });
  try {
    const fail = await json(new Request("http://local/api/channel/fetch_models/" + id, { headers: auth }), e);
    assert.equal(fail.res.status, 200);
    omitData(fail.body, "获取模型列表失败: upstream down");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original FetchModels leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const incomplete = await json(
    new Request("http://local/api/channel/fetch_models", { method: "POST", headers: auth, body: "{" }),
    e,
  );
  assert.equal(incomplete.res.status, 400);
  omitData(incomplete.body, "Invalid request");

  const empty = await json(new Request("http://local/api/channel/fetch_models", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 400);
  omitData(empty.body, "Invalid request");

  const preview = await json(
    new Request("http://local/api/channel/fetch_models", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: CHANNEL_TYPE_ADVANCED_CUSTOM }),
    }),
    e,
  );
  assert.equal(preview.res.status, 200);
  omitData(preview.body, "advanced_custom is required");

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream down", { status: 500 });
  try {
    const fail = await json(
      new Request("http://local/api/channel/fetch_models", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: 1, key: "sk-x", base_url: "https://example.invalid" }),
      }),
      e,
    );
    omitData(fail.body, "获取模型列表失败: upstream down");
  } finally {
    globalThis.fetch = origFetch;
  }
});
