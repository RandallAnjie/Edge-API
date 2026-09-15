import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { LOG_TOPUP, ROOT_QUOTA } from "../src/constants.js";
import { md5Hex } from "../src/crypto.js";
import { handleFetch } from "../src/worker.js";
import worker from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import {
  ERR_PAYMENT_METHOD_MISMATCH,
  ERR_TOP_UP_NOT_FOUND,
  ERR_TOP_UP_QUOTA_LIMIT_EXCEEDED,
  ERR_TOP_UP_STATUS_INVALID,
  Store,
} from "../src/store.js";
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

async function epaySign(params: Record<string, string>, key: string): Promise<string> {
  const parts = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return md5Hex(parts.join("&") + key);
}

async function enableEpay(store: Store) {
  await store.setOption("PaymentComplianceConfirmed", "true");
  await store.setOption("PayAddress", "https://epay.example.com");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
}

function parseOther(raw: unknown): Record<string, unknown> {
  assert.equal(typeof raw, "string", "original Log.other is a JSON string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

async function topupLog(auth: Record<string, string>, e: Env, contentPrefix: string): Promise<Record<string, unknown>> {
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_TOPUP + "&page_size=100", { headers: auth }), e);
  const items = (logs.body.data as { items: Record<string, unknown>[] }).items;
  const row = items.find((item) => String(item.content || "").includes(contentPrefix));
  assert.ok(row, "missing topup log for " + contentPrefix + " " + JSON.stringify(items.map((i) => i.content)));
  return row;
}

test("original RechargeEpay credits Amount*QuotaPerUnit and RecordTopupLog JSON", async () => {
  const { e, auth, store } = await boot();
  await enableEpay(store);
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 12.34,
    trade_no: "EPAY-1",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "pending",
  });
  const paid: Record<string, string> = { out_trade_no: "EPAY-1", trade_status: "TRADE_SUCCESS", type: "wxpay" };
  paid.sign = await epaySign(paid, "epay-secret");
  const notify = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams(paid), { headers: { "x-real-ip": "203.0.113.9" } }),
    e,
  );
  assert.equal(notify.text, "success");
  const order = await store.getTopupByTrade("EPAY-1");
  assert.equal(order?.status, "success");
  assert.equal(order?.payment_method, "wxpay");
  const user = await store.getUserById(1);
  assert.equal(user?.quota, ROOT_QUOTA + 5_000_000);

  const againParams: Record<string, string> = { out_trade_no: "EPAY-1", trade_status: "TRADE_SUCCESS" };
  againParams.sign = await epaySign(againParams, "epay-secret");
  const again = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams(againParams)),
    e,
  );
  assert.equal(again.text, "success");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 5_000_000);

  const missingParams: Record<string, string> = { out_trade_no: "NO-SUCH", trade_status: "TRADE_SUCCESS" };
  missingParams.sign = await epaySign(missingParams, "epay-secret");
  const missing = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams(missingParams)),
    e,
  );
  assert.equal(missing.text, "fail");

  const log = await topupLog(auth, e, "使用在线充值成功，充值金额: ＄10.000000 额度，支付金额：12.340000");
  assert.equal(log.type, LOG_TOPUP);
  const other = parseOther(log.other);
  const admin = other.admin_info as Record<string, unknown>;
  assert.equal(admin.callback_payment_method, "epay");
  assert.equal(admin.payment_method, "wxpay");
  assert.equal(admin.caller_ip, "203.0.113.9");
  assert.equal(admin.node_name, "edge-api");
});

test("original RechargeEpay rejects mismatched provider and non-pending status", async () => {
  const { store } = await boot();
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "STRIPE-AS-EPAY",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await assert.rejects(() => store.rechargeEpay("STRIPE-AS-EPAY"), { message: ERR_PAYMENT_METHOD_MISMATCH });
  await assert.rejects(() => store.rechargeEpay(""), { message: "未提供支付单号" });
  await assert.rejects(() => store.rechargeEpay("missing"), { message: ERR_TOP_UP_NOT_FOUND });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "EPAY-EXPIRED",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "expired",
  });
  await assert.rejects(() => store.rechargeEpay("EPAY-EXPIRED"), { message: ERR_TOP_UP_STATUS_INVALID });
});

