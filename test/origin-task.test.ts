import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHANNEL_MANUAL_DISABLED,
  CHANNEL_TYPE_DOUBAO_VIDEO,
  CHANNEL_TYPE_OPENAI,
} from "../src/constants.js";
import {
  FILTER_TASK_PLUGIN_IDENTITY,
  PIN_RETRY_SAME_CHANNEL,
} from "../src/channel-constraint.js";
import { applyOriginTaskIntent, taskPluginLegacyPlatforms } from "../src/origin-task.js";
import {
  isAlwaysSkipRetryStatusCode,
  parseHTTPStatusCodeRanges,
  shouldRetryByStatusCode,
} from "../src/status-code-ranges.js";
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
  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  return { e, auth, store, rootId: Number(root?.id || 1) };
}

function pluginSource(key: string, extra: { routes?: string; protocols?: string; channelTypes?: string; models?: string } = {}) {
  const models = extra.models || `["resolved-model"]`;
  const routes = extra.routes || `[{method:"POST",path:"/vendor/jobs",type:"submit"}]`;
  const protocols = extra.protocols || `[]`;
  const channelTypes = extra.channelTypes || `[${CHANNEL_TYPE_OPENAI}]`;
  return `const meta = { apiVersion: 1, key: "${key}", name: "${key}", version: "1.0.0", author: { name: "test" }, models: ${models}, fetchMode: "per_task", routes: ${routes}, protocols: ${protocols}, channelTypes: ${channelTypes}, allowedHosts: [], auth: { type: "none" } };`;
}

async function addChannel(
  e: Env,
  auth: Record<string, string>,
  name: string,
  opts: { type?: number; base_url?: string; models?: string; status?: number } = {},
) {
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name,
        type: opts.type ?? CHANNEL_TYPE_OPENAI,
        key: `sk-${name}`,
        models: opts.models ?? "resolved-model",
        group: "default",
        base_url: opts.base_url || `https://${name}.example.test`,
      }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const id = Number((created.body.data as { id: number }).id);
  if (opts.status) {
    const st = await json(
      new Request(`http://local/api/channel/${id}/status`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ status: opts.status }),
      }),
      e,
    );
    assert.equal(st.body.success, true, String(st.body.message));
  }
  return id;
}

async function insertOwnedTask(
  store: Store,
  opts: { taskId: string; userId: number; channelId: number; platform: string },
) {
  await store.insertTask({
    task_id: opts.taskId,
    user_id: opts.userId,
    channel_id: opts.channelId,
    platform: opts.platform,
    action: "text_to_video",
    status: "SUCCESS",
    data: JSON.stringify({ id: `upstream-${opts.taskId}` }),
    private_data: JSON.stringify({ upstream_task_id: `upstream-${opts.taskId}` }),
  });
}

test("original taskPluginLegacyPlatforms includes key, suno, and numeric types", () => {
  assert.deepEqual(taskPluginLegacyPlatforms({ key: "origin-plugin" }), ["origin-plugin"]);
  assert.deepEqual(taskPluginLegacyPlatforms({ key: "sunoapi", channelTypes: [0, 61, 1, 1] }), ["sunoapi", "suno", "1"]);
  assert.deepEqual(taskPluginLegacyPlatforms({ key: "origin-plugin", channelTypes: [CHANNEL_TYPE_DOUBAO_VIDEO] }), [
    "origin-plugin",
    String(CHANNEL_TYPE_DOUBAO_VIDEO),
  ]);
});

