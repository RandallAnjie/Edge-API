import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
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
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  return { e, auth, store: new Store(e.DB) };
}

async function createPlan(e: Env, auth: Record<string, string>): Promise<number> {
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "reset-json",
          total_amount: 1000,
          duration_unit: "day",
          duration_value: 30,
          price_amount: 0,
          quota_reset_period: "daily",
        },
      }),
    }),
    e,
  );
  const id = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(id, String(plan.body.message));
  return id;
}

test("original AdminResetPlanSubscriptions JSON only zeros amount_used unless advance_reset_time", async () => {
  const { e, auth, store } = await boot();
  const planId = await createPlan(e, auth);
  await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  const rows = await store.listActiveUserSubs(1, planId);
  assert.equal(rows.length, 1);
  const subId = Number(rows[0].id);
  await store.updateUserSub(subId, {
    amount_used: 400,
    remaining_quota: 7,
    last_reset_time: 111,
    next_reset_time: 222,
  });

  const kept = await json(
    new Request("http://local/api/subscription/admin/plans/" + planId + "/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ advance_reset_time: false }),
    }),
    e,
  );
  assert.equal(kept.body.success, true);
  assert.equal(kept.body.message, "");
  assert.deepEqual(kept.body.data, {
    plan_id: planId,
    matched_count: 1,
    reset_count: 1,
    user_count: 1,
    advance_reset_time: false,
  });
  const afterKeep = await store.getUserSub(subId);
  assert.equal(Number(afterKeep?.amount_used), 0);
  assert.equal(Number(afterKeep?.remaining_quota), 7);
  assert.equal(Number(afterKeep?.last_reset_time), 111);
  assert.equal(Number(afterKeep?.next_reset_time), 222);

  await store.updateUserSub(subId, { amount_used: 250, remaining_quota: 7, last_reset_time: 111, next_reset_time: 222 });
  const advanced = await json(
    new Request("http://local/api/subscription/admin/plans/" + planId + "/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(advanced.body.success, true);
  const adv = advanced.body.data as { advance_reset_time: boolean; next_reset_time?: number };
  assert.equal(adv.advance_reset_time, true);
  const afterAdv = await store.getUserSub(subId);
  assert.equal(Number(afterAdv?.amount_used), 0);
  assert.equal(Number(afterAdv?.remaining_quota), 7);
  assert.notEqual(Number(afterAdv?.next_reset_time), 222);
  assert.notEqual(Number(afterAdv?.last_reset_time), 111);
});

test("original AdminResetUserSubscriptionsByPlan JSON errors", async () => {
  const { e, auth } = await boot();
  const planId = await createPlan(e, auth);

  const badUser = await json(
    new Request("http://local/api/subscription/admin/users/abc/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(badUser.body.success, false);
  assert.equal(badUser.body.message, "无效的用户ID");

  const empty = await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: "",
    }),
    e,
  );
  assert.equal(empty.body.message, "参数错误");

  const missingPlan = await json(
    new Request("http://local/api/subscription/admin/users/1/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(missingPlan.body.message, "该用户没有有效的此套餐订阅");

  const unknownPlan = await json(
    new Request("http://local/api/subscription/admin/plans/999999/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(unknownPlan.body.message, "record not found");

  const badPlanId = await json(
    new Request("http://local/api/subscription/admin/plans/abc/subscriptions/reset", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(badPlanId.body.message, "无效的ID");
});
