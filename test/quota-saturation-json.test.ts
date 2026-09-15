import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_MODE_TIERED_EXPR } from "../src/billing-setting.js";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import {
  attachQuotaSaturation,
  consumeLogOther,
  RELAY_FORMAT_OPENAI,
} from "../src/log-info-generate.js";
import { postWssConsumeQuota, type WssPriceData } from "../src/openai-realtime-billing.js";
import { calculateAudioQuota, realtimeUsageFromJSON } from "../src/openai-realtime-usage.js";
import { MAX_QUOTA, MIN_QUOTA } from "../src/task-plugin-usage.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const OVERFLOW_EXPR = `tier("overflow", p * 100000000)`;

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

async function putOption(e: Env, auth: Record<string, string>, key: string, value: string) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "quota-sat", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

function baseConsumeOpts() {
  return {
    model: "gpt-4o-mini",
    group: "default",
    groupRatio: 1,
    modelRatio: 0.075,
    completionRatio: 2,
    cacheTokens: 0,
    cacheRatio: 1,
    modelPrice: -1,
    userGroupRatio: -1,
    frt: -1000,
    channelId: 9,
    channelName: "oa",
    channelType: CHANNEL_TYPE_OPENAI,
    ok: true,
    requestPath: "/v1/chat/completions",
    requestConversion: [RELAY_FORMAT_OPENAI],
    billingSource: "wallet",
    useChannel: ["9"],
  };
}

test("original attachQuotaSaturation nests under admin_info JSON", () => {
  const other: Record<string, unknown> = { model_price: 0.004 };
  attachQuotaSaturation(other, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 1.8e19,
    clamped: MAX_QUOTA,
  });
  const admin = other.admin_info as Record<string, unknown>;
  assert.equal("model_price" in other, true);
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 1.8e19,
    clamped: MAX_QUOTA,
  });
});

test("original attachQuotaSaturation preserves existing admin_info JSON", () => {
  const other: Record<string, unknown> = {
    admin_info: { use_channel: ["9"], admin_username: "root" },
  };
  attachQuotaSaturation(other, {
    op: "QuotaFromFloat",
    kind: "underflow",
    original: -1e20,
    clamped: MIN_QUOTA,
  });
  const admin = other.admin_info as Record<string, unknown>;
  assert.equal(admin.admin_username, "root");
  assert.deepEqual(admin.use_channel, ["9"]);
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaFromFloat",
    kind: "underflow",
    original: -1e20,
    clamped: MIN_QUOTA,
  });
});

test("original attachQuotaSaturation no clamp leaves other untouched JSON", () => {
  const other: Record<string, unknown> = { model_price: 0.004 };
  attachQuotaSaturation(other, null);
  attachQuotaSaturation(other, undefined);
  assert.equal("admin_info" in other, false);
  assert.equal(other.model_price, 0.004);
});

test("original consumeLogOther quota_saturation JSON preserves use_channel", () => {
  const parsed = JSON.parse(
    consumeLogOther({
      ...baseConsumeOpts(),
      quotaClamp: {
        op: "QuotaRound",
        kind: "overflow",
        original: 5000000000,
        clamped: MAX_QUOTA,
      },
    }),
  ) as Record<string, unknown>;
  assert.equal("quota_saturation" in parsed, false);
  const admin = parsed.admin_info as Record<string, unknown>;
  assert.deepEqual(admin.use_channel, ["9"]);
  assert.equal(admin.channel_id, 9);
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaRound",
    kind: "overflow",
    original: 5000000000,
    clamped: MAX_QUOTA,
  });
});

test("original consumeLogOther without clamp omits quota_saturation JSON", () => {
  const parsed = JSON.parse(consumeLogOther(baseConsumeOpts())) as Record<string, unknown>;
  const admin = parsed.admin_info as Record<string, unknown>;
  assert.ok(admin);
  assert.equal("quota_saturation" in admin, false);
});

