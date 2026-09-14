import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginMethodNotAllowed, pluginRoutePanicError } from "../src/http.js";
import { pluginRoutePathMatches } from "../src/plugin-dispatch.js";
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

function pluginSource(key: string, routes: string) {
  return `const meta = { apiVersion: 1, key: "${key}", name: "${key}", version: "1.0.0", author: { name: "test" }, models: ["${key}"], fetchMode: "per_task", routes: ${routes}, protocols: [], allowedHosts: [], auth: { type: "none" } };`;
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

test("original plugin-router path match, 405 empty body, and plugin_route_error JSON", async () => {
  assert.equal(pluginRoutePathMatches("/vendor/jobs/:task_id", "/vendor/jobs/task-1"), true);
  assert.equal(pluginRoutePathMatches("/vendor/job", "/vendor/job/"), false);
  assert.equal(pluginRoutePathMatches("/vendor/job/", "/vendor/job"), false);
  assert.equal(pluginRoutePathMatches("/vendor/job", "/vendor/job"), true);

  const panic = pluginRoutePanicError();
  assert.equal(panic.status, 500);
  assert.deepEqual(await panic.json(), {
    error: { message: "internal plugin route error", type: "plugin_route_error" },
  });
  const method = pluginMethodNotAllowed();
  assert.equal(method.status, 405);
  assert.equal(await method.text(), "");

  const { e, auth } = await boot();
  const up = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: pluginSource("method-owner", `[{method:"GET",path:"/vendor/jobs/:task_id",type:"query"}]`),
      }),
    }),
    e,
  );
  assert.equal(up.body.success, true, String(up.body.message));

  const mismatch = await handleFetch(new Request("http://local/vendor/jobs/task-1", { method: "POST" }), e, ctx());
  assert.equal(mismatch.status, 405);
  assert.equal(await mismatch.text(), "");

  const slash = await handleFetch(new Request("http://local/vendor/jobs/task-1/", { method: "GET" }), e, ctx());
  assert.equal(slash.status, 404);
  assert.equal(await slash.text(), "Not Found");

  const miss = await handleFetch(new Request("http://local/not-owned", { method: "GET" }), e, ctx());
  assert.equal(miss.status, 404);
  assert.equal(await miss.text(), "Not Found");
});
