import assert from "node:assert/strict";
import { test } from "node:test";
import { ROOT_QUOTA } from "../src/constants.js";
import { signWaffoBody, verifyWaffoBody } from "../src/crypto.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { createMemoryD1 } from "./d1-memory.js";
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

async function enableWaffo(
  store: Store,
  keys: { privateKey: string; publicKey: string },
  extras: { sandbox?: boolean } = {},
) {
  await store.setOption("WaffoEnabled", "true");
  if (extras.sandbox) {
    await store.setOption("WaffoSandbox", "true");
    await store.setOption("WaffoSandboxApiKey", "wk_sandbox");
    await store.setOption("WaffoSandboxPrivateKey", keys.privateKey);
    await store.setOption("WaffoSandboxPublicCert", keys.publicKey);
    return;
  }
  await store.setOption("WaffoApiKey", "wk_live");
  await store.setOption("WaffoPrivateKey", keys.privateKey);
  await store.setOption("WaffoPublicCert", keys.publicKey);
}

async function postWebhook(e: Env, body: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature != null) headers.set("X-SIGNATURE", signature);
  return json(new Request("http://local/api/waffo/webhook", { method: "POST", headers, body }), e);
}

async function signedWebhook(e: Env, keys: { privateKey: string; publicKey: string }, body: string) {
  const signature = await signWaffoBody(body, keys.privateKey);
  assert.ok(signature);
  return postWebhook(e, body, signature);
}

async function assertSignedMessage(
  out: { res: Response; body: Record<string, unknown>; text: string },
  keys: { publicKey: string },
  message: "success" | "failed",
) {
  assert.equal(out.res.status, 200);
  assert.equal(out.text, `{"message":"${message}"}`);
  assert.equal(out.body.message, message);
  assert.equal("code" in out.body, false);
  assert.equal("success" in out.body, false);
  assert.equal((out.res.headers.get("content-type") || "").split(";")[0], "application/json");
  const signature = out.res.headers.get("X-SIGNATURE") || "";
  assert.ok(signature);
  assert.equal(await verifyWaffoBody(out.text, signature, keys.publicKey), true);
}

test("original WaffoWebhook disabled, invalid SDK, and signature HTTP", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();

  const disabled = await postWebhook(e, "{}", null);
  assert.equal(disabled.res.status, 403);
  assert.equal(disabled.text, "");

  await confirmCompliance(e, auth);
  await store.setOption("WaffoEnabled", "true");
  await store.setOption("WaffoApiKey", "wk_live");
  await store.setOption("WaffoPrivateKey", "not-rsa");
  await store.setOption("WaffoPublicCert", "not-rsa");
  const invalidSdk = await postWebhook(e, "{}", null);
  assert.equal(invalidSdk.res.status, 500);
  assert.equal(invalidSdk.text, "");

  await enableWaffo(store, keys);
  const missingSig = await postWebhook(e, '{"eventType":"PAYMENT_NOTIFICATION"}', null);
  assert.equal(missingSig.res.status, 400);
  assert.equal(missingSig.text, "");

  const badSig = await postWebhook(e, '{"eventType":"PAYMENT_NOTIFICATION"}', "AAAA");
  assert.equal(badSig.res.status, 400);
  assert.equal(badSig.text, "");
});

test("original WaffoWebhook signed success/failed JSON and PAYMENT_NOTIFICATION fields", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await confirmCompliance(e, auth);
  await enableWaffo(store, keys);

  await store.insertTopup({
    user_id: 1,
    amount: 4,
    money: 32,
    trade_no: "WAFFO-1-pay",
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 2,
    money: 16,
    trade_no: "WAFFO-1-close",
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });
  await store.insertTopup({
    user_id: 1,
    amount: 1,
    money: 8,
    trade_no: "WAFFO-1-refund",
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });

  const invalidJson = await signedWebhook(e, keys, "{");
  await assertSignedMessage(invalidJson, keys, "failed");

  const unknownEvent = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "REFUND_NOTIFICATION",
      result: { merchantOrderId: "WAFFO-1-refund", orderStatus: "PAY_SUCCESS" },
    }),
  );
  await assertSignedMessage(unknownEvent, keys, "success");
  assert.equal((await store.getTopupByTrade("WAFFO-1-refund"))?.status, "pending");

  const nullBody = await signedWebhook(e, keys, "null");
  await assertSignedMessage(nullBody, keys, "success");

  const badResult = await signedWebhook(
    e,
    keys,
    JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: "not-an-object" }),
  );
  await assertSignedMessage(badResult, keys, "failed");

  const numericOrderId = await signedWebhook(
    e,
    keys,
    JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: { merchantOrderId: 1, orderStatus: "PAY_SUCCESS" } }),
  );
  await assertSignedMessage(numericOrderId, keys, "failed");

  const wrongCamel = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: { merchantOrderID: "WAFFO-1-pay", orderStatus: "PAY_SUCCESS" },
    }),
  );
  await assertSignedMessage(wrongCamel, keys, "failed");
  assert.equal((await store.getTopupByTrade("WAFFO-1-pay"))?.status, "pending");

  const emptyPaySuccess = await signedWebhook(
    e,
    keys,
    JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: { orderStatus: "PAY_SUCCESS" } }),
  );
  await assertSignedMessage(emptyPaySuccess, keys, "failed");

  const closed = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: { merchantOrderId: "WAFFO-1-close", orderStatus: "ORDER_CLOSE" },
    }),
  );
  await assertSignedMessage(closed, keys, "success");
  assert.equal((await store.getTopupByTrade("WAFFO-1-close"))?.status, "failed");

  const paid = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: {
        paymentRequestId: "WAFFO-1-pay",
        merchantOrderId: "WAFFO-1-pay",
        acquiringOrderId: "ACQ-1",
        orderStatus: "PAY_SUCCESS",
        orderAmount: "32.00",
        orderCurrency: "USD",
      },
    }),
  );
  await assertSignedMessage(paid, keys, "success");
  assert.equal((await store.getTopupByTrade("WAFFO-1-pay"))?.status, "success");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 2_000_000);

  const replay = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: { merchantOrderId: "WAFFO-1-pay", orderStatus: "PAY_SUCCESS" },
    }),
  );
  await assertSignedMessage(replay, keys, "success");
  assert.equal((await store.getUserById(1))?.quota, ROOT_QUOTA + 2_000_000);
});

test("original WaffoWebhook sandbox credentials verify and sign JSON", async () => {
  const { e, auth, store } = await boot();
  const keys = await generateWaffoTestKeyPair();
  await confirmCompliance(e, auth);
  await enableWaffo(store, keys, { sandbox: true });
  await store.insertTopup({
    user_id: 1,
    amount: 4,
    money: 4,
    trade_no: "WAFFO-sandbox",
    payment_method: "waffo",
    payment_provider: "waffo",
    status: "pending",
  });
  const out = await signedWebhook(
    e,
    keys,
    JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: { merchantOrderId: "WAFFO-sandbox", orderStatus: "PAY_SUCCESS" },
    }),
  );
  await assertSignedMessage(out, keys, "success");
  assert.equal((await store.getTopupByTrade("WAFFO-sandbox"))?.status, "success");
});

test("original router has no POST /api/waffo/webhook/:env", async () => {
  const { e } = await boot();
  const extra = await json(new Request("http://local/api/waffo/webhook/prod", { method: "POST", body: "{}" }), e);
  assert.equal(extra.res.status, 404);
  assert.equal((extra.body.error as { type?: string })?.type, "invalid_request_error");
  assert.equal((extra.body.error as { message?: string })?.message, "Invalid URL (POST /api/waffo/webhook/prod)");
});
