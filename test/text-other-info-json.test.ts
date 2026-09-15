import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import {
  consumeLogOther,
  DEFAULT_RELAY_FRT_MS,
  generateClaudeOtherInfo,
  generateTextOtherInfo,
  RELAY_FORMAT_CLAUDE,
  RELAY_FORMAT_OPENAI,
  requestConversionChain,
  requestConversionLabel,
} from "../src/log-info-generate.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

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

async function createChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown> = {}) {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "text-other",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-text-other",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://text-other.example.test",
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
      body: JSON.stringify({ name: "text-other", remain_quota: 100000, unlimited_quota: true }),
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

test("original GenerateTextOtherInfo always-set consume-log JSON fields", () => {
  const other = generateTextOtherInfo({
    modelRatio: 2.5,
    groupRatio: 1,
    completionRatio: 4,
    cacheTokens: 0,
    cacheRatio: 1,
    modelPrice: -1,
    userGroupRatio: -1,
    frt: DEFAULT_RELAY_FRT_MS,
    requestPath: "/v1/chat/completions",
    requestConversion: [RELAY_FORMAT_OPENAI],
    billingSource: "wallet",
  });
  assert.equal(other.model_ratio, 2.5);
  assert.equal(other.group_ratio, 1);
  assert.equal(other.completion_ratio, 4);
  assert.equal(other.cache_tokens, 0);
  assert.equal(other.cache_ratio, 1);
  assert.equal(other.model_price, -1);
  assert.equal(other.user_group_ratio, -1);
  assert.equal(other.frt, -1000);
  assert.equal(other.request_path, "/v1/chat/completions");
  assert.equal(other.billing_source, "wallet");
  assert.deepEqual(other.request_conversion, ["OpenAI Compatible"]);
  assert.equal("group" in other, false);
  assert.equal("is_model_mapped" in other, false);
  assert.equal("reasoning_effort" in other, false);
  assert.equal("claude" in other, false);
});

test("original GenerateTextOtherInfo mapped / reasoning / Claude conversion JSON", () => {
  const other = generateTextOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    cacheTokens: 12,
    cacheRatio: 0.1,
    modelPrice: -1,
    userGroupRatio: 0.9,
    frt: 42,
    reasoningEffort: "high",
    isModelMapped: true,
    upstreamModelName: "claude-3-opus",
    isSystemPromptOverwritten: true,
    requestConversion: requestConversionChain({
      clientFormat: "openai",
      mode: "chat",
      destinationFormat: RELAY_FORMAT_CLAUDE,
    }),
    claude: true,
    billingSource: "wallet",
  });
  assert.equal(other.cache_tokens, 12);
  assert.equal(other.cache_ratio, 0.1);
  assert.equal(other.user_group_ratio, 0.9);
  assert.equal(other.frt, 42);
  assert.equal(other.reasoning_effort, "high");
  assert.equal(other.is_model_mapped, true);
  assert.equal(other.upstream_model_name, "claude-3-opus");
  assert.equal(other.is_system_prompt_overwritten, true);
  assert.equal(other.claude, true);
  assert.deepEqual(other.request_conversion, ["OpenAI Compatible", "Claude Messages"]);
});

test("original GenerateClaudeOtherInfo cache creation JSON", () => {
  const other = generateClaudeOtherInfo({
    modelRatio: 1,
    groupRatio: 1,
    completionRatio: 1,
    cacheTokens: 100,
    cacheRatio: 0.1,
    modelPrice: -1,
    userGroupRatio: -1,
    cacheCreationTokens: 0,
    cacheCreationRatio: 1.25,
    cacheCreationTokens5m: 20,
    cacheCreationRatio5m: 1.25,
    cacheCreationTokens1h: 0,
  });
  assert.equal(other.claude, true);
  assert.equal(other.cache_tokens, 100);
  assert.equal(other.cache_creation_tokens, 0);
  assert.equal(other.cache_creation_ratio, 1.25);
  assert.equal(other.cache_creation_tokens_5m, 20);
  assert.equal(other.cache_creation_ratio_5m, 1.25);
  assert.equal("cache_creation_tokens_1h" in other, false);
});

test("original consumeLogOther RecordConsumeLog JSON omits group and keeps admin use_channel", () => {
  const parsed = JSON.parse(
    consumeLogOther({
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
    }),
  ) as Record<string, unknown>;
  assert.equal(parsed.cache_tokens, 0);
  assert.equal(parsed.cache_ratio, 1);
  assert.equal(parsed.model_price, -1);
  assert.equal(parsed.user_group_ratio, -1);
  assert.equal(parsed.frt, -1000);
  assert.equal("group" in parsed, false);
  assert.deepEqual(parsed.request_conversion, ["OpenAI Compatible"]);
  const admin = parsed.admin_info as { use_channel: string[]; channel_id: number };
  assert.deepEqual(admin.use_channel, ["9"]);
  assert.equal(admin.channel_id, 9);
});

test("original request_conversion labels match GenerateTextOtherInfo switch", () => {
  assert.equal(requestConversionLabel(RELAY_FORMAT_OPENAI), "OpenAI Compatible");
  assert.equal(requestConversionLabel(RELAY_FORMAT_CLAUDE), "Claude Messages");
  assert.equal(requestConversionLabel("gemini"), "Google Gemini");
  assert.equal(requestConversionLabel("openai_responses"), "OpenAI Responses");
  assert.equal(requestConversionLabel("openai_realtime"), "openai_realtime");
});

test("original text-relay consume log JSON has GenerateTextOtherInfo fields", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth);
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-text-other",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: "hi" }],
            reasoning_effort: "low",
          }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gpt-4o-mini" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.equal(other.cache_tokens, 3);
  assert.equal(other.cache_ratio, 0.5);
  assert.equal(other.model_price, -1);
  assert.equal(other.user_group_ratio, -1);
  assert.equal(typeof other.model_ratio, "number");
  assert.equal(typeof other.group_ratio, "number");
  assert.equal(typeof other.completion_ratio, "number");
  assert.equal(typeof other.frt, "number");
  assert.equal(other.billing_source, "wallet");
  assert.equal(other.request_path, "/v1/chat/completions");
  assert.deepEqual(other.request_conversion, ["OpenAI Compatible"]);
  assert.equal(other.reasoning_effort, "low");
  assert.equal("group" in other, false);
  assert.equal(items[0].group, "default");
});

test("original text-relay consume log is_model_mapped JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await createChannel(e, auth, {
    name: "mapped-text-other",
    model_mapping: JSON.stringify({ "gpt-4o-mini": "gpt-4o-mini-upstream" }),
  });
  const sk = await createSk(e, auth);
  await withMockedFetch(
    () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-mapped",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async () => {
      const hit = await json(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
        }),
        e,
      );
      assert.equal(hit.res.status, 200, hit.text);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "gpt-4o-mini",
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.equal(other.is_model_mapped, true);
  assert.equal(other.upstream_model_name, "gpt-4o-mini-upstream");
  assert.equal(other.cache_tokens, 0);
});
