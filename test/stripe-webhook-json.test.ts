import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_QUOTA } from "../src/constants.js";
import { hmacSha256Hex } from "../src/crypto.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { createMemoryD1 } from "./d1-memory.js";
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

async function confirmCompliance(e: Env, auth: Record<string, string>) {
  const res = await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth, body: JSON.stringify({ confirmed: true }) }), e);
  assert.equal(res.body.success, true, String(res.body.message));
}

async function enableStripe(store: Store) {
  await store.setOption("StripeApiSecret", "sk_test_json");
  await store.setOption("StripeWebhookSecret", "whsec_test");
  await store.setOption("StripePriceId", "price_json");
}

async function stripeSignature(secret: string, raw: string, t = String(Math.floor(Date.now() / 1000))): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${t}.${raw}`);
  return `t=${t},v1=${v1}`;
}

async function postWebhook(e: Env, raw: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature != null) headers.set("Stripe-Signature", signature);
  return json(new Request("http://local/api/stripe/webhook", { method: "POST", headers, body: raw }), e);
}

async function signedWebhook(e: Env, payload: unknown, t?: string) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return postWebhook(e, raw, await stripeSignature("whsec_test", raw, t));
}

test("original StripeWebhook disabled, signature, and JSON HTTP", async () => {
  const { e, auth, store } = await boot();

  const disabled = await postWebhook(e, "{}", null);
  assert.equal(disabled.res.status, 403);
  assert.equal(disabled.text, "");

  await confirmCompliance(e, auth);
  await enableStripe(store);

  const missingSig = await postWebhook(e, "{}", null);
  assert.equal(missingSig.res.status, 400);
  assert.equal(missingSig.text, "");

  const stale = await signedWebhook(e, { type: "checkout.session.completed" }, "1710000000");
  assert.equal(stale.res.status, 400);

  const invalidJson = await signedWebhook(e, "{");
  assert.equal(invalidJson.res.status, 400);
  assert.equal(invalidJson.text, "");
});

test("original StripeWebhook checkout.session JSON fields and fulfill payload", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await enableStripe(store);

  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-1",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-meta",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-async",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-fail",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-exp",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });

  const missingStatus = await signedWebhook(e, {
    type: "checkout.session.completed",
    data: { object: { client_reference_id: "STRIPE-1", payment_status: "paid", customer: "cus_1" } },
  });
  assert.equal(missingStatus.res.status, 200);
  assert.equal(missingStatus.text, "");
  assert.equal((await store.getTopupByTrade("STRIPE-1"))?.status, "pending");

  const unpaid = await signedWebhook(e, {
    type: "checkout.session.completed",
    data: {
      object: { client_reference_id: "STRIPE-1", status: "complete", payment_status: "unpaid", customer: "cus_1" },
    },
  });
  assert.equal(unpaid.res.status, 200);
  assert.equal((await store.getTopupByTrade("STRIPE-1"))?.status, "pending");

  const metadataOnly = await signedWebhook(e, {
    type: "checkout.session.completed",
    data: {
      object: {
        status: "complete",
        payment_status: "paid",
        metadata: { trade_no: "STRIPE-meta" },
        customer: "cus_meta",
      },
    },
  });
  assert.equal(metadataOnly.res.status, 200);
  assert.equal((await store.getTopupByTrade("STRIPE-meta"))?.status, "pending");

  const paid = await signedWebhook(e, {
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: "STRIPE-1",
        status: "complete",
        payment_status: "paid",
        customer: "cus_test_1",
        amount_total: 850,
        currency: "usd",
      },
    },
  });
  assert.equal(paid.res.status, 200);
  assert.equal(paid.text, "");
  assert.equal((await store.getTopupByTrade("STRIPE-1"))?.status, "success");
  const user = await store.getUserById(1);
  assert.equal(user?.quota, ROOT_QUOTA + 4_250_000);
  assert.equal(user?.stripe_customer, "cus_test_1");

  const asyncPaid = await signedWebhook(e, {
    type: "checkout.session.async_payment_succeeded",
    data: { object: { client_reference_id: "STRIPE-async", customer: "cus_async" } },
  });
  assert.equal(asyncPaid.res.status, 200);
  assert.equal((await store.getTopupByTrade("STRIPE-async"))?.status, "success");
  assert.equal((await store.getUserById(1))?.stripe_customer, "cus_async");

  const asyncFailed = await signedWebhook(e, {
    type: "checkout.session.async_payment_failed",
    data: { object: { client_reference_id: "STRIPE-fail" } },
  });
  assert.equal(asyncFailed.res.status, 200);
  const failed = await store.getTopupByTrade("STRIPE-fail");
  assert.equal(failed?.status, "failed");
  assert.equal(Number(failed?.complete_time || 0), 0);

  const expired = await signedWebhook(e, {
    type: "checkout.session.expired",
    data: { object: { client_reference_id: "STRIPE-exp", status: "expired" } },
  });
  assert.equal(expired.res.status, 200);
  assert.equal((await store.getTopupByTrade("STRIPE-exp"))?.status, "expired");
});

test("original StripeWebhook fulfillOrder subscription provider_payload JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await enableStripe(store);
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "Stripe JSON",
          total_amount: 1000,
          duration_unit: "day",
          duration_value: 30,
          price_amount: 12,
          upgrade_group: "vip",
        },
      }),
    }),
    e,
  );
  const planId = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(planId, String(plan.body.message));
  const trade = "sub_ref_" + "b".repeat(40);
  await store.insertSubscriptionOrder({
    user_id: 1,
    plan_id: planId,
    money: 12,
    trade_no: trade,
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  const hook = await signedWebhook(e, {
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: trade,
        status: "complete",
        payment_status: "paid",
        customer: "cus_sub",
        amount_total: 1200,
        currency: "usd",
      },
    },
  });
  assert.equal(hook.res.status, 200);
  const order = await store.getSubscriptionOrderByTrade(trade);
  assert.equal(order?.status, "success");
  assert.equal(
    String(order?.provider_payload || ""),
    JSON.stringify({
      amount_total: "1200",
      currency: "USD",
      customer: "cus_sub",
      event_type: "checkout.session.completed",
    }),
  );
});
