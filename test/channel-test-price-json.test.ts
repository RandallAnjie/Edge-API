import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { CHANNEL_TYPE_COZE, CHANNEL_TYPE_OPENAI } from "../src/constants.js";
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

function openaiChatResponse() {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("original TestChannel ModelPriceHelper is JSON-before-Convert* and uses billing identity", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  const openaiRow = await createChannel(e, auth, {
    name: "price-openai",
    type: CHANNEL_TYPE_OPENAI,
    key: "sk-test",
    models: "gpt-4o-mini,fail-me,gemini-2.5-flash@thinking:on",
    group: "default",
    base_url: "https://api.example.test",
  });
  const cozeRow = await createChannel(e, auth, {
    name: "price-coze",
    type: CHANNEL_TYPE_COZE,
    key: "coze-key",
    models: "coze-bot,gpt-4o-mini",
    group: "default",
    base_url: "https://api.coze.example",
  });

  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("/v1/chat/completions")) return openaiChatResponse();
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;

  try {
    seen.length = 0;
    const unpriced = await json(new Request("http://local/api/channel/test/" + openaiRow.id + "?model=fail-me", { headers: auth }), e);
    assert.equal(unpriced.body.success, false);
    assert.equal(unpriced.body.error_code, "model_price_error");
    assert.equal(unpriced.body.time, 0);
    assert.match(String(unpriced.body.message), /Model fail-me price not configured/);
    assert.equal(seen.length, 0);

    seen.length = 0;
    const unpricedCoze = await json(
      new Request("http://local/api/channel/test/" + cozeRow.id + "?model=coze-bot&endpoint_type=image-generation", { headers: auth }),
      e,
    );
    assert.equal(unpricedCoze.body.success, false);
    assert.equal(unpricedCoze.body.error_code, "model_price_error");
    assert.match(String(unpricedCoze.body.message), /Model coze-bot price not configured/);
    assert.equal(seen.length, 0);

    const pricedCozeImage = await json(
      new Request("http://local/api/channel/test/" + cozeRow.id + "?model=gpt-4o-mini&endpoint_type=image-generation", {
        headers: auth,
      }),
      e,
    );
    assert.equal(pricedCozeImage.body.success, false);
    assert.equal(pricedCozeImage.body.error_code, "convert_request_failed");
    assert.equal(pricedCozeImage.body.message, "not implemented");
    assert.equal(pricedCozeImage.body.time, 0);

    seen.length = 0;
    const billingAlias = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=" + encodeURIComponent("gemini-2.5-flash@thinking:on"), {
        headers: auth,
      }),
      e,
    );
    assert.equal(billingAlias.body.success, true, String(billingAlias.body.message));
    assert.ok(seen.some((url) => url.includes("/v1/chat/completions")));
    const aliasLogs = await json(new Request("http://local/api/log/?type=2&token_name=" + encodeURIComponent("模型测试"), { headers: auth }), e);
    const aliasItems = ((aliasLogs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
      (row) => row.model_name === "gemini-2.5-flash@thinking:on",
    );
    assert.equal(aliasItems.length >= 1, true, JSON.stringify(aliasLogs.body));
    const aliasOther =
      aliasItems[0].other && typeof aliasItems[0].other === "object"
        ? (aliasItems[0].other as Record<string, unknown>)
        : (JSON.parse(String(aliasItems[0].other)) as Record<string, unknown>);
    assert.equal(aliasOther.model_ratio, 0.15);
    assert.equal((aliasOther.admin_info as Record<string, unknown>).billing_model, "gemini-2.5-flash");

    await store.setOption("SelfUseModeEnabled", "true");
    seen.length = 0;
    const selfUse = await json(new Request("http://local/api/channel/test/" + openaiRow.id + "?model=fail-me", { headers: auth }), e);
    assert.equal(selfUse.body.success, true, String(selfUse.body.message));
    assert.ok(seen.length > 0);
    await store.setOption("SelfUseModeEnabled", "false");

    const root = await store.getRootUser();
    assert.ok(root);
    await store.updateUser(root.id, {
      settings: JSON.stringify({ accept_unset_model_ratio_model: true }),
    });
    seen.length = 0;
    const acceptUnset = await json(
      new Request("http://local/api/channel/test/" + openaiRow.id + "?model=still-unpriced", { headers: auth }),
      e,
    );
    assert.equal(acceptUnset.body.success, true, String(acceptUnset.body.message));
    assert.ok(seen.length > 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
