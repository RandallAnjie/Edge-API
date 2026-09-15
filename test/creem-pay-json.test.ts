import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { creemCheckoutApiUrl } from "../src/payments.js";
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

async function creemTopupCount(store: Store): Promise<number> {
  const { items } = await store.listTopups(null, 0, 1000);
  return items.filter((row) => String((row as { payment_provider?: string }).payment_provider) === "creem").length;
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

async function pay(e: Env, auth: Record<string, string>, body: unknown) {
  return json(
    new Request("http://local/api/user/creem/pay", {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

test("original RequestCreemPay bind, method, and catalog JSON", async () => {
  const { e, auth, store } = await boot();
  const empty = await json(new Request("http://local/api/user/creem/pay", { method: "POST", headers: auth, body: "" }), e);
  assert.equal(empty.body.message, "error");
  assert.equal(empty.body.data, "参数错误");

  const invalid = await pay(e, auth, "{");
  assert.equal(invalid.body.message, "error");
  assert.equal(invalid.body.data, "参数错误");

  const method = await pay(e, auth, { product_id: "prod_1" });
  assert.equal(method.body.message, "error");
  assert.equal(method.body.data, "不支持的支付渠道");

  const missingProduct = await pay(e, auth, { payment_method: "creem" });
  assert.equal(missingProduct.body.message, "error");
  assert.equal(missingProduct.body.data, "请选择产品");

  const missing = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
  assert.equal(missing.body.message, "error");
  assert.equal(missing.body.data, "产品不存在");
  assert.equal(await creemTopupCount(store), 0);

  await store.setOption("CreemProducts", "{not-json");
  const bad = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
  assert.equal(bad.body.data, "产品配置错误");
});

test("original RequestCreemPay inserts then maps genCreemLink errors to 拉起支付失败", async () => {
  const { e, auth, store } = await boot();
  await store.setOption(
    "CreemProducts",
    JSON.stringify([{ productId: "prod_1", name: "Pack", price: 10, quota: 500000, currency: "USD" }]),
  );
  const before = await creemTopupCount(store);
  const out = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "拉起支付失败");
  assert.equal(await creemTopupCount(store), before + 1);
});

test("original RequestCreemPay checkout JSON: ref_ sha1 trade, empty email, metadata quota", async () => {
  const { e, auth, store } = await boot();
  await store.setOption(
    "CreemProducts",
    JSON.stringify([{ productId: "prod_1", name: "Pack", price: 10, quota: 500000, currency: "USD" }]),
  );
  await store.setOption("CreemApiKey", "ck_test");
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  let captured = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    captured = String(init?.body || "");
    return new Response(JSON.stringify({ checkout_url: "https://checkout.creem.io/pay", id: "ch_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const out = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
    assert.equal(out.body.message, "success");
    const data = out.body.data as { checkout_url?: string; order_id?: string };
    assert.equal(data.checkout_url, "https://checkout.creem.io/pay");
    assert.match(String(data.order_id || ""), /^ref_[0-9a-f]{40}$/);
    assert.equal(capturedUrl, "https://api.creem.io/v1/checkouts");
    const payload = JSON.parse(captured) as {
      product_id?: string;
      request_id?: string;
      customer?: { email?: string };
      metadata?: { username?: string; reference_id?: string; product_name?: string; quota?: string };
    };
    assert.equal(payload.product_id, "prod_1");
    assert.equal(payload.request_id, data.order_id);
    assert.equal(payload.customer?.email, "");
    assert.equal(payload.metadata?.username, "root");
    assert.equal(payload.metadata?.reference_id, data.order_id);
    assert.equal(payload.metadata?.product_name, "Pack");
    assert.equal(payload.metadata?.quota, "500000");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original genCreemLink uses CreemTestMode hosts and ignores CreemCheckoutUrl", async () => {
  assert.equal(creemCheckoutApiUrl(false), "https://api.creem.io/v1/checkouts");
  assert.equal(creemCheckoutApiUrl(true), "https://test-api.creem.io/v1/checkouts");

  const { e, auth, store } = await boot();
  await store.setOption(
    "CreemProducts",
    JSON.stringify([{ productId: "prod_1", name: "Pack", price: 10, quota: 500000, currency: "USD" }]),
  );
  await store.setOption("CreemApiKey", "ck_test");
  await store.setOption("CreemCheckoutUrl", "https://evil.example/v1/checkouts");
  await store.setOption("CreemTestMode", "true");
  const origFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    void init;
    return new Response(JSON.stringify({ checkout_url: "https://checkout.creem.io/pay", id: "ch_1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const testMode = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
    assert.equal(testMode.body.message, "success", String(testMode.body.data));
    assert.equal(urls.at(-1), "https://test-api.creem.io/v1/checkouts");

    await store.setOption("CreemTestMode", "false");
    const live = await pay(e, auth, { product_id: "prod_1", payment_method: "creem" });
    assert.equal(live.body.message, "success", String(live.body.data));
    assert.equal(urls.at(-1), "https://api.creem.io/v1/checkouts");
    assert.equal(urls.some((u) => u.includes("evil.example")), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
