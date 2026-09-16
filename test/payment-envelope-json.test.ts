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

/** Original topup gin.H `{message:"error", data}` omits `success`. */
function payErrEnvelope(body: Record<string, unknown>, data: unknown) {
  assert.equal(body.message, "error");
  assert.equal(body.data, data);
  assert.equal("success" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["data", "message"]);
}

/** Original topup gin.H `{message:"success", data}` omits `success`. */
function payOkEnvelope(body: Record<string, unknown>, extraKeys: string[] = []) {
  assert.equal(body.message, "success");
  assert.equal("success" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["data", "message", ...extraKeys].sort());
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

async function post(e: Env, auth: Record<string, string>, path: string, body: unknown) {
  return json(
    new Request("http://local" + path, {
      method: "POST",
      headers: auth,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
}

test("original RequestEpay and RequestAmount gin.H omit success", async () => {
  const { e, auth, store } = await boot();
  const empty = await json(new Request("http://local/api/user/pay", { method: "POST", headers: auth, body: "" }), e);
  payErrEnvelope(empty.body, "参数错误");

  const missingMethod = await post(e, auth, "/api/user/pay", { amount: 10 });
  payErrEnvelope(missingMethod.body, "支付方式不存在");

  const amountLow = await post(e, auth, "/api/user/amount", { amount: 0 });
  payErrEnvelope(amountLow.body, "充值数量不能小于 1");

  const amountOk = await post(e, auth, "/api/user/amount", { amount: 10 });
  payOkEnvelope(amountOk.body);
  assert.equal(amountOk.body.data, "73.00");

  await store.setOption("PayAddress", "https://epay.example");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("ServerAddress", "https://console.example.com");
  const pay = await post(e, auth, "/api/user/pay", { amount: 10, payment_method: "alipay" });
  payOkEnvelope(pay.body, ["url"]);
  assert.equal(pay.body.url, "https://epay.example/submit.php");
});

test("original RequestStripePay RequestCreemPay RequestWaffoPay gin.H omit success", async () => {
  const { e, auth } = await boot();
  const stripeFail = await post(e, auth, "/api/user/stripe/pay", { amount: 10, payment_method: "stripe" });
  payErrEnvelope(stripeFail.body, "拉起支付失败");

  const stripeLow = await post(e, auth, "/api/user/stripe/pay", { amount: 0, payment_method: "stripe" });
  assert.equal(stripeLow.body.message, "充值数量不能小于 1");
  assert.equal(stripeLow.body.data, 10);
  assert.equal("success" in stripeLow.body, false);
  assert.deepEqual(Object.keys(stripeLow.body).sort(), ["data", "message"]);

  const stripeHigh = await post(e, auth, "/api/user/stripe/pay", { amount: 10001, payment_method: "stripe" });
  assert.equal(stripeHigh.body.message, "充值数量不能大于 10000");
  assert.equal(stripeHigh.body.data, 10);
  assert.equal("success" in stripeHigh.body, false);

  const stripeAmount = await post(e, auth, "/api/user/stripe/amount", { amount: 10 });
  payOkEnvelope(stripeAmount.body);
  assert.equal(stripeAmount.body.data, "80.00");

  const creem = await post(e, auth, "/api/user/creem/pay", { product_id: "prod_1", payment_method: "creem" });
  payErrEnvelope(creem.body, "产品不存在");

  const waffo = await post(e, auth, "/api/user/waffo/pay", { amount: 10 });
  payErrEnvelope(waffo.body, "Waffo 支付未启用");

  const pancake = await post(e, auth, "/api/user/waffo-pancake/pay", { amount: 10 });
  payErrEnvelope(pancake.body, "Waffo Pancake 配置不完整");
});

test("original subscription pay gin.H omit success on checkout envelopes", async () => {
  const { e, auth, store } = await boot();
  const compliance = await post(e, auth, "/api/option/payment_compliance", { confirmed: true });
  assert.equal(compliance.body.success, true, String(compliance.body.message));
  await store.setOption("PayAddress", "https://epay.example/submit.php");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
  await store.setOption("ServerAddress", "http://local");
  const created = await post(e, auth, "/api/subscription/admin/plans", {
    plan: {
      title: "VIP Month",
      total_amount: 1000,
      duration_unit: "day",
      duration_value: 30,
      price_amount: 9.9,
      upgrade_group: "vip",
    },
  });
  assert.equal(created.body.success, true, String(created.body.message));
  const planId = Number((created.body.data as { id?: number }).id || 0);

  const epay = await post(e, auth, "/api/subscription/epay/pay", { plan_id: planId, payment_method: "alipay" });
  payOkEnvelope(epay.body, ["url"]);
  assert.match(String(epay.body.url), /^https:\/\/epay\.example\/submit\.php\?/);

  const stripe = await post(e, auth, "/api/subscription/stripe/pay", { plan_id: planId });
  assert.equal(stripe.body.success, false);
  assert.equal(stripe.body.message, "该套餐未配置 StripePriceId");
  assert.equal("data" in stripe.body, false);

  const creemBind = await post(e, auth, "/api/subscription/creem/pay", {});
  payErrEnvelope(creemBind.body, "参数错误");

  const pancakeFail = await post(e, auth, "/api/subscription/waffo-pancake/pay", { plan_id: planId });
  assert.equal(pancakeFail.body.success, false);
  assert.equal(pancakeFail.body.message, "该套餐未配置 WaffoPancakeProductId");
});
