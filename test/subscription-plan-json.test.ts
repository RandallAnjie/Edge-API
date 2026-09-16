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
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) }), e);
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

test("original AdminCreate/UpdateSubscriptionPlan ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const emptyTitle = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan: { title: "  ", price_amount: 1 } }),
    }),
    e,
  );
  assert.equal(emptyTitle.res.status, 200);
  omitData(emptyTitle.body, "套餐标题不能为空");

  const neg = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan: { title: "neg", price_amount: -1 } }),
    }),
    e,
  );
  omitData(neg.body, "价格不能为负数");

  const unknownGroup = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan: { title: "g", upgrade_group: "no-such-group" } }),
    }),
    e,
  );
  omitData(unknownGroup.body, "升级分组不存在");

  const customReset = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan: { title: "reset", quota_reset_period: "custom", quota_reset_custom_seconds: 0 } }),
    }),
    e,
  );
  omitData(customReset.body, "自定义重置周期需大于0秒");

  const bindObj = await json(
    new Request("http://local/api/subscription/admin/plans", { method: "POST", headers: auth, body: "[]" }),
    e,
  );
  omitData(bindObj.body, "参数错误");

  const badId = await json(
    new Request("http://local/api/subscription/admin/plans/abc", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ plan: { title: "x" } }),
    }),
    e,
  );
  omitData(badId.body, "无效的ID");

  const patchBind = await json(
    new Request("http://local/api/subscription/admin/plans/1", { method: "PATCH", headers: auth, body: "{}" }),
    e,
  );
  omitData(patchBind.body, "参数错误");

  const createUser = await json(
    new Request("http://local/api/subscription/admin/users/abc/subscriptions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: 1 }),
    }),
    e,
  );
  omitData(createUser.body, "无效的用户ID");

  const pref = await json(
    new Request("http://local/api/subscription/self/preference", { method: "PUT", headers: auth, body: "[]" }),
    e,
  );
  omitData(pref.body, "参数错误");

  const pay = await json(
    new Request("http://local/api/subscription/balance/pay", { method: "POST", headers: auth, body: "" }),
    e,
  );
  omitData(pay.body, "参数错误");

  const inv = await json(
    new Request("http://local/api/subscription/admin/user_subscriptions/abc/invalidate", { method: "POST", headers: auth }),
    e,
  );
  omitData(inv.body, "无效的订阅ID");
});
