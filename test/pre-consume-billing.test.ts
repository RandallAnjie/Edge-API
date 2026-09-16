import assert from "node:assert/strict";
import { test } from "node:test";
import {
  billingSessionLogFields,
  preConsumeBilling,
  refundBilling,
  settleBilling,
  shouldTrustWallet,
} from "../src/billing-session.js";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME, ROOT_QUOTA } from "../src/constants.js";
import { formatQuotaOriginal, getTrustQuota, insufficientWalletQuotaMessage } from "../src/quota.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { AuthToken, Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
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

async function boot(e: Env) {
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
  return { token, auth, store: new Store(e.DB) };
}

async function asAuth(store: Store, tokenId: number): Promise<AuthToken> {
  const token = await store.getTokenById(tokenId);
  assert.ok(token);
  const user = await store.getUserById(token.user_id);
  assert.ok(user);
  return { token, user, usingGroup: user.group || "default" };
}

test("original common.GetTrustQuota is 10 * QuotaPerUnit", () => {
  assert.equal(getTrustQuota(500000), 5_000_000);
  assert.equal(getTrustQuota(), 5_000_000);
});

test("original BillingSession.shouldTrust wallet vs subscription JSON", () => {
  assert.equal(
    shouldTrustWallet({
      forcePreConsume: false,
      trustQuota: 5_000_000,
      tokenUnlimited: true,
      tokenQuota: 0,
      userQuota: ROOT_QUOTA,
      funding: "wallet",
    }),
    true,
  );
  assert.equal(
    shouldTrustWallet({
      forcePreConsume: false,
      trustQuota: 5_000_000,
      tokenUnlimited: true,
      tokenQuota: 0,
      userQuota: ROOT_QUOTA,
      funding: "subscription",
    }),
    false,
  );
  assert.equal(
    shouldTrustWallet({
      forcePreConsume: true,
      trustQuota: 5_000_000,
      tokenUnlimited: true,
      tokenQuota: 0,
      userQuota: ROOT_QUOTA,
      funding: "wallet",
    }),
    false,
  );
  assert.equal(
    shouldTrustWallet({
      forcePreConsume: false,
      trustQuota: 5_000_000,
      tokenUnlimited: false,
      tokenQuota: 37,
      userQuota: ROOT_QUOTA,
      funding: "wallet",
    }),
    false,
  );
  assert.equal(
    shouldTrustWallet({
      forcePreConsume: false,
      trustQuota: 5_000_000,
      tokenUnlimited: true,
      tokenQuota: 0,
      userQuota: 100_000,
      funding: "wallet",
    }),
    false,
  );
});

test("original PreConsumeBilling negative quota is model_price_error JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-neg-pre",
    name: "neg",
    remain_quota: 1000,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "neg-1", quota: -1 });
  assert.equal(held.error?.status, 400);
  assert.equal(held.error?.code, "model_price_error");
  assert.equal(held.error?.message, "pre-consume quota cannot be negative: -1");
  assert.equal(held.session, undefined);
});

test("original NewBillingSession wallet FormatQuota insufficient JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 0, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-wallet-zero",
    name: "zero",
    remain_quota: 100000,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "wallet-0", quota: 37 });
  assert.equal(held.error?.status, 403);
  assert.equal(held.error?.code, "insufficient_user_quota");
  assert.equal(
    held.error?.message,
    insufficientWalletQuotaMessage(0, 37, formatQuotaOriginal(0, 500000, "USD"), formatQuotaOriginal(37, 500000, "USD")),
  );

  await store.updateUser(root.id, { quota: 10 });
  const short = await asAuth(store, tokenId);
  const shortHeld = await preConsumeBilling(store, short, { requestId: "wallet-10", quota: 37 });
  assert.equal(shortHeld.error?.status, 403);
  assert.equal(shortHeld.error?.code, "insufficient_user_quota");
  assert.equal(
    shortHeld.error?.message,
    `预扣费额度失败, 用户剩余额度: ${formatQuotaOriginal(10, 500000, "USD")}, 需要预扣费额度: ${formatQuotaOriginal(37, 500000, "USD")}`,
  );
});

