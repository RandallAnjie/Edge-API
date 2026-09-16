import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WALLET_QUOTA_INSUFFICIENT,
  preConsumeBilling,
  prepareImageBillingForRequest,
  refundBilling,
  reserveBilling,
} from "../src/billing-session.js";
import { CHANNEL_TYPE_ALI, CHANNEL_TYPE_OPENAI, ROOT_QUOTA } from "../src/constants.js";
import {
  applyAliImageParametersN,
  imageRequestCount,
  outboundImageQuantity,
  refreshOutboundImageQuantity,
} from "../src/image-billing.js";
import { MAX_IMAGE_N, quotaRoundStrict } from "../src/task-plugin-usage.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { AuthToken, Env, ExecutionContextLike } from "../src/types.js";
import { mergeModelRatio } from "./merge-model-ratio.js";

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

function dallePrice(n: number, groupRatio = 1) {
  return {
    usePrice: true,
    modelPrice: 0.04,
    otherRatios: { n } as Record<string, number>,
    imageQuotaBeforeGroup: 20000,
    groupRatio,
    quotaPerUnit: 500000,
    quotaToPreConsume: 20000 * n,
    freeModel: false,
  };
}

test("original QuotaRoundStrict rejects overflow instead of saturating", () => {
  const ok = quotaRoundStrict(37.4);
  assert.equal(ok.clamp, null);
  assert.equal(ok.quota, 37);
  const overflow = quotaRoundStrict(Number.MAX_VALUE);
  assert.ok(overflow.clamp);
  assert.equal(overflow.clamp?.kind, "overflow");
  assert.equal(overflow.quota, 0);
});

test("original ImageHelper outbound n nil keeps previous ImageCount JSON", () => {
  const kept = outboundImageQuantity({ parameters: {} }, 3, false);
  assert.equal(kept.count, 3);
  const overridden = outboundImageQuantity({ n: 2 }, 3, false);
  assert.equal(overridden.count, 2);
  assert.throws(() => outboundImageQuantity({ n: MAX_IMAGE_N + 1 }, 1, false), /n must be an integer between 1 and 128/);
  assert.throws(
    () => outboundImageQuantity({ n: 1, parameters: { n: MAX_IMAGE_N + 1 } }, 1, true),
    /parameters.n must be an integer between 1 and 128/,
  );
});

test("original ImageHelper Ali parameters.n is the reserved quantity", () => {
  const target = { body: { model: "z-image", input: { prompt: "cat" }, parameters: { size: "1024*1024" } } };
  const refreshed = refreshOutboundImageQuantity(target, 2, CHANNEL_TYPE_ALI);
  assert.equal(refreshed.error, undefined);
  assert.equal(refreshed.count, 2);
  assert.equal((target.body as { parameters: { n: number } }).parameters.n, 2);
  const next = applyAliImageParametersN({ parameters: { prompt_extend: true } }, 4);
  assert.equal(next.parameters.n, 4);
  assert.equal(next.parameters.prompt_extend, true);
});

test("original PrepareImageBillingForRequest image_count bounds are invalid_request JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-image-count",
    name: "count",
    remain_quota: 1000,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const zero = await prepareImageBillingForRequest(store, authTok, {
    count: 0,
    promptExtend: false,
    channelType: CHANNEL_TYPE_OPENAI,
    upstreamModelName: "dall-e-3",
    price: dallePrice(1),
    session: null,
    requestId: "img-0",
  });
  assert.equal(zero.error?.status, 400);
  assert.equal(zero.error?.code, "invalid_request");
  assert.equal(zero.error?.skipRetry, true);
  assert.equal(zero.error?.message, `image_count must be an integer between 1 and ${MAX_IMAGE_N}`);

  const huge = await prepareImageBillingForRequest(store, authTok, {
    count: MAX_IMAGE_N + 1,
    promptExtend: false,
    channelType: CHANNEL_TYPE_OPENAI,
    upstreamModelName: "dall-e-3",
    price: dallePrice(1),
    session: null,
    requestId: "img-129",
  });
  assert.equal(huge.error?.message, `image_count must be an integer between 1 and ${MAX_IMAGE_N}`);
});

test("original BillingSession.Reserve bypasses trust for images and holds extra n", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-image-trust",
    name: "trust-img",
    remain_quota: 0,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "img-trust", quota: 20000 });
  assert.equal(held.session?.trusted, true);
  assert.equal(held.session?.preConsumedQuota, 0);
  const afterTrust = await store.getUserById(root.id);
  assert.equal(Number(afterTrust?.quota), ROOT_QUOTA);

  const reserved = await reserveBilling(store, authTok, held.session!, 20000, true);
  assert.equal(reserved, null);
  assert.equal(held.session?.trusted, false);
  assert.equal(held.session?.preConsumedQuota, 20000);
  assert.equal(held.session?.extraReserved, 20000);
  assert.equal(held.session?.tokenConsumed, 20000);
  const afterReserve = await store.getUserById(root.id);
  assert.equal(Number(afterReserve?.quota), ROOT_QUOTA - 20000);

  const extra = await reserveBilling(store, authTok, held.session!, 40000, true);
  assert.equal(extra, null);
  assert.equal(held.session?.preConsumedQuota, 40000);
  const afterExtra = await store.getUserById(root.id);
  assert.equal(Number(afterExtra?.quota), ROOT_QUOTA - 40000);

  const shrink = await reserveBilling(store, authTok, held.session!, 20000, true);
  assert.equal(shrink, null);
  assert.equal(held.session?.preConsumedQuota, 40000);
});

