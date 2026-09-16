import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { DEFAULT_MARKETPLACE_SOURCES, getTaskPluginMarketplaceSources } from "../src/option-defaults.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

test("original GetTaskPluginMarketplaceSources empty option vs JSON null vs []", () => {
  assert.deepEqual(getTaskPluginMarketplaceSources(""), DEFAULT_MARKETPLACE_SOURCES);
  assert.deepEqual(getTaskPluginMarketplaceSources("   "), DEFAULT_MARKETPLACE_SOURCES);
  assert.deepEqual(getTaskPluginMarketplaceSources("{"), DEFAULT_MARKETPLACE_SOURCES);
  assert.deepEqual(getTaskPluginMarketplaceSources("{}"), DEFAULT_MARKETPLACE_SOURCES);
  assert.deepEqual(getTaskPluginMarketplaceSources("null"), []);
  assert.deepEqual(getTaskPluginMarketplaceSources("[]"), []);
});

test("original task-plugin ApiErrorMsg gin.H omit data; marketplace PUT returns sources", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const missing = await json(new Request("http://local/api/plugin/task/no-such-plugin", { headers: auth }), e);
  assert.equal(missing.res.status, 200);
  omitData(missing.body, "task plugin not found");

  const versionMiss = await json(new Request("http://local/api/plugin/task/kling?version=no-such", { headers: auth }), e);
  omitData(versionMiss.body, "record not found");

  const tooBig = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: "x".repeat(1024 * 1024 + 1) }),
    }),
    e,
  );
  omitData(tooBig.body, "plugin source exceeds 1 MiB");

  const mismatch = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: `export const meta = {apiVersion:1,key:"sha-miss",name:"Test",version:"1.0.0",author:{name:"Test"},models:["doc-1"],fetchMode:"per_task"};
export function buildSubmitRequest(){return {}}
export function parseSubmitResponse(){return {}}
export function buildQueryRequest(){return {}}
export function parseTaskResult(){return {}}
`,
        sourceSha256: "deadbeef",
      }),
    }),
    e,
  );
  omitData(mismatch.body, "plugin source sha256 mismatch");

  const activateBind = await json(
    new Request("http://local/api/plugin/task/kling/activate", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  omitData(
    activateBind.body,
    "Key: 'taskPluginActivateRequest.Version' Error:Field validation for 'Version' failed on the 'required' tag",
  );

  const activateMiss = await json(
    new Request("http://local/api/plugin/task/kling/activate", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ version: "9.9.9" }),
    }),
    e,
  );
  omitData(activateMiss.body, "plugin version not found");

  const statusBind = await json(
    new Request("http://local/api/plugin/task/kling/status", { method: "POST", headers: auth, body: "{}" }),
    e,
  );
  omitData(statusBind.body, "enabled is required");

  const dryMiss = await json(
    new Request("http://local/api/plugin/task/no-such-plugin/dryrun", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ hook: "buildSubmitRequest" }),
    }),
    e,
  );
  omitData(dryMiss.body, "task plugin not found");

  const delMiss = await json(
    new Request("http://local/api/plugin/task/kling/versions/9.9.9", { method: "DELETE", headers: auth }),
    e,
  );
  omitData(delMiss.body, "override plugin version not found; factory plugins cannot be deleted");

  const nameReq = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify([{ name: "  ", index_url: "https://example.test/index.json" }]),
    }),
    e,
  );
  omitData(nameReq.body, "marketplace source name is required");

  const badUrl = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify([{ name: "Local", index_url: "/relative.json" }]),
    }),
    e,
  );
  omitData(badUrl.body, "marketplace source index_url must be an absolute http(s) URL");

  const bindObj = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ name: "Official", index_url: "https://example.test/index.json" }),
    }),
    e,
  );
  omitData(bindObj.body, "json: cannot unmarshal object into Go value of type []setting.TaskPluginMarketplaceSource");

  const emptyBody = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", { method: "PUT", headers: auth, body: "" }),
    e,
  );
  omitData(emptyBody.body, "EOF");

  const saved = [
    { name: "  Custom  ", index_url: "  https://plugins.example.test/index.json  " },
  ];
  const put = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(saved),
    }),
    e,
  );
  assert.equal(put.res.status, 200);
  assert.equal(put.body.success, true);
  assert.equal(put.body.message, "");
  assert.deepEqual(put.body.data, [{ name: "Custom", index_url: "https://plugins.example.test/index.json" }]);

  const got = await json(new Request("http://local/api/plugin/task/marketplace/sources", { headers: auth }), e);
  assert.deepEqual(got.body.data, [{ name: "Custom", index_url: "https://plugins.example.test/index.json" }]);

  const cleared = await json(
    new Request("http://local/api/plugin/task/marketplace/sources", { method: "PUT", headers: auth, body: "[]" }),
    e,
  );
  assert.deepEqual(cleared.body.data, []);
  const gotEmpty = await json(new Request("http://local/api/plugin/task/marketplace/sources", { headers: auth }), e);
  assert.deepEqual(gotEmpty.body.data, []);
});
