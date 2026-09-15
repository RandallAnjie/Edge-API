import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelAttemptFromResponseTimeExceeded,
  channelDisableThresholdMs,
  channelResponseTimeExceededMessage,
  shouldEnableChannel,
} from "../src/channel-error.js";
import {
  CHANNEL_AUTO_DISABLED,
  CHANNEL_ENABLED,
  CHANNEL_MANUAL_DISABLED,
  CHANNEL_TYPE_MIDJOURNEY,
} from "../src/constants.js";
import { runChannelTestTask } from "../src/channel-test.js";
import { createMemoryD1 } from "./d1-memory.js";
import { formatLogOtherJSON } from "../src/dto.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1(), extra: Partial<Env> = {}): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test", ...extra };
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
  const hit = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key, value }),
    }),
    e,
  );
  assert.equal(hit.body.success, true, String(hit.body.message));
}

async function createOpenaiChannel(
  e: Env,
  auth: Record<string, string>,
  body: Record<string, unknown> = {},
): Promise<number> {
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "health-openai",
        type: 1,
        key: "sk-upstream",
        models: "gpt-4o-mini",
        group: "default",
        base_url: "https://health.example.test",
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
      body: JSON.stringify({ name: "health-token", remain_quota: 100000, unlimited_quota: true }),
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

function openaiChatOk(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-health",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function openaiStatus(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
  });
}

async function channelView(e: Env, auth: Record<string, string>, id: number) {
  const hit = await json(new Request("http://local/api/channel/" + id, { headers: auth }), e);
  assert.equal(hit.body.success, true, String(hit.body.message));
  return hit.body.data as { id: number; status: number; other_info: string; auto_ban: number };
}

async function abilityEnabled(e: Env, channelId: number): Promise<number[]> {
  const rows = await e.DB.prepare("SELECT enabled FROM abilities WHERE channel_id = ?")
    .bind(channelId)
    .all<{ enabled: number }>();
  return (rows.results || []).map((r) => Number(r.enabled));
}

test("original ChannelDisableThreshold 0 is an impossible 10000000ms and response-time JSON uses %.2fs", () => {
  assert.equal(channelDisableThresholdMs(0), 10_000_000);
  assert.equal(channelDisableThresholdMs(5), 5000);
  assert.equal(channelResponseTimeExceededMessage(5010, 5000), "响应时间 5.01s 超过阈值 5.00s");
  const err = channelAttemptFromResponseTimeExceeded(5010, 5000);
  assert.equal(err.errorCode, "channel:response_time_exceeded");
  assert.equal(err.statusCode, 408);
  assert.equal(err.errorType, "openai_error");
  assert.equal(err.message, "响应时间 5.01s 超过阈值 5.00s");
});

test("original ShouldEnableChannel requires AutomaticEnableChannelEnabled and auto-disabled status", async () => {
  const off = {
    optionBool: async () => false,
  } as unknown as Store;
  assert.equal(await shouldEnableChannel(off, null, CHANNEL_AUTO_DISABLED), false);
  const on = {
    optionBool: async () => true,
  } as unknown as Store;
  assert.equal(await shouldEnableChannel(on, null, CHANNEL_AUTO_DISABLED), true);
  assert.equal(await shouldEnableChannel(on, null, CHANNEL_ENABLED), false);
  assert.equal(await shouldEnableChannel(on, null, CHANNEL_MANUAL_DISABLED), false);
  assert.equal(
    await shouldEnableChannel(on, { message: "x", statusCode: 401, errorCode: "invalid_api_key", errorType: "openai_error" }, CHANNEL_AUTO_DISABLED),
    false,
  );
});

test("original health-check unsupported Midjourney is succeeded with no newAPIError and does not disable", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const mj = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "health-mj", type: 2, key: "mj-key", models: "midjourney" }),
    }),
    e,
  );
  assert.equal(mj.body.success, true, String(mj.body.message));
  const mjId = Number((mj.body.data as { id: number }).id);
  const summary = await runChannelTestTask(store, "scheduled_all", e);
  assert.equal(summary.tested, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.disabled, 0);
  assert.equal((await channelView(e, auth, mjId)).status, CHANNEL_ENABLED);
});

