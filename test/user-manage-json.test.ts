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

function omitDataSuccess(body: Record<string, unknown>) {
  assert.equal(body.success, true);
  assert.equal(body.message, "");
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
  const users = await json(new Request("http://local/api/user/?page_size=20", { headers: auth }), e);
  const root = ((users.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "root");
  assert.ok(root);
  return { e, auth, rootId: root.id };
}

const PASSWORD_MIN = "Key: 'User.Password' Error:Field validation for 'Password' failed on the 'min' tag";

test("original GetUser leftover ApiError / ApiErrorI18n gin.H omit data", async () => {
  const { e, auth } = await boot();

  const abc = await json(new Request("http://local/api/user/abc", { headers: auth }), e);
  assert.equal(abc.res.status, 200);
  omitData(abc.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/user/999999", { headers: auth }), e);
  omitData(missing.body, "record not found");
});

test("original CreateUser leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/user/", { method: "POST", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "Invalid parameters");

  const jsonNull = await json(new Request("http://local/api/user/", { method: "POST", headers: auth, body: "null" }), e);
  omitData(jsonNull.body, "Invalid parameters");

  const arr = await json(new Request("http://local/api/user/", { method: "POST", headers: auth, body: "[]" }), e);
  omitData(arr.body, "Invalid parameters");

  const noPassword = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "nopass" }),
    }),
    e,
  );
  omitData(noPassword.body, "Invalid parameters");

  const short = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "shortpw", password: "short" }),
    }),
    e,
  );
  omitData(short.body, "Invalid input " + PASSWORD_MIN);

  const higher = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "root2", password: "password12", role: 100 }),
    }),
    e,
  );
  omitData(higher.body, "Cannot create users with permission level equal to or higher than yourself");

  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "created-omit", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.res.status, 200);
  omitDataSuccess(created.body);
});

test("original UpdateUser leftover ApiError / ApiErrorI18n gin.H omit data", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/user/", { method: "PUT", headers: auth }), e);
  omitData(empty.body, "Invalid parameters");

  const noId = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ username: "x" }),
    }),
    e,
  );
  omitData(noId.body, "Invalid parameters");

  const missing = await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 999999, username: "missing" }),
    }),
    e,
  );
  omitData(missing.body, "record not found");
});

test("original ManageUser leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, auth, rootId } = await boot();

  const empty = await json(new Request("http://local/api/user/manage", { method: "POST", headers: auth }), e);
  omitData(empty.body, "Invalid parameters");

  const jsonNull = await json(
    new Request("http://local/api/user/manage", { method: "POST", headers: auth, body: "null" }),
    e,
  );
  omitData(jsonNull.body, "User does not exist");

  const missing = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: 999999, action: "disable" }),
    }),
    e,
  );
  omitData(missing.body, "User does not exist");

  const disableRoot = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: rootId, action: "disable" }),
    }),
    e,
  );
  omitData(disableRoot.body, "Cannot disable super administrator user");

  const deleteRoot = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: rootId, action: "delete" }),
    }),
    e,
  );
  omitData(deleteRoot.body, "Cannot delete super administrator account");

  const demoteRoot = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: rootId, action: "demote" }),
    }),
    e,
  );
  omitData(demoteRoot.body, "Cannot demote super administrator user");

  const unknown = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: rootId, action: "nope" }),
    }),
    e,
  );
  omitData(unknown.body, "Invalid parameters");

  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "manage-del", password: "password12" }),
    }),
    e,
  );
  omitDataSuccess(created.body);
  const found = await json(new Request("http://local/api/user/search?keyword=manage-del", { headers: auth }), e);
  const row = ((found.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "manage-del");
  assert.ok(row);
  const deleted = await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: row.id, action: "delete" }),
    }),
    e,
  );
  omitDataSuccess(deleted.body);
});

test("original DeleteUser leftover ApiError / ApiErrorI18n gin.H omit data", async () => {
  const { e, auth, rootId } = await boot();

  const abc = await json(new Request("http://local/api/user/abc", { method: "DELETE", headers: auth }), e);
  omitData(abc.body, 'strconv.Atoi: parsing "abc": invalid syntax');

  const missing = await json(new Request("http://local/api/user/999999", { method: "DELETE", headers: auth }), e);
  omitData(missing.body, "record not found");

  const root = await json(new Request("http://local/api/user/" + rootId, { method: "DELETE", headers: auth }), e);
  omitData(root.body, "Cannot delete super administrator account");
});