test("original calculateAudioQuota usePrice overflow is QuotaFromDecimal JSON", () => {
  const result = calculateAudioQuota({
    inputTextTokens: 1,
    inputAudioTokens: 0,
    outputTextTokens: 0,
    outputAudioTokens: 0,
    modelName: "gpt-4o-realtime-preview",
    usePrice: true,
    modelPrice: 10000,
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    audioRatio: 1,
    audioCompletionRatio: 1,
    quotaPerUnit: 500000,
  });
  assert.equal(result.quota, MAX_QUOTA);
  assert.deepEqual(result.clamp, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 5000000000,
    clamped: MAX_QUOTA,
  });
});

test("original TryTieredSettle overflow consume-log admin_info.quota_saturation JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "overflow-sat": BILLING_MODE_TIERED_EXPR }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({ "overflow-sat": OVERFLOW_EXPR }));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "overflow-sat",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-overflow-sat",
        models: "overflow-sat",
        group: "default",
        base_url: "https://overflow-sat.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const sk = await createSk(e, auth);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-overflow-sat",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "overflow-sat", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  } finally {
    globalThis.fetch = orig;
  }
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "overflow-sat" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  assert.equal(items[0].quota, MAX_QUOTA);
  const other = parseOther(items[0].other);
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.matched_tier, "overflow");
  const admin = other.admin_info as Record<string, unknown>;
  assert.ok(admin.use_channel, "use_channel must be preserved");
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaRound",
    kind: "overflow",
    original: 5000000000,
    clamped: MAX_QUOTA,
  });

  const selfLogs = await json(new Request("http://local/api/log/self?type=" + LOG_CONSUME, { headers: auth }), e);
  const selfItems = ((selfLogs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "overflow-sat",
  );
  assert.equal(selfItems.length >= 1, true, JSON.stringify(selfLogs.body));
  const selfOther = parseOther(selfItems[0].other);
  assert.equal("admin_info" in selfOther, false);
  assert.equal(selfLogs.text.includes("quota_saturation"), false);
});

test("original PostWssConsumeQuota attachQuotaSaturation QuotaFromDecimal JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "wss-sat",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-wss-sat",
        models: "gpt-4o-realtime-preview",
        group: "default",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const channelId = Number((ch.body.data as { id: number }).id);
  const channel = await store.getChannel(channelId);
  assert.ok(channel);
  const sk = await createSk(e, auth);
  const token = await store.getTokenByKey(sk);
  const user = await store.getUserByUsername("root");
  assert.ok(token && user);
  const usage = realtimeUsageFromJSON({
    total_tokens: 1,
    input_tokens: 1,
    output_tokens: 0,
    input_token_details: { audio_tokens: 0, cached_tokens: 0, text_tokens: 1 },
    output_token_details: { audio_tokens: 0, text_tokens: 0 },
  });
  assert.ok(usage);
  const price: WssPriceData = {
    usePrice: true,
    modelPrice: 10000,
    originModelRatio: 1,
    originCompletionRatio: 1,
    originAudioRatio: 1,
    originAudioCompletionRatio: 1,
    upstreamCompletionRatio: 1,
    upstreamAudioRatio: 1,
    upstreamAudioCompletionRatio: 1,
    groupRatio: 1,
    userGroupRatio: -1,
    quotaPerUnit: 500000,
    originModel: "gpt-4o-realtime-preview",
    upstreamModel: "gpt-4o-realtime-preview",
  };
  await postWssConsumeQuota({
    store,
    auth: { token, user, usingGroup: "default" },
    channel,
    req: new Request("http://local/v1/realtime"),
    price,
    usage,
    finalPreConsumedQuota: MAX_QUOTA,
    startMs: Date.now() - 1000,
    firstResponseMs: Date.now(),
    requestId: "wss-sat-req",
  });
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.request_id || "") === "wss-sat-req",
  );
  assert.equal(items.length, 1, JSON.stringify(logs.body));
  assert.equal(items[0].quota, MAX_QUOTA);
  const other = parseOther(items[0].other);
  assert.equal(other.ws, true);
  assert.equal("audio" in other, false);
  const admin = other.admin_info as Record<string, unknown>;
  assert.deepEqual(admin.use_channel, [String(channelId)]);
  assert.deepEqual(admin.quota_saturation, {
    op: "QuotaFromDecimal",
    kind: "overflow",
    original: 5000000000,
    clamped: MAX_QUOTA,
  });
});
