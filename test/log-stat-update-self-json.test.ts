import assert from "node:assert/strict";
import { test } from "node:test";
import { ERR_ACCOUNT_PASSWORD_LENGTH } from "../src/crypto.js";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import type { Env, ExecutionContextLike } from "../src/types.js";

function ctx(): ExecutionContextLike {
  return { waitUntil() {} };
}

async function json(req: Request, e: Env) {
  const res = await handleFetch(req, e, ctx());
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function omitDataSuccess(body: Record<string, unknown>) {
  assert.equal(body.success, true);
  assert.equal(body.message, "");
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function openaiErr(body: Record<string, unknown>, status: number, message: string, code: string, res: Response) {
  assert.equal(res.status, status);
  assert.equal("success" in body, false);
  const err = body.error as { message: string; type: string; code: string; param: string };
  assert.deepEqual(Object.keys(err).sort(), ["code", "message", "param", "type"]);
  assert.equal(err.message, message);
  assert.equal(err.type, "new_api_error");
  assert.equal(err.code, code);
  assert.equal(err.param, "");
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
  return { e, auth };
}

async function passwordProof(e: Env, auth: Record<string, string>, scope: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "password", scope, password: "password12" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

test("original SearchAllLogs / SearchUserLogs leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const search = await json(new Request("http://local/api/log/search", { headers: auth }), e);
  assert.equal(search.res.status, 200);
  omitData(search.body, "该接口已废弃");

  const selfSearch = await json(new Request("http://local/api/log/self/search", { headers: auth }), e);
  omitData(selfSearch.body, "该接口已废弃");
});

test("original GetLogByKey leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const created = await json(
    new Request("http://local/api/token/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "log-key", remain_quota: 1, unlimited_quota: true }),
    }),
    e,
  );
  assert.equal(created.body.success, true, String(created.body.message));
  const sk = String((created.body.data as { key: string }).key);

  await e.DB.exec("DROP TABLE request_logs");
  const listErr = await json(new Request("http://local/api/log/token", { headers: { authorization: "Bearer " + sk } }), e);
  assert.equal(listErr.res.status, 200);
  assert.equal(listErr.body.success, false);
  assert.equal("data" in listErr.body, false);
  assert.deepEqual(Object.keys(listErr.body).sort(), ["message", "success"]);
  assert.match(String(listErr.body.message), /no such table/i);

  const adminErr = await json(new Request("http://local/api/log/?p=1", { headers: auth }), e);
  assert.equal(adminErr.body.success, false);
  assert.equal("data" in adminErr.body, false);
  assert.match(String(adminErr.body.message), /no such table/i);

  resetSchemaFlag();
  const { e: e2, auth: auth2 } = await boot();
  const root = await e2.DB.prepare("SELECT id FROM users WHERE username = ?").bind("root").first<{ id: number }>();
  assert.ok(root);
  await e2.DB.prepare(
    `INSERT INTO api_tokens (id, user_id, key, status, name, created_time, expired_time, remain_quota, unlimited_quota, model_limits_enabled, model_limits, allow_ips, "group", auto_groups, cross_group_retry, deleted_at)
     VALUES (0, ?, 'zerokey', 1, 'zero', 0, -1, 0, 1, 0, '', '', '', '', 0, 0)`,
  )
    .bind(root.id)
    .run();
  const zero = await json(new Request("http://local/api/log/token", { headers: { authorization: "Bearer zerokey" } }), e2);
  const stored = await e2.DB.prepare("SELECT id FROM api_tokens WHERE key = 'zerokey'").first<{ id: number }>();
  if (Number(stored?.id) === 0) {
    omitData(zero.body, "无效的令牌");
  } else {
    void auth2;
  }
});

test("original UpdateSelf leftover ApiErrorI18n / ApiSuccessI18n gin.H", async () => {
  const { e, auth } = await boot();

  const empty = await json(new Request("http://local/api/user/self", { method: "PUT", headers: auth }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "Invalid parameters");

  const emptyZh = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
    }),
    e,
  );
  omitData(emptyZh.body, "无效的参数");

  const jsonNull = await json(
    new Request("http://local/api/user/self", { method: "PUT", headers: auth, body: "null" }),
    e,
  );
  omitDataSuccess(jsonNull.body);

  const arr = await json(
    new Request("http://local/api/user/self", { method: "PUT", headers: auth, body: "[]" }),
    e,
  );
  omitData(arr.body, "Invalid parameters");

  const badType = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ password: 1 }),
    }),
    e,
  );
  omitData(badType.body, "Invalid parameters");

  const tooLong = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ username: "a".repeat(21) }),
    }),
    e,
  );
  omitData(tooLong.body, "Invalid input");
  const tooLongZh = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ username: "a".repeat(21) }),
    }),
    e,
  );
  omitData(tooLongZh.body, "输入不合法");

  const sidebar = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ sidebar_modules: JSON.stringify({ chat: true }) }),
    }),
    e,
  );
  assert.equal(sidebar.res.status, 200);
  assert.equal(sidebar.body.success, true);
  assert.equal(sidebar.body.message, "Update successful");
  assert.equal(sidebar.body.data, null);
  assert.deepEqual(Object.keys(sidebar.body).sort(), ["data", "message", "success"]);

  const sidebarZh = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "accept-language": "zh-CN" },
      body: JSON.stringify({ sidebar_modules: JSON.stringify({ chat: true }) }),
    }),
    e,
  );
  assert.equal(sidebarZh.body.message, "更新成功");
  assert.equal(sidebarZh.body.data, null);

  const display = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ display_name: "root-display" }),
    }),
    e,
  );
  omitDataSuccess(display.body);

  const proof = await passwordProof(e, auth, "account.password.change");
  const short = await json(
    new Request("http://local/api/user/self", {
      method: "PUT",
      headers: { ...auth, "x-security-proof": proof.proof_token },
      body: JSON.stringify({ password: "short" }),
    }),
    e,
  );
  assert.equal(short.res.status, 200);
  assert.equal(short.body.success, false);
  assert.equal(short.body.code, "PASSWORD_POLICY_REJECTED");
  assert.equal(short.body.message, ERR_ACCOUNT_PASSWORD_LENGTH);
  assert.equal("data" in short.body, false);
  assert.deepEqual(Object.keys(short.body).sort(), ["code", "message", "success"]);
});

test("original UpdateOption empty key leftover gin.H omit data", async () => {
  const { e, auth } = await boot();

  const emptyKey = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "", value: "x" }),
    }),
    e,
  );
  assert.equal(emptyKey.res.status, 200);
  omitData(emptyKey.body, "无效的参数");

  const missingKey = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ value: "x" }),
    }),
    e,
  );
  omitData(missingKey.body, "无效的参数");
});

test("original Playground NewAPIError OpenAI envelope", async () => {
  const { e, auth } = await boot();

  const proof = await passwordProof(e, auth, "access_token.generate");
  const issued = await json(
    new Request("http://local/api/user/token", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(issued.body.success, true, String(issued.body.message));
  const pat = String(issued.body.data);
  assert.ok(pat);

  const denied = await json(
    new Request("http://local/pg/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + pat, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    }),
    e,
  );
  openaiErr(denied.body, 500, "暂不支持使用 access token", "access_denied", denied.res);
});
