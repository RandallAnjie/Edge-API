import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenAllowsModel } from "../src/auth.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike, TokenRow } from "../src/types.js";

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
  return { token, auth, login };
}

function tokenRow(limits: string, enabled = true): TokenRow {
  return {
    id: 1,
    user_id: 1,
    key: "sk-test",
    status: 1,
    name: "t",
    created_time: 0,
    accessed_time: 0,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: 1,
    model_limits_enabled: enabled ? 1 : 0,
    model_limits: limits,
    allow_ips: "",
    used_quota: 0,
    group: "",
    auto_groups: "",
    cross_group_retry: 0,
    deleted_at: 0,
  };
}

test("original distributor token limits use GetModelLimitsMap not csv trim", () => {
  assert.equal(tokenAllowsModel(tokenRow("gpt-4o-mini"), "gpt-4o-mini"), true);
  assert.equal(tokenAllowsModel(tokenRow(" gpt-4o-mini "), "gpt-4o-mini"), false);
  assert.equal(tokenAllowsModel(tokenRow("gpt-4o-mini;gpt-4o"), "gpt-4o-mini"), false);
  assert.equal(tokenAllowsModel(tokenRow("gpt-4o-mini,gpt-4o"), "gpt-4o"), true);
  assert.equal(tokenAllowsModel(tokenRow("claude-3-7-sonnet"), "claude-3-7-sonnet-thinking"), true);
  assert.equal(tokenAllowsModel(tokenRow(""), "gpt-4o-mini"), false);
  assert.equal(tokenAllowsModel(tokenRow("gpt-4o-mini", false), "gpt-4o"), true);
});

test("original relay JSON forbids padded and semicolon GetModelLimitsMap keys", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const paddedTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "padded-limits",
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: " gpt-4o-mini ",
      }),
    }),
    e,
  );
  assert.equal(paddedTk.body.success, true, String(paddedTk.body.message));
  const paddedSk = (paddedTk.body.data as { key: string }).key;
  const padded = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + paddedSk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(padded.res.status, 403);
  assert.equal((padded.body.error as { message: string }).message, "This token has no access to model gpt-4o-mini");

  const semiTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "semi-limits",
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: "gpt-4o-mini;gpt-4o",
      }),
    }),
    e,
  );
  const semiSk = (semiTk.body.data as { key: string }).key;
  const semi = await json(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + semiSk, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  assert.equal(semi.res.status, 403);
  assert.equal((semi.body.error as { message: string }).message, "This token has no access to model gpt-4o-mini");
});