test("original image Reserve wallet extra fail is wallet quota insufficient JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 25000, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-image-short",
    name: "short-img",
    remain_quota: 100000,
    unlimited_quota: 1,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "img-short", quota: 20000 });
  assert.equal(held.session?.preConsumedQuota, 20000);
  const fail = await reserveBilling(store, authTok, held.session!, 40000, true);
  assert.equal(fail?.status, 403);
  assert.equal(fail?.code, "insufficient_user_quota");
  assert.equal(fail?.skipRetry, true);
  assert.equal(fail?.message, WALLET_QUOTA_INSUFFICIENT);
  const user = await store.getUserById(root.id);
  assert.equal(Number(user?.quota), 5000);
});

test("original playground Reserve increments tokenConsumed so wallet Refund runs", async () => {
  resetSchemaFlag();
  const e = env();
  const { store } = await boot(e);
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 100_000, billing_preference: "wallet_only" });
  const tokenId = await store.insertToken({
    user_id: root.id,
    key: "sk-play",
    name: "play",
    remain_quota: 1000,
    unlimited_quota: 0,
  });
  const authTok = await asAuth(store, tokenId);
  const held = await preConsumeBilling(store, authTok, { requestId: "play-1", quota: 37, playground: true });
  assert.equal(held.session?.playground, true);
  assert.equal(held.session?.preConsumedQuota, 37);
  assert.equal(held.session?.tokenConsumed, 37);
  const tokenHold = await store.getTokenById(tokenId);
  assert.equal(Number(tokenHold?.remain_quota), 1000);
  await refundBilling(store, authTok, held.session);
  const after = await store.getUserById(root.id);
  const tokenRefund = await store.getTokenById(tokenId);
  assert.equal(Number(after?.quota), 100_000);
  assert.equal(Number(tokenRefund?.remain_quota), 1000);
});

test("original HTTP image Reserve extra n and trusted hold JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "image-reserve",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-image-reserve",
        models: "dall-e-3",
        group: "default",
        base_url: "https://image-reserve.example.test",
        param_override: JSON.stringify({ n: 2 }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const root = await store.getRootUser();
  assert.ok(root);
  await store.updateUser(root.id, { quota: 25000, billing_preference: "wallet_only" });
  const shortTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "image-short", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  const shortSk = (shortTok.body.data as { key: string }).key;
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response("should-not-fetch");
  }) as typeof fetch;
  try {
    const extra = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + shortSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
      }),
      e,
    );
    assert.equal(extra.res.status, 403, extra.text);
    assert.equal((extra.body.error as { code?: string })?.code, "insufficient_user_quota");
    assert.equal((extra.body.error as { type?: string })?.type, "new_api_error");
    assert.equal((extra.body.error as { message?: string })?.message, WALLET_QUOTA_INSUFFICIENT);
    assert.equal(fetched, false);
    const after = await store.getUserById(root.id);
    assert.equal(Number(after?.quota), 5000);
  } finally {
    globalThis.fetch = orig;
  }

  await store.updateUser(root.id, { quota: ROOT_QUOTA, billing_preference: "wallet_only" });
  const trustTok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "image-trust", remain_quota: 0, unlimited_quota: true }),
    }),
    e,
  );
  const trustSk = (trustTok.body.data as { key: string }).key;
  let heldDuringFetch = -1;
  globalThis.fetch = (async () => {
    const mid = await store.getUserById(root.id);
    heldDuringFetch = Number(mid?.quota || 0);
    return new Response("upstream down", { status: 500 });
  }) as typeof fetch;
  try {
    const failed = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + trustSk, "content-type": "application/json" },
        body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
      }),
      e,
    );
    assert.equal(failed.res.status >= 400, true, failed.text);
    assert.equal(heldDuringFetch, ROOT_QUOTA - 40000);
    const afterFail = await store.getUserById(root.id);
    assert.equal(Number(afterFail?.quota), ROOT_QUOTA);
  } finally {
    globalThis.fetch = orig;
  }
});

test("original HTTP Ali parameters.n matches reserved outbound quantity", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await mergeModelRatio(store, { "z-image": 1 });
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "ali-image-n",
        type: CHANNEL_TYPE_ALI,
        key: "sk-ali-n",
        models: "z-image",
        group: "default",
        base_url: "https://dashscope.aliyuncs.com",
        param_override: JSON.stringify({
          operations: [{ path: "parameters.n", mode: "set", value: 3 }],
        }),
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ali-n", unlimited_quota: true }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(String(init?.body || "")) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    calls.push({ url, body: parsed });
    return new Response(
      JSON.stringify({
        output: { results: [{ url: "https://example.com/ali.png" }] },
        usage: { image_count: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/images/generations", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "z-image", prompt: "poster", n: 1, parameters: { prompt_extend: true } }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    const imageCall = calls.find((c) => c.url.includes("/aigc/") || c.url.includes("dashscope"));
    assert.ok(imageCall, JSON.stringify(calls.map((c) => c.url)));
    assert.equal((imageCall.body.parameters as { n?: number })?.n, 3);
    assert.equal(imageRequestCount({ n: 1, parameters: { n: 3 } }, true), 3);
  } finally {
    globalThis.fetch = orig;
  }
});
