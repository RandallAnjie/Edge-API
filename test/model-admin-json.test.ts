import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
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

test("original CreateModelMeta/UpdateModelMeta ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const emptyName = await json(
    new Request("http://local/api/models/", { method: "POST", headers: auth, body: JSON.stringify({ model_name: "" }) }),
    e,
  );
  assert.equal(emptyName.res.status, 200);
  assert.equal(emptyName.body.success, false);
  assert.equal(emptyName.body.message, "模型名称不能为空");
  assert.equal("data" in emptyName.body, false);
  assert.deepEqual(Object.keys(emptyName.body).sort(), ["message", "success"]);

  const created = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "meta-dup", status: 1 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const id = Number((created.body.data as { id: number }).id);

  const dup = await json(
    new Request("http://local/api/models/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ model_name: "meta-dup", status: 1 }),
    }),
    e,
  );
  assert.equal(dup.body.message, "模型名称已存在");
  assert.equal("data" in dup.body, false);

  const missingId = await json(
    new Request("http://local/api/models/", { method: "PUT", headers: auth, body: JSON.stringify({ model_name: "x" }) }),
    e,
  );
  assert.equal(missingId.body.message, "缺少模型 ID");
  assert.equal("data" in missingId.body, false);

  const badVis = await json(
    new Request("http://local/api/models/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id, status: 2 }),
    }),
    e,
  );
  assert.equal(badVis.body.message, "invalid catalog visibility");
  assert.equal("data" in badVis.body, false);

  const getBad = await json(new Request("http://local/api/models/abc", { headers: auth }), e);
  assert.equal(getBad.res.status, 200);
  assert.equal(getBad.body.success, false);
  assert.match(String(getBad.body.message), /strconv\.Atoi/);
  assert.equal("data" in getBad.body, false);

  const delBad = await json(new Request("http://local/api/models/abc", { method: "DELETE", headers: auth }), e);
  assert.match(String(delBad.body.message), /strconv\.Atoi/);
  assert.equal("data" in delBad.body, false);
});
