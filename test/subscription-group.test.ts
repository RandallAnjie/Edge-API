import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

void worker;

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
  return { e, auth, store: new Store(e.DB) };
}

async function selfGroup(e: Env, auth: Record<string, string>) {
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  return (self.body.data as { group: string }).group;
}

async function selfSubscription(e: Env, auth: Record<string, string>, subId: number) {
  const listed = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  assert.equal(listed.body.success, true, String(listed.body.message));
  const data = listed.body.data as {
    subscriptions: { subscription: Record<string, unknown> }[];
    all_subscriptions: { subscription: Record<string, unknown> }[];
  };
  const active = data.subscriptions.find((item) => Number(item.subscription.id) === subId)?.subscription;
  const all = data.all_subscriptions.find((item) => Number(item.subscription.id) === subId)?.subscription;
  return { data, active, all };
}

test("original AdminBindSubscription GET /api/user/self group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "VIP",
          total_amount: 1000,
          duration_unit: "day",
          duration_value: 30,
          price_amount: 0,
          upgrade_group: "vip",
        },
      }),
    }),
    e,
  );
  const planId = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(planId, String(plan.body.message));
  const bind = await json(
    new Request("http://local/api/subscription/admin/bind", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: root.id, plan_id: planId }),
    }),
    e,
  );
  assert.equal(bind.body.success, true, String(bind.body.message));
  assert.deepEqual(bind.body.data, { message: "用户分组将升级到 vip" }, bind.text);
  assert.equal(await selfGroup(e, auth), "vip");
  const listed = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const sub = (listed.body.data as { subscriptions: { subscription: Record<string, unknown> }[] }).subscriptions[0]
    ?.subscription;
  assert.ok(sub, listed.text);
  assert.equal(sub.upgrade_group, "vip");
  assert.equal(sub.prev_user_group, "default");
  assert.equal(sub.downgrade_group, "");
  assert.equal(sub.source, "admin");
  assert.equal(sub.status, "active");
});

test("original AdminCreateUserSubscription POST users/:id/subscriptions group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const planId = await store.insertPlan({
    title: "Pro",
    quota_reset_period: "never",
    total_amount: 500,
    enabled: 1,
    upgrade_group: "pro",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await json(
    new Request(`http://local/api/subscription/admin/users/${root.id}/subscriptions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  assert.deepEqual(created.body.data, { message: "用户分组将升级到 pro" }, created.text);
  assert.equal(await selfGroup(e, auth), "pro");
});

test("original ExpireDueSubscriptions reverts GET /api/user/self group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const planId = await store.insertPlan({
    title: "Expiring VIP",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await store.createUserSubscriptionFromPlan(root.id, (await store.getPlan(planId))!, "admin");
  assert.equal(created.prev_user_group, "default");
  assert.equal(await selfGroup(e, auth), "vip");
  const now = Math.floor(Date.now() / 1000);
  await store.updateUserSub(created.id, { end_time: now, expire_at: now });
  const n = await store.expireSubscriptions();
  assert.equal(n, 1);
  assert.equal(await selfGroup(e, auth), "default");
  const { all } = await selfSubscription(e, auth, created.id);
  assert.ok(all, "expired subscription missing");
  assert.equal(all.status, "expired");
  assert.equal(all.prev_user_group, "default");
  assert.equal(all.upgrade_group, "vip");
});

test("original ExpireDueSubscriptions explicit downgrade_group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const planId = await store.insertPlan({
    title: "SVIP fall",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    downgrade_group: "svip",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await store.createUserSubscriptionFromPlan(root.id, (await store.getPlan(planId))!, "order");
  assert.equal(await selfGroup(e, auth), "vip");
  const now = Math.floor(Date.now() / 1000);
  await store.updateUserSub(created.id, { end_time: now, expire_at: now });
  await store.expireSubscriptions();
  assert.equal(await selfGroup(e, auth), "svip");
  const { all } = await selfSubscription(e, auth, created.id);
  assert.equal(all?.downgrade_group, "svip");
});

test("original ExpireDueSubscriptions keeps group while another upgrade_group is active JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const planId = await store.insertPlan({
    title: "Stacked",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const plan = (await store.getPlan(planId))!;
  const first = await store.createUserSubscriptionFromPlan(root.id, plan, "admin");
  const second = await store.createUserSubscriptionFromPlan(root.id, plan, "admin");
  const now = Math.floor(Date.now() / 1000);
  await store.updateUserSub(first.id, { end_time: now, expire_at: now });
  await store.expireSubscriptions();
  assert.equal(await selfGroup(e, auth), "vip");
  const { all: expired, active } = await selfSubscription(e, auth, first.id);
  assert.equal(expired?.status, "expired");
  const still = await selfSubscription(e, auth, second.id);
  assert.equal(still.active?.status, "active");
  assert.ok(active == null);
});

test("original ExpireDueSubscriptions skips revert when current group != upgrade_group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const planId = await store.insertPlan({
    title: "Moved",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await store.createUserSubscriptionFromPlan(root.id, (await store.getPlan(planId))!, "admin");
  await store.updateUser(root.id, { group: "other" });
  const now = Math.floor(Date.now() / 1000);
  await store.updateUserSub(created.id, { end_time: now, expire_at: now });
  await store.expireSubscriptions();
  assert.equal(await selfGroup(e, auth), "other");
});

test("original AdminInvalidateUserSubscription GET /api/user/self group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const planId = await store.insertPlan({
    title: "Cancel me",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await store.adminBindSubscription(root.id, planId);
  assert.equal(await selfGroup(e, auth), "vip");
  const invalidated = await json(
    new Request(`http://local/api/subscription/admin/user_subscriptions/${created.id}/invalidate`, {
      method: "POST",
      headers: auth,
    }),
    e,
  );
  assert.equal(invalidated.body.success, true, String(invalidated.body.message));
  assert.deepEqual(invalidated.body.data, { message: "用户分组将回退到 default" }, invalidated.text);
  assert.equal(await selfGroup(e, auth), "default");
  const { all } = await selfSubscription(e, auth, created.id);
  assert.equal(all?.status, "cancelled");
});

