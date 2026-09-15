import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { hmacSha256Hex, md5Hex } from "../src/crypto.js";
import { LOG_TOPUP, ROOT_QUOTA } from "../src/constants.js";
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

async function confirmCompliance(e: Env, auth: Record<string, string>) {
  const res = await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  assert.equal(res.body.success, true, String(res.body.message));
}

async function createPlan(
  e: Env,
  auth: Record<string, string>,
  plan: Record<string, unknown>,
): Promise<number> {
  const res = await json(
    new Request("http://local/api/subscription/admin/plans", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan }),
    }),
    e,
  );
  const id = Number((res.body.data as { id?: number })?.id || 0);
  assert.ok(id, String(res.body.message));
  return id;
}

async function selfGroup(e: Env, auth: Record<string, string>) {
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.equal(self.body.success, true, String(self.body.message));
  return (self.body.data as { group: string; quota: number }).group;
}

async function selfQuota(e: Env, auth: Record<string, string>) {
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  return Number((self.body.data as { quota: number }).quota);
}

async function epaySign(params: Record<string, string>, key: string): Promise<string> {
  const parts = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return md5Hex(parts.join("&") + key);
}

async function stripeSignature(secret: string, raw: string, t = "1710000000"): Promise<string> {
  const v1 = await hmacSha256Hex(secret, `${t}.${raw}`);
  return `t=${t},v1=${v1}`;
}

test("original SubscriptionRequestEpay pay/notify/return JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("PayAddress", "https://epay.example/submit.php");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("ServerAddress", "http://local");
  const planId = await createPlan(e, auth, {
    title: "VIP Month",
    total_amount: 1000,
    duration_unit: "day",
    duration_value: 30,
    price_amount: 9.9,
    upgrade_group: "vip",
  });

  const missing = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    }),
    e,
  );
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "参数错误");

  const unknownPlan = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: 99999, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(unknownPlan.body.message, "record not found");

  const badMethod = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId, payment_method: "not-a-method" }),
    }),
    e,
  );
  assert.equal(badMethod.body.message, "支付方式不存在");

  const cheapId = await createPlan(e, auth, {
    title: "Cheap",
    total_amount: 10,
    duration_unit: "day",
    duration_value: 1,
    price_amount: 0.001,
  });
  const cheap = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: cheapId, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(cheap.body.message, "套餐金额过低");

  const disabledId = await createPlan(e, auth, {
    title: "Off",
    total_amount: 10,
    duration_unit: "day",
    duration_value: 1,
    price_amount: 1,
    enabled: false,
  });
  const disabled = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: disabledId, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(disabled.body.message, "套餐未启用");

  const pay = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(pay.body.message, "success", pay.text);
  assert.equal(typeof pay.body.url, "string");
  assert.match(String(pay.body.url), /^https:\/\/epay\.example\/submit\.php\?/);
  const params = pay.body.data as Record<string, string>;
  assert.match(params.out_trade_no, /^SUBUSR\d+NO[0-9a-zA-Z]{6}\d+$/);
  assert.equal(params.name, "SUB:VIP Month");
  assert.equal(params.money, "9.90");
  assert.equal(params.type, "alipay");
  assert.equal(params.device, "pc");
  assert.equal(params.notify_url, "http://local/api/subscription/epay/notify");
  assert.equal(params.return_url, "http://local/api/subscription/epay/return");
  assert.equal(params.sign_type, "MD5");
  assert.ok(params.sign);

  const emptyNotify = await json(new Request("http://local/api/subscription/epay/notify"), e);
  assert.equal(emptyNotify.text, "fail");
  const emptyReturn = await json(new Request("http://local/api/subscription/epay/return"), e);
  assert.equal(emptyReturn.res.status, 302);
  assert.equal(emptyReturn.res.headers.get("location"), "http://local/wallet?pay=fail");

  const pendingParams: Record<string, string> = { ...params, trade_status: "WAIT_BUYER_PAY" };
  pendingParams.sign = await epaySign(pendingParams, "epay-secret");
  const pendingQs = new URLSearchParams(pendingParams).toString();
  const pendingReturn = await json(new Request("http://local/api/subscription/epay/return?" + pendingQs), e);
  assert.equal(pendingReturn.res.status, 302);
  assert.equal(pendingReturn.res.headers.get("location"), "http://local/wallet?pay=pending");
  const pendingOrder = await store.getSubscriptionOrderByTrade(params.out_trade_no);
  assert.equal(pendingOrder?.status, "pending");

  const walletNotify = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams({ out_trade_no: params.out_trade_no, trade_status: "TRADE_SUCCESS" })),
    e,
  );
  assert.equal(walletNotify.text, "fail");
  assert.equal((await store.getSubscriptionOrderByTrade(params.out_trade_no))?.status, "pending");
  assert.equal(await selfGroup(e, auth), "default");

  const okParams: Record<string, string> = { ...params, trade_status: "TRADE_SUCCESS" };
  okParams.sign = await epaySign(okParams, "epay-secret");
  const notify = await json(new Request("http://local/api/subscription/epay/notify?" + new URLSearchParams(okParams)), e);
  assert.equal(notify.text, "success");
  const again = await json(new Request("http://local/api/subscription/epay/notify?" + new URLSearchParams(okParams)), e);
  assert.equal(again.text, "success");
  assert.equal(await selfGroup(e, auth), "vip");
  assert.equal(await selfQuota(e, auth), ROOT_QUOTA);

  const listed = await json(new Request("http://local/api/subscription/self", { headers: auth }), e);
  const sub = (listed.body.data as { subscriptions: { subscription: Record<string, unknown> }[] }).subscriptions[0]
    ?.subscription;
  assert.ok(sub, listed.text);
  assert.equal(sub.source, "order");
  assert.equal(sub.status, "active");
  assert.equal(sub.upgrade_group, "vip");
  assert.equal(sub.prev_user_group, "default");

  const topups = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
  const top = (topups.body.data as { items: Record<string, unknown>[] }).items.find((item) => item.trade_no === params.out_trade_no);
  assert.ok(top, topups.text);
  assert.equal(top.amount, 0);
  assert.equal(Number(top.money), 9.9);
  assert.equal(top.status, "success");
  assert.equal(top.trade_no, params.out_trade_no);
  assert.equal(top.payment_method, "alipay");
  assert.ok(Number(top.complete_time) > 0);
  assert.ok(Number(top.create_time) > 0);

  const logs = await store.listLogs({ offset: 0, limit: 20, userId: 1, type: LOG_TOPUP });
  assert.ok(logs.items.some((row) => String(row.content).includes("订阅购买成功，套餐: VIP Month，支付金额: 9.90，支付方式: alipay")));

  const successReturn = await json(new Request("http://local/api/subscription/epay/return?" + new URLSearchParams(okParams)), e);
  assert.equal(successReturn.res.headers.get("location"), "http://local/wallet?pay=success");
});