test("original health-check 500 fetch is routed per channel key so 401 and 500 can be distinguished", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id401 = await createOpenaiChannel(e, auth, { name: "health-split-401", key: "sk-unauth" });
  const id500 = await createOpenaiChannel(e, auth, { name: "health-split-500", key: "sk-server" });
  const idNoBan = await createOpenaiChannel(e, auth, { name: "health-split-noban", key: "sk-noban", auto_ban: 0 });
  await withMockedFetch((_input, init) => {
    const headers = new Headers(init?.headers);
    const authz = headers.get("authorization") || "";
    if (authz.includes("sk-unauth") || authz.includes("sk-noban")) {
      return openaiStatus(401, { error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } });
    }
    return openaiStatus(500, "internal");
  }, async () => {
    const summary = await runChannelTestTask(store, "scheduled_all", e);
    assert.equal(summary.failed, 3);
    assert.equal(summary.disabled, 1);
  });
  const banned = await channelView(e, auth, id401);
  assert.equal(banned.status, CHANNEL_AUTO_DISABLED);
  const info = JSON.parse(banned.other_info || "{}") as { status_reason?: string; status_time?: number };
  assert.equal(String(info.status_reason || "").startsWith("status_code=401"), true, String(info.status_reason));
  assert.equal(typeof info.status_time, "number");
  assert.ok((await abilityEnabled(e, id401)).every((v) => v === 0));
  assert.equal((await channelView(e, auth, id500)).status, CHANNEL_ENABLED);
  assert.equal((await channelView(e, auth, idNoBan)).status, CHANNEL_ENABLED);
});

test("original health-check response-time channel:response_time_exceeded disables; threshold 0 does not", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  await putOption(e, auth, "ChannelDisableThreshold", "-1");
  const id = await createOpenaiChannel(e, auth);
  await withMockedFetch(() => openaiChatOk(), async () => {
    const summary = await runChannelTestTask(store, "scheduled_all", e);
    assert.equal(summary.tested, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.disabled, 1);
  });
  const banned = await channelView(e, auth, id);
  assert.equal(banned.status, CHANNEL_AUTO_DISABLED);
  const info = JSON.parse(banned.other_info || "{}") as { status_reason?: string };
  assert.match(String(info.status_reason || ""), /^status_code=408, 响应时间 /);
  assert.match(String(info.status_reason || ""), /超过阈值 /);

  resetSchemaFlag();
  const eZero = env();
  const zero = await boot(eZero);
  await putOption(eZero, zero.auth, "AutomaticDisableChannelEnabled", "true");
  await putOption(eZero, zero.auth, "ChannelDisableThreshold", "0");
  const zeroId = await createOpenaiChannel(eZero, zero.auth);
  await withMockedFetch(() => openaiChatOk(), async () => {
    const summary = await runChannelTestTask(zero.store, "scheduled_all", eZero);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.disabled, 0);
  });
  assert.equal((await channelView(eZero, zero.auth, zeroId)).status, CHANNEL_ENABLED);
});

test("original ShouldEnableChannel stays auto-disabled unless AutomaticEnableChannelEnabled", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const id = await createOpenaiChannel(e, auth);
  await store.updateChannelStatus(id, CHANNEL_AUTO_DISABLED, "prior");
  await withMockedFetch(() => openaiChatOk(), async () => {
    const off = await runChannelTestTask(store, "scheduled_all", e);
    assert.equal(off.enabled, 0);
  });
  assert.equal((await channelView(e, auth, id)).status, CHANNEL_AUTO_DISABLED);

  await putOption(e, auth, "AutomaticEnableChannelEnabled", "true");
  await withMockedFetch(() => openaiChatOk(), async () => {
    const on = await runChannelTestTask(store, "scheduled_all", e);
    assert.equal(on.enabled, 1);
    assert.equal(on.succeeded, 1);
  });
  const enabled = await channelView(e, auth, id);
  assert.equal(enabled.status, CHANNEL_ENABLED);
  const info = JSON.parse(enabled.other_info || "{}") as { status_reason?: string };
  assert.equal(info.status_reason, "");
  assert.ok((await abilityEnabled(e, id)).every((v) => v === 1));
});

