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

async function enableCreemTopup(store: Store, secret = "") {
  await store.setOption("CreemApiKey", "ck_test");
  await store.setOption("CreemProducts", JSON.stringify([{ productId: "prod_wallet", name: "Wallet", price: 8, quota: 250000 }]));
  if (secret) await store.setOption("CreemWebhookSecret", secret);
}

async function signedWebhook(e: Env, payload: unknown, secret = "creem_whsec") {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = await hmacSha256Hex(secret, raw);
  return json(
    new Request("http://local/api/creem/webhook", {
      method: "POST",
      headers: { "creem-signature": signature, "content-type": "application/json" },
      body: raw,
    }),
    e,
  );
}

test("original CreemWebhook requires secret, signature, and valid JSON", async () => {
  const { e, auth, store } = await boot();
  const disabled = await json(new Request("http://local/api/creem/webhook", { method: "POST", body: "{}" }), e);
  assert.equal(disabled.res.status, 403);
  assert.equal(disabled.text, "");

  await confirmCompliance(e, auth);
  await enableCreemTopup(store);
  const noSecret = await json(new Request("http://local/api/creem/webhook", { method: "POST", body: "{}" }), e);
  assert.equal(noSecret.res.status, 403);

  await store.setOption("CreemWebhookSecret", "creem_whsec");
  const missingSig = await json(
    new Request("http://local/api/creem/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    e,
  );
  assert.equal(missingSig.res.status, 401);
  assert.equal(missingSig.text, "");

  const badSig = await json(
    new Request("http://local/api/creem/webhook", {
      method: "POST",
      headers: { "creem-signature": "deadbeef", "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  assert.equal(badSig.res.status, 401);

  const invalidJson = await signedWebhook(e, "{");
  assert.equal(invalidJson.res.status, 400);
  assert.equal(invalidJson.text, "");
});

test("original CreemWebhook checkout.completed JSON fields and HTTP", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await enableCreemTopup(store, "creem_whsec");
  await store.updateUser(1, { email: "" });
  await store.insertTopup({
    user_id: 1,
    amount: 250000,
    money: 9.99,
    trade_no: "ref_paid",
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 250000,
    money: 9.99,
    trade_no: "ref_unpaid",
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 250000,
    money: 9.99,
    trade_no: "ref_sub",
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 250000,
    money: 9.99,
    trade_no: "ref_done",
    payment_method: "creem",
    payment_provider: "creem",
    status: "success",
  });

  const unpaid = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "ref_unpaid", order: { status: "unpaid", type: "onetime" } },
  });
  assert.equal(unpaid.res.status, 200);
  assert.equal((await store.getTopupByTrade("ref_unpaid"))?.status, "pending");

  const emptyStatus = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "ref_unpaid", order: { type: "onetime" } },
  });
  assert.equal(emptyStatus.res.status, 200);
  assert.equal((await store.getTopupByTrade("ref_unpaid"))?.status, "pending");

  const missingId = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { order: { status: "paid", type: "onetime" } },
  });
  assert.equal(missingId.res.status, 400);

  const missingOrder = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "missing", order: { status: "paid", type: "onetime" } },
  });
  assert.equal(missingOrder.res.status, 400);

  const notOnetime = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "ref_sub", order: { status: "paid", type: "subscription" } },
  });
  assert.equal(notOnetime.res.status, 200);
  assert.equal((await store.getTopupByTrade("ref_sub"))?.status, "pending");

  const emptyType = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "ref_sub", order: { status: "paid" } },
  });
  assert.equal(emptyType.res.status, 200);
  assert.equal((await store.getTopupByTrade("ref_sub"))?.status, "pending");

  const already = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: "ref_done", order: { status: "paid", type: "onetime" } },
  });
  assert.equal(already.res.status, 200);

  const paid = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: {
      request_id: "ref_paid",
      order: { status: "paid", type: "onetime" },
      customer: { email: "paid@example.com", name: "Buyer" },
    },
  });
  assert.equal(paid.res.status, 200);
  assert.equal(paid.text, "");
  assert.equal((await store.getTopupByTrade("ref_paid"))?.status, "success");
  const user = await store.getUserById(1);
  assert.equal(user?.quota, ROOT_QUOTA + 250000);
  assert.equal(user?.email, "paid@example.com");
});

test("original CreemWebhook CompleteSubscriptionOrder GetJsonString payload", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await enableCreemTopup(store, "creem_whsec");
  const plan = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        plan: {
          title: "Creem JSON",
          total_amount: 800,
          duration_unit: "day",
          duration_value: 30,
          price_amount: 8,
          upgrade_group: "vip",
        },
      }),
    }),
    e,
  );
  const planId = Number((plan.body.data as { id?: number })?.id || 0);
  assert.ok(planId, String(plan.body.message));
  const trade = "sub_ref_" + "c".repeat(40);
  await store.insertSubscriptionOrder({
    user_id: 1,
    plan_id: planId,
    money: 8,
    trade_no: trade,
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  const hook = await signedWebhook(e, {
    eventType: "checkout.completed",
    object: { request_id: trade, order: { id: "ord_1", status: "paid", type: "subscription" } },
  });
  assert.equal(hook.res.status, 200);
  const order = await store.getSubscriptionOrderByTrade(trade);
  assert.equal(order?.status, "success");
  const payload = JSON.parse(String(order?.provider_payload || "{}")) as {
    id: string;
    eventType: string;
    created_at: number;
    object: { request_id: string; order: { id: string; status: string; type: string; amount: number }; product: { price: number } };
  };
  assert.equal(payload.eventType, "checkout.completed");
  assert.equal(payload.id, "");
  assert.equal(payload.created_at, 0);
  assert.equal(payload.object.request_id, trade);
  assert.equal(payload.object.order.id, "ord_1");
  assert.equal(payload.object.order.status, "paid");
  assert.equal(payload.object.order.type, "subscription");
  assert.equal(payload.object.order.amount, 0);
  assert.equal(payload.object.product.price, 0);
  assert.equal("metadata" in payload.object, false);
});
