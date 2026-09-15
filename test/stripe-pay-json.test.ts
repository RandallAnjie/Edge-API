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

async function stripeTopupCount(store: Store): Promise<number> {
  const { total } = await store.listTopups(null, 0, 100);
  const { items } = await store.listTopups(null, 0, Math.max(total, 1));
  return items.filter((row) => String((row as { payment_provider?: string }).payment_provider) === "stripe").length;
}

async function boot(extra: Partial<Env> = {}) {
  resetSchemaFlag();
  const e: Env = { DB: createMemoryD1(), SYSTEM_NAME: "Edge API Test", ...extra };
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

async function pay(e: Env, auth: Record<string, string>, body: unknown) {
  return json(
    new Request("http://local/api/user/stripe/pay", {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

test("original RequestStripePay untrusted success_url is HTTP 400 without inserting", async () => {
  const { e, auth, store } = await boot();
  const before = await stripeTopupCount(store);
  const out = await pay(e, auth, {
    amount: 10,
    payment_method: "stripe",
    success_url: "https://evil.com/phishing",
  });
  assert.equal(out.res.status, 400);
  assert.equal(out.body.message, "支付成功重定向URL不在可信任域名列表中");
  assert.equal(out.body.data, "");
  assert.equal("success" in out.body, false);
  assert.equal(await stripeTopupCount(store), before);
});

test("original RequestStripePay untrusted cancel_url is HTTP 400 without inserting", async () => {
  const { e, auth, store } = await boot({ TRUSTED_REDIRECT_DOMAINS: "example.com" });
  const before = await stripeTopupCount(store);
  const out = await pay(e, auth, {
    amount: 10,
    payment_method: "stripe",
    cancel_url: "https://evil.com/cancel",
  });
  assert.equal(out.res.status, 400);
  assert.equal(out.body.message, "支付取消重定向URL不在可信任域名列表中");
  assert.equal(out.body.data, "");
  assert.equal("success" in out.body, false);
  assert.equal(await stripeTopupCount(store), before);
});

test("original RequestStripePay empty success_url skips validator even with empty trusted list", async () => {
  const { e, auth, store } = await boot();
  const before = await stripeTopupCount(store);
  const out = await pay(e, auth, { amount: 10, payment_method: "stripe" });
  assert.equal(out.res.status, 200);
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "拉起支付失败");
  assert.equal(await stripeTopupCount(store), before);
});

test("original RequestStripePay trusted subdomain proceeds to checkout then insert", async () => {
  const { e, auth, store } = await boot({ TRUSTED_REDIRECT_DOMAINS: "example.com" });
  await store.setOption("StripeApiSecret", "sk_test_json");
  await store.setOption("StripePriceId", "price_json");
  await store.setOption("ServerAddress", "https://console.example.com");
  const before = await stripeTopupCount(store);
  const origFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), "https://api.stripe.com/v1/checkout/sessions");
    captured = String(init?.body || "");
    return new Response(JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const out = await pay(e, auth, {
      amount: 10,
      payment_method: "stripe",
      success_url: "https://sub.example.com/ok",
      cancel_url: "https://example.com/wallet",
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.body.message, "success");
    assert.deepEqual(out.body.data, { pay_link: "https://checkout.stripe.com/c/pay/cs_test" });
    const params = new URLSearchParams(captured);
    assert.equal(params.get("success_url"), "https://sub.example.com/ok");
    assert.equal(params.get("cancel_url"), "https://example.com/wallet");
    assert.equal(params.get("allow_promotion_codes"), "false");
    assert.equal(params.get("mode"), "payment");
    assert.equal(params.get("line_items[0][price]"), "price_json");
    assert.equal(params.get("line_items[0][quantity]"), "10");
    assert.equal(params.get("customer_creation"), "always");
    assert.match(String(params.get("client_reference_id") || ""), /^ref_/);
    assert.equal(await stripeTopupCount(store), before + 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original RequestStripePay invalid Stripe secret does not insert a pending order", async () => {
  const { e, auth, store } = await boot({ TRUSTED_REDIRECT_DOMAINS: "example.com" });
  const before = await stripeTopupCount(store);
  const out = await pay(e, auth, {
    amount: 10,
    payment_method: "stripe",
    success_url: "https://example.com/ok",
  });
  assert.equal(out.res.status, 200);
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "拉起支付失败");
  assert.equal(await stripeTopupCount(store), before);
});

test("original RequestStripePay bind errors and amount bounds JSON", async () => {
  const { e, auth } = await boot();
  const empty = await json(
    new Request("http://local/api/user/stripe/pay", { method: "POST", headers: auth, body: "" }),
    e,
  );
  assert.equal(empty.body.message, "error");
  assert.equal(empty.body.data, "参数错误");

  const invalid = await pay(e, auth, "{");
  assert.equal(invalid.body.message, "error");
  assert.equal(invalid.body.data, "参数错误");

  const low = await pay(e, auth, { amount: 0, payment_method: "stripe" });
  assert.equal(low.res.status, 200);
  assert.equal(low.body.message, "充值数量不能小于 1");
  assert.equal(low.body.data, 10);

  const high = await pay(e, auth, { amount: 10001, payment_method: "stripe" });
  assert.equal(high.res.status, 200);
  assert.equal(high.body.message, "充值数量不能大于 10000");
  assert.equal(high.body.data, 10);

  const method = await pay(e, auth, { amount: 10, payment_method: "epay" });
  assert.equal(method.body.message, "error");
  assert.equal(method.body.data, "不支持的支付渠道");
});

test("original RequestStripePay default return paths use ServerAddress and always send allow_promotion_codes", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("StripeApiSecret", "sk_test_defaults");
  await store.setOption("StripePriceId", "price_defaults");
  await store.setOption("ServerAddress", "https://console.example.com");
  await store.setOption("StripePromotionCodesEnabled", "true");
  const origFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = String(init?.body || "");
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_default" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const out = await pay(e, auth, { amount: 10, payment_method: "stripe" });
    assert.equal(out.body.message, "success");
    assert.equal((out.body.data as { pay_link?: string }).pay_link, "https://checkout.stripe.com/c/pay/cs_default");
    const params = new URLSearchParams(captured);
    assert.equal(params.get("success_url"), "https://console.example.com/usage-logs");
    assert.equal(params.get("cancel_url"), "https://console.example.com/wallet");
    assert.equal(params.get("allow_promotion_codes"), "true");
  } finally {
    globalThis.fetch = origFetch;
  }
});