test("original manual TestChannel 401 does not auto-disable", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createOpenaiChannel(e, auth);
  await withMockedFetch(
    () => openaiStatus(401, { error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } }),
    async () => {
      const hit = await json(new Request("http://local/api/channel/test/" + id, { headers: auth }), e);
      assert.equal(hit.body.success, false);
      assert.equal(hit.body.time, 0);
      assert.equal(hit.body.error_code, "invalid_api_key");
      assert.equal(hit.body.message, "Unauthorized");
    },
  );
  assert.equal((await channelView(e, auth, id)).status, CHANNEL_ENABLED);
  assert.ok((await abilityEnabled(e, id)).every((v) => v === 1));
});

test("original health-check ERROR_LOG_ENABLED RecordErrorLog other JSON has empty use_channel", async () => {
  resetSchemaFlag();
  const e = env(createMemoryD1(), { ERROR_LOG_ENABLED: "true" });
  const { auth, store } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const id = await createOpenaiChannel(e, auth);
  await withMockedFetch(
    () => openaiStatus(401, { error: { message: "Unauthorized", type: "invalid_request_error", code: "invalid_api_key" } }),
    async () => {
      await runChannelTestTask(store, "scheduled_all", e);
    },
  );
  const logs = await json(new Request("http://local/api/log/?type=5", { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter((row) => {
    try {
      const other = JSON.parse(String(row.other || "{}")) as Record<string, unknown>;
      return other.error_type === "openai_error" && other.error_code === "invalid_api_key";
    } catch {
      return false;
    }
  });
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const stored = JSON.parse(String(items[0].other || "{}")) as Record<string, unknown>;
  assert.equal(stored.request_path, "/v1/chat/completions");
  assert.equal(stored.error_type, "openai_error");
  assert.equal(stored.error_code, "invalid_api_key");
  assert.equal(stored.status_code, 401);
  assert.deepEqual((stored.admin_info as { use_channel?: unknown }).use_channel, []);
  assert.equal(items[0].token_name, "");
  assert.equal(items[0].channel, id);
  const user = JSON.parse(formatLogOtherJSON(JSON.stringify(stored), "user")) as Record<string, unknown>;
  assert.equal("admin_info" in user, false);
});

test("original Midjourney code 3 UpdateChannelStatus is manually disabled with No available account instance", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "AutomaticDisableChannelEnabled", "true");
  const sk = await createSk(e, auth);
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mj-code3",
        type: CHANNEL_TYPE_MIDJOURNEY,
        key: "mj-secret",
        models: "mj_imagine",
        group: "default",
        base_url: "https://mj-code3.example.test",
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const id = Number((created.body.data as { id: number }).id);
  await withMockedFetch((input) => {
    if (String(input) === "https://mj-code3.example.test/mj/submit/imagine") {
      return new Response(JSON.stringify({ code: 3, description: "No available account instance", result: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  }, async () => {
    const hit = await json(
      new Request("http://local/mj/submit/imagine", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "a cat" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.equal(hit.body.code, 3);
  });
  const ch = await channelView(e, auth, id);
  assert.equal(ch.status, CHANNEL_MANUAL_DISABLED);
  const info = JSON.parse(ch.other_info || "{}") as { status_reason?: string; status_time?: number };
  assert.equal(info.status_reason, "No available account instance");
  assert.equal(typeof info.status_time, "number");
  assert.ok((await abilityEnabled(e, id)).every((v) => v === 0));
});

test("original Midjourney code 3 does not disable when AutomaticDisableChannelEnabled is false", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  const sk = await createSk(e, auth);
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "mj-code3-off",
        type: CHANNEL_TYPE_MIDJOURNEY,
        key: "mj-secret",
        models: "mj_imagine",
        group: "default",
        base_url: "https://mj-off.example.test",
      }),
    }),
    e,
  );
  const id = Number((created.body.data as { id: number }).id);
  await withMockedFetch(
    () =>
      new Response(JSON.stringify({ code: 3, description: "No available account instance", result: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const hit = await json(
        new Request("http://local/mj/submit/imagine", {
          method: "POST",
          headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
          body: JSON.stringify({ prompt: "a cat" }),
        }),
        e,
      );
      assert.equal(hit.body.code, 3, hit.text);
    },
  );
  assert.equal((await channelView(e, auth, id)).status, CHANNEL_ENABLED);
});
