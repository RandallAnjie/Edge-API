import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, CHANNEL_TYPE_OPENROUTER, LOG_CONSUME } from "../src/constants.js";
import { consumeLogOther, RELAY_FORMAT_OPENAI } from "../src/log-info-generate.js";
import type { TextConsumePriceData } from "../src/quota.js";
import { logQuota } from "../src/quota.js";
import {
  calcOpenRouterCacheCreateTokens,
  calculateTextQuotaSummary,
  calculateTextToolCallSurcharge,
  composeTieredTextQuota,
  hasCustomModelRatio,
  mergeToolSurchargeItems,
  postTextAudioInputQuota,
  postTextConsumeLogContent,
  postTextConsumeLogParts,
  postTextToolSurchargeQuota,
  textHasBillableUsage,
} from "../src/text-quota.js";
import { mergeModelRatio } from "./merge-model-ratio.js";
import {
  BUILD_IN_TOOL_FILE_SEARCH,
  BUILD_IN_TOOL_GOOGLE_SEARCH,
  BUILD_IN_TOOL_IMAGE_GENERATION,
  BUILD_IN_TOOL_WEB_SEARCH,
  BUILD_IN_TOOL_WEB_SEARCH_PREVIEW,
  getToolPriceForModel,
} from "../src/tool-price.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const QUOTA_PER_UNIT = 500000;

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

