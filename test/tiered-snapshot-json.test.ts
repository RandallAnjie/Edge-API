import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_TYPE_OPENAI, LOG_CONSUME } from "../src/constants.js";
import { BILLING_MODE_TIERED_EXPR } from "../src/billing-setting.js";
import {
  captureTieredBillingSnapshot,
  DEFAULT_TIERED_PRE_CONSUME_MAX_TOKENS,
} from "../src/tiered-settle.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

const OLD_EXPR = `tier("old", p * 2 + c * 4)`;
const NEW_EXPR = `tier("new", p * 99 + c * 99)`;

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
      body: JSON.stringify({ name: "frozen-snap", remain_quota: 100000, unlimited_quota: true }),
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

function exprB64(expr: string): string {
  return Buffer.from(expr, "utf8").toString("base64");
}

test("original modelPriceHelperTiered freezes estimated_completion_tokens 8192", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "frozen-expr": BILLING_MODE_TIERED_EXPR }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({ "frozen-expr": OLD_EXPR }));
  const snap = await captureTieredBillingSnapshot(store, "frozen-expr", "default", 10, {}, { body: {} });
  assert.ok(snap);
  assert.equal(snap.estimatedPromptTokens, 10);
  assert.equal(snap.estimatedCompletionTokens, DEFAULT_TIERED_PRE_CONSUME_MAX_TOKENS);
  assert.equal(DEFAULT_TIERED_PRE_CONSUME_MAX_TOKENS, 8192);
  assert.equal(snap.estimatedTier, "old");
  assert.equal(snap.exprString, OLD_EXPR);
  const withMax = await captureTieredBillingSnapshot(store, "frozen-expr", "default", 10, { maxTokens: 16 }, { body: {} });
  assert.equal(withMax?.estimatedCompletionTokens, 16);
});

test("original TryTieredSettle consume-log JSON keeps frozen expr_b64 after option change", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth, store } = await boot(e);
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "frozen-expr": BILLING_MODE_TIERED_EXPR }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({ "frozen-expr": OLD_EXPR }));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "frozen-expr",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-frozen",
        models: "frozen-expr",
        group: "default",
        base_url: "https://frozen-expr.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const sk = await createSk(e, auth);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    await store.setOption("billing_setting.billing_expr", JSON.stringify({ "frozen-expr": NEW_EXPR }));
    return new Response(
      JSON.stringify({
        id: "chatcmpl-frozen",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "frozen-expr", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(hit.res.status, 200, hit.text);
  } finally {
    globalThis.fetch = orig;
  }
  const logs = await json(new Request("http://local/api/log/?type=" + LOG_CONSUME, { headers: auth }), e);
  const items = ((logs.body.data as { items?: Record<string, unknown>[] })?.items || []).filter(
    (row) => String(row.model_name || "") === "frozen-expr" && Number(row.type) === LOG_CONSUME,
  );
  assert.equal(items.length >= 1, true, JSON.stringify(logs.body));
  const other = parseOther(items[0].other);
  assert.equal(other.billing_mode, "tiered_expr");
  assert.equal(other.expr_b64, exprB64(OLD_EXPR));
  assert.notEqual(other.expr_b64, exprB64(NEW_EXPR));
  assert.equal(other.matched_tier, "old");
  assert.equal(items[0].quota, 18);
});

test("original ModelPriceHelper missing tiered expr is HTTP 400 model_price_error JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await putOption(e, auth, "billing_setting.billing_mode", JSON.stringify({ "missing-expr": BILLING_MODE_TIERED_EXPR }));
  await putOption(e, auth, "billing_setting.billing_expr", JSON.stringify({}));
  const ch = await json(
    new Request("http://local/api/channel/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "missing-expr",
        type: CHANNEL_TYPE_OPENAI,
        key: "sk-missing",
        models: "missing-expr",
        group: "default",
        base_url: "https://missing-expr.example.test",
      }),
    }),
    e,
  );
  assert.equal(ch.body.success, true, String(ch.body.message));
  const sk = await createSk(e, auth);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response("should-not-fetch")) as typeof fetch;
  try {
    const hit = await json(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + sk, "content-type": "application/json" },
        body: JSON.stringify({ model: "missing-expr", messages: [{ role: "user", content: "hi" }] }),
      }),
      e,
    );
    assert.equal(hit.res.status, 400, hit.text);
    const err = (hit.body.error || {}) as { message?: string; code?: string };
    assert.equal(err.code, "model_price_error");
    assert.match(String(err.message || ""), /missing-expr/);
    assert.match(String(err.message || ""), /no billing expression/);
  } finally {
    globalThis.fetch = orig;
  }
});
