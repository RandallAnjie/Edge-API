import assert from "node:assert/strict";
import { test } from "node:test";
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

test("original CreateLogCleanupSystemTask leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const missing = await json(new Request("http://local/api/system-task/log-cleanup", { method: "POST", headers: auth }), e);
  assert.equal(missing.res.status, 200);
  omitData(missing.body, "target timestamp is required");

  const zero = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=0", { method: "POST", headers: auth }),
    e,
  );
  omitData(zero.body, "target timestamp is required");

  const float = await json(
    new Request("http://local/api/system-task/log-cleanup?target_timestamp=1.5", { method: "POST", headers: auth }),
    e,
  );
  omitData(float.body, "target timestamp is required");
});

test("original GetCurrentSystemTask / GetSystemTask leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const typeMissing = await json(new Request("http://local/api/system-task/current", { headers: auth }), e);
  assert.equal(typeMissing.res.status, 200);
  omitData(typeMissing.body, "type is required");

  const missingId = await json(new Request("http://local/api/system-task/systask_missing", { headers: auth }), e);
  assert.equal(missingId.res.status, 404);
  omitData(missingId.body, "task not found");

  await e.DB.exec("DROP TABLE system_tasks");
  const listErr = await json(new Request("http://local/api/system-task/list", { headers: auth }), e);
  assert.equal(listErr.res.status, 200);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});