test("original Recharge Stripe credits Money*QuotaPerUnit and stripe_customer JSON", async () => {
  const { e, auth, store } = await boot();
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 8.5,
    trade_no: "STRIPE-1",
    payment_method: "stripe",
    payment_provider: "stripe",
    status: "pending",
  });
  await store.rechargeStripe("STRIPE-1", "cus_test_1", "198.51.100.10");
  const user = await store.getUserById(1);
  assert.equal(user?.quota, ROOT_QUOTA + 4_250_000);
  assert.equal(user?.stripe_customer, "cus_test_1");
  const self = await json(new Request("http://local/api/user/self", { headers: auth }), e);
  assert.equal((self.body.data as { stripe_customer: string }).stripe_customer, "cus_test_1");

  const log = await topupLog(auth, e, "使用在线充值成功，充值金额: ＄8.500000，支付金额：10");
  const admin = parseOther(log.other).admin_info as Record<string, unknown>;
  assert.equal(admin.callback_payment_method, "stripe");
  assert.equal(admin.payment_method, "stripe");
  assert.equal(admin.caller_ip, "198.51.100.10");

  await assert.rejects(() => store.rechargeStripe("STRIPE-1", "cus_again"), { message: "充值订单状态错误" });
});

test("original RechargeCreem credits Amount as quota and fills empty email", async () => {
  const { e, auth, store } = await boot();
  await store.updateUser(1, { email: "" });
  await store.insertTopup({
    user_id: 1,
    amount: 250000,
    money: 9.99,
    trade_no: "CREEM-1",
    payment_method: "creem",
    payment_provider: "creem",
    status: "pending",
  });
  await store.rechargeCreem("CREEM-1", "paid@example.com", "Buyer", "192.0.2.1");
  const user = await store.getUserById(1);
  assert.equal(user?.quota, ROOT_QUOTA + 250000);
  assert.equal(user?.email, "paid@example.com");
  const log = await topupLog(auth, e, "使用Creem充值成功，充值额度: 250000，支付金额：9.99");
  const admin = parseOther(log.other).admin_info as Record<string, unknown>;
  assert.equal(admin.callback_payment_method, "creem");
  assert.equal(admin.caller_ip, "192.0.2.1");
});

test("original RechargeWaffo and RechargeWaffoPancake quota and log JSON", async () => {
  const { e, auth, store } = await boot();
  await store.insertTopup({
    user_id: 1,
    amount: 4,
    money: 32,
    trade_no: "WAFFO-1",
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });
  await store.rechargeWaffo("WAFFO-1", "203.0.113.20");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 2_000_000);
  await store.rechargeWaffo("WAFFO-1", "203.0.113.20");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 2_000_000);
  const waffoLog = await topupLog(auth, e, "Waffo充值成功，充值额度: ＄4.000000，支付金额: 32.00");
  assert.equal((parseOther(waffoLog.other).admin_info as Record<string, unknown>).callback_payment_method, "waffo");

  await store.insertTopup({
    user_id: 1,
    amount: 2,
    money: 16.5,
    trade_no: "PANCAKE-1",
    payment_method: "waffo_pancake",
    payment_provider: "waffo_pancake",
    status: "pending",
  });
  await store.rechargeWaffoPancake("PANCAKE-1");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 2_000_000 + 1_000_000);
  const pancake = await topupLog(auth, e, "Waffo Pancake充值成功，充值额度: ＄2.000000，支付金额: 16.50");
  const pancakeOther = parseOther(pancake.other || "{}");
  assert.equal("admin_info" in pancakeOther, false);
});

test("original Recharge rolls back the order when creditTopUpQuota hits the wallet ceiling", async () => {
  const { store } = await boot();
  await store.updateUser(1, { quota: Number.MAX_SAFE_INTEGER - 10 });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "EPAY-LIMIT",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "pending",
  });
  await assert.rejects(() => store.rechargeEpay("EPAY-LIMIT"), { message: ERR_TOP_UP_QUOTA_LIMIT_EXCEEDED });
  const order = await store.getTopupByTrade("EPAY-LIMIT");
  assert.equal(order?.status, "pending");
  assert.equal(Number(order?.complete_time || 0), 0);
});
