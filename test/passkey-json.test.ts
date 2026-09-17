import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryD1 } from "./d1-memory.js";
import { handleFetch } from "../src/worker.js";
import { resetSchemaFlag } from "../src/schema.js";
import { Store } from "../src/store.js";
import { totpCode } from "../src/totp.js";
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

function omitData(body: Record<string, unknown>, message: string) {
  assert.equal(body.success, false);
  assert.equal(body.message, message);
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

function rotationKeys(data: Record<string, unknown>) {
  assert.equal(typeof data.access_token, "string");
  assert.equal(data.token_type, "Bearer");
  assert.equal(typeof data.access_expires_at, "number");
  assert.equal(typeof (data.session as { sid: string }).sid, "string");
  assert.equal("user" in data, false);
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

async function enablePasskey(e: Env, auth: Record<string, string>) {
  const r = await json(
    new Request("http://local/api/option/", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ key: "passkey.enabled", value: "true" }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message));
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

async function twoFAProof(e: Env, auth: Record<string, string>, scope: string, secret: string) {
  const r = await json(
    new Request("http://local/api/verify", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ method: "2fa", scope, code: await totpCode(secret) }),
    }),
    e,
  );
  assert.equal(r.body.success, true, String(r.body.message || r.body.code));
  return r.body.data as { proof_token: string };
}

test("original Passkey disabled gin.H omits data before proof", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const begin = await json(
    new Request("http://local/api/user/passkey/register/begin", { method: "POST", headers: auth }),
    e,
  );
  assert.equal(begin.res.status, 200);
  omitData(begin.body, "管理员未启用 Passkey 登录");

  const loginBegin = await json(
    new Request("http://local/api/user/passkey/login/begin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    e,
  );
  omitData(loginBegin.body, "管理员未启用 Passkey 登录");

  const verifyBegin = await json(
    new Request("http://local/api/user/passkey/verify/begin", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ scope: "passkey.delete" }),
    }),
    e,
  );
  omitData(verifyBegin.body, "管理员未启用 Passkey 登录");
});

test("original parsePasskeyFinishRequest / AUTH_FLOW_INVALID gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enablePasskey(e, auth);

  const empty = await json(new Request("http://local/api/user/passkey/register/finish", { method: "POST", headers: auth }), e);
  omitData(empty.body, "无效的 Passkey 验证请求");
  const badJson = await json(
    new Request("http://local/api/user/passkey/register/finish", { method: "POST", headers: auth, body: "{" }),
    e,
  );
  omitData(badJson.body, "无效的 Passkey 验证请求");
  const missingCred = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flow_token: "x" }),
    }),
    e,
  );
  omitData(missingCred.body, "无效的 Passkey 验证请求");

  const stale = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flow_token: "missing", credential: { id: "cred-1" } }),
    }),
    e,
  );
  assert.equal(stale.res.status, 200);
  securityOp(stale.body, "AUTH_FLOW_INVALID", "Verification flow expired");

  const loginFinish = await json(
    new Request("http://local/api/user/passkey/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flow_token: "missing", credential: { id: "cred-1" } }),
    }),
    e,
  );
  securityOp(loginFinish.body, "AUTH_FLOW_INVALID", "Verification flow expired");
});

test("original PasskeyRegisterFinish / PasskeyDelete authRotationData gin.H omits user", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);
  await enablePasskey(e, auth);
  const proof = await passwordProof(e, auth, "passkey.register");
  const begin = await json(
    new Request("http://local/api/user/passkey/register/begin", {
      method: "POST",
      headers: { ...auth, "X-Security-Proof": proof.proof_token },
    }),
    e,
  );
  assert.equal(begin.body.success, true, String(begin.body.message));
  const started = begin.body.data as { flow_token: string; options: unknown };
  assert.equal(typeof started.flow_token, "string");
  assert.equal("flow_id" in started, false);
  assert.equal("publicKey" in started, false);

  const finish = await json(
    new Request("http://local/api/user/passkey/register/finish", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flow_token: started.flow_token, credential: { id: "cred-root", rawId: "cred-root" } }),
    }),
    e,
  );
  assert.equal(finish.body.success, true, String(finish.body.message));
  assert.equal(finish.body.message, "Passkey 注册成功");
  rotationKeys(finish.body.data as Record<string, unknown>);

  const nextAuth = {
    authorization: "Bearer " + (finish.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  const status = await json(new Request("http://local/api/user/passkey", { headers: nextAuth }), e);
  assert.equal((status.body.data as { enabled: boolean }).enabled, true);

  const store = new Store(e.DB);
  const root = await store.getUserByUsername("root");
  assert.ok(root);
  await store.updateUser(root.id, { totp_enabled: 1, totp_secret: "JBSWY3DPEHPK3PXP" });
  const delProof = await twoFAProof(e, nextAuth, "passkey.delete", "JBSWY3DPEHPK3PXP");
  const deleted = await json(
    new Request("http://local/api/user/passkey", {
      method: "DELETE",
      headers: { ...nextAuth, "X-Security-Proof": delProof.proof_token },
    }),
    e,
  );
  assert.equal(deleted.body.success, true, String(deleted.body.message));
  assert.equal(deleted.body.message, "Passkey 已解绑");
  rotationKeys(deleted.body.data as Record<string, unknown>);
});

test("original AdminResetPasskey ApiErrorMsg gin.H omit data", async () => {
  resetSchemaFlag();
  const e = env();
  const { auth } = await boot(e);

  const invalid = await json(new Request("http://local/api/user/invalid/reset_passkey", { method: "DELETE", headers: auth }), e);
  omitData(invalid.body, "无效的用户 ID");

  const zero = await json(new Request("http://local/api/user/0/reset_passkey", { method: "DELETE", headers: auth }), e);
  assert.equal(zero.res.status, 500);
  securityOp(zero.body, "AUTH_INTERNAL_ERROR", "Internal Server Error");

  const missing = await json(new Request("http://local/api/user/999/reset_passkey", { method: "DELETE", headers: auth }), e);
  omitData(missing.body, "该用户尚未绑定 Passkey");

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "member1", password: "password12", role: 1 }),
    }),
    e,
  );
  const users = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const member = (users.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === "member1");
  assert.ok(member);
  const store = new Store(e.DB);
  await store.insertPasskey(member.id, "cred-member", "pubkey", "device", "example.com");
  const ok = await json(
    new Request("http://local/api/user/" + member.id + "/reset_passkey", { method: "DELETE", headers: auth }),
    e,
  );
  assert.equal(ok.res.status, 200);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.message, "Passkey 已重置");
  assert.equal("data" in ok.body, false);

  await json(
    new Request("http://local/api/user/", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ username: "admin1", password: "password12", role: 1 }),
    }),
    e,
  );
  const all = await json(new Request("http://local/api/user/", { headers: auth }), e);
  const adminUser = (all.body.data as { items: { id: number; username: string }[] }).items.find((u) => u.username === "admin1");
  assert.ok(adminUser);
  await json(
    new Request("http://local/api/user/manage", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: adminUser.id, action: "promote" }),
    }),
    e,
  );
  const adminLogin = await json(
    new Request("http://local/api/user/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin1", password: "password12" }),
    }),
    e,
  );
  const adminAuth = {
    authorization: "Bearer " + (adminLogin.body.data as { access_token: string }).access_token,
    "content-type": "application/json",
  };
  await store.insertPasskey(1, "cred-root", "pubkey", "device", "example.com");
  const forbidden = await json(new Request("http://local/api/user/1/reset_passkey", { method: "DELETE", headers: adminAuth }), e);
  omitData(forbidden.body, "no permission");
});
