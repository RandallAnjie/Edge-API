import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { generateWaffoTestKeyPair } from "./waffo-keys.js";
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

async function waffoRows(store: Store): Promise<Record<string, unknown>[]> {
  const { items } = await store.listTopups(null, 0, 1000);
  return items.filter((row) => String((row as { payment_provider?: string }).payment_provider) === "waffo") as Record<
    string,
    unknown
  >[];
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
    new Request("http://local/api/user/waffo/pay", {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

test("original RequestWaffoPay enabled/bind/min/method JSON", async () => {
  const { e, auth, store } = await boot();
  const disabled = await pay(e, auth, { amount: 10 });
  assert.equal(disabled.body.message, "error");
  assert.equal(disabled.body.data, "Waffo 支付未启用");

  await store.setOption("WaffoEnabled", "true");
  const empty = await json(new Request("http://local/api/user/waffo/pay", { method: "POST", headers: auth, body: "" }), e);
  assert.equal(empty.body.data, "参数错误");

  const invalid = await pay(e, auth, "{");
  assert.equal(invalid.body.data, "参数错误");

  const low = await pay(e, auth, { amount: 0 });
  assert.equal(low.body.data, "充值数量不能小于 1");

  const badIndex = await pay(e, auth, { amount: 10, pay_method_index: 99 });
  assert.equal(badIndex.body.data, "不支持的支付方式");

  const badType = await pay(e, auth, { amount: 10, pay_method_type: "ALIPAY", pay_method_name: "ALIPAY" });
  assert.equal(badType.body.data, "不支持的支付方式");
  assert.equal((await waffoRows(store)).length, 0);
});

test("original RequestWaffoPay invalid SDK keys mark the pending order failed", async () => {
  const { e, auth, store } = await boot();
  await store.setOption("WaffoEnabled", "true");
  await store.setOption("WaffoApiKey", "wk_test");
  await store.setOption("WaffoPrivateKey", "wk_private");
  await store.setOption("WaffoPublicCert", "wk_cert");
  const out = await pay(e, auth, { amount: 10 });
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "支付配置错误");
  const rows = await waffoRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.match(String(rows[0].trade_no || ""), /^WAFFO-1-\d+-[0-9a-zA-Z]{6}$/);
});

test("original RequestWaffoPay CreateOrder JSON, headers, and payment_url", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await store.setOption("WaffoEnabled", "true");
  await store.setOption("WaffoApiKey", "wk_live");
  await store.setOption("WaffoPrivateKey", keys.privateKey);
  await store.setOption("WaffoPublicCert", keys.publicKey);
  await store.setOption("WaffoMerchantId", "mch_1");
  await store.setOption("ServerAddress", "https://console.example.com");
  await store.setOption("CustomCallbackAddress", "https://callback.example.com");
  await store.setOption("SystemName", "New API");
  const origFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let captured = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = {};
    new Headers(init?.headers).forEach((v, k) => {
      capturedHeaders[k.toLowerCase()] = v;
    });
    captured = String(init?.body || "");
    return new Response(
      JSON.stringify({
        code: "0",
        data: { orderAction: JSON.stringify({ actionType: "WEB", webUrl: "https://pay.waffo.com/x" }) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const out = await pay(e, auth, { amount: 10, pay_method_index: 1 });
    assert.equal(out.body.message, "success");
    const data = out.body.data as { payment_url?: string; order_id?: string };
    assert.equal(data.payment_url, "https://pay.waffo.com/x");
    assert.match(String(data.order_id || ""), /^WAFFO-1-\d+-[0-9a-zA-Z]{6}$/);
    assert.equal(capturedUrl, "https://api.waffo.com/api/v1/order/create");
    assert.equal(capturedHeaders["x-api-key"], "wk_live");
    assert.equal(capturedHeaders["x-api-version"], "1.0.0");
    assert.equal(capturedHeaders["x-sdk-version"], "waffo-go/1.3.2");
    assert.ok(capturedHeaders["x-signature"]);
    const payload = JSON.parse(captured) as {
      paymentRequestId?: string;
      merchantOrderId?: string;
      orderCurrency?: string;
      orderAmount?: string;
      orderDescription?: string;
      notifyUrl?: string;
      successRedirectUrl?: string;
      failedRedirectUrl?: string;
      merchantInfo?: { merchantId?: string };
      userInfo?: { userId?: string; userEmail?: string; userTerminal?: string };
      paymentInfo?: { productName?: string; payMethodType?: string; payMethodName?: string };
      goodsInfo?: { goodsName?: string; appName?: string };
    };
    assert.equal(payload.paymentRequestId, data.order_id);
    assert.equal(payload.merchantOrderId, data.order_id);
    assert.equal(payload.orderCurrency, "USD");
    assert.equal(payload.orderAmount, "10.00");
    assert.equal(payload.orderDescription, "Recharge 10 credits");
    assert.equal(payload.notifyUrl, "https://callback.example.com/api/waffo/webhook");
    assert.equal(payload.successRedirectUrl, "https://console.example.com/wallet?show_history=true");
    assert.equal(payload.failedRedirectUrl, "https://console.example.com/wallet?show_history=true");
    assert.equal(payload.merchantInfo?.merchantId, "mch_1");
    assert.equal(payload.userInfo?.userId, "1");
    assert.equal(payload.userInfo?.userEmail, "1@examples.com");
    assert.equal(payload.userInfo?.userTerminal, "WEB");
    assert.equal(payload.paymentInfo?.productName, "ONE_TIME_PAYMENT");
    assert.equal(payload.paymentInfo?.payMethodType, "APPLEPAY");
    assert.equal(payload.paymentInfo?.payMethodName, "APPLEPAY");
    assert.equal(payload.goodsInfo?.goodsName, "Recharge 10 credits");
    assert.equal(payload.goodsInfo?.appName, "New API");
    const rows = await waffoRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(Number(rows[0].amount), 10);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original RequestWaffoPay Create failure marks the order failed", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await store.setOption("WaffoEnabled", "true");
  await store.setOption("WaffoApiKey", "wk_live");
  await store.setOption("WaffoPrivateKey", keys.privateKey);
  await store.setOption("WaffoPublicCert", keys.publicKey);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: "E1001", msg: "denied" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const out = await pay(e, auth, { amount: 10 });
    assert.equal(out.body.data, "拉起支付失败");
    const rows = await waffoRows(store);
    assert.equal(rows[0]?.status, "failed");
  } finally {
    globalThis.fetch = origFetch;
  }
});
