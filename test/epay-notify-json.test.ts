import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_QUOTA } from "../src/constants.js";
import { md5Hex } from "../src/crypto.js";
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

async function enableEpay(store: Store) {
  await store.setOption("PaymentComplianceConfirmed", "true");
  await store.setOption("PayAddress", "https://epay.example.com");
  await store.setOption("EpayId", "1001");
  await store.setOption("EpayKey", "epay-secret");
}

async function epaySign(params: Record<string, string>, key: string): Promise<string> {
  const parts = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`);
  return md5Hex(parts.join("&") + key);
}

async function signedParams(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const params: Record<string, string> = {
    pid: "1001",
    out_trade_no: "EPAY-FORM",
    trade_status: "TRADE_SUCCESS",
    type: "alipay",
    money: "10.00",
    ...extra,
  };
  params.sign = await epaySign(params, "epay-secret");
  params.sign_type = "MD5";
  return params;
}

test("original EpayNotify disabled/empty/unsigned fail text", async () => {
  const { e, store } = await boot();
  const disabled = await json(new Request("http://local/api/user/epay/notify"), e);
  assert.equal(disabled.res.status, 200);
  assert.equal(disabled.text, "fail");

  await enableEpay(store);
  const empty = await json(new Request("http://local/api/user/epay/notify"), e);
  assert.equal(empty.res.status, 200);
  assert.equal(empty.text, "fail");

  const unsigned = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams({ out_trade_no: "EPAY-1", trade_status: "TRADE_SUCCESS" })),
    e,
  );
  assert.equal(unsigned.text, "fail");
});

test("original EpayNotify POST form vs JSON, TRADE_SUCCESS, and non-success ack", async () => {
  const { e, store } = await boot();
  await enableEpay(store);
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "EPAY-FORM",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 10,
    money: 10,
    trade_no: "EPAY-WAIT",
    payment_method: "alipay",
    payment_provider: "epay",
    status: "pending",
  });

  const jsonBody = await signedParams();
  const jsonPost = await json(
    new Request("http://local/api/user/epay/notify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jsonBody),
    }),
    e,
  );
  assert.equal(jsonPost.res.status, 200);
  assert.equal(jsonPost.text, "fail");
  assert.equal((await store.getTopupByTrade("EPAY-FORM"))?.status, "pending");

  const queryOnPost = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams(await signedParams()), { method: "POST" }),
    e,
  );
  assert.equal(queryOnPost.text, "fail");
  assert.equal((await store.getTopupByTrade("EPAY-FORM"))?.status, "pending");

  const form = await signedParams();
  const posted = await json(
    new Request("http://local/api/user/epay/notify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
    e,
  );
  assert.equal(posted.res.status, 200);
  assert.equal(posted.text, "success");
  assert.equal((await store.getTopupByTrade("EPAY-FORM"))?.status, "success");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 5_000_000);

  const pending = await signedParams({ out_trade_no: "EPAY-WAIT", trade_status: "WAIT_BUYER_PAY" });
  const pendingNotify = await json(
    new Request("http://local/api/user/epay/notify?" + new URLSearchParams(pending)),
    e,
  );
  assert.equal(pendingNotify.text, "success");
  assert.equal((await store.getTopupByTrade("EPAY-WAIT"))?.status, "pending");
});