test("original ShouldRetryByStatusCode default matches legacy behavior", () => {
  assert.equal(shouldRetryByStatusCode(200), false);
  assert.equal(shouldRetryByStatusCode(400), false);
  assert.equal(shouldRetryByStatusCode(401), true);
  assert.equal(shouldRetryByStatusCode(408), false);
  assert.equal(shouldRetryByStatusCode(429), true);
  assert.equal(shouldRetryByStatusCode(500), true);
  assert.equal(shouldRetryByStatusCode(504), false);
  assert.equal(shouldRetryByStatusCode(524), false);
  assert.equal(shouldRetryByStatusCode(599), true);
  assert.equal(isAlwaysSkipRetryStatusCode(504), true);
  assert.equal(isAlwaysSkipRetryStatusCode(500), false);
  const parsed = parseHTTPStatusCodeRanges("401,403,500-599");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.ranges, [
      { start: 401, end: 401 },
      { start: 403, end: 403 },
      { start: 500, end: 599 },
    ]);
  }
  assert.equal(parseHTTPStatusCodeRanges("99,600,foo").ok, false);
});

test("original applyOriginTaskIntent table", async () => {
  const { store, rootId } = await boot();
  const enabled = await store.insertChannel({
    name: "origin-channel",
    key: "sk-origin",
    type: CHANNEL_TYPE_DOUBAO_VIDEO,
    models: "resolved-model",
    group: "default",
  });
  const otherEnabled = await store.insertChannel({
    name: "origin-channel-b",
    key: "sk-origin-b",
    type: CHANNEL_TYPE_DOUBAO_VIDEO,
    models: "resolved-model",
    group: "default",
  });
  const disabled = await store.insertChannel({
    name: "origin-disabled",
    key: "sk-origin-d",
    type: CHANNEL_TYPE_DOUBAO_VIDEO,
    models: "resolved-model",
    group: "default",
    status: CHANNEL_MANUAL_DISABLED,
  });
  await insertOwnedTask(store, { taskId: "task-own", userId: rootId, channelId: enabled, platform: "origin-plugin" });
  await insertOwnedTask(store, { taskId: "task-own-b", userId: rootId, channelId: enabled, platform: "origin-plugin" });
  await insertOwnedTask(store, { taskId: "task-other-channel", userId: rootId, channelId: otherEnabled, platform: "origin-plugin" });
  await insertOwnedTask(store, { taskId: "task-foreign", userId: rootId + 99, channelId: enabled, platform: "origin-plugin" });
  await insertOwnedTask(store, { taskId: "task-wrong-platform", userId: rootId, channelId: enabled, platform: "other-plugin" });
  await insertOwnedTask(store, {
    taskId: "task-legacy",
    userId: rootId,
    channelId: enabled,
    platform: String(CHANNEL_TYPE_DOUBAO_VIDEO),
  });
  await insertOwnedTask(store, { taskId: "task-disabled", userId: rootId, channelId: disabled, platform: "origin-plugin" });

  const tooMany = Array.from({ length: 17 }, (_, i) => `task-${i}`);
  const meta = { key: "origin-plugin", channelTypes: [0] };
  const legacyMeta = { key: "origin-plugin", channelTypes: [CHANNEL_TYPE_DOUBAO_VIDEO] };

  const absent = await applyOriginTaskIntent(store, rootId, {}, meta);
  assert.equal(absent.pin, undefined);
  const emptyArr = await applyOriginTaskIntent(store, rootId, { originTaskIds: [] }, meta);
  assert.equal(emptyArr.pin, undefined);

  const ok = await applyOriginTaskIntent(store, rootId, { originTaskIds: ["task-own"] }, meta);
  assert.equal(ok.error, undefined);
  assert.equal(ok.pin?.channelId, enabled);
  assert.equal(ok.pin?.retryMode, PIN_RETRY_SAME_CHANNEL);
  assert.deepEqual(
    ok.tasks?.map((t) => t.taskId),
    ["task-own"],
  );
  assert.equal(ok.tasks?.[0].upstreamTaskId, "upstream-task-own");
  assert.equal(ok.tasks?.[0].action, "text_to_video");
  assert.equal(ok.tasks?.[0].status, "SUCCESS");

  const deduped = await applyOriginTaskIntent(store, rootId, { originTaskIds: ["task-own", " task-own ", "task-own-b"] }, meta);
  assert.deepEqual(
    deduped.tasks?.map((t) => t.taskId),
    ["task-own", "task-own-b"],
  );
  assert.equal(deduped.pin?.channelId, enabled);

  const legacy = await applyOriginTaskIntent(store, rootId, { originTaskIds: ["task-legacy"] }, legacyMeta);
  assert.equal(legacy.pin?.channelId, enabled);

  const cases: { intent: Record<string, unknown>; code: string; channelTypes?: number[] }[] = [
    { intent: { originTaskIds: ["task-missing"] }, code: "origin_task_not_found" },
    { intent: { originTaskIds: ["task-foreign"] }, code: "origin_task_not_found" },
    { intent: { originTaskIds: ["task-wrong-platform"] }, code: "origin_task_platform_mismatch" },
    { intent: { originTaskIds: ["task-own", "task-other-channel"] }, code: "origin_task_channel_conflict" },
    { intent: { originTaskIds: ["task-disabled"] }, code: "origin_task_channel_disabled" },
    { intent: { originTaskIds: tooMany }, code: "invalid_origin_task_ids" },
    { intent: { originTaskIds: "task-own" }, code: "invalid_origin_task_ids" },
    { intent: { originTaskIds: ["task-own", "  "] }, code: "invalid_origin_task_ids" },
  ];
  for (const row of cases) {
    const got = await applyOriginTaskIntent(store, rootId, row.intent, {
      key: "origin-plugin",
      channelTypes: row.channelTypes || [0],
    });
    assert.equal(got.error?.code, row.code, row.code);
    assert.equal(got.error?.statusCode, 400);
    assert.equal(got.pin, undefined);
  }
});

