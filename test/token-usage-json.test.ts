import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { tokenModelLimitsMap } from "../src/constants.js";
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
  return { token, auth, login };
}

test("original Token.GetModelLimitsMap keeps empty comma fragments", () => {
  assert.deepEqual(tokenModelLimitsMap(""), {});
  assert.deepEqual(tokenModelLimitsMap("gpt-4"), { "gpt-4": true });
  assert.deepEqual(tokenModelLimitsMap("gpt-4,"), { "gpt-4": true, "": true });
  assert.deepEqual(tokenModelLimitsMap(",gpt-4"), { "": true, "gpt-4": true });
  assert.deepEqual(tokenModelLimitsMap("a,,b"), { a: true, "": true, b: true });
  assert.deepEqual(tokenModelLimitsMap(" gpt-4 "), { " gpt-4 ": true });
});

test("original GetTokenUsage JSON uses GetModelLimitsMap including empty keys", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const emptyTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "empty-limits", unlimited_quota: true, model_limits_enabled: true, model_limits: "" }),
    }),
    e,
  );
  assert.equal(emptyTk.body.success, true, String(emptyTk.body.message));
  const emptySk = (emptyTk.body.data as { key: string }).key;
  const emptyUsage = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + emptySk } }),
    e,
  );
  assert.equal(emptyUsage.body.code, true);
  assert.equal(emptyUsage.body.message, "ok");
  assert.equal("success" in emptyUsage.body, false);
  const emptyData = emptyUsage.body.data as Record<string, unknown>;
  assert.equal(emptyData.object, "token_usage");
  assert.deepEqual(emptyData.model_limits, {});
  assert.equal(emptyData.model_limits_enabled, true);

  const trailingTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "trailing-comma",
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: "gpt-4,",
      }),
    }),
    e,
  );
  assert.equal(trailingTk.body.success, true, String(trailingTk.body.message));
  const trailingSk = (trailingTk.body.data as { key: string }).key;
  const trailingUsage = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + trailingSk } }),
    e,
  );
  assert.equal(trailingUsage.body.code, true);
  const trailingLimits = (trailingUsage.body.data as { model_limits: Record<string, boolean> }).model_limits;
  assert.equal(trailingLimits["gpt-4"], true);
  assert.equal(trailingLimits[""], true);
  assert.equal(Object.keys(trailingLimits).length, 2);

  const spacedTk = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "spaced-limits",
        unlimited_quota: true,
        model_limits_enabled: true,
        model_limits: " gpt-4 ",
      }),
    }),
    e,
  );
  const spacedSk = (spacedTk.body.data as { key: string }).key;
  const spacedUsage = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + spacedSk } }),
    e,
  );
  const spacedLimits = (spacedUsage.body.data as { model_limits: Record<string, boolean> }).model_limits;
  assert.equal(spacedLimits[" gpt-4 "], true);
  assert.equal(spacedLimits["gpt-4"], undefined);
});

test("original GetTokenUsage auth and MsgTokenGetInfoFailed JSON", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const none = await json(new Request("http://local/api/usage/token"), e);
  assert.equal(none.res.status, 401);
  assert.equal(none.body.success, false);
  assert.equal(none.body.message, "No Authorization header");
  assert.equal(none.body.code, undefined);

  const badScheme = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Token x" } }),
    e,
  );
  assert.equal(badScheme.res.status, 401);
  assert.equal(badScheme.body.success, false);
  assert.equal(badScheme.body.message, "Invalid Bearer token");

  const extraParts = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer sk-foo extra" } }),
    e,
  );
  assert.equal(extraParts.res.status, 401);
  assert.equal(extraParts.body.message, "Invalid Bearer token");

  const missing = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer sk-missing-usage" } }),
    e,
  );
  assert.equal(missing.res.status, 200);
  assert.equal(missing.body.success, false);
  assert.equal(missing.body.message, "Failed to get token info, please try again later");

  const missingZh = await json(
    new Request("http://local/api/usage/token", {
      headers: { authorization: "Bearer sk-missing-usage", "accept-language": "zh-CN" },
    }),
    e,
  );
  assert.equal(missingZh.body.message, "获取令牌信息失败，请稍后重试");

  const missingTw = await json(
    new Request("http://local/api/usage/token", {
      headers: { authorization: "Bearer sk-missing-usage", "accept-language": "zh-TW" },
    }),
    e,
  );
  assert.equal(missingTw.body.message, "獲取令牌資訊失敗，請稍後重試");

  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "disabled-usage", remain_quota: 10, unlimited_quota: false }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const createdData = created.body.data as { id: number; key: string };
  const disabled = await json(
    new Request("http://local/api/token/?status_only=true", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: createdData.id, status: 2 }),
    }),
    e,
  );
  assert.equal(disabled.body.success, true, String(disabled.body.message));
  const usage = await json(
    new Request("http://local/api/usage/token", { headers: { authorization: "Bearer " + createdData.key } }),
    e,
  );
  assert.equal(usage.res.status, 200, usage.text);
  assert.equal(usage.body.code, true);
  assert.equal(usage.body.message, "ok");
  assert.equal("success" in usage.body, false);
  const data = usage.body.data as Record<string, unknown>;
  assert.equal(data.object, "token_usage");
  assert.equal(data.name, "disabled-usage");
  assert.equal(data.total_granted, 10);
  assert.equal(data.total_used, 0);
  assert.equal(data.total_available, 10);
  assert.equal(data.unlimited_quota, false);
  assert.equal(data.expires_at, 0);
  assert.deepEqual(Object.keys(data).sort(), [
    "expires_at",
    "model_limits",
    "model_limits_enabled",
    "name",
    "object",
    "total_available",
    "total_granted",
    "total_used",
    "unlimited_quota",
  ]);
  assert.deepEqual(Object.keys(usage.body).sort(), ["code", "data", "message"]);

  const slash = await json(
    new Request("http://local/api/usage/token/", { headers: { authorization: "Bearer " + createdData.key } }),
    e,
  );
  assert.equal(slash.res.status, 200);
  assert.equal(slash.body.code, true);
  assert.equal("success" in slash.body, false);
});

