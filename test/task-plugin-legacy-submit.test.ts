import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI } from "../src/constants.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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
      body: JSON.stringify({ name: "legacy-submit", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  return { e, auth, sk };
}

const legacyPlugin = `
export const meta = {apiVersion:1,key:"legacy-entry-test",name:"Legacy",version:"1.0.0",author:{name:"Test"},models:["legacy-v1"],fetchMode:"per_task",channelTypes:[${CHANNEL_TYPE_OPENAI}]};
export function buildSubmitRequest(){return {url:"https://legacy.example.test/submit"}}
export function parseSubmitResponse(){return {taskId:"upstream"}}
export function buildQueryRequest(){return {url:"https://legacy.example.test/query"}}
export function parseTaskResult(){return {status:"SUCCESS"}}
`;

test("original PrepareTaskPluginSubmit rejects missing plugin JSON", async () => {
  const { e, sk } = await boot();
  const hit = await json(
    new Request("http://local/v1/tasks/no-such-plugin", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "legacy-v1" }),
    }),
    e,
  );
  assert.equal(hit.res.status, 400, hit.text);
  const err = hit.body.error as { message?: string; type?: string; code?: unknown; param?: unknown };
  assert.ok(err, hit.text);
  assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);
  assert.equal(err.type, "invalid_request_error");
  assert.equal(err.message, "task plugin not found");
});

test("original PrepareTaskPluginSubmit requires model JSON", async () => {
  const { e, auth, sk } = await boot();
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: legacyPlugin, force: true }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const hit = await json(
    new Request("http://local/v1/tasks/legacy-entry-test", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    }),
    e,
  );
  assert.equal(hit.res.status, 400, hit.text);
  const err = hit.body.error as { message?: string; type?: string };
  assert.deepEqual(Object.keys(err).sort(), ["message", "type"]);
  assert.equal(err.type, "invalid_request_error");
  assert.equal(err.message, "model is required");
});

test("original POST /v1/tasks/:key empty-channel is distributor model_not_found JSON", async () => {
  const { e, auth, sk } = await boot();
  const registered = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: legacyPlugin, force: true }),
    }),
    e,
  );
  assert.equal(registered.body.success, true, String(registered.body.message));
  const hit = await json(
    new Request("http://local/v1/tasks/legacy-entry-test", {
      method: "POST",
      headers: {
        authorization: "Bearer " + sk,
        "content-type": "application/json",
        "x-oneapi-request-id": "legacy-empty-req",
      },
      body: JSON.stringify({ model: "legacy-v1" }),
    }),
    e,
  );
  assert.equal(hit.res.status, 503, hit.text);
  const err = hit.body.error as { message?: string; type?: string; code?: string; param?: unknown };
  assert.ok(err, hit.text);
  assert.deepEqual(Object.keys(err).sort(), ["code", "message", "type"]);
  assert.equal(err.type, "new_api_error");
  assert.equal(err.code, "model_not_found");
  assert.match(String(err.message), /No available channel for model legacy-v1 under group default \(distributor\)/);
  assert.match(String(err.message), /request id: legacy-empty-req/);
  assert.equal(hit.body.code, undefined);
});
