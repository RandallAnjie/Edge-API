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

function omitDataOk(body: Record<string, unknown>) {
  assert.equal(body.success, true);
  assert.equal(body.message, "");
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["message", "success"]);
}

function securityOp(body: Record<string, unknown>, code: string, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.code, code);
  assert.equal(body.message, message);
  assert.equal("data" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["code", "message", "success"]);
}

const TAKEN_EN = "Email address is already in use";
const TAKEN_ZH_CN = "邮箱地址已被占用";
const TAKEN_ZH_TW = "信箱位址已被占用";
const RESET_EN = "Password reset link is invalid or has expired";
const RESET_ZH_CN = "重置链接非法或已过期";
const RESET_ZH_TW = "重置連結非法或已過期";

test("original SendEmailVerification writeSecurityOperationError / ApiErrorI18n gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);
  const store = new Store(e.DB);
  await e.DB.prepare("UPDATE users SET email = ? WHERE id = 1").bind("taken@example.com").run();

  const invalid = await json(new Request("http://local/api/verification?email=not-an-email"), e);
  assert.equal(invalid.res.status, 200);
  securityOp(invalid.body, "EMAIL_ADDRESS_REJECTED", "Please enter a valid email address");

  await store.setOption("EmailDomainWhitelist", "allowed.example");
  await store.setOption("EmailDomainRestrictionEnabled", "true");
  const restricted = await json(new Request("http://local/api/verification?email=user@blocked.example"), e);
  securityOp(
    restricted.body,
    "EMAIL_ADDRESS_REJECTED",
    "This email address is not allowed by the administrator's email policy.",
  );
  await store.setOption("EmailDomainRestrictionEnabled", "false");

  const taken = await json(new Request("http://local/api/verification?email=taken@example.com"), e);
  omitData(taken.body, TAKEN_EN);
  const takenZh = await json(
    new Request("http://local/api/verification?email=taken@example.com", { headers: { "accept-language": "zh-CN" } }),
    e,
  );
  omitData(takenZh.body, TAKEN_ZH_CN);
  const takenTw = await json(
    new Request("http://local/api/verification?email=taken@example.com", { headers: { "accept-language": "zh-TW" } }),
    e,
  );
  omitData(takenTw.body, TAKEN_ZH_TW);

  const unconfigured = await json(new Request("http://local/api/verification?email=new@example.com"), e);
  omitData(unconfigured.body, "邮件未配置");

  await store.setOption("ResendApiKey", "re_test");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    if (String(input).includes("api.resend.com")) return new Response("{}", { status: 200 });
    return origFetch(input as RequestInfo, undefined);
  };
  try {
    const sent = await json(new Request("http://local/api/verification?email=fresh@example.com"), e);
    omitDataOk(sent.body);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("original SendPasswordResetEmail ApiErrorI18n gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  await boot(e);

  const missing = await json(new Request("http://local/api/reset_password"), e);
  omitData(missing.body, "Invalid parameters");
  const bad = await json(new Request("http://local/api/reset_password?email=not-an-email"), e);
  omitData(bad.body, "Invalid parameters");
  const badZh = await json(
    new Request("http://local/api/reset_password?email=not-an-email", { headers: { "accept-language": "zh-CN" } }),
    e,
  );
  omitData(badZh.body, "无效的参数");

  const unknown = await json(new Request("http://local/api/reset_password?email=nobody@example.com"), e);
  omitDataOk(unknown.body);
});

test("original ResetPassword Decoder EOF / ApiErrorI18n gin.H", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await json(
    new Request("http://local/api/user/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ id: 1, username: "root", email: "root@example.com" }),
    }),
    e,
  );

  const empty = await json(new Request("http://local/api/user/reset", { method: "POST" }), e);
  omitData(empty.body, "EOF");
  const ws = await json(
    new Request("http://local/api/user/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "  \n" }),
    e,
  );
  omitData(ws.body, "EOF");
  const arr = await json(
    new Request("http://local/api/user/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "[]" }),
    e,
  );
  omitData(arr.body, "json: cannot unmarshal array into Go value of type controller.PasswordResetRequest");
  const emailNum = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: 1 }),
    }),
    e,
  );
  omitData(emailNum.body, "json: cannot unmarshal number into Go struct field PasswordResetRequest.email of type string");
  const tokenBool = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", token: true }),
    }),
    e,
  );
  omitData(tokenBool.body, "json: cannot unmarshal bool into Go struct field PasswordResetRequest.token of type string");
  const nul = await json(
    new Request("http://local/api/user/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "null" }),
    e,
  );
  omitData(nul.body, "Invalid parameters");
  const onlyCode = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", code: "deadbeef" }),
    }),
    e,
  );
  omitData(onlyCode.body, "Invalid parameters");

  const resetMail = await json(new Request("http://local/api/reset_password?email=root@example.com"), e);
  omitDataOk(resetMail.body);
  const codeRow = await e.DB.prepare("SELECT code FROM email_codes WHERE email = ? AND type = 'reset' AND used = 0")
    .bind("root@example.com")
    .first<{ code: string }>();
  assert.ok(codeRow?.code);

  const bad = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", token: "deadbeef" }),
    }),
    e,
  );
  omitData(bad.body, RESET_EN);
  const badZh = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-CN" },
      body: JSON.stringify({ email: "root@example.com", token: "deadbeef" }),
    }),
    e,
  );
  omitData(badZh.body, RESET_ZH_CN);
  const badTw = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json", "accept-language": "zh-TW" },
      body: JSON.stringify({ email: "root@example.com", token: "deadbeef" }),
    }),
    e,
  );
  omitData(badTw.body, RESET_ZH_TW);

  const ok = await json(
    new Request("http://local/api/user/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "root@example.com", token: codeRow.code }),
    }),
    e,
  );
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "");
  assert.equal(typeof ok.body.data, "string");
  assert.equal(String(ok.body.data).length, 12);
  assert.deepEqual(Object.keys(ok.body).sort(), ["data", "message", "success"]);
});
