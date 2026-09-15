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