test("original PreConsumeTokenQuota FormatQuota JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 100_000, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-token-short",
    name: "short",
    remain_quota: 36,
    unlimited_quota: 0,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "tok-36", quota: 37 });
  assert.equal(held.error?.status, 403);
  assert.equal(held.error?.code, "pre_consume_token_quota_failed");
  assert.equal(
    held.error?.message,
    "token quota is not enough, token remain quota: ＄0.000072, need quota: ＄0.000074",
  );
  const user = await store.getUserById(root.id);
  assert.equal(Number(user?.quota), 100_000);
});

test("original BillingSession trust bypass holds 0 then Settle deducts actual", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-trust",
    name: "trust",
    remain_quota: 0,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "trust-1", quota: 37 });
  assert.equal(held.error, undefined);
  assert.equal(held.session?.trusted, true);
  assert.equal(held.session?.preConsumedQuota, 0);
  const afterHold = await store.getUserById(root.id);
  assert.equal(Number(afterHold?.quota), ROOT_QUOTA);
  await settleBilling(store, authTok, held.session, 12);
  const afterSettle = await store.getUserById(root.id);
  assert.equal(Number(afterSettle?.quota), ROOT_QUOTA - 12);
});

test("original BillingSession hold + Refund restores wallet and token", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 100_000, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-hold",
    name: "hold",
    remain_quota: 1000,
    unlimited_quota: 0,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "hold-1", quota: 37 });
  assert.equal(held.error, undefined);
  assert.equal(held.session?.trusted, false);
  assert.equal(held.session?.preConsumedQuota, 37);
  const afterHold = await store.getUserById(root.id);
  const tokenHold = await store.getTokenById(tokenId);
  assert.equal(Number(afterHold?.quota), 100_000 - 37);
  assert.equal(Number(tokenHold?.remain_quota), 1000 - 37);
  await refundBilling(store, authTok, held.session);
  await refundBilling(store, authTok, held.session);
  const afterRefund = await store.getUserById(root.id);
  const tokenRefund = await store.getTokenById(tokenId);
  assert.equal(Number(afterRefund?.quota), 100_000);
  assert.equal(Number(tokenRefund?.remain_quota), 1000);
});

test("original SettleBilling delta does not double-debit the pre-hold", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 100_000, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-delta",
    name: "delta",
    remain_quota: 1000,
    unlimited_quota: 0,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "delta-1", quota: 37 });
  assert.equal(held.session?.preConsumedQuota, 37);
  await settleBilling(store, authTok, held.session, 12);
  const user = await store.getUserById(root.id);
  const token = await store.getTokenById(tokenId);
  assert.equal(Number(user?.quota), 100_000 - 12);
  assert.equal(Number(token?.remain_quota), 1000 - 12);
  assert.equal(billingSessionLogFields(held.session).billingSource, "wallet");
});

test("original HTTP PreConsumeBilling wallet insufficient and failed-relay refund JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "preconsume-http",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-preconsume",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://preconsume.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 0, billing_preference: "wallet_only" });
  const zeroTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "zero-wallet", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  const zeroSk = (zeroTok.body.data as { key: string }).key;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("should-not-fetch")) as typeof fetch;
  try {
    const zero = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + zeroSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(zero.res.status, 403, zero.text);
    assert.equal((zero.body.error as { code?: string })?.code, "insufficient_user_quota");
    assert.equal((zero.body.error as { type?: string })?.type, "new_api_error");
    assert.equal((zero.body.error as { message?: string })?.message, "用户额度不足, 剩余额度: ＄0.000000");
  } finally {
    globalThis.fetch = orig;
  }

  await store.updateUser(root.id, { quota: 100_000 });
  const holdTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "hold-refund", remain_quota: 1000, unlimited_quota: false }),
    }),
    e,
  );
  const holdSk = (holdTok.body.data as { key: string }).key;
  globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as typeof fetch;
  try {
    const failed = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + holdSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(failed.res.status >= 400, true, failed.text);
    const after = await store.getUserById(root.id);
    assert.equal(Number(after?.quota), 100_000);
  } finally {
    globalThis.fetch = orig;
  }

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-preconsume",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const before = await store.getUserById(root.id);
    const ok = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + holdSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(ok.res.status, 200, ok.text);
    const logs = await store.listLogs({ userId: root.id, type: LOG_CONSUME, offset: 0, limit: 5, order: "id" });
    const row = logs.items[0];
    assert.ok(row);
    const after = await store.getUserById(root.id);
    assert.equal(Number(after?.quota), Number(before?.quota) - Number(row.quota));
  } finally {
    globalThis.fetch = orig;
  }
});
