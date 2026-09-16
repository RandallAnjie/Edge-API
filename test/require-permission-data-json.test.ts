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

test("original RequirePermission leftover gin.H omit data", async () => {
  const { e, auth } = await boot();
  const created = await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "admin-perm", password: "password12", role: 10 }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const adminLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin-perm", password: "password12" }),
    }),
    e,
  );
  const adminAuth = {
    authorization: "Bearer " + (adminLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const users = await json(new Request("http://local/api/user/search?keyword=admin-perm", { headers: auth }), e);
  const adminRow = ((users.body.data as { items: { id: number; username: string }[] }).items || []).find((u) => u.username === "admin-perm");
  assert.ok(adminRow);
  await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: adminRow!.id, username: "admin-perm", admin_permissions: { channel: { read: false } } }),
    }),
    e,
  );

  const denied = await json(new Request("http://local/api/channel/", { headers: adminAuth }), e);
  assert.equal(denied.res.status, 403);
  omitData(denied.body, "Unauthorized, insufficient privileges");

  const zh = await json(
    new Request("http://local/api/channel/", { headers: { ...adminAuth, "accept-language": "zh-CN" } }),
    e,
  );
  assert.equal(zh.res.status, 403);
  omitData(zh.body, "无权进行此操作，权限不足");

  const tw = await json(
    new Request("http://local/api/channel/", { headers: { ...adminAuth, "accept-language": "zh-TW" } }),
    e,
  );
  assert.equal(tw.res.status, 403);
  omitData(tw.body, "無權進行此操作，權限不足");
});

test("original GetAllQuotaDates / GetUserQuotaDates leftover ApiError omit data", async () => {
  const { e, auth } = await boot();

  const span = await json(new Request("http://local/api/data/self?start_timestamp=1&end_timestamp=3000000", { headers: auth }), e);
  assert.equal(span.res.status, 200);
  omitData(span.body, "时间跨度不能超过 1 个月");

  await e.DB.exec("DROP TABLE quota_data");
  const listErr = await json(new Request("http://local/api/data/?start_timestamp=1&end_timestamp=10", { headers: auth }), e);
  assert.equal(listErr.res.status, 200);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.match(String(listErr.body.message), /no such table/i);
});
