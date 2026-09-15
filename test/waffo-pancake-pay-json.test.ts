import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { formatWaffoPancakeAmount, waffoPancakeBuyerIdentityFromUserId } from "../src/waffo-pancake.js";
import { generateWaffoTestKeyPair } from "./waffo-keys.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const MERCHANT_ID = "MER_1234567890abcdefghijKL";
const PRODUCT_ID = "PROD_1234567890abcdefghijKL";

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

async function pancakeRows(store: Store): Promise<Record<string, unknown>[]> {
  const { items } = await store.listTopups(null, 0, 1000);
  return items.filter((row) => String((row as { payment_provider?: string }).payment_provider) === "waffo_pancake") as Record<
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

async function confirmCompliance(e: Env, auth: Record<string, string>) {
  const res = await json(new Request("http://local/api/option/payment_compliance", { method: "POST", headers: auth }), e);
  assert.equal(res.body.success, true, String(res.body.message));
}

async function pay(e: Env, auth: Record<string, string>, body: unknown) {
  return json(
    new Request("http://local/api/user/waffo-pancake/pay", {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

type Captured = { url: string; headers: Record<string, string>; body: string };

function mockPancakeSdk(origFetch: typeof fetch): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    captured.push({ url, headers, body: String(init?.body || "") });
    if (url.endsWith("/v1/actions/auth/issue-session-token")) {
      return new Response(JSON.stringify({ data: { token: "JWT", expiresAt: "2026-05-13T01:00:00Z" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/actions/checkout/create-session")) {
      return new Response(
        JSON.stringify({
          data: {
            sessionId: "ses_1",
            checkoutUrl: "https://pancake.example/checkout/abc",
            expiresAt: "2026-05-13T00:45:00Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return origFetch(input, init);
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}

test("original formatWaffoPancakeAmount uses StringFixed(2)", () => {
  assert.equal(formatWaffoPancakeAmount(29), "29.00");
  assert.equal(formatWaffoPancakeAmount(29.9), "29.90");
  assert.equal(formatWaffoPancakeAmount(29.999), "30.00");
  assert.equal(waffoPancakeBuyerIdentityFromUserId(1), "new-api-user-1");
});

test("original RequestWaffoPancakePay enabled/bind/min JSON", async () => {
  const { e, auth, store } = await boot();
  const disabled = await pay(e, auth, { amount: 10 });
  assert.equal(disabled.body.message, "error");
  assert.equal(disabled.body.data, "Waffo Pancake 配置不完整");

  await confirmCompliance(e, auth);
  const stillDisabled = await json(
    new Request("http://local/api/user/waffo-pancake/pay", { method: "POST", headers: auth, body: "" }),
    e,
  );
  assert.equal(stillDisabled.body.data, "Waffo Pancake 配置不完整");

  await store.setOption("WaffoPancakeMerchantID", MERCHANT_ID);
  await store.setOption("WaffoPancakePrivateKey", "pk_test");
  await store.setOption("WaffoPancakeProductID", PRODUCT_ID);

  const empty = await json(
    new Request("http://local/api/user/waffo-pancake/pay", { method: "POST", headers: auth, body: "" }),
    e,
  );
  assert.equal(empty.body.data, "参数错误");

  const invalid = await pay(e, auth, "{");
  assert.equal(invalid.body.data, "参数错误");

  const low = await pay(e, auth, { amount: 0 });
  assert.equal(low.body.data, "充值数量不能小于 1");
  assert.equal((await pancakeRows(store)).length, 0);
});

test("original RequestWaffoPancakePay invalid SDK keys mark the pending order failed", async () => {
  const { e, auth, store } = await boot();
  await confirmCompliance(e, auth);
  await store.setOption("WaffoPancakeMerchantID", "mch_1");
  await store.setOption("WaffoPancakePrivateKey", "pk_test");
  await store.setOption("WaffoPancakeProductID", PRODUCT_ID);
  const out = await pay(e, auth, { amount: 10 });
  assert.equal(out.body.message, "error");
  assert.equal(out.body.data, "拉起支付失败");
  const rows = await pancakeRows(store);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.match(String(rows[0].trade_no || ""), /^WAFFO_PANCAKE-1-\d+-[0-9a-zA-Z]{6}$/);
});

test("original RequestWaffoPancakePay Authenticated checkout JSON and headers", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await confirmCompliance(e, auth);
  await store.setOption("WaffoPancakeMerchantID", MERCHANT_ID);
  await store.setOption("WaffoPancakePrivateKey", keys.privateKey);
  await store.setOption("WaffoPancakeProductID", PRODUCT_ID);
  await store.updateUser(1, { email: "buyer@example.com" });
  const origFetch = globalThis.fetch;
  const mock = mockPancakeSdk(origFetch);
  try {
    const out = await pay(e, auth, { amount: 10 });
    assert.equal(out.body.message, "success", out.text);
    const data = out.body.data as {
      checkout_url?: string;
      session_id?: string;
      expires_at?: string;
      order_id?: string;
      token?: string;
      token_expires_at?: string;
    };
    assert.equal(data.checkout_url, "https://pancake.example/checkout/abc#token=JWT");
    assert.equal(data.session_id, "ses_1");
    assert.equal(data.expires_at, "2026-05-13T00:45:00Z");
    assert.equal(data.token, "JWT");
    assert.equal(data.token_expires_at, "2026-05-13T01:00:00Z");
    assert.match(String(data.order_id || ""), /^WAFFO_PANCAKE-1-\d+-[0-9a-zA-Z]{6}$/);

    const tokenReq = mock.captured.find((r) => r.url.endsWith("/v1/actions/auth/issue-session-token"));
    const sessionReq = mock.captured.find((r) => r.url.endsWith("/v1/actions/checkout/create-session"));
    assert.ok(tokenReq);
    assert.ok(sessionReq);
    assert.equal(tokenReq.url, "https://api.waffo.ai/v1/actions/auth/issue-session-token");
    assert.equal(sessionReq.url, "https://api.waffo.ai/v1/actions/checkout/create-session");
    for (const req of [tokenReq, sessionReq]) {
      assert.equal(req.headers["x-merchant-id"], MERCHANT_ID);
      assert.ok(/^\d+$/.test(req.headers["x-timestamp"] || ""));
      assert.ok(req.headers["x-signature"]);
      assert.equal((req.headers["x-idempotency-key"] || "").length, 64);
      assert.equal(req.headers["content-type"], "application/json");
    }
    const tokenBody = JSON.parse(tokenReq.body) as { productId?: string; buyerIdentity?: string };
    assert.equal(tokenBody.productId, PRODUCT_ID);
    assert.equal(tokenBody.buyerIdentity, "new-api-user-1");
    const sessionBody = JSON.parse(sessionReq.body) as {
      productId?: string;
      currency?: string;
      priceSnapshot?: { amount?: string; taxCategory?: string };
      buyerEmail?: string;
      expiresInSeconds?: number;
      orderMerchantExternalId?: string;
      merchantId?: string;
      buyerIdentity?: string;
      successUrl?: string;
    };
    assert.equal(sessionBody.productId, PRODUCT_ID);
    assert.equal(sessionBody.currency, "USD");
    assert.deepEqual(sessionBody.priceSnapshot, { amount: "10.00", taxCategory: "saas" });
    assert.equal(sessionBody.buyerEmail, "buyer@example.com");
    assert.equal(sessionBody.expiresInSeconds, 2700);
    assert.equal(sessionBody.orderMerchantExternalId, data.order_id);
    assert.equal(sessionBody.merchantId, undefined);
    assert.equal(sessionBody.buyerIdentity, undefined);
    assert.equal(sessionBody.successUrl, undefined);
    const keysOrder = Object.keys(sessionBody);
    assert.deepEqual(keysOrder, ["productId", "currency", "priceSnapshot", "buyerEmail", "expiresInSeconds", "orderMerchantExternalId"]);

    const rows = await pancakeRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].amount, 10);
    assert.equal(Number(rows[0].money), 10);
    assert.equal(rows[0].trade_no, data.order_id);
  } finally {
    mock.restore();
  }
});

test("original RequestWaffoPancakePay omits empty buyerEmail and maps SDK errors", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await confirmCompliance(e, auth);
  await store.setOption("WaffoPancakeMerchantID", MERCHANT_ID);
  await store.setOption("WaffoPancakePrivateKey", keys.privateKey);
  await store.setOption("WaffoPancakeProductID", PRODUCT_ID);
  const origFetch = globalThis.fetch;
  const captured: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    captured.push(String(init?.body || ""));
    if (url.endsWith("/v1/actions/checkout/create-session")) {
      return new Response(JSON.stringify({ errors: [{ message: "product unavailable" }] }), { status: 400 });
    }
    if (url.endsWith("/v1/actions/auth/issue-session-token")) {
      return new Response(JSON.stringify({ data: { token: "JWT", expiresAt: "2026-05-13T01:00:00Z" } }), { status: 200 });
    }
    return origFetch(input, init);
  }) as typeof fetch;
  try {
    const out = await pay(e, auth, { amount: 10 });
    assert.equal(out.body.data, "拉起支付失败");
    const sessionBody = captured.find((raw) => raw.includes("priceSnapshot"));
    assert.ok(sessionBody);
    const parsed = JSON.parse(sessionBody) as { buyerEmail?: string };
    assert.equal(parsed.buyerEmail, undefined);
    const rows = await pancakeRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original RequestWaffoPancakePay TOKENS stored amount and RequestWaffoPancakeAmount JSON", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await confirmCompliance(e, auth);
  await store.setOption("WaffoPancakeMerchantID", MERCHANT_ID);
  await store.setOption("WaffoPancakePrivateKey", keys.privateKey);
  await store.setOption("WaffoPancakeProductID", PRODUCT_ID);
  await store.setOption("general_setting.quota_display_type", "TOKENS");
  const origFetch = globalThis.fetch;
  const mock = mockPancakeSdk(origFetch);
  try {
    const amount = await json(
      new Request("http://local/api/user/waffo-pancake/amount", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ amount: 1_500_000 }),
      }),
      e,
    );
    assert.equal(amount.body.message, "success");
    assert.equal(amount.body.data, "3.00");

    const out = await pay(e, auth, { amount: 1_500_000 });
    assert.equal(out.body.message, "success", out.text);
    const sessionReq = mock.captured.find((r) => r.url.endsWith("/v1/actions/checkout/create-session"));
    const sessionBody = JSON.parse(sessionReq?.body || "{}") as { priceSnapshot?: { amount?: string } };
    assert.equal(sessionBody.priceSnapshot?.amount, "3.00");
    const rows = await pancakeRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 3);
    assert.equal(Number(rows[0].money), 3);
  } finally {
    mock.restore();
  }
});