test("original Distribute honors origin-task pin and token pin beats origin", async () => {
  const { e, auth, store, rootId } = await boot();
  const originId = await addChannel(e, auth, "origin-ch", { base_url: "https://origin.example.test" });
  const otherId = await addChannel(e, auth, "other-ch", { base_url: "https://other.example.test" });
  await insertOwnedTask(store, { taskId: "task-route", userId: rootId, channelId: originId, platform: "origin-route" });

  const plugin = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("origin-route") }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));

  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "origin-token", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  assert.equal(tk.body.success, true, String(tk.body.message));
  const sk = (tk.body.data as { key: string }).key;

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({
        id: "resp-origin",
        object: "response",
        status: "completed",
        output: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "resolved-model", originTaskIds: ["task-route"], prompt: "ok" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.ok(seen.some((u) => u.startsWith("https://origin.example.test")), JSON.stringify(seen));
    assert.ok(!seen.some((u) => u.startsWith("https://other.example.test")), JSON.stringify(seen));

    seen.length = 0;
    const tokenPin = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: `Bearer ${sk}-${otherId}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "resolved-model", originTaskIds: ["task-route"], prompt: "ok" }),
      }),
      e,
    );
    assert.equal(tokenPin.res.status, 200, tokenPin.text);
    assert.ok(seen.some((u) => u.startsWith("https://other.example.test")), JSON.stringify(seen));
    assert.ok(!seen.some((u) => u.startsWith("https://origin.example.test")), JSON.stringify(seen));
  } finally {
    globalThis.fetch = origFetch;
  }

  const unknownRoute = await json(
    new Request("http://local/vendor/jobs", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "resolved-model", originTaskIds: ["missing"] }),
    }),
    e,
  );
  assert.equal(unknownRoute.res.status, 400);
  assert.equal(unknownRoute.body.code, "invalid_request");
  assert.match(String(unknownRoute.body.message), /origin task not found/);
  assert.equal(unknownRoute.body.data, null);
});

test("original origin pin retries same channel; token pin is single-attempt", async () => {
  const { e, auth, store, rootId } = await boot();
  await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "RetryTimes", value: "1" }),
    }),
    e,
  );
  const originId = await addChannel(e, auth, "retry-origin", { base_url: "https://origin-retry.example.test" });
  await addChannel(e, auth, "retry-other", { base_url: "https://other-retry.example.test" });
  await insertOwnedTask(store, { taskId: "task-retry", userId: rootId, channelId: originId, platform: "origin-retry" });
  const plugin = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ source: pluginSource("origin-retry") }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "retry-token", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;

  const seen: string[] = [];
  let n = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    n += 1;
    if (n === 1) return new Response("upstream", { status: 500 });
    return new Response(JSON.stringify({ id: "ok", choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const origin = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "resolved-model", originTaskIds: ["task-retry"] }),
      }),
      e,
    );
    assert.equal(origin.res.status, 200, origin.text);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((u) => u.startsWith("https://origin-retry.example.test")), JSON.stringify(seen));

    seen.length = 0;
    n = 0;
    const token = await json(
      new Request("http://local/vendor/jobs", {
        method: "POST",
        headers: { authorization: `Bearer ${sk}-${originId}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "resolved-model", originTaskIds: ["task-retry"] }),
      }),
      e,
    );
    assert.equal(token.res.status, 500, token.text);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].startsWith("https://origin-retry.example.test"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original PrepareTaskPluginEndpoint origin pin JSON fields", async () => {
  const { e, auth, store, rootId } = await boot();
  const originId = await addChannel(e, auth, "endpoint-origin", { base_url: "https://origin-ep.example.test" });
  await addChannel(e, auth, "endpoint-other", { base_url: "https://other-ep.example.test" });
  await insertOwnedTask(store, { taskId: "task-endpoint", userId: rootId, channelId: originId, platform: "origin-endpoint" });
  const plugin = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: pluginSource("origin-endpoint", {
          routes: "[]",
          protocols: `["openai_responses"]`,
          models: `["claimed-model"]`,
        }),
      }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ep-token", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ id: "resp", object: "response" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "claimed-model", originTaskIds: ["task-endpoint"], input: "hello" }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
    assert.ok(seen.some((u) => u.startsWith("https://origin-ep.example.test")), JSON.stringify(seen));
  } finally {
    globalThis.fetch = origFetch;
  }

  const missing = await json(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "claimed-model", originTaskIds: ["missing"], input: "hello" }),
    }),
    e,
  );
  assert.equal(missing.res.status, 400);
  assert.equal((missing.body.error as { code?: string }).code, "origin_task_not_found");
  assert.match(String((missing.body.error as { message?: string }).message), /origin task not found/);

  const disabledId = await addChannel(e, auth, "endpoint-disabled", {
    base_url: "https://disabled-ep.example.test",
    status: CHANNEL_MANUAL_DISABLED,
  });
  await insertOwnedTask(store, { taskId: "task-disabled-ep", userId: rootId, channelId: disabledId, platform: "origin-endpoint" });
  const disabled = await json(
    new Request("http://local/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "claimed-model", originTaskIds: ["task-disabled-ep"], input: "hello" }),
    }),
    e,
  );
  assert.equal(disabled.res.status, 400);
  assert.equal((disabled.body.error as { code?: string }).code, "origin_task_channel_disabled");
});

test("original Distribute pin violating identity filter returns task_plugin_identity", async () => {
  const { e, auth, store, rootId } = await boot();
  const originId = await addChannel(e, auth, "ident-origin", { base_url: "https://ident.example.test" });
  await insertOwnedTask(store, { taskId: "task-ident", userId: rootId, channelId: originId, platform: "origin-ident" });
  const plugin = await json(
    new Request("http://local/api/plugin/task", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        source: pluginSource("origin-ident", { channelTypes: "[]" }),
      }),
    }),
    e,
  );
  assert.equal(plugin.body.success, true, String(plugin.body.message));
  const tk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "ident-token", unlimited_quota: true, group: "default" }),
    }),
    e,
  );
  const sk = (tk.body.data as { key: string }).key;
  const hit = await json(
    new Request("http://local/vendor/jobs", {
      method: "POST",
      headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
      body: JSON.stringify({ model: "resolved-model", originTaskIds: ["task-ident"] }),
    }),
    e,
  );
  assert.equal(hit.res.status, 400);
  assert.equal((hit.body.error as { code?: string }).code, FILTER_TASK_PLUGIN_IDENTITY);
});