test("original CompleteSubscriptionOrder payment method mismatch JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("PayAddress", "https://epay.example/submit.php");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("StripeApiSecret", "sk_test_123");
  await store.setOption("StripeWebhookSecret", "whsec_test");
  await store.setOption("StripePriceId", "price_wallet");
  const planId = await createPlan(e, auth, {
    title: "Guard",
    total_amount: 500,
    duration_unit: "day",
    duration_value: 7,
    price_amount: 5,
  });
  const pay = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: planId, payment_method: "alipay" }),
    }),
    e,
  );
  const trade = String((pay.body.data as { out_trade_no: string }).out_trade_no);
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: trade,
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  const raw = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { client_reference_id: trade, status: "complete", payment_status: "paid" } },
  });
  const hook = await json(
    new Request("http://local/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": await stripeSignature("whsec_test", raw), "content-type": "application/json" },
      body: raw,
    }),
    e,
  );
  assert.equal(hook.res.status, 200);
  assert.equal((await store.getSubscriptionOrderByTrade(trade))?.status, "pending");
  assert.equal((await store.getTopupByTrade(trade))?.status, "pending");
  assert.equal(await selfQuota(e, auth), ROOT_QUOTA);
  assert.equal(await selfGroup(e, auth), "default");
});

test("original SubscriptionRequestStripePay pay_link and webhook CompleteSubscriptionOrder JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("StripeApiSecret", "sk_test_123");
  await store.setOption("StripeWebhookSecret", "whsec_test");
  const planId = await createPlan(e, auth, {
    title: "Stripe VIP",
    total_amount: 2000,
    duration_unit: "day",
    duration_value: 30,
    price_amount: 12,
    upgrade_group: "vip",
    stripe_price_id: "price_sub_vip",
  });
  const origFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("api.stripe.com/v1/checkout/sessions")) {
      captured = String(init?.body || "");
      return new Response(JSON.stringify({ id: "cs_sub", url: "https://checkout.stripe.com/c/pay/cs_sub" }), { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const pay = await json(
      new Request("http://local/api/subscription/stripe/pay", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ plan_id: planId }),
      }),
      e,
    );
    assert.equal(pay.body.message, "success", pay.text);
    const data = pay.body.data as { pay_link: string };
    assert.equal(data.pay_link, "https://checkout.stripe.com/c/pay/cs_sub");
    assert.match(captured, /mode=subscription/);
    assert.ok(captured.includes("quantity=1") || captured.includes("quantity%5D=1"));
    assert.match(captured, /price_sub_vip/);
    const orderRow = await e.DB.prepare("SELECT trade_no FROM subscription_orders ORDER BY id DESC LIMIT 1").first<{ trade_no: string }>();
    const trade = String(orderRow?.trade_no || "");
    assert.match(trade, /^sub_ref_[0-9a-f]{40}$/);
    const order = await store.getSubscriptionOrderByTrade(trade);
    assert.equal(order?.payment_provider, "stripe");
    assert.equal(order?.status, "pending");

    await store.setOption("StripePriceId", "price_wallet");
    const raw = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: trade, status: "complete", payment_status: "paid" } },
    });
    const hook = await json(
      new Request("http://local/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": await stripeSignature("whsec_test", raw), "content-type": "application/json" },
        body: raw,
      }),
      e,
    );
    assert.equal(hook.res.status, 200);
    assert.equal((await store.getSubscriptionOrderByTrade(trade))?.status, "success");
    assert.equal(await selfGroup(e, auth), "vip");
    assert.equal(await selfQuota(e, auth), ROOT_QUOTA);
    const topups = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
    const top = (topups.body.data as { items: Record<string, unknown>[] }).items.find((item) => item.trade_no === trade);
    assert.ok(top);
    assert.equal(top.amount, 0);
    assert.equal(Number(top.money), 12);
    assert.equal(top.status, "success");
    assert.equal(top.trade_no, trade);

    const expiredTrade = "sub_ref_" + "a".repeat(40);
    await store.insertSubscriptionOrder({
      user_id: 1,
      plan_id: planId,
      money: 12,
      trade_no: expiredTrade,
      payment_method: "stripe",
      payment_provider: "stripe",
      status: "pending",
    });
    const expiredRaw = JSON.stringify({
      type: "checkout.session.expired",
      data: { object: { client_reference_id: expiredTrade, status: "expired" } },
    });
    const expired = await json(
      new Request("http://local/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": await stripeSignature("whsec_test", expiredRaw), "content-type": "application/json" },
        body: expiredRaw,
      }),
      e,
    );
    assert.equal(expired.res.status, 200);
    assert.equal((await store.getSubscriptionOrderByTrade(expiredTrade))?.status, "expired");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original SubscriptionRequestCreemPay checkout_url/order_id JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("CreemWebhookSecret", "creem_whsec");
  await store.setOption("CreemApiKey", "ck_test");
  const planId = await createPlan(e, auth, {
    title: "Creem Sub",
    total_amount: 800,
    duration_unit: "day",
    duration_value: 30,
    price_amount: 8,
    upgrade_group: "vip",
    creem_product_id: "prod_sub",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("creem.io")) {
      const body = JSON.parse(String(init?.body || "{}")) as { request_id?: string };
      return new Response(JSON.stringify({ checkout_url: "https://checkout.creem.io/sub", id: body.request_id }), { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const pay = await json(
      new Request("http://local/api/subscription/creem/pay", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ plan_id: planId }),
      }),
      e,
    );
    assert.equal(pay.body.message, "success", pay.text);
    const data = pay.body.data as { checkout_url: string; order_id: string };
    assert.equal(data.checkout_url, "https://checkout.creem.io/sub");
    assert.match(data.order_id, /^sub_ref_[0-9a-f]{40}$/);
    await store.setOption("CreemProducts", JSON.stringify([{ productId: "prod_wallet", name: "Wallet", price: 8, quota: 1 }]));
    const raw = JSON.stringify({
      eventType: "checkout.completed",
      object: { request_id: data.order_id, order: { id: "ord_1", status: "paid", type: "subscription" } },
    });
    const sig = await hmacSha256Hex("creem_whsec", raw);
    const hook = await json(
      new Request("http://local/api/creem/webhook", {
        method: "POST",
        headers: { "creem-signature": sig, "content-type": "application/json" },
        body: raw,
      }),
      e,
    );
    assert.equal(hook.res.status, 200);
    assert.equal((await store.getSubscriptionOrderByTrade(data.order_id))?.status, "success");
    assert.equal(await selfGroup(e, auth), "vip");
    assert.equal(await selfQuota(e, auth), ROOT_QUOTA);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original SubscriptionRequestWaffoPancakePay WAFFO_PANCAKE_SUB JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("WaffoPancakeMerchantID", "mch_1");
  await store.setOption("WaffoPancakePrivateKey", "pk_test");
  const planId = await createPlan(e, auth, {
    title: "Pancake Sub",
    total_amount: 300,
    duration_unit: "day",
    duration_value: 30,
    price_amount: 3.5,
    upgrade_group: "vip",
    waffo_pancake_product_id: "prod_sub_pancake",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.includes("pancake/checkout") || url.includes("waffo.com")) {
      const body = JSON.parse(String(init?.body || "{}")) as { orderMerchantExternalId?: string; productId?: string };
      assert.equal(body.productId, "prod_sub_pancake");
      assert.match(String(body.orderMerchantExternalId), /^WAFFO_PANCAKE_SUB-/);
      return new Response(
        JSON.stringify({
          checkout_url: "https://pay.waffo.com/pancake/sub",
          session_id: "sess_sub",
          expires_at: 1710002700,
          token: "tok_sub",
          token_expires_at: 1710002700,
        }),
        { status: 200 },
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const pay = await json(
      new Request("http://local/api/subscription/waffo-pancake/pay", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ plan_id: planId }),
      }),
      e,
    );
    assert.equal(pay.body.message, "success", pay.text);
    const data = pay.body.data as {
      checkout_url: string;
      session_id: string;
      expires_at: number | string;
      order_id: string;
      token: string;
      token_expires_at: number | string;
    };
    assert.equal(data.checkout_url, "https://pay.waffo.com/pancake/sub");
    assert.equal(data.session_id, "sess_sub");
    assert.equal(data.expires_at, 1710002700);
    assert.equal(data.token, "tok_sub");
    assert.equal(data.token_expires_at, 1710002700);
    assert.match(data.order_id, /^WAFFO_PANCAKE_SUB-\d+-\d+-[0-9a-zA-Z]{6}$/);

    await store.setOption("WaffoPancakeProductID", "prod_wallet");
    const raw = JSON.stringify({
      mode: "test",
      event_type: "order.completed",
      data: {
        order_merchant_external_id: data.order_id,
        merchantProvidedBuyerIdentity: "new-api-user-1",
      },
    });
    const hook = await json(
      new Request("http://local/api/waffo-pancake/webhook/test", {
        method: "POST",
        headers: { "X-Waffo-Signature": "sig", "content-type": "application/json" },
        body: raw,
      }),
      e,
    );
    assert.equal(hook.res.status, 200);
    assert.equal(hook.text, "OK");
    assert.equal((await store.getSubscriptionOrderByTrade(data.order_id))?.status, "success");
    assert.equal(await selfGroup(e, auth), "vip");
    assert.equal(await selfQuota(e, auth), ROOT_QUOTA);
    const topups = await json(new Request("http://local/api/user/topup/self", { headers: auth }), e);
    const top = (topups.body.data as { items: Record<string, unknown>[] }).items.find((item) => item.trade_no === data.order_id);
    assert.ok(top);
    assert.equal(top.amount, 0);
    assert.equal(Number(top.money), 3.5);
    assert.equal(top.status, "success");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original subscription pay max purchase and unconfigured epay JSON", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  const cappedId = await createPlan(e, auth, {
    title: "Once",
    total_amount: 10,
    duration_unit: "day",
    duration_value: 1,
    price_amount: 1,
    max_purchase_per_user: 1,
  });
  const bind = await json(
    new Request("http://local/api/subscription/admin/bind", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ user_id: 1, plan_id: cappedId }),
    }),
    e,
  );
  assert.equal(bind.body.success, true, String(bind.body.message));
  await store.setOption("PayAddress", "https://epay.example/submit.php");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  const capped = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: cappedId, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(capped.body.message, "已达到该套餐购买上限");

  await store.setOption("PayAddress", "");
  const openId = await createPlan(e, auth, {
    title: "Open",
    total_amount: 10,
    duration_unit: "day",
    duration_value: 1,
    price_amount: 2,
  });
  const unconfigured = await json(
    new Request("http://local/api/subscription/epay/pay", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ plan_id: openId, payment_method: "alipay" }),
    }),
    e,
  );
  assert.equal(unconfigured.body.message, "当前管理员未配置支付信息");
});
