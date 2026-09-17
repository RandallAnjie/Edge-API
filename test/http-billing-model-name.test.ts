import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME, ROLE_ADMIN } from "../src/constants.js";
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

async function createChannel(e: Env, auth: Record<string, string>, body: Record<string, unknown>) {
  const created = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const channels = await json(new Request("http://local/api/channel/", { headers: auth }), e);
  const row = ((channels.body.data as { items: { id: number; name: string }[] }).items || []).find(
    (c) => c.name === body.name,
  );
  assert.ok(row);
  return row;
}

async function createSk(e: Env, auth: Record<string, string>): Promise<string> {
  const tok = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "http-billing", unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(tok.body.success, true, String(tok.body.message));
  return (tok.body.data as { key: string }).key;
}

function openaiChatResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-billing",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function parseOther(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

async function latestConsume(e: Env, auth: Record<string, string>, modelName: string) {
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === modelName && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  return { row: items[0], other: parseOther(items[0].other) };
}

test("original HTTP ModelPriceHelper resolveBillingModelName consume-log JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await createChannel(e, auth, {
    name: "http-billing-openai",
    type: CHANNEL_TYPE_OPENAI,
    key: "sk-test",
    models:
      "fail-me,gemini-2.5-flash@thinking:on,gemini-2.5-flash-thinking-8192,gpt-4-gizmo-abc,gpt-4o-mini",
    group: "default",
    base_url: "https://api.example.test",
  });
  const sk = await createSk(e, auth);

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return openaiChatResponse();
  }) as typeof fetch;

  try {
    seen.length = 0;
    const unpriced = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "fail-me", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(unpriced.res.status, 400, unpriced.text);
    const unpricedErr = unpriced.body.error as { message: string; type: string; code: string };
    assert.equal(unpricedErr.code, "model_price_error");
    assert.equal(unpricedErr.type, "new_api_error");
    assert.match(unpricedErr.message, /Model fail-me price not configured/);
    assert.equal(seen.length, 0);

    seen.length = 0;
    const alias = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-flash@thinking:on",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(alias.res.status, 200, alias.text);
    assert.ok(seen.some((url) => url.includes("/v1/chat/completions")));
    const aliasLog = await latestConsume(e, auth, "gemini-2.5-flash");
    assert.equal(aliasLog.row.model_name, "gemini-2.5-flash");
    assert.equal(aliasLog.other.model_ratio, 0.15);
    const aliasAdmin = aliasLog.other.admin_info as Record<string, unknown>;
    assert.equal(aliasAdmin.billing_model, "gemini-2.5-flash");

    seen.length = 0;
    const thinking8192 = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gemini-2.5-flash-thinking-8192",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(thinking8192.res.status, 200, thinking8192.text);
    const thinkingLog = await latestConsume(e, auth, "gemini-2.5-flash-thinking-8192");
    assert.equal(thinkingLog.row.model_name, "gemini-2.5-flash-thinking-8192");
    assert.equal(thinkingLog.other.model_ratio, 0.075);
    const thinkingAdmin = thinkingLog.other.admin_info as Record<string, unknown>;
    assert.equal("billing_model" in thinkingAdmin, false);

    seen.length = 0;
    const gizmo = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4-gizmo-abc",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      e,
    );
    assert.equal(gizmo.res.status, 200, gizmo.text);
    const gizmoLog = await latestConsume(e, auth, "gpt-4-gizmo-*");
    assert.equal(gizmoLog.row.model_name, "gpt-4-gizmo-*");
    assert.equal(gizmoLog.row.content, "模型 gpt-4-gizmo-abc");
    const gizmoAdmin = gizmoLog.other.admin_info as Record<string, unknown>;
    assert.equal("billing_model" in gizmoAdmin, false);

    const root = await store.getRootUser();
    assert.ok(root);
    assert.ok(Number(root.role || 0) >= ROLE_ADMIN);
    await store.updateUser(root.id, {
      settings: JSON.stringify({ accept_unset_model_ratio_model: true }),
    });
    seen.length = 0;
    const acceptUnset = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "fail-me", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(acceptUnset.res.status, 200, acceptUnset.text);
    assert.ok(seen.length > 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
