import assert from "node:assert/strict";
import { test } from "node:test";
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
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
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
  return { e, auth, store: new Store(e.DB) };
}

const PASSWORD_MIN = "Key: 'User.Password' Error:Field validation for 'Password' failed on the 'min' tag";
const USERNAME_MAX = "Key: 'User.Username' Error:Field validation for 'Username' failed on the 'max' tag";
const DISPLAY_MAX = "Key: 'User.DisplayName' Error:Field validation for 'DisplayName' failed on the 'max' tag";

test("original Login leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, store } = await boot();

  const empty = await json(new Request("http://local/api/user/login", { method: "POST" }), e);
  assert.equal(empty.res.status, 200);
  omitData(empty.body, "Invalid parameters");

  const jsonNull = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
    e,
  );
  omitData(jsonNull.body, "Invalid parameters");

  const arr = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    }),
    e,
  );
  omitData(arr.body, "Invalid parameters");

  const typed = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: 1, password: "password12" }),
    }),
    e,
  );
  omitData(typed.body, "Invalid parameters");

  const spaces = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "   ", password: "password12" }),
    }),
    e,
  );
  omitData(spaces.body, "Invalid parameters");

  const padded = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "  root", password: "password12" }),
    }),
    e,
  );
  assert.equal(padded.body.success, true, String(padded.body.message));

  const wrong = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "nope-nope" }),
    }),
    e,
  );
  omitData(wrong.body, "Username or password is incorrect, or user has been banned");

  const wrongZh = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ username: "root", password: "nope-nope" }),
    }),
    e,
  );
  omitData(wrongZh.body, "用户名或密码错误，或用户已被封禁");

  await store.setOption("PasswordLoginEnabled", "false");
  const disabled = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  omitData(disabled.body, "Password login has been disabled by administrator");

  const disabledZh = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  omitData(disabledZh.body, "管理员关闭了密码登录");
  await store.setOption("PasswordLoginEnabled", "true");

  await store.setOption("PasswordLoginEncryptionEnabled", "true");
  const encMissing = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "root", password: "password12" }),
    }),
    e,
  );
  omitData(encMissing.body, "Invalid parameters");

  const encKey = await json(new Request("http://local/api/user/login/encryption-key"), e);
  omitData(encKey.body, "Database error, please contact the administrator");
  const encKeyZh = await json(
    new Request("http://local/api/user/login/encryption-key", { headers: { "accept-language": "zh-CN" } }),
    e,
  );
  omitData(encKeyZh.body, "数据库出错，请联系管理员");
});

test("original Register leftover ApiErrorI18n gin.H omit data", async () => {
  const { e, store } = await boot();

  const empty = await json(new Request("http://local/api/user/register", { method: "POST" }), e);
  omitData(empty.body, "Invalid parameters");

  const jsonNull = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    }),
    e,
  );
  omitData(jsonNull.body, "Invalid parameters");

  const short = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "shortpw", password: "short" }),
    }),
    e,
  );
  omitData(short.body, `Invalid input ${PASSWORD_MIN}`);

  const shortZh = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ username: "shortpw", password: "short" }),
    }),
    e,
  );
  omitData(shortZh.body, `输入不合法 ${PASSWORD_MIN}`);

  const longName = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "a".repeat(21), password: "password12" }),
    }),
    e,
  );
  omitData(longName.body, `Invalid input ${USERNAME_MAX}`);

  const longDisplay = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "okname",
        password: "password12",
        display_name: "d".repeat(21),
      }),
    }),
    e,
  );
  omitData(longDisplay.body, `Invalid input ${DISPLAY_MAX}`);

  await store.setOption("RegisterEnabled", "false");
  const closed = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "closedreg", password: "password12" }),
    }),
    e,
  );
  omitData(closed.body, "New user registration has been disabled by administrator");
  await store.setOption("RegisterEnabled", "true");

  await store.setOption("PasswordRegisterEnabled", "false");
  const pwClosed = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "pwclosed", password: "password12" }),
    }),
    e,
  );
  omitData(
    pwClosed.body,
    "Password registration has been disabled by administrator, please use third-party account verification",
  );
  await store.setOption("PasswordRegisterEnabled", "true");

  const created = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mailuser", password: "password12" }),
    }),
    e,
  );
  assert.equal(created.res.status, 200);
  assert.equal(created.body.success, true);
  assert.equal(created.body.message, "");
  assert.equal("data" in created.body, false);
  assert.deepEqual(Object.keys(created.body).sort(), ["message", "success"]);

  await store.setOption("EmailVerificationEnabled", "true");
  const needMail = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "needmail", password: "password12" }),
    }),
    e,
  );
  omitData(needMail.body, "Email verification is enabled, please enter email address and verification code");

  const badCode = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "needmail",
        password: "password12",
        email: "need@example.com",
        verification_code: "000000",
      }),
    }),
    e,
  );
  omitData(badCode.body, "Verification code is incorrect or has expired");

  await store.insertEmailCode("need@example.com", "123456", "verify");
  const withMail = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "needmail",
        password: "password12",
        email: "need@example.com",
        verification_code: "123456",
      }),
    }),
    e,
  );
  assert.equal(withMail.body.success, true, String(withMail.body.message));
  assert.equal("data" in withMail.body, false);

  const emailLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "need@example.com", password: "password12" }),
    }),
    e,
  );
  assert.equal(emailLogin.body.success, true, String(emailLogin.body.message));
  assert.equal(typeof (emailLogin.body.data as { access_token: string }).access_token, "string");

  await store.insertEmailCode("need@example.com", "654321", "verify");
  const taken = await json(
    new Request("http://local/api/user/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "othermail",
        password: "password12",
        email: "need@example.com",
        verification_code: "654321",
      }),
    }),
    e,
  );
  omitData(taken.body, "Email address is already in use");
});
