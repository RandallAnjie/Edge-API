import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

function env(db = createMemoryD1()): Env {
  return { DB: db, SYSTEM_NAME: "Edge API Test" };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
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
  return { auth };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function postState(e: Env, headers: Record<string, string>, body?: string) {
  return json(
    new Request("http://local/api/oauth/state", {
      method: "POST",
      headers,
      ...(body !== undefined ? { body } : {}),
    }),
    e,
  );
}

test("original GenerateOAuthCode DecodeJson / validation ApiErrorI18n gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const empty = await postState(e, auth);
  omitData(empty.body, "Invalid parameters");
  const arr = await postState(e, auth, "[]");
  omitData(arr.body, "Invalid parameters");
  const providerNum = await postState(e, auth, JSON.stringify({ provider: 1, intent: "login" }));
  omitData(providerNum.body, "Invalid parameters");
  const unknown = await postState(e, auth, JSON.stringify({ provider: "not-a-provider", intent: "login" }));
  omitData(unknown.body, "Invalid parameters");
  const missingIntent = await postState(e, auth, JSON.stringify({ provider: "github" }));
  omitData(missingIntent.body, "Invalid parameters");
  const badIntent = await postState(e, auth, JSON.stringify({ provider: "github", intent: "signup" }));
  omitData(badIntent.body, "Invalid parameters");
  const affOnBind = await postState(e, auth, JSON.stringify({ provider: "github", intent: "bind", aff: "abc" }));
  omitData(affOnBind.body, "Invalid parameters");
  const longAff = await postState(e, auth, JSON.stringify({ provider: "github", intent: "login", aff: "a".repeat(33) }));
  omitData(longAff.body, "Invalid parameters");
  const scopeOnLogin = await postState(
    e,
    auth,
    JSON.stringify({ provider: "github", intent: "login", scope: "account.binding.bind" }),
  );
  omitData(scopeOnLogin.body, "Invalid parameters");
  const contextNull = await postState(e, auth, JSON.stringify({ provider: "github", intent: "login", context: null }));
  omitData(contextNull.body, "Invalid parameters");
  const zh = await postState(
    e,
    { ...auth, "accept-language": "zh-CN" },
    JSON.stringify({ provider: "github", intent: "nope" }),
  );
  omitData(zh.body, "无效的参数");

  const anonBind = await postState(
    e,
    { "content-type": "application/json" },
    JSON.stringify({ provider: "github", intent: "bind" }),
  );
  assert.equal(anonBind.res.status, 401);
  assert.equal(anonBind.body.success, false);
  assert.equal(anonBind.body.message, "绑定操作需要登录");
  assert.equal("data" in anonBind.body, false);
  assert.equal("code" in anonBind.body, false);

  const ok = await postState(e, auth, JSON.stringify({ provider: "github", intent: "login" }));
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "");
  const data = ok.body.data as { flow_token: string; expires_at: number };
  assert.equal(typeof data.flow_token, "string");
  assert.equal(typeof data.expires_at, "number");
  assert.equal("state" in data, false);
  const affOk = await postState(e, auth, JSON.stringify({ provider: "github", intent: "login", aff: "a".repeat(32) }));
  assert.equal(affOk.body.success, true, String(affOk.body.message));
});