async function createChannel(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown>,
): Promise<number> {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        group: "default",
        key: "sk-text-quota",
        base_url: "https://text-quota.example.test",
        type: CHANNEL_TYPE_OPENAI,
        ...body,
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  return Number((ch.body.data as { id: number }).id);
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "text-quota", remain_quota: 100000, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

async function withMockedFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  assert.equal(typeof raw, "string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

function price(overrides: Partial<TextConsumePriceData> = {}): TextConsumePriceData {
  return {
    modelRatio: 1,
    completionRatio: 1,
    groupRatio: 1,
    cacheRatio: 0.1,
    cacheCreationRatio: 1.25,
    cacheCreationRatio5m: 1.25,
    cacheCreationRatio1h: 2,
    imageRatio: 1,
    audioRatio: 1,
    audioCompletionRatio: 1,
    modelPrice: -1,
    userGroupRatio: -1,
    hasSpecialRatio: false,
    usePrice: false,
    tiered: false,
    ...overrides,
  };
}

function usage(opts: {
  prompt: number;
  completion?: number;
  cached?: number;
  creation?: number;
  write?: number;
  five?: number;
  hour?: number;
  audio?: number;
  semantic?: string;
  source?: string;
  cost?: number;
}) {
  return {
    prompt_tokens: opts.prompt,
    completion_tokens: opts.completion || 0,
    usage_semantic: opts.semantic || "",
    usage_source: opts.source || "",
    cost: opts.cost || 0,
    claude_cache_creation_5_m_tokens: opts.five || 0,
    claude_cache_creation_1_h_tokens: opts.hour || 0,
    prompt_tokens_details: {
      cached_tokens: opts.cached || 0,
      cached_creation_tokens: opts.creation || 0,
      cache_write_tokens: opts.write || 0,
      audio_tokens: opts.audio || 0,
    },
  };
}

async function chatLog(
  e: Env,
  auth: Record<string, string>,
  sk: string,
  model: string,
  usageJson: Record<string, unknown>,
) {
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-text-quota",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: usageJson,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === model && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  return { row: items[0], other: parseOther(items[0].other) };
}

test("original PostTextConsumeQuota extraContent JSON", () => {
  const formatQuota = (q: number) => logQuota(q, QUOTA_PER_UNIT);
  assert.equal(postTextToolSurchargeQuota({ name: "web_search_preview", count: 1, price: 25 }, 1, QUOTA_PER_UNIT), 12500);
  assert.equal(postTextAudioInputQuota(1, 50, 1, QUOTA_PER_UNIT), 25);
  assert.equal(
    postTextConsumeLogContent(
      [],
      postTextConsumeLogParts({
        usageMissing: true,
        groupRatio: 1,
        quotaPerUnit: QUOTA_PER_UNIT,
        formatQuota,
        hasBillableUsage: false,
        billingModelName: "gpt-4o-mini",
      }),
    ),
    "上游无计费信息, 上游没有返回计费信息，无法扣费（可能是上游超时）",
  );
  assert.equal(
    postTextConsumeLogParts({
      toolSurcharges: [{ name: "web_search_preview", count: 2, price: 10 }],
      groupRatio: 1,
      quotaPerUnit: QUOTA_PER_UNIT,
      formatQuota,
      hasBillableUsage: true,
      billingModelName: "gpt-5.1",
    }).join(", "),
    "web_search_preview 调用 2 次，调用花费 ＄0.020000 额度",
  );
  assert.equal(
    postTextConsumeLogParts({
      audioInputPrice: 1,
      audioInputTokens: 50,
      groupRatio: 1,
      quotaPerUnit: QUOTA_PER_UNIT,
      formatQuota,
      hasBillableUsage: true,
      billingModelName: "gemini-2.5-flash",
    }).join(", "),
    "Audio Input 花费 ＄0.000050 额度",
  );
  assert.equal(
    postTextConsumeLogParts({
      groupRatio: 1,
      quotaPerUnit: QUOTA_PER_UNIT,
      formatQuota,
      hasBillableUsage: true,
      billingModelName: "gpt-4-gizmo-abc",
    }).join(", "),
    "模型 gpt-4-gizmo-abc",
  );
  assert.equal(
    postTextConsumeLogParts({
      groupRatio: 1,
      quotaPerUnit: QUOTA_PER_UNIT,
      formatQuota,
      hasBillableUsage: true,
      billingModelName: "gpt-4o-gizmo-xyz",
    }).join(", "),
    "模型 gpt-4o-gizmo-xyz",
  );
  assert.equal(
    postTextConsumeLogContent(
      ["大小 1024x1024", "品质 hd", "生成数量 2"],
      postTextConsumeLogParts({
        groupRatio: 1,
        quotaPerUnit: QUOTA_PER_UNIT,
        formatQuota,
        hasBillableUsage: true,
        billingModelName: "dall-e-3",
      }),
    ),
    "大小 1024x1024, 品质 hd, 生成数量 2",
  );
  assert.equal(textHasBillableUsage({ totalTokens: 0, toolCallSurchargeQuota: 5000 } as never), true);
  assert.equal(textHasBillableUsage({ totalTokens: 0, toolCallSurchargeQuota: 0 } as never), false);
  assert.equal(textHasBillableUsage({ totalTokens: 0, toolCallSurchargeQuota: 0 } as never, true), true);
});

test("original calculateTextQuotaSummary Claude semantic quota JSON 1488", () => {
  const summary = calculateTextQuotaSummary({
    model: "claude-3-7-sonnet",
    price: price({ completionRatio: 2 }),
    usage: usage({ prompt: 1000, completion: 200, cached: 100, creation: 50, five: 10, hour: 20 }),
    finalRequestFormat: "claude",
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.isClaudeUsageSemantic, true);
  assert.equal(summary.quota, 1488);
});

test("original calculateTextQuotaSummary split Claude cache-creation quota JSON 118", () => {
  const summary = calculateTextQuotaSummary({
    model: "claude-3-7-sonnet",
    price: price({ cacheRatio: 0, cacheCreationRatio: 1, cacheCreationRatio5m: 2, cacheCreationRatio1h: 3 }),
    usage: usage({ prompt: 100, creation: 10, five: 2, hour: 3 }),
    finalRequestFormat: "claude",
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.quota, 118);
});

test("original calculateTextQuotaSummary usage_semantic anthropic quota JSON 1488", () => {
  const summary = calculateTextQuotaSummary({
    model: "claude-3-7-sonnet",
    price: price({ completionRatio: 2 }),
    usage: usage({
      prompt: 1000,
      completion: 200,
      cached: 100,
      creation: 50,
      five: 10,
      hour: 20,
      semantic: "anthropic",
    }),
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.usageSemantic, "anthropic");
  assert.equal(summary.quota, 1488);
});

test("original calculateTextQuotaSummary legacy Claude-derived OpenAI quota JSON 1624", () => {
  const summary = calculateTextQuotaSummary({
    model: "claude-3-7-sonnet",
    price: price({ completionRatio: 5 }),
    usage: usage({ prompt: 62, completion: 95, cached: 3544, five: 586 }),
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.quota, 1624);
});

test("original calculateTextQuotaSummary OpenAI cache_write remainder quota JSON 1879", () => {
  const summary = calculateTextQuotaSummary({
    model: "gpt-5.1",
    price: price({ completionRatio: 2 }),
    usage: usage({ prompt: 1473, completion: 19, write: 1470 }),
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.cacheCreationTokens, 1470);
  assert.equal(summary.quota, 1879);
});

test("original calculateTextQuotaSummary OpenAI cache_write overlap clamp quota JSON 4884", () => {
  const summary = calculateTextQuotaSummary({
    model: "gpt-5.1",
    price: price({ completionRatio: 2 }),
    usage: usage({ prompt: 3619, completion: 36, cached: 2921, write: 3616 }),
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.promptTokens, 3619);
  assert.equal(summary.quota, 4884);
});

test("original calculateTextQuotaSummary OpenRouter OpenAI keeps prompt 2604 quota JSON 798", () => {
  const summary = calculateTextQuotaSummary({
    model: "openai/gpt-4.1",
    price: price(),
    usage: usage({ prompt: 2604, completion: 383, cached: 2432 }),
    channelType: CHANNEL_TYPE_OPENROUTER,
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.promptTokens, 2604);
  assert.equal(summary.quota, 798);
});

test("original calculateTextQuotaSummary OpenRouter Claude logged prompt 172 quota JSON 798", () => {
  const summary = calculateTextQuotaSummary({
    model: "anthropic/claude-3.7-sonnet",
    price: price(),
    usage: usage({ prompt: 2604, completion: 383, cached: 2432 }),
    channelType: CHANNEL_TYPE_OPENROUTER,
    finalRequestFormat: "claude",
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.isClaudeUsageSemantic, true);
  assert.equal(summary.promptTokens, 172);
  assert.equal(summary.totalTokens, 2987);
  assert.equal(summary.quota, 798);
});

test("original calculateTextQuotaSummary OpenRouter cache creation keeps prompt JSON 3012", () => {
  const summary = calculateTextQuotaSummary({
    model: "openai/gpt-4.1",
    price: price({ cacheRatio: 0 }),
    usage: usage({ prompt: 2604, completion: 383, creation: 100 }),
    channelType: CHANNEL_TYPE_OPENROUTER,
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.promptTokens, 2604);
  assert.equal(summary.quota, 3012);
});

test("original calculateTextQuotaSummary zero tokens still bills tool surcharge JSON", () => {
  const summary = calculateTextQuotaSummary({
    model: "o1",
    price: price(),
    usage: usage({ prompt: 0 }),
    builtInTools: { [BUILD_IN_TOOL_WEB_SEARCH_PREVIEW]: 1 },
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.totalTokens, 0);
  assert.equal(summary.quota, 5000);
  assert.deepEqual(summary.toolSurchargeItems, [{ name: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, count: 1, price: 10 }]);
});

test("original calculateTextQuotaSummary does not apply n to tool surcharge JSON", () => {
  const summary = calculateTextQuotaSummary({
    model: "o1",
    price: price(),
    usage: usage({ prompt: 0 }),
    builtInTools: { [BUILD_IN_TOOL_WEB_SEARCH_PREVIEW]: 1 },
    otherRatios: { n: 3 },
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.toolCallSurchargeQuota, 5000);
  assert.equal(summary.quota, 5000);
});

test("original calculateTextQuotaSummary usePrice n=3 image count JSON 180000", () => {
  const summary = calculateTextQuotaSummary({
    model: "dall-e-3",
    price: price({ usePrice: true, modelPrice: 0.12, modelRatio: 0 }),
    usage: usage({ prompt: 1 }),
    otherRatios: { n: 3 },
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.quota, 180000);
});

test("original calculateTextQuotaSummary Gemini audio_input_seperate_price JSON", () => {
  const summary = calculateTextQuotaSummary({
    model: "gemini-2.5-flash",
    price: price(),
    usage: usage({ prompt: 100, audio: 50 }),
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  assert.equal(summary.audioInputPrice, 1);
  assert.equal(summary.quota, 75);
  const parsed = JSON.parse(
    consumeLogOther({
      model: "gemini-2.5-flash",
      group: "default",
      groupRatio: 1,
      modelRatio: 1,
      completionRatio: 1,
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
      audioInputPrice: summary.audioInputPrice,
      audioInputTokens: summary.audioTokens,
      toolSurcharges: summary.toolSurchargeItems,
    }),
  ) as Record<string, unknown>;
  assert.equal(parsed.audio_input_seperate_price, true);
  assert.equal(parsed.audio_input_token_count, 50);
  assert.equal(parsed.audio_input_price, 1);
  assert.equal("web_search" in parsed, false);
  assert.equal("web_search_call_count" in parsed, false);
  assert.equal("web_search_price" in parsed, false);
});

test("original consumeLogOther tool_surcharges JSON omits legacy web_search keys", () => {
  const parsed = JSON.parse(
    consumeLogOther({
      model: "o1",
      group: "default",
      groupRatio: 1,
      modelRatio: 1,
      completionRatio: 1,
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
      toolSurcharges: [
        { name: BUILD_IN_TOOL_WEB_SEARCH, count: 2, price: 10 },
        { name: BUILD_IN_TOOL_IMAGE_GENERATION, count: 1, price: 150 },
      ],
    }),
  ) as Record<string, unknown>;
  assert.deepEqual(parsed.tool_surcharges, [
    { name: BUILD_IN_TOOL_WEB_SEARCH, count: 2, price: 10 },
    { name: BUILD_IN_TOOL_IMAGE_GENERATION, count: 1, price: 150 },
  ]);
  assert.equal("web_search" in parsed, false);
  assert.equal("web_search_call_count" in parsed, false);
  assert.equal("web_search_price" in parsed, false);
  assert.equal("file_search" in parsed, false);
  assert.equal("image_generation_call" in parsed, false);
  assert.equal("image_generation_call_price" in parsed, false);
});

test("original calculateTextToolCallSurcharge search-preview gpt-4o price 25 JSON", () => {
  const tools = calculateTextToolCallSurcharge({
    model: "gpt-4o-search-preview",
    groupRatio: 1,
    quotaPerUnit: QUOTA_PER_UNIT,
    relayMode: "chat",
  });
  assert.deepEqual(tools.items, [{ name: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, count: 1, price: 25 }]);
  assert.equal(tools.surcharge, 12500);
});

test("original calculateTextToolCallSurcharge does not infer search for responses JSON", () => {
  const tools = calculateTextToolCallSurcharge({
    model: "gpt-4o-search-preview",
    groupRatio: 1,
    quotaPerUnit: QUOTA_PER_UNIT,
    relayMode: "responses",
    builtInTools: {},
  });
  assert.deepEqual(tools.items, []);
  assert.equal(tools.surcharge, 0);
});

test("original calculateTextToolCallSurcharge merges same name and price JSON", () => {
  const tools = calculateTextToolCallSurcharge({
    model: "claude-3-7-sonnet",
    groupRatio: 1,
    quotaPerUnit: QUOTA_PER_UNIT,
    builtInTools: { [BUILD_IN_TOOL_WEB_SEARCH]: 2 },
    claudeWebSearchRequests: 3,
  });
  assert.deepEqual(tools.items, [{ name: BUILD_IN_TOOL_WEB_SEARCH, count: 5, price: 10 }]);
  assert.equal(tools.surcharge, 25000);
});

test("original calculateTextToolCallSurcharge gemini google_search JSON", () => {
  const tools = calculateTextToolCallSurcharge({
    model: "gemini-2.5-flash",
    groupRatio: 1,
    quotaPerUnit: QUOTA_PER_UNIT,
    geminiGoogleSearchCall: true,
  });
  assert.deepEqual(tools.items, [{ name: BUILD_IN_TOOL_GOOGLE_SEARCH, count: 1, price: 14 }]);
  assert.equal(tools.surcharge, 7000);
});

test("original mergeToolSurchargeItems saturates count overflow JSON", () => {
  const merged = mergeToolSurchargeItems([
    { name: "custom_fn", count: Number.MAX_SAFE_INTEGER, price: 5 },
    { name: "custom_fn", count: 1, price: 5 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, Number.MAX_SAFE_INTEGER);
});

test("original composeTieredTextQuota keeps tool-call surcharges JSON 14000", () => {
  const summary = calculateTextQuotaSummary({
    model: "o1",
    price: price(),
    usage: usage({ prompt: 100, completion: 50 }),
    builtInTools: {
      [BUILD_IN_TOOL_WEB_SEARCH_PREVIEW]: 1,
      [BUILD_IN_TOOL_FILE_SEARCH]: 2,
      [BUILD_IN_TOOL_IMAGE_GENERATION]: 1,
    },
    toolPrices: { [BUILD_IN_TOOL_IMAGE_GENERATION]: 11 },
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  const composed = composeTieredTextQuota({
    toolCallSurchargeQuota: summary.toolCallSurchargeQuota,
    tieredQuota: 1000,
    result: { actualQuotaBeforeGroup: 1000 } as never,
    snap: { groupRatio: 1 } as never,
  });
  assert.equal(summary.toolCallSurchargeQuota, 13000);
  assert.equal(composed.quota, 14000);
});

test("original composeTieredTextQuota fallback keeps surcharges JSON 13750", () => {
  const summary = calculateTextQuotaSummary({
    model: "claude-3-7-sonnet",
    price: price({ groupRatio: 1.25 }),
    usage: usage({ prompt: 100, completion: 50 }),
    claudeWebSearchRequests: 2,
    quotaPerUnit: QUOTA_PER_UNIT,
  });
  const composed = composeTieredTextQuota({
    toolCallSurchargeQuota: summary.toolCallSurchargeQuota,
    tieredQuota: 1250,
  });
  assert.equal(summary.toolCallSurchargeQuota, 12500);
  assert.equal(composed.quota, 13750);
});

test("original CalcOpenRouterCacheCreateTokens Inf cost does not wrap JSON", () => {
  assert.equal(
    calcOpenRouterCacheCreateTokens(
      usage({ prompt: 0, cost: Number.POSITIVE_INFINITY }),
      price({ cacheCreationRatio: 2, cacheRatio: 1, completionRatio: 1 }),
      QUOTA_PER_UNIT,
    ),
    -1,
  );
});

test("original hasCustomModelRatio missing default is custom JSON", () => {
  assert.equal(hasCustomModelRatio("not-a-default-model", 1), true);
  assert.equal(hasCustomModelRatio("gpt-4o-mini", 0.075), false);
  assert.equal(hasCustomModelRatio("gpt-4o-mini", 1), true);
});

test("original GetToolPriceForModel longest prefix and zero terminal JSON", () => {
  assert.equal(getToolPriceForModel(BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, "o1"), 10);
  assert.equal(getToolPriceForModel(BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, "gpt-4o-search-preview"), 25);
  assert.equal(getToolPriceForModel(BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, "gpt-4o-mini-search-preview"), 25);
  assert.equal(getToolPriceForModel(BUILD_IN_TOOL_WEB_SEARCH, "claude-3-7-sonnet", { web_search: 0 }), 0);
});

test("original search-preview HTTP tool_surcharges consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await mergeModelRatio(store, { "gpt-4o-search-preview": 1 });
  await createChannel(e, auth, { name: "search-preview", models: "gpt-4o-search-preview" });
  const sk = await createSk(e, auth);
  const { row, other } = await chatLog(e, auth, sk, "gpt-4o-search-preview", {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  assert.equal(row.quota, 12500);
  assert.deepEqual(other.tool_surcharges, [{ name: BUILD_IN_TOOL_WEB_SEARCH_PREVIEW, count: 1, price: 25 }]);
  assert.equal(row.content, "web_search_preview 调用 1 次，调用花费 ＄0.025000 额度");
  assert.equal("web_search" in other, false);
  assert.equal("web_search_call_count" in other, false);
  assert.equal("web_search_price" in other, false);
});

test("original OpenAI cache_write HTTP consume-log quota JSON 1879", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gpt-5.1": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gpt-5.1": 2 }));
  await putOption(e, auth, "CacheRatio", JSON.stringify({ "gpt-5.1": 0.1 }));
  await createChannel(e, auth, { name: "cache-write", models: "gpt-5.1" });
  const sk = await createSk(e, auth);
  const { row, other } = await chatLog(e, auth, sk, "gpt-5.1", {
    prompt_tokens: 1473,
    completion_tokens: 19,
    total_tokens: 1492,
    prompt_tokens_details: { cache_write_tokens: 1470 },
  });
  assert.equal(row.quota, 1879);
  assert.equal(other.cache_write_tokens, 1470);
  assert.equal(other.cache_creation_tokens, 1470);
  assert.equal(other.cache_creation_ratio, 1.25);
});

test("original OpenRouter OpenAI HTTP keeps prompt 2604 quota JSON 798", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "openai/gpt-4.1": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "openai/gpt-4.1": 1 }));
  await putOption(e, auth, "CacheRatio", JSON.stringify({ "openai/gpt-4.1": 0.1 }));
  await createChannel(e, auth, {
    name: "or-openai",
    type: CHANNEL_TYPE_OPENROUTER,
    models: "openai/gpt-4.1",
    key: "sk-or",
  });
  const sk = await createSk(e, auth);
  const { row, other } = await chatLog(e, auth, sk, "openai/gpt-4.1", {
    prompt_tokens: 2604,
    completion_tokens: 383,
    total_tokens: 2987,
    prompt_tokens_details: { cached_tokens: 2432 },
  });
  assert.equal(row.prompt_tokens, 2604);
  assert.equal(row.quota, 798);
  assert.equal(other.cache_tokens, 2432);
  assert.equal(other.usage_semantic, undefined);
});

test("original OpenRouter Claude HTTP logged prompt 172 quota JSON 798", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "anthropic/claude-3.7-sonnet": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "anthropic/claude-3.7-sonnet": 1 }));
  await putOption(e, auth, "CacheRatio", JSON.stringify({ "anthropic/claude-3.7-sonnet": 0.1 }));
  await createChannel(e, auth, {
    name: "or-claude",
    type: CHANNEL_TYPE_OPENROUTER,
    models: "anthropic/claude-3.7-sonnet",
    key: "sk-or-claude",
  });
  const sk = await createSk(e, auth);
  const { row, other } = await chatLog(e, auth, sk, "anthropic/claude-3.7-sonnet", {
    prompt_tokens: 2604,
    completion_tokens: 383,
    total_tokens: 2987,
    usage_semantic: "anthropic",
    prompt_tokens_details: { cached_tokens: 2432 },
  });
  assert.equal(row.prompt_tokens, 172);
  assert.equal(row.quota, 798);
  assert.equal(other.usage_semantic, "anthropic");
  assert.equal(other.cache_tokens, 2432);
});

test("original Gemini audio_input_seperate_price HTTP consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gemini-2.5-flash": 1 }));
  await putOption(e, auth, "CompletionRatio", JSON.stringify({ "gemini-2.5-flash": 1 }));
  await createChannel(e, auth, { name: "gemini-audio", models: "gemini-2.5-flash" });
  const sk = await createSk(e, auth);
  const { row, other } = await chatLog(e, auth, sk, "gemini-2.5-flash", {
    prompt_tokens: 100,
    completion_tokens: 0,
    total_tokens: 100,
    prompt_tokens_details: { audio_tokens: 50 },
  });
  assert.equal(row.quota, 75);
  assert.equal(other.audio_input_seperate_price, true);
  assert.equal(other.audio_input_token_count, 50);
  assert.equal(other.audio_input_price, 1);
  assert.equal(row.content, "Audio Input 花费 ＄0.000050 额度");
});

test("original PostTextConsumeQuota zero TotalTokens consume-log Content JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "ModelRatio", JSON.stringify({ "gpt-4o-mini": 0.075 }));
  await createChannel(e, auth, { name: "zero-tokens", models: "gpt-4o-mini" });
  const sk = await createSk(e, auth);
  const { row } = await chatLog(e, auth, sk, "gpt-4o-mini", {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
  assert.equal(row.quota, 0);
  assert.equal(row.content, "上游没有返回计费信息，无法扣费（可能是上游超时）");
});