test("original AdminDeleteUserSubscription GET /api/user/self group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const planId = await store.insertPlan({
    title: "Delete me",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const created = await store.adminBindSubscription(root.id, planId);
  const deleted = await json(
    new Request(`http://local/api/subscription/admin/user_subscriptions/${created.id}`, {
      method: "DELETE",
      headers: auth,
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.deepEqual(deleted.body.data, { message: "用户分组将回退到 default" }, deleted.text);
  assert.equal(await selfGroup(e, auth), "default");
  const listed = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const data = listed.body.data as { all_subscriptions: { subscription: Record<string, unknown> }[] };
  assert.equal(data.all_subscriptions.find((item) => Number(item.subscription.id) === created.id), undefined);
});

test("original CreateUserSubscriptionFromPlanTx max purchase JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const planId = await store.insertPlan({
    title: "Once",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    max_purchase_per_user: 1,
    duration_unit: "day",
    duration_value: 30,
  });
  const first = await json(
    new Request("http://local/api/subscription/admin/bind", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: root.id, plan_id: planId }),
    }),
    e,
  );
  assert.equal(first.body.success, true, String(first.body.message));
  const second = await json(
    new Request("http://local/api/subscription/admin/bind", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: root.id, plan_id: planId }),
    }),
    e,
  );
  assert.equal(second.body.success, false);
  assert.equal(second.body.message, "已达到该套餐购买上限");
});

test("original PurchaseSubscriptionWithBalance source and group JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  const planId = await store.insertPlan({
    title: "Balance VIP",
    quota_reset_period: "never",
    total_amount: 1000,
    enabled: 1,
    price_amount: 0,
    upgrade_group: "vip",
    duration_unit: "day",
    duration_value: 30,
  });
  const buy = await json(
    new Request("http://local/api/subscription/balance/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId }),
    }),
    e,
  );
  assert.equal(buy.body.success, true, String(buy.body.message));
  assert.equal(buy.body.data, null);
  assert.equal(await selfGroup(e, auth), "vip");
  const listed = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const sub = (listed.body.data as { subscriptions: { subscription: Record<string, unknown> }[] }).subscriptions[0]
    ?.subscription;
  assert.ok(sub, listed.text);
  assert.equal(sub.source, "balance");
  assert.equal(sub.upgrade_group, "vip");
  assert.equal(sub.prev_user_group, "default");
});
