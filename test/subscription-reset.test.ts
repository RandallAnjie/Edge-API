import assert from "node:assert/strict";
import { test } from "node:test";
import { calcNextResetTime } from "../src/subscription.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
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
  return { e, auth, store: new Store(e.DB) };
}

function expectedAdvancedReset(
  plan: Record<string, unknown>,
  lastReset: number,
  start: number,
  end: number,
  now: number,
) {
  let baseUnix = lastReset > 0 ? lastReset : start;
  let next = calcNextResetTime(baseUnix, plan, end);
  let advanced = false;
  let base = baseUnix;
  while (next > 0 && next <= now) {
    advanced = true;
    base = next;
    next = calcNextResetTime(base, plan, end);
  }
  return { advanced, last_reset_time: base, next_reset_time: next };
}

test("original calcNextResetTime custom seconds <= 0 JSON", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(calcNextResetTime(now, { quota_reset_period: "custom", quota_reset_custom_seconds: 0 }, now + 86400 * 30), 0);
  assert.equal(calcNextResetTime(now, { quota_reset_period: "never" }, now + 86400 * 30), 0);
  const daily = calcNextResetTime(now, { quota_reset_period: "daily" }, now + 86400 * 30);
  assert.ok(daily > now);
});

test("original ResetDueSubscriptions GET /api/subscription/self amount_used JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const now = Math.floor(Date.now() / 1000);
  const start = now - 3 * 86400;
  const end = now + 30 * 86400;
  const lastReset = start;
  const due = now - 3600;
  const planId = await store.insertPlan({
    title: "Daily Reset",
    quota_reset_period: "daily",
    total_amount: 10_000,
    grant_quota: 10_000,
    enabled: 1,
  });
  const subId = await store.insertUserSub({
    user_id: root.id,
    plan_id: planId,
    amount_total: 10_000,
    amount_used: 7_500,
    start_time: start,
    end_time: end,
    status: "active",
    last_reset_time: lastReset,
    next_reset_time: due,
  });
  const pending: Promise<unknown>[] = [];
  await worker.scheduled({}, e, {
    waitUntil(p) {
      pending.push(p);
    },
  });
  await Promise.all(pending);
  const plan = await store.getPlan(planId);
  assert.ok(plan);
  const expected = expectedAdvancedReset(plan, lastReset, start, end, Math.floor(Date.now() / 1000));
  assert.equal(expected.advanced, true);
  const self = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  const data = self.body.data as { subscriptions: { subscription: Record<string, unknown> }[] };
  const sub = data.subscriptions.find((item) => Number(item.subscription.id) === subId)?.subscription;
  assert.ok(sub, self.text);
  assert.equal(sub.status, "active");
  assert.equal(sub.amount_used, 0);
  assert.equal(sub.amount_total, 10_000);
  assert.equal(sub.last_reset_time, expected.last_reset_time);
  assert.equal(sub.next_reset_time, expected.next_reset_time);
  assert.ok(Number(sub.next_reset_time) > now);
  const persisted = await store.getUserSub(subId);
  assert.equal(Number(persisted?.amount_used), 0);
  assert.equal(Number(persisted?.last_reset_time), expected.last_reset_time);
  assert.equal(Number(persisted?.next_reset_time), expected.next_reset_time);
});

test("original PreConsumeUserSubscription maybeReset zeros amount_used JSON", async () => {
  const { store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const now = Math.floor(Date.now() / 1000);
  const start = now - 3 * 86400;
  const end = now + 30 * 86400;
  const planId = await store.insertPlan({
    title: "Daily PreConsume",
    quota_reset_period: "daily",
    total_amount: 10_000,
    grant_quota: 10_000,
    enabled: 1,
  });
  const subId = await store.insertUserSub({
    user_id: root.id,
    plan_id: planId,
    amount_total: 10_000,
    amount_used: 9_000,
    start_time: start,
    end_time: end,
    status: "active",
    last_reset_time: start,
    next_reset_time: now - 60,
  });
  const result = await store.preConsumeUserSubscription("req-reset-1", root.id, 2_000);
  assert.equal(result.userSubscriptionId, subId);
  assert.equal(result.preConsumed, 2_000);
  assert.equal(result.amountUsedBefore, 0);
  assert.equal(result.amountUsedAfter, 2_000);
  const persisted = await store.getUserSub(subId);
  assert.equal(Number(persisted?.amount_used), 2_000);
  assert.ok(Number(persisted?.next_reset_time) > now);
});

test("original ResetDueSubscriptions never period keeps amount_used JSON", async () => {
  const { store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const now = Math.floor(Date.now() / 1000);
  const planId = await store.insertPlan({
    title: "Never Reset",
    quota_reset_period: "never",
    total_amount: 5_000,
    grant_quota: 5_000,
    enabled: 1,
  });
  const subId = await store.insertUserSub({
    user_id: root.id,
    plan_id: planId,
    amount_total: 5_000,
    amount_used: 1_234,
    start_time: now - 86400,
    end_time: now + 86400,
    status: "active",
    last_reset_time: now - 86400,
    next_reset_time: now - 10,
  });
  const n = await store.resetDueSubscriptions(200);
  assert.equal(n, 1);
  const persisted = await store.getUserSub(subId);
  assert.equal(Number(persisted?.amount_used), 1_234);
  assert.equal(Number(persisted?.next_reset_time), now - 10);
});

test("original ExpireDueSubscriptions marks end_time == now expired JSON", async () => {
  const { e, auth, store } = await boot();
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  const now = Math.floor(Date.now() / 1000);
  const planId = await store.insertPlan({
    title: "Expiring",
    quota_reset_period: "never",
    total_amount: 1_000,
    enabled: 1,
  });
  const subId = await store.insertUserSub({
    user_id: root.id,
    plan_id: planId,
    amount_total: 1_000,
    amount_used: 10,
    start_time: now - 86400,
    end_time: now,
    status: "active",
  });
  await store.expireSubscriptions();
  const persisted = await store.getUserSub(subId);
  assert.equal(String(persisted?.status), "expired");
  const self = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const data = self.body.data as {
    subscriptions: { subscription: Record<string, unknown> }[];
    all_subscriptions: { subscription: Record<string, unknown> }[];
  };
  assert.equal(data.subscriptions.length, 0);
  const all = data.all_subscriptions.find((item) => Number(item.subscription.id) === subId)?.subscription;
  assert.ok(all, self.text);
  assert.equal(all.status, "expired");
  assert.equal(all.amount_used, 10);
});
